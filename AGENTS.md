# 2048（2048.dmhpro.top）

纯静态、零 npm 依赖的 2048，vanilla JS。部署在 Vercel，SW 全量预缓存，离线可玩。

## 命令

- `npm run check` —— 唯一验证门禁 = `build:check` + `node --test`。提交前必须全绿。
- `npm run build` —— 从模板重新生成 `index.html` 和 `sw.js`。
- `npm run benchmark:ai` —— JS 引擎整局基准（`--games=N`）。
- `node scripts/benchmark-ziap.mjs` —— WASM 引擎整局基准（`--games=N --max-moves=N`）。

## 陷阱

- **`index.html` 和 `sw.js` 是构建产物**，直接提交在仓库根。改页面去 `src/index.template.html`，改 SW 去 `src/sw.template.js`，然后跑 `npm run build` 把产物一起提交。CI / Vercel 用 `--check` 拒绝过期产物。
- 新增运行时资源文件时，必须同步加进 `scripts/build.mjs` 的 `PRECACHE_ASSETS`，否则离线模式缺文件（`tests/build.test.mjs` 会校验列表里的文件都存在）。
- WASM 引擎需要跨源隔离（COOP/COEP）。生产由 `vercel.json` 发头，离线/次次加载由 SW 注入（`src/sw.template.js`）。没有隔离时 worker 报 `move-error`，app 自动落到纯 JS 引擎。

## 架构

- `src/game-core.js` —— 棋盘规则（纯函数，IIFE 挂 `globalThis.GameCore`）。
- `src/ai.js` —— 纯 JS expectimax 兜底引擎（`GameAI`）。评估函数刻意保留原始魔法权重，强度靠实战验证，勿"整理"。
- `src/ai-worker.js` —— ES module worker，适配 vendored ziap WASM 引擎（主引擎）。
- `src/ziap/main.wasm` —— vendored 自 https://github.com/ziap/2048-ai （MIT，见 `src/ziap/LICENSE`）。Zig 编译；重编译需从上游仓库按其 build.zig 构建（MEMORY_BYTES=64MB 共享内存）。
- `src/app.js` —— DOM、autoplay 调度、后台标签页/discard 恢复。所有异步竞态用 `generation` + `requestId` 双重防护。
- 测试跑在 `node:vm` 假浏览器里（`tests/helpers/load-scripts.mjs`），无 jsdom。

## 已定决策（勿"修复"）

- 手动刷新永远开新局，不持久化棋局（7a0493a）。sessionStorage 只用于 tab discard 恢复（`document.wasDiscarded === true` 才恢复）。
- EGTB/GPL 引擎已回滚（a02e34f），只接受 MIT 兼容代码。
- 代码风格：4 空格缩进、IIFE + `Object.freeze` 导出、无构建期转译、无外部依赖。
