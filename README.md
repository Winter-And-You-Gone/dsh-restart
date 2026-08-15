# dsh-restart

DeepSeek Harness（DSH）**纯插件**：会话头部加「🔄 重启 DSH」按钮，让整个桌面应用一键重启；
若重启时当前回合仍在运行，重启后自动"继续"接着跑。

**不修改任何 `@deepseek-ai/dsh-*` 源码。**

## 功能：一键重启 DSH（🔄 重启 DSH）+ 条件自动续跑

会话头部有一个「🔄 重启 DSH」按钮：
1. **第一次点击**进入「确认重启？」（3 秒不点自动复位，防误触）；
2. **再点一次**执行：
   - 若**当前会话的 agent 正在运行（回合未结束）**，写入"续跑标记"（重启后自动发"继续"）；
     若 agent 已停止，则只重启、不续跑；
   - host 脱离地拉起「复活进程」，随后请求宿主退出：宿主提供 `ctx.appExit` 时调用它
     （3 秒兜底 `process.exit(0)`）；桌面 web 宿主不提供 `appExit`，直接 `process.exit(0)`
     —— 无论如何保证宿主必退；
3. 桌面应用随之整体退出，复活进程**确认旧实例退出（8 秒宽限，不退就 `taskkill /F` 强杀）**，
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

### 为什么需要"复活进程 + 强杀"

桌面应用（Electron）对 host 只有监督、没有自动复活：host 一退出，桌面主进程理应
`app.quit()`——但实测**经常不退出**（变成无子进程的僵尸一直挂着），导致只等它自然退出
永远等不到。所以：
1. `index.js` 先 `spawn` 出 `revive.mjs`（detached，宿主退出后仍存活）；
2. `revive.mjs` 给旧实例 **8 秒宽限**自然退出，不退就 **`taskkill /T /F` 强杀**并确认死透；
3. 再拉起桌面可执行文件；新实例 5 秒内退出则按 2s/3s/5s/8s 退避重试（最多 5 次）。

全程日志：`~/.dsh/storages/dsh-restart-revive.log`。

### 边界与安全

- 仅在桌面托管下注册（`DSH_DESKTOP=1`）；纯 CLI 宿主下按钮路由不存在。
- 路由为 loopback 的 `POST /dsh-revive`，只影响本机。
- 强杀只作用于用户主动请求重启的旧实例，不碰其他进程。

## 安装

```powershell
# 把插件目录放到你已有的 DSH 插件目录（~/.dsh/profiles/node_modules/ 下），然后运行：
.\install.ps1 -PluginSource "C:\path\to\dsh-restart"
# 不传参数时默认用脚本自身所在目录作为插件源
```

脚本会：
1. 在 `~/.dsh/profiles/node_modules/dsh-restart` 建 **Junction** 指向插件目录；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加一个 `- insert:` 注册块；
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
  先 `spawn` detached 的 `revive.mjs`，再请求宿主退出 —— 宿主提供 `ctx.appExit`
  （CLI/headless 宿主）则调用并 3 秒兜底强退；**桌面 web 宿主不提供 `appExit`，
  直接 `process.exit(0)`**（宿主退出 → 桌面监督器 `app.quit()` → 复活进程重新拉起应用）。
- 请求体带 `{ sessionId, text }` 且 agent 运行中时，先写"续跑标记"到
  `~/.dsh/storages/dsh-restart-resume.json`；重启后 `agent/created` 事件触发自动注入"继续"。

## 注意事项

- 一键重启会断开当前会话；若复活进程异常（极少数），应用可能只是关闭未自动重启，
  手动再开一次即可，不会损坏任何数据。
