/**
 * 开发用:不重启 DSH,用桩 ctx 把 host 半身跑起来,对真实 HTTP 路由做端到端验证。
 *
 *   node tools/host-test.mjs
 *
 * 覆盖:配置/健康检查路由、final 定稿、interim 增量(滑动窗口)、drop 丢弃、
 *      模型未就绪时的 409 语义、跨站请求拒绝。
 */
import fs from "node:fs";
import http from "node:http";
import { apply } from "../lib/index.js";
import { modelsReady } from "../lib/model-cache.js";

// 没有模型时(CI / 新克隆的仓库不下载 228MB)只跑不依赖识别的用例:
// 路由注册、config 形状、跨站拒绝、405/404 —— 这些恰好是纯形式校验。
// 注意全程不碰 /health?prepare=1,避免在 CI 上触发 228MB 下载。
const HAS_MODEL = modelsReady({ modelDir: process.env.DSH_HTT_MODEL_DIR || "" }) && fs.existsSync(new URL("./zh.wav", import.meta.url));

/* ---------- 桩 ctx:只提供 host 半身真正用到的东西 ---------- */

const routes = [];
const logs = [];

const ctx = {
	name: "dsh-hold-to-talk",
	logger: {
		info: (msg) => logs.push(["info", msg]),
		warn: (msg) => logs.push(["warn", msg]),
	},
	inject(deps, callback) {
		if (deps.includes("webServer")) {
			callback({
				webServer: {
					register(route) {
						if (routes.some((r) => r.path === route.path)) throw new Error("duplicate route " + route.path);
						routes.push(route);
						return () => {};
					},
				},
			});
		}
	},
	effect(fn) {
		fn();
	},
};

apply(ctx);

/* ---------- 真 HTTP 服务 ---------- */

const server = http.createServer((req, res) => {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const route = routes.find((r) => r.path === url.pathname);
	if (!route) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "no route" }));
		return;
	}
	Promise.resolve(route.handler(req, res)).catch((err) => {
		if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String(err && err.message) }));
	});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log("[host-test] 路由:", routes.map((r) => r.path).join(", "));

/* ---------- 工具 ---------- */

function readWav16k(file) {
	const buf = fs.readFileSync(file);
	let offset = 12;
	let dataStart = -1;
	let dataLength = 0;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		if (id === "data") {
			dataStart = offset + 8;
			dataLength = size;
			break;
		}
		offset = offset + 8 + size + (size % 2);
	}
	const count = Math.floor(dataLength / 2);
	const out = new Float32Array(count);
	for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
	return out;
}

async function get(path) {
	const res = await fetch(base + path);
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function postPcm(path, samples, headers = {}) {
	const res = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/octet-stream", ...headers },
		body: samples,
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

let failures = 0;
function check(label, ok, detail) {
	console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? " — " + detail : ""}`);
	if (!ok) failures += 1;
}

/* ---------- 用例 ---------- */

const pcm = HAS_MODEL ? readWav16k("tools/zh.wav") : new Float32Array(16000);
if (HAS_MODEL) console.log(`[host-test] 测试音频 ${pcm.length} 样本 (${(pcm.length / 16000).toFixed(2)}s)\n`);
else console.log("[host-test] 未检测到模型/测试音频 → 只跑不依赖识别的用例(config / 403 / 405 / 404)。\n");

console.log("1) GET /config");
{
	const r = await get("/dsh-hold-to-talk/config");
	check("200 且带 holdThresholdMs/interimIntervalMs", r.status === 200 && r.body && typeof r.body.holdThresholdMs === "number", JSON.stringify(r.body));
}

console.log("2) GET /health(路由与状态形状)");
{
	let r = await get("/dsh-hold-to-talk/health");
	check("200 且带 model/engine 状态", r.status === 200 && r.body?.model && r.body?.engine, JSON.stringify(r.body?.model));
	if (HAS_MODEL) {
		// 浏览器半身挂载时就是用 prepare=1 让宿主在后台预热引擎的
		r = await get("/dsh-hold-to-talk/health?prepare=1");
		check("model.status=ready", r.body?.model?.status === "ready", JSON.stringify(r.body?.model));
		for (let i = 0; i < 60 && !r.body?.engine?.ready; i++) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			r = await get("/dsh-hold-to-talk/health");
		}
		check("engine.ready=true", r.body?.engine?.ready === true, JSON.stringify(r.body?.engine));
	}
}

console.log("3) 跨站请求被拒");
{
	const r = await postPcm("/dsh-hold-to-talk/asr?mode=final&hold=x", pcm, { "sec-fetch-site": "cross-site" });
	check("403", r.status === 403, JSON.stringify(r.body));
}

if (HAS_MODEL) {
	console.log("4) 短音频被跳过(不足 200ms)");
	{
		const r = await postPcm("/dsh-hold-to-talk/asr?mode=final&hold=short", pcm.subarray(0, 1600));
		check("skipped=true 且 text 为空", r.status === 200 && r.body?.skipped === true && r.body?.text === "", JSON.stringify(r.body));
	}

	console.log("5) final 定稿(整段 5.59s)");
	{
		const started = Date.now();
		const r = await postPcm("/dsh-hold-to-talk/asr?mode=final&hold=final-1", pcm);
		check("200 且有中文文本", r.status === 200 && typeof r.body?.text === "string" && r.body.text.length > 0, `"${r.body?.text}" ${Date.now() - started}ms`);
	}

	console.log("6) interim 增量:先发 2.5s,再发剩余");
	{
		const first = await postPcm("/dsh-hold-to-talk/asr?mode=interim&hold=int-1", pcm.subarray(0, 40000));
		check("第一段有文本", first.status === 200 && typeof first.body?.text === "string", `"${first.body?.text}"`);
		const rest = await postPcm("/dsh-hold-to-talk/asr?mode=interim&hold=int-1", pcm.subarray(40000));
		check("增量拼接后文本更长/更完整", rest.status === 200 && (rest.body?.text || "").length >= (first.body?.text || "").length, `"${rest.body?.text}" (窗口 ${rest.body?.samples} 样本)`);
		const fin = await postPcm("/dsh-hold-to-talk/asr?mode=final&hold=int-1", new Float32Array(0));
		check("final 用完整缓冲(样本数=全量)", fin.status === 200 && fin.body?.samples === pcm.length, `samples=${fin.body?.samples} text="${fin.body?.text}"`);
	}

	console.log("7) drop 丢弃缓冲");
	{
		await postPcm("/dsh-hold-to-talk/asr?mode=interim&hold=drop-1", pcm.subarray(0, 20000));
		const r = await postPcm("/dsh-hold-to-talk/asr?mode=drop&hold=drop-1", new Float32Array(0));
		check("dropped=true", r.status === 200 && r.body?.dropped === true, JSON.stringify(r.body));
		const after = await postPcm("/dsh-hold-to-talk/asr?mode=final&hold=drop-1", new Float32Array(0));
		check("丢弃后 final 为空", after.status === 200 && after.body?.skipped === true, JSON.stringify(after.body));
	}
}

console.log("8) 方法/路径边界");
{
	const res = await fetch(base + "/dsh-hold-to-talk/asr", { method: "GET" });
	check("GET /asr → 405", res.status === 405, "status " + res.status);
	const miss = await fetch(base + "/dsh-hold-to-talk/nope");
	check("未知子路径 → 404", miss.status === 404, "status " + miss.status);
}

console.log("\n[host-test] 宿主日志:");
for (const [level, msg] of logs) console.log(`  ${level}: ${msg}`);

server.close();
console.log(failures === 0 ? "\n[host-test] 全部通过 ✅" : `\n[host-test] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
