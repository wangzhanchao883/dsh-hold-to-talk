/**
 * dsh-hold-to-talk · host 半身
 *
 * 职责:
 *  1. 注册 HTTP 路由(浏览器半身通过它上传 PCM、查询模型状态、取配置)
 *  2. 管理本地 SenseVoice 识别引擎(懒加载 + worker 线程,避免阻塞宿主事件循环)
 *  3. 首次使用按需下载模型(hf-mirror,断点续传,带进度)
 *  4. 维护每个"长按会话"的音频缓冲:实时预览只解码尾部滑动窗口,松手定稿用完整音频
 *
 * 路由:
 *   POST /dsh-hold-to-talk/asr?mode=interim|final|drop&hold=<id>  body = 小端 f32 PCM
 *   GET  /dsh-hold-to-talk/health[?prepare=1]
 *   GET  /dsh-hold-to-talk/config
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DEFAULT_MIRROR, ensureModels, modelsReady, modelPaths } from "./model-cache.js";

export const name = "dsh-hold-to-talk";

const NS = "dsh-hold-to-talk";
const ROUTE = "/dsh-hold-to-talk";
const SAMPLE_RATE = 16000;
/** 单次上传上限:60 秒 @16k f32 ≈ 3.8MB,留足余量 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** 长按会话缓冲的存活时间(客户端异常退出后的兜底清理) */
const MAX_HOLD_AGE_MS = 5 * 60 * 1000;
const MAX_HOLDS = 8;
/** 太短的音频不值得解码 */
const MIN_DECODE_SAMPLES = Math.round(SAMPLE_RATE * 0.2);

export const DEFAULT_CONFIG = {
  enabled: true,
  holdThresholdMs: 400,
  cancelSlidePx: 60,
  // 实测(原生引擎 RTF≈0.15):6 秒窗口解码约 0.9 秒,1.5 秒一轮留足余量。
  // 原定 900ms/12s 在 WASM 单线程下要 4.4 秒一轮,预览会拖到 4 秒以上,已按实测调宽。
  interimIntervalMs: 1500,
  minHoldMs: 250,
  maxHoldMs: 60000,
  maxWindowSec: 6,
  autoSend: false,
  language: "auto",
  useItn: true,
  numThreads: 2,
  mirror: DEFAULT_MIRROR,
  modelDir: "",
};

/** ---------- 小工具 ---------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 廉价防护:自定义路由不在 `/api` 的浏览器信任栅栏后面,这里自己挡一下跨站请求
 * (DNS rebinding / 恶意页面直接 POST)。同源 fetch 的 sec-fetch-site 是 same-origin,
 * 用户直接在地址栏打开是 none;两者都放行。
 */
function crossSite(req) {
  const site = req.headers["sec-fetch-site"];
  return typeof site === "string" && site !== "same-origin" && site !== "none";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 小端 f32 裸字节 → Float32Array(x86/arm 都是小端,直接视图即可) */
function toFloat32(buf) {
  const usable = buf.byteLength - (buf.byteLength % 4);
  if (usable <= 0) return new Float32Array(0);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** ---------- 插件 ---------- */

export function apply(ctx, entryConfig) {
  // 配置来源 = 插件条目 config(即 cordis.patch.yml 里 insert[].config)。
  // DSH 0.1.7 起,Web 设置面板改为 schema 驱动的自动表单,旧的
  // `settings.register(ns, schema, {base})` 命名空间契约已废弃(相关服务被移除),
  // 本插件不再注册设置命名空间;要改参数请直接改 cordis.patch.yml。
  let config = { ...DEFAULT_CONFIG, ...(entryConfig || {}) };

  const state = {
    model: { status: "idle", progress: 0, file: "", error: null, dir: modelsDirSafe() },
    engine: { ready: false, error: null },
    holds: new Map(),
  };

  function modelsDirSafe() {
    try {
      return modelPaths(config).dir;
    } catch {
      return "";
    }
  }

  function log(level, message) {
    try {
      const logger = ctx.logger;
      if (logger && typeof logger[level] === "function") logger[level](message);
    } catch {
      /* ignore */
    }
  }

  /** ---------- 识别引擎(worker 线程) ---------- */

  let worker = null;
  const pending = new Map();
  let nextId = 1;

  function spawnEngine() {
    if (worker) return worker;
    const { modelPath, tokensPath } = modelPaths(config);
    worker = new Worker(new URL("./asr-worker.mjs", import.meta.url), {
      workerData: {
        modelPath,
        tokensPath,
        language: config.language,
        useItn: config.useItn,
        numThreads: config.numThreads,
      },
    });

    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        state.engine.ready = true;
        state.engine.error = null;
        log("info", `${NS}: 识别引擎就绪 (${path.basename(modelPath)})`);
        return;
      }
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.type === "result") slot.resolve(msg);
      else slot.reject(new Error(msg.message || "worker 报错"));
    });

    worker.on("error", (err) => {
      const message = String((err && err.message) || err);
      state.engine.ready = false;
      state.engine.error = message;
      log("warn", `${NS}: 识别引擎异常:${message}`);
      for (const slot of pending.values()) slot.reject(new Error(message));
      pending.clear();
      worker = null;
    });

    worker.on("exit", () => {
      worker = null;
      state.engine.ready = false;
    });

    worker.postMessage({ type: "warmup", id: 0 });
    return worker;
  }

  function decode(samples) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = spawnEngine();
      } catch (err) {
        reject(err);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const copy = samples.slice();
      target.postMessage({ type: "decode", id, samples: copy }, [copy.buffer]);
    });
  }

  function shutdownEngine() {
    if (!worker) return;
    const dying = worker;
    worker = null;
    state.engine.ready = false;
    dying.removeAllListeners();
    dying.terminate().catch(() => {});
    for (const slot of pending.values()) slot.reject(new Error("引擎已重启"));
    pending.clear();
  }

  /** ---------- 模型准备 ---------- */

  let preparePromise = null;

  function prepareModel() {
    if (preparePromise) return preparePromise;
    if (modelsReady(config)) {
      state.model.status = "ready";
      state.model.progress = 1;
      state.model.dir = modelsDirSafe();
      spawnEngine();
      return Promise.resolve();
    }
    state.model.status = "downloading";
    state.model.error = null;
    preparePromise = ensureModels(config, (p) => {
      state.model.status = "downloading";
      state.model.progress = Math.max(0, Math.min(1, p.ratio || 0));
      state.model.file = p.file;
    })
      .then(() => {
        state.model.status = "ready";
        state.model.progress = 1;
        state.model.dir = modelsDirSafe();
        spawnEngine();
      })
      .catch((err) => {
        state.model.status = "error";
        state.model.error = String((err && err.message) || err);
        log("warn", `${NS}: 模型准备失败:${state.model.error}`);
      })
      .finally(() => {
        preparePromise = null;
      });
    return preparePromise;
  }

  /** ---------- 长按会话缓冲 ---------- */

  function getHold(id) {
    const now = Date.now();
    for (const [key, entry] of state.holds) {
      if (now - entry.updatedAt > MAX_HOLD_AGE_MS) state.holds.delete(key);
    }
    let entry = state.holds.get(id);
    if (!entry) {
      if (state.holds.size >= MAX_HOLDS) {
        const oldest = [...state.holds.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (oldest) state.holds.delete(oldest[0]);
      }
      entry = { chunks: [], updatedAt: now, createdAt: now };
      state.holds.set(id, entry);
    }
    entry.updatedAt = now;
    return entry;
  }

  /** ---------- 路由 ---------- */

  async function handleAsr(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "只接受 POST" });
      return;
    }
    if (!config.enabled) {
      sendJson(res, 503, { error: "插件已禁用" });
      return;
    }

    const url = new URL(req.url || ROUTE, "http://127.0.0.1");
    const mode = url.searchParams.get("mode") === "interim" ? "interim" : url.searchParams.get("mode") === "drop" ? "drop" : "final";
    const holdId = (url.searchParams.get("hold") || "default").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "default";

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: String((err && err.message) || err) });
      return;
    }

    if (mode === "drop") {
      state.holds.delete(holdId);
      sendJson(res, 200, { ok: true, dropped: true });
      return;
    }

    if (state.model.status !== "ready") {
      prepareModel();
      sendJson(res, 409, {
        code: "model-preparing",
        status: state.model.status,
        progress: state.model.progress,
        error: state.model.error,
      });
      return;
    }

    const samples = toFloat32(body);
    const entry = getHold(holdId);
    if (samples.length > 0) entry.chunks.push(samples);

    const total = entry.chunks.reduce((sum, c) => sum + c.length, 0);
    const all = mode === "final" ? concatChunks(entry.chunks) : null;
    // 实时预览只解码尾部窗口,避免长按越久单次解码越贵;定稿用完整音频
    let window = all;
    if (mode === "interim") {
      const cap = Math.max(1, Math.round(config.maxWindowSec * SAMPLE_RATE));
      if (total <= cap) {
        window = concatChunks(entry.chunks);
      } else {
        const skip = total - cap;
        let seen = 0;
        const tail = [];
        for (const c of entry.chunks) {
          if (seen + c.length <= skip) {
            seen += c.length;
            continue;
          }
          const from = Math.max(0, skip - seen);
          tail.push(c.subarray(from));
          seen += c.length;
        }
        window = concatChunks(tail);
      }
    }

    if (mode === "final") state.holds.delete(holdId);

    if (!window || window.length < MIN_DECODE_SAMPLES) {
      sendJson(res, 200, { text: "", samples: total, skipped: true });
      return;
    }

    try {
      const result = await decode(window);
      sendJson(res, 200, { text: result.text || "", ms: result.ms || 0, samples: total });
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  }

  function handleHealth(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    const url = new URL(req.url || ROUTE, "http://127.0.0.1");
    // 页面挂载时用 prepare=1 让宿主在后台把模型/引擎准备好(不占关键路径)
    if (url.searchParams.get("prepare") === "1" && config.enabled && !state.engine.ready) {
      prepareModel();
    }
    sendJson(res, 200, {
      ok: true,
      enabled: config.enabled,
      model: {
        status: state.model.status,
        progress: state.model.progress,
        file: state.model.file,
        error: state.model.error,
        dir: state.model.dir,
        ready: modelsReady(config),
      },
      engine: { ready: state.engine.ready, error: state.engine.error },
      activeHolds: state.holds.size,
    });
  }

  function handleConfig(req, res) {
    if (crossSite(req)) {
      sendJson(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    // 只暴露浏览器半身需要的字段
    sendJson(res, 200, {
      enabled: config.enabled,
      holdThresholdMs: config.holdThresholdMs,
      cancelSlidePx: config.cancelSlidePx,
      interimIntervalMs: config.interimIntervalMs,
      minHoldMs: config.minHoldMs,
      maxHoldMs: config.maxHoldMs,
      autoSend: config.autoSend,
    });
  }

  // host 侧路由靠 webServer 服务;它可能晚于本插件就绪,用 ctx.inject 等它就位
  ctx.inject(["webServer"], (serverCtx) => {
    const routes = [
      { kind: "exact", path: `${ROUTE}/asr`, handler: handleAsr },
      { kind: "exact", path: `${ROUTE}/health`, handler: handleHealth },
      { kind: "exact", path: `${ROUTE}/config`, handler: handleConfig },
    ];
    for (const route of routes) {
      try {
        serverCtx.webServer.register(route);
      } catch (err) {
        log("warn", `${NS}: 路由注册失败 ${route.path}:${String((err && err.message) || err)}`);
      }
    }
    log("info", `${NS}: 路由已注册 (${ROUTE})`);
  });

  if (modelsReady(config)) {
    // 只标记就绪,不在这里预热引擎:启动时加载 228MB 模型要多花 ~3.5 秒并常驻
    // ~250MB 内存。改由页面挂载时的 /health?prepare=1 在后台预热。
    state.model.status = "ready";
    state.model.progress = 1;
  }

  ctx.effect(() => () => {
    shutdownEngine();
    state.holds.clear();
  }, `${NS}.teardown`);
}
