# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录本项目所有值得注意的改动。格式参考 Keep a Changelog,版本号遵循语义化版本。

## [0.1.3] - 2026-09-25

### Fixed / 修复

- **兼容 DSH 0.1.7 / DSH 0.1.7 compatibility.** DSH 0.1.7 移除了旧设置契约,
  本插件原先调用 `settings.register(ns, schema, { base })` 注册设置命名空间,
  在 0.1.7 上不再生效。由于该设置面板实际从未被使用,这里直接移除注册块而非
  重写 —— **host 端功能与浏览器端行为完全不变**。 / DSH 0.1.7 replaced the old
  settings contract; the previous `settings.register(ns, schema, { base })`
  call no longer took effect. Since the panel was never used in practice, the
  registration block was removed rather than rewritten — host and browser
  behaviour are unchanged.
- 插件参数改为从插件条目的 `config`(即 `cordis.patch.yml` 的 `insert[].config`)
  读取。此前 `apply()` 忽略了第二个参数,**该段配置实际从未生效**,一直只有硬编码
  默认值在起作用;现在它按文档描述生效了。 / Plugin options are now read from
  the entry's `config`. Previously `apply()` ignored its second argument, so the
  documented `cordis.patch.yml` block had no effect at all; it works now.
- 移除 `dsh.client.inject` 里失效的 `@deepseek-ai/dsh-client-runtime` 声明 ——
  该包自 0.1.5 起未再发布,Web 端组合器只会静默跳过它。 / Removed the dead
  `@deepseek-ai/dsh-client-runtime` entry; that package has published nothing
  since 0.1.5 and the web bundle resolver silently skips it.

### Removed / 移除

- `buildSettingsSchema()` 与 `applyConfig()`(仅被已删除的设置注册块调用)。
- README 中"设置面板"相关的两处配置说明(英/中)。

## [0.1.2] - 2026-09-11

### Added / 新增

- Real product screenshots and a 35-second demo GIF recorded against a running
  DSH web UI (`assets/screenshots/`), plus the full MP4 (`assets/videos/`). /
  在真实 DSH Web 界面上录制的产品截图与 35 秒演示 GIF（`assets/screenshots/`），
  以及完整 MP4（`assets/videos/`）。
- `screenshots.json` at the repository root declaring the screenshots for the
  plugin storefront, and shipped in the npm package. / 仓库根新增
  `screenshots.json` 供插件商店展示，并随 npm 包一起发布。

## [0.1.1] - 2026-09-11

### Fixed / 修复

- **Long-press stopped working after the first successful dictation.**
  Gesture dispatch picked the overlay instance by *visibility*
  (`offsetParent` / `getClientRects()`), but the overlay is hidden while idle —
  so after the first recognition the instance was considered invisible and no
  `mousedown` was routed anywhere. Ownership is now decided by DOM containment
  (walk up from the editor until an ancestor contains the overlay node), which
  is independent of CSS. /
  **第一次识别成功后长按彻底失效**：手势派发用"实例是否可见"挑实例，而浮层空闲时是隐藏的，
  于是第一次识别完之后实例被判为不可见、`mousedown` 没人接。改为按 DOM 包含关系判定归属，
  与 CSS 无关。
- Overlay anchor is now rendered permanently (zero-size, out of flow) so the
  ownership anchor never disappears. / 浮层锚点常驻渲染（零尺寸、脱离文档流）。
- Stale document-level listeners from a hot-reloaded module bundle are now
  invalidated by a module token. / 客户端热重载后旧模块的文档监听器自动失效。

### Added / 新增

- Regression tests: ownership dispatch assertions plus **three consecutive
  successful holds** (a single "cancel then retry" case did not catch the bug). /
  回归用例：归属判定断言 + **连续 3 轮成功长按**（只测"取消后重试"抓不到该 bug）。

## [0.1.0] - 2026-09-11

### Added / 新增

- Hold-to-talk voice input for the DeepSeek Harness Web composer: hold the mouse
  on the input box, speak, release to insert the transcript into the draft,
  slide up to discard. / 输入框上按住鼠标说话、松手入草稿、上滑取消的微信式语音输入。
- Live transcript preview in a floating overlay while holding; the preview never
  writes into the draft — only the release-time final transcript does. /
  按住期间浮层实时预览；预览绝不回写草稿，只有松手定稿才写入。
- Local ASR: SenseVoice (int8) via sherpa-onnx, native binary first with a WASM
  fallback, decoded in a worker thread. No API key, offline, audio never leaves
  the machine. / 本地识别：SenseVoice(int8) + sherpa-onnx，原生引擎优先、WASM 兜底，
  解码放在 worker 线程。免密钥、离线、音频不出本机。
- On-demand model download (228MB, hf-mirror, resumable) with progress surfaced
  in the overlay. / 模型按需下载（228MB、hf-mirror、断点续传），进度显示在浮层里。
- HTTP routes `POST /dsh-hold-to-talk/asr` (`interim` / `final` / `drop`),
  `GET /dsh-hold-to-talk/health`, `GET /dsh-hold-to-talk/config`. /
  宿主端三条路由 + 设置命名空间（扁平 schema）。
- Offline test suites that need neither a browser nor a DSH restart:
  registration contract, host routes over a real HTTP server, and the full
  client interaction logic driven in Node with stubbed browser APIs. /
  三套离线自测：注册契约、真实 HTTP 路由、在 Node 里驱动真实客户端交互逻辑。

[0.1.1]: https://github.com/wangzhanchao883/dsh-hold-to-talk/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wangzhanchao883/dsh-hold-to-talk/releases/tag/v0.1.0
