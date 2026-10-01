# dsh-restart

DeepSeek Harness（DSH）**纯插件**：会话头部加一个无边框的纯线条「重启」图标按钮（无文字），
让整个桌面应用一键重启；若重启时当前回合仍在运行，重启后自动"继续"接着跑。

**不修改任何 `@deepseek-ai/dsh-*` 源码。**

## 功能：一键重启 DSH（线条图标按钮）+ 条件自动续跑

会话头部有一个无边框的纯线条「重启」图标按钮（电源符号造型，无文字，线条颜色跟随
界面文字色，悬停显示 tooltip；发起重启后图标呼吸闪烁表示进行中）。图标有两个挂载点：
活跃会话显示在标题行动作区（带 sessionId，可写续跑标记）；**全新空白会话**（还没有
任何消息）时框架会隐藏标题行动作区，此时图标自动补位到头部左侧引导位，发第一条
消息后回到动作区：
1. **第一次点击**进入确认态（图标变琥珀色，3 秒不点自动复位，防误触）；
2. **再点一次**执行：
   - 若**当前会话的 agent 正在运行（回合未结束）**，写入"续跑标记"（重启后自动发"继续"）；
     若 agent 已停止，则只重启、不续跑；
   - 按当前桌面代际选择重启方式（见下），无论如何保证宿主必退；
3. 桌面应用随之整体退出，复活进程**确认旧实例退出（宽限期内不退就 `taskkill /F` 强杀）**，
   再**自动重新启动**整个应用；
4. 重启后，被标记的会话一旦由 web 端正常创建/恢复（打开该会话），自动注入"继续"接着跑。

> ⚠️ 重启会**短暂断开**当前会话（属预期）；回合未结束才会自动"继续"。

### 自动续跑实现

- 插件监听 **`agent/created`** 事件：被标记的会话一旦被创建/恢复，立即 `agent.followup(...)` 注入"继续"并清标记。
- **不在启动时自己 `agents.resume`**——那会造出缺 agent preset / 工具呈现 / 权限的
  "半成品 agent"，导致该会话工具大面积 UNKNOWN_TOOL（已踩过坑）。
- 续跑标记 **5 分钟内有效**，防陈旧标记误复活旧会话。
- 只在 agent **运行中**才写标记：回合已结束不续跑。

### Agent 触发的重启（"你也能自动重启 DSH"）

会话内的 agent 可以直接触发带续跑的自动重启：

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json' `
  -Body (@{ sessionId = $env:DSH_SESSION_ID; text = '继续' } | ConvertTo-Json) `
  "$env:DSH_WEB_URL/dsh-revive"
```

你在对话里说一句"重启 DSH"，我就在回复末尾执行它：应用自动关、自动开、回合未结束则自动继续。

### 三代桌面宿主，插件自动识别

插件在 `apply` 时按以下顺序识别宿主代际，任一命中才注册 `/dsh-revive` 路由
（纯 CLI 下保持纯占位，不注册）：

| 代际 | 识别条件 | 重启方式 |
| --- | --- | --- |
| 旧版桌面 | 环境变量 `DSH_DESKTOP=1` | 复活进程等桌面主进程退出（8 秒宽限，不退 `taskkill /T /F`），再拉起应用 |
| 中间版桌面（dsh-plugin-desktop v2） | `ctx.desktopRuntime` 存在 | 宿主原生 `desktopRuntime.requestRestart()`（`app.relaunch()` + `app.exit(0)`），不 spawn 任何外部进程 |
| 新版桌面（DSH Desktop 44.x，`dsh-desktop-host`） | `profileContext.name === 'desktop'` **且** argv 带 `dsh-desktop-host` 入口路径 | 复活进程等宿主优雅退出 → 强杀 Electron 主进程树 → 拉起应用 |

### 为什么需要"复活进程 + 强杀"（旧版桌面）

桌面应用（Electron）对 host 只有监督、没有自动复活：host 一退出，桌面主进程理应
`app.quit()`——但实测**经常不退出**（变成无子进程的僵尸一直挂着），导致只等它自然退出
永远等不到。所以：
1. `index.js` 先 `spawn` 出 `revive.mjs`（detached，宿主退出后仍存活）；
2. `revive.mjs` 给旧实例 **8 秒宽限**自然退出，不退就 **`taskkill /T /F` 强杀**并确认死透；
3. 再拉起桌面可执行文件；新实例 5 秒内退出则按 2s/3s/5s/8s 退避重试（最多 5 次）。

全程日志：`~/.dsh/storages/dsh-restart-revive.log`。

### 新版桌面（DSH Desktop 44.x，dsh-desktop-host）的重启流程

44.x 桌面与旧版一样是"Electron 主进程 + 独立宿主子进程"，但监督行为完全不同：

- 宿主（Cordis host，`dsh-desktop-host`）以 **Node 模式**（`ELECTRON_RUN_AS_NODE=1`）跑在
  Electron 主进程之下，插件就在这个宿主进程里；`process.ppid` 即 Electron 主进程；
- 宿主**意外退出时主进程不会自动重启**，而是弹出「退出 / 重启 / 禁用第三方插件」的
  致命错误对话框，一直等用户点击——只等它自己退出永远等不到；
- 中间版（v2）的 `ctx.desktopRuntime` 在这一代**已不存在**，`DSH_DESKTOP=1` 也不再设置
  ——这就是插件在 44.x 下按钮失效的根因；
- 所以本代重启流程（`revive.mjs` 三参数模式）：
  1. 插件先脱离地拉起 `revive.mjs <hostPid> <shellPid> <exePath>`；
  2. 插件请求宿主优雅退出（`ctx.appExit` → 树 dispose、存储落盘，3 秒兜底强退）；
  3. `revive.mjs` 等宿主退出后，立即 **`taskkill /T /F` 强杀**卡在错误对话框上的主进程
     整棵树（此刻宿主已死、复活进程已脱离父链，树杀不会误伤自己）；
  4. 确认死透后重新拉起应用（`process.execPath` 即应用 exe，去掉 `ELECTRON_RUN_AS_NODE`
     启动它就是 GUI）；新实例 5 秒内退出则退避重试（最多 5 次）。
- 若宿主 dispose 卡死超 8 秒：`revive.mjs` 只强杀宿主单个进程（不带 `/T`——此时复活进程
  还是宿主的孩子，树杀会自杀），再走主进程强杀兜底。
- 代价：重启途中主进程可能**闪现一次**致命错误对话框，并写一份崩溃报告（logs 目录）——
  属预期、无害，忽略即可。

> 中间版桌面（dsh-plugin-desktop v2，宿主即 Electron 主进程）仍走 `requestRestart()`
> 原生 relaunch，不经过 revive.mjs——那时 `process.ppid` 不是应用本体，强杀会杀错进程。

两种桌面共用：`POST /dsh-revive` 路由、续跑标记（`~/.dsh/storages/dsh-restart-resume.json`）、
`agent/created` 自动注入"继续"。

### 边界与安全

- 仅在桌面托管下注册（三代识别条件见上表）；纯 CLI 宿主下按钮路由不存在。
- 新版识别要求 desktop profile 与 `dsh-desktop-host` 入口路径（argv）**同时**成立：
  从 CLI 手动跑 desktop profile 时后者不成立（此时 `ppid` 是用户终端，绝不能杀），
  插件保持 no-op。
- 路由为 loopback 的 `POST /dsh-revive`，只影响本机。
- 强杀只作用于用户主动请求重启的这一棵桌面进程树，不碰其他进程。

## 安装

```powershell
# 把插件目录放到你已有的 DSH 插件目录（~/.dsh/profiles/node_modules/ 下），然后运行：
.\install.ps1 -PluginSource "C:\path\to\dsh-restart"
# 不传参数时默认用脚本自身所在目录作为插件源
```

脚本会：
1. 在 `~/.dsh/profiles/node_modules/dsh-restart` 建 **Junction** 指向插件目录；
2. 在 profile 的 `cordis.patch.yml` 追加一个 `- insert:` 注册块
   （自动识别桌面 profile `~/.dsh/profiles/desktop/`，否则用旧版 `~/.dsh/profiles/web/`）；
3. 校验 `require.resolve` 可解析。

然后**完全退出 DSH 进程并重启**（这一次仍需手动，因为按钮本身要等插件加载后才出现）；
之后插件改动即可用头部「🔄 重启 DSH」按钮一键重启。

## 卸载

```powershell
Remove-Item "$env:DSH_HOME\profiles\node_modules\dsh-restart" -Force   # 删 Junction
# 手动删掉 cordis.patch.yml 里对应的 insert 块
```

## 工作原理（为什么不用改源码）

- 会话头部有一个 `conversation.session.header.actions`（list 槽，按 `order` 升序渲染）；
  本插件以 `id: dsh-revive, order: 90` 注册按钮。
- `client.js` 点击后 `fetch POST /dsh-revive`；`index.js` 在 `webServer` 上注册该路由：
  - **中间版桌面**（`ctx.desktopRuntime` 存在）：直接 `desktopRuntime.requestRestart()`；
  - **新版桌面**（desktop profile + argv 带 `dsh-desktop-host`）：spawn 三参数
    `revive.mjs`，随后 `ctx.appExit(0)` 优雅退出宿主（3 秒兜底强退）；
  - **旧版桌面**（`DSH_DESKTOP=1`）：spawn 二参数 `revive.mjs`，再请求宿主退出
    —— 宿主提供 `ctx.appExit` 则调用并 3 秒兜底强退；桌面 web 宿主不提供 `appExit`，
    直接 `process.exit(0)`（宿主退出 → 桌面监督器 `app.quit()` → 复活进程重新拉起应用）。
- 请求体带 `{ sessionId, text }` 且 agent 运行中时，先写"续跑标记"到
  `~/.dsh/storages/dsh-restart-resume.json`；重启后 `agent/created` 事件触发自动注入"继续"。

## 注意事项

- 一键重启会断开当前会话；若复活进程异常（极少数），应用可能只是关闭未自动重启，
  手动再开一次即可，不会损坏任何数据。
- 宿主半边只在应用启动时加载：**装好插件 / 改动 `index.js` 后，必须完全退出并重启一次
  桌面应用**，`/dsh-revive` 路由才存在。若只刷新了页面（图标已是新的）而宿主还是旧代码，
  点击会失败——此时图标会**变红 4 秒**提示，控制台有详情。
- 新版桌面上每次一键重启都会在应用日志目录留下一份"宿主停止"的崩溃报告，
  与重启时的错误对话框一样，属预期现象。
