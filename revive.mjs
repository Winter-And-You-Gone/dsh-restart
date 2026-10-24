// revive.mjs — "一键复活"的脱离进程（reviver）：配合宿主/主进程把桌面应用重启。
//
// 由 index.js 以 detached 方式启动：宿主（Node/Electron-as-Node）退出后它继续存活，
// 负责确认旧实例退场、见证新实例起来，兜底时才自己动手。
//
// 两代用法（killPid 是否等于 waitPid 区分）：
//   旧版桌面（killPid === waitPid）  node revive.mjs <desktopPid> <desktopPid> <desktopExePath>
//     desktopPid 是桌面应用主进程：等它自然退出（宿主退出后监督器通常 app.quit()），
//     8 秒不退就 taskkill /T /F 强杀（此时父链里的宿主已死，树杀不会误伤自己），
//     确认死透后拉起新实例。无窗口助手。
//
//   新版桌面（killPid !== waitPid）  node revive.mjs <hostPid> <shellPid> <desktopExePath>
//     DSH Desktop 44.x（dsh-desktop-host）：宿主只是 Electron 主进程（shellPid）的
//     Node 子进程（hostPid）。插件在退出前已向 shell 发了协议内的 fatal 消息（见
//     index.js），shell 会弹"退出/重启/禁用第三方插件"的致命恢复对话框并干等用户。
//     reviver 的工作是"替用户点一下 + 见证"：
//       1. 启动时立即预热一个 PowerShell「窗口助手」——趁编译 Add-Type 的间隙，
//         对话框一出现（~0.1–0.3 秒内）就能动手；
//       2. 助手按窗口标题（"DeepSeek Harness …"）+ 类 #32770 + 归属主进程 pid 识别
//          对话框，先 ShowWindow(SW_HIDE) 压掉闪窗，再发 TDM_CLICK_BUTTON 点
//          「重启应用」（defaultId=1）——shell 随即走自身优雅链：backend.close() →
//          向宿主发 shutdown IPC → 宿主 Cordis 树 dispose、存储落盘、回
//          shutdown-complete → app.relaunch() 原生拉起新实例；
//       3. 点「重启」不奏效才回退 WM_CLOSE（等价点「退出应用」→ shell 退出但不
//          relaunch），仍关不掉就 taskkill /T /F 强杀主进程整棵树（旧方案）；
//       4. 收尾：宿主与主进程都退场后，助手轮询"晚于死亡时刻启动"的同名新进程——
//          出现即 shell 原生 relaunch 成功，reviver 直接功成身退；超时未现（对话框
//          没出现/只点了退出/被强杀）才回退自行 tasklist 拉起 + 重试梯子。
//
// 为什么总需要兜底强杀：两种桌面都存在"只等自然退出永远等不到"的情形
// （旧版是监督器不 app.quit() 的僵尸；新版是恢复对话框在等用户点击）。
//
// 日志：{DSH_HOME|~/.dsh}/storages/dsh-restart-revive.log
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const [, , waitPidRaw, killPidRaw, exeArg] = process.argv
const exePath = exeArg ?? killPidRaw
// 旧版两参数调用已不存在（index.js 恒传三参数）；保留解析只为兼容手工调用。
const killPid = exeArg !== undefined ? Number(killPidRaw) : Number(waitPidRaw)
const waitPid = Number(waitPidRaw)
if (!Number.isInteger(waitPid) || waitPid <= 0
  || !Number.isInteger(killPid) || killPid <= 0
  || typeof exePath !== 'string' || exePath.length === 0) {
  process.exit(2)
}
// 新版（宿主 + 主进程分开）才有"对话框 + 见证 relaunch"一说；旧版两 pid 相同。
const MODE_V3 = killPid !== waitPid
// GetProcessesByName 要不带扩展名的映像名。
const EXE_NAME = basename(exePath).replace(/\.exe$/i, '')

const LOG_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-restart-revive.log')
function log(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志写不了不阻塞主流程 */
  }
}

const GRACE_EXIT_MS_LEGACY = 8_000 // 旧版：给桌面主进程自然退出的宽限
const GRACE_EXIT_MS_V3 = 12_000    // 新版：宿主在"点掉对话框（~3s）+ shutdown 后 dispose
                                   // （DSH 自身 5s 兜底强退）"后才退，8s 会误杀正在落盘的宿主
const KILL_CONFIRM_MS = 5_000   // 强杀后确认退出的最长时间
const POST_EXIT_DELAY_MS = 1_500 // 自行拉起前再等 1.5 秒（等锁释放/退场落定）
const SUCCESS_GRACE_MS = 5_000  // 自行拉起的新实例存活超过 5 秒才算成功
const RETRY_DELAYS_MS = [2_000, 3_000, 5_000, 8_000] // 锁竞争退避：2s/3s/5s/8s
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length      // 最多 5 次拉起尝试
const WATCHER_DIALOG_MS = 30_000 // 助手等恢复对话框出现的窗口（覆盖 fatal 弹窗与兜底路径）
const WATCHER_EXIT_WAIT_MS = 32_000 // 助手等"宿主+主进程都退场"的上限（12s 宽限 + 5s 强杀 + 12s 退出）
const DIALOG_DESTROY_MS = 5_000  // 点「重启」后等对话框销毁的时间
const RELAUNCH_SETTLE_MS = 2_000 // 主进程退场后先等旧实例残留子进程退场
const RELAUNCH_DETECT_MS = 12_000 // 之后轮询新实例出现的窗口
const QUIT_WAIT_MS = 12_000     // 对话框被处理后等主进程自行退出的上限
const HANDLED_RACE_MS = 15_000  // 等"对话框已处理"结论的竞速上限（覆盖 fatal 弹窗与兜底路径）
const RELAUNCH_RACE_MS = 6_000  // 等见证 relaunch 的竞速上限——原生 relaunch 在主进程死后 ~1-3s 出现；
                                // 超时说明不会有了（只点了退出/被强杀），转自行拉起，别跟 watcher 死等

log(`=== start === mode=${MODE_V3 ? 'desktop-host(v3)' : 'legacy'} waitPid=${waitPid} killPid=${killPid} exe=${exePath} ownPid=${process.pid} ppid=${process.ppid} nodeEnv=${process.env.ELECTRON_RUN_AS_NODE}`)

function alive(pid) {
  try {
    process.kill(pid, 0) // 信号 0 = 仅探测进程是否存在
    return true
  } catch {
    return false
  }
}

/** 轮询等待条件成立或超时。 */
function waitUntil(cond, timeoutMs, pollMs = 200) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    ;(function tick() {
      if (cond()) return resolve(true)
      if (Date.now() - t0 >= timeoutMs) return resolve(false)
      setTimeout(tick, pollMs)
    })()
  })
}

/** promise 的超时竞速：超时后以 fallback 兑现（原 promise 继续在后台跑）。 */
function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => { const t = setTimeout(() => resolve(fallback), timeoutMs); t.unref?.() }),
  ])
}

/** taskkill 强杀进程；tree=true 时连子进程树一起杀。 */
function killProcess(pid, tree) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F']
    const child = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve())
    child.once('exit', () => resolve())
  })
}

// PowerShell「窗口助手」（仅新版）：识别并把主进程的致命恢复对话框"点掉"，随后
// 见证 shell 的原生 relaunch。识别条件：归属主进程 pid、Win32 对话框类 #32770、
// 可见、标题以应用名开头（zh: "DeepSeek Harness 无法使用" / en: "DeepSeek Harness
// is unavailable"）。处理顺序：SW_HIDE 压掉闪窗 → SendMessageTimeout(TDM_CLICK_BUTTON,
// 按钮 id 1 =「重启应用」，Electron showMessageBox 的按钮 id 即其在 buttons 数组的
// 下标) → 等 IsWindow 销毁；不奏效回退 WM_CLOSE（Electron 按 cancelId=0 处理，即
// 「退出应用」→ shell 走 backend.close() 后退出但不 relaunch）。之后等宿主与主进程
// 都退场，轮询"晚于死亡时刻启动"的同名新进程作为 relaunch 成功的判据——StartTime
// 过滤保证旧实例的残留子进程不会被误认。
// 注意：脚本里不能出现 "${" 序列（JS 模板字面量会插值），占位符用 __NAME__ 替换。
const DIALOG_WATCHER_PS = `
$watch = __WATCH_PID__
$shell = __SHELL_PID__
$self = __SELF_PID__
$dlgWait = __DIALOG_MS__
$exeName = __EXE_NAME__
$titlePrefix = 'DeepSeek Harness'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace DsrRevive {
  public static class Native {
    private delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
    public static List<IntPtr> DialogsOf(uint pid) {
      List<IntPtr> found = new List<IntPtr>();
      EnumWindows(delegate(IntPtr h, IntPtr l) {
        uint owner;
        GetWindowThreadProcessId(h, out owner);
        if (owner == pid) {
          StringBuilder sb = new StringBuilder(64);
          GetClassName(h, sb, 64);
          if (sb.ToString() == "#32770" && IsWindowVisible(h)) found.Add(h);
        }
        return true;
      }, IntPtr.Zero);
      return found;
    }
    public static string TitleOf(IntPtr h) {
      StringBuilder sb = new StringBuilder(128);
      GetWindowText(h, sb, 128);
      return sb.ToString();
    }
  }
}
'@
Write-Output 'ready'

# 阶段 A：等致命恢复对话框出现（标题以应用名开头，防误点其它对话框）。
$deadline = [Environment]::TickCount + $dlgWait
$target = [IntPtr]::Zero
while ($true) {
  if ([Environment]::TickCount -ge $deadline) { break }
  foreach ($d in [DsrRevive.Native]::DialogsOf([uint32]$shell)) {
    $title = [DsrRevive.Native]::TitleOf($d)
    if ($title.StartsWith($titlePrefix)) { $target = $d; Write-Output ('dialog-found:' + $title); break }
  }
  if ($target -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 20
}
if ($target -eq [IntPtr]::Zero) { Write-Output 'none-found'; exit 1 }

# 阶段 B：隐藏闪窗 + 点「重启应用」（TDM_CLICK_BUTTON = WM_USER+102，按钮 id 即下标）。
$null = [DsrRevive.Native]::ShowWindow($target, 0)
$clickResult = [UIntPtr]::Zero
$null = [DsrRevive.Native]::SendMessageTimeout($target, 1126, [IntPtr]1, [IntPtr]0, 2, 2000, [ref]$clickResult)
$deadline = [Environment]::TickCount + __DESTROY_MS__
while ([DsrRevive.Native]::IsWindow($target) -and [Environment]::TickCount -lt $deadline) { Start-Sleep -Milliseconds 20 }
if (-not [DsrRevive.Native]::IsWindow($target)) {
  Write-Output 'handled'
} else {
  # 回退 WM_CLOSE：等价点「退出应用」——shell 会退出但不会自己 relaunch。
  for ($round = 0; $round -lt 3; $round++) {
    if (-not [DsrRevive.Native]::IsWindow($target)) { break }
    $null = [DsrRevive.Native]::PostMessage($target, 16, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 600
  }
  if ([DsrRevive.Native]::IsWindow($target)) { Write-Output 'close-failed'; exit 1 }
  Write-Output 'handled-by-close'
}

# 阶段 C：见证 relaunch——等宿主与主进程都退场，再找"晚于死亡时刻启动"的同名新进程。
$deadline = [Environment]::TickCount + __EXIT_WAIT_MS__
while ($true) {
  $hostGone = -not (Get-Process -Id $watch -ErrorAction SilentlyContinue)
  $shellGone = -not (Get-Process -Id $shell -ErrorAction SilentlyContinue)
  if ($hostGone -and $shellGone) { break }
  if ([Environment]::TickCount -ge $deadline) { Write-Output 'no-relaunch'; exit 1 }
  Start-Sleep -Milliseconds 100
}
$tDead = [DateTime]::Now
Start-Sleep -Milliseconds __SETTLE_MS__
$deadline = [Environment]::TickCount + __DETECT_MS__
while ($true) {
  $fresh = [System.Diagnostics.Process]::GetProcessesByName($exeName) |
    Where-Object { try { $_.Id -ne $self -and $_.StartTime -ge $tDead.AddSeconds(-2) } catch { $false } }
  if ($fresh) { Write-Output 'relaunched'; exit 0 }
  if ([Environment]::TickCount -ge $deadline) { Write-Output 'no-relaunch'; exit 1 }
  Start-Sleep -Milliseconds 500
}
`

/** 启动窗口助手（仅新版 v3）。要在任何等待之前启动：趁编译 Add-Type 与轮询的间隙
 *  完成预热，对话框一冒头就能零延迟处理。返回两个 promise 和一个停止句柄：
 *  - handled：对话框是否已被处理（found）——reviver 阶段 2 用来决定"等 shell 自退还是强杀"；
 *  - done：最终结论（relaunched）——reviver 阶段 3 用来决定"功成身退还是自行拉起"。
 *    done 在脚本退出或给出结论时才兑现（relaunch 判定晚于对话框处理数秒）。 */
function startDialogWatcher(watchPid, shellPid, selfPid, exeName) {
  const script = DIALOG_WATCHER_PS
    .replace('__WATCH_PID__', String(watchPid))
    .replace('__SHELL_PID__', String(shellPid))
    .replace('__SELF_PID__', String(selfPid))
    .replace('__DIALOG_MS__', String(WATCHER_DIALOG_MS))
    .replace('__DESTROY_MS__', String(DIALOG_DESTROY_MS))
    .replace('__EXIT_WAIT_MS__', String(WATCHER_EXIT_WAIT_MS))
    .replace('__SETTLE_MS__', String(RELAUNCH_SETTLE_MS))
    .replace('__DETECT_MS__', String(RELAUNCH_DETECT_MS))
    .replace('__EXE_NAME__', `'${exeName.replaceAll("'", "''")}'`)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const t0 = Date.now()
  let out = ''
  let relaunched = false
  let handledSettled = false
  let finished = false
  const state = {}
  const handled = new Promise((resolve) => { state.settleHandled = (found, note) => { if (!handledSettled) { handledSettled = true; resolve({ found, detail: note }) } } })
  const done = new Promise((resolve) => { state.settleDone = () => { if (!finished) { finished = true; resolve({ relaunched, detail: `ps in ${String(Date.now() - t0)}ms: ${out.trim()}` }) } } })
  const finish = () => { state.settleHandled?.(false, 'watcher ended'); state.settleDone?.() }
  let child
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch (error) {
    out = `spawn failed: ${String(error)} | `
    finish()
    return { handled, done, stop() {} }
  }
  child.stdout?.setEncoding('utf8')
  let lineBuf = ''
  child.stdout?.on('data', (chunk) => {
    lineBuf += chunk
    let index
    while ((index = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, index).trim()
      lineBuf = lineBuf.slice(index + 1)
      if (line === '') continue
      out = (out + line + ' | ').slice(-1024)
      if (line === 'handled' || line === 'handled-by-close') state.settleHandled?.(true, line)
      else if (line === 'none-found' || line === 'close-failed') state.settleHandled?.(false, line)
      else if (line === 'relaunched') { relaunched = true; state.settleDone?.() }
      else if (line === 'no-relaunch') state.settleDone?.()
    }
  })
  child.once('error', (error) => { out = (out + `err:${String(error)} | `).slice(-1024); finish() })
  child.once('exit', (code) => { out = (out + `exit=${String(code)} | `).slice(-1024); finish() })
  return {
    handled,
    done,
    stop() { try { child.kill() } catch {} },
  }
}

function launch() {
  // 重启的是桌面应用本体（Electron），绝不能带上 ELECTRON_RUN_AS_NODE
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', env, windowsHide: false })
    child.unref()
    log(`launch ok childPid=${child.pid}`)
    return child
  } catch (error) {
    log(`launch ERROR ${String(error)}`)
    return null
  }
}

function scheduleRetryOrGiveUp(failedAttemptIndex) {
  if (failedAttemptIndex + 1 >= MAX_ATTEMPTS) {
    log(`give up after ${failedAttemptIndex + 1} attempts`)
    process.exit(4)
  }
  const delay = RETRY_DELAYS_MS[failedAttemptIndex]
  log(`retry ${failedAttemptIndex + 1} -> attempt ${failedAttemptIndex + 1} after ${delay}ms`)
  setTimeout(() => attemptLaunch(failedAttemptIndex + 1), delay)
}

function attemptLaunch(attemptIndex) {
  log(`attempt ${attemptIndex} begin`)
  const child = launch()
  if (!child) {
    scheduleRetryOrGiveUp(attemptIndex)
    return
  }
  const spawnedPid = child.pid
  let settled = false
  const fail = (reason) => {
    if (settled) return
    settled = true
    log(`attempt ${attemptIndex} FAIL (${reason}) childPid=${spawnedPid}`)
    scheduleRetryOrGiveUp(attemptIndex)
  }
  const succeed = () => {
    if (settled) return
    settled = true
    log(`attempt ${attemptIndex} SUCCESS (survived ${SUCCESS_GRACE_MS}ms) childPid=${spawnedPid}`)
    process.exit(0)
  }

  child.once('error', (error) => fail(`error ${String(error)}`))
  child.once('exit', (code, signal) => fail(`exit code=${code} signal=${signal}`))
  setTimeout(succeed, SUCCESS_GRACE_MS)
}

;(async () => {
  // 窗口助手要在任何等待之前启动（预热编译 + 轮询就位），仅新版模式需要。
  const watcher = MODE_V3 ? startDialogWatcher(waitPid, killPid, process.pid, EXE_NAME) : null

  // 阶段 1：等宿主（waitPid）自然退出。
  //   新版——插件已发 fatal，shell 点掉对话框后会走 backend.close() 停掉宿主，
  //   宿主 dispose 完自然退；超时不退（dispose 卡死等异常）才强杀宿主单个进程
  //   （不带 /T，否则树杀会沿父链连本进程和窗口助手一起杀掉）。
  //   旧版——waitPid 即桌面主进程，reviver 的父链里宿主早已退出，/T 树杀安全。
  const hostGraceMs = MODE_V3 ? GRACE_EXIT_MS_V3 : GRACE_EXIT_MS_LEGACY
  const hostExited = await waitUntil(() => !alive(waitPid), hostGraceMs, 250)
  if (!hostExited) {
    const tree = !MODE_V3
    log(`host (pid ${waitPid}) did not exit within ${hostGraceMs}ms — force killing (tree=${tree})`)
    await killProcess(waitPid, tree)
    await waitUntil(() => !alive(waitPid), KILL_CONFIRM_MS, 200)
    log(`host (pid ${waitPid}) force-killed`)
  } else {
    log(`host (pid ${waitPid}) exited gracefully`)
  }

  // 阶段 2：主进程收尾（旧版与 waitPid 相同、此刻已死，直接跳过）。
  //   优先"礼"——对话框已被助手处理（点「重启应用」/回退「退出应用」），给 shell
  //   自行退出（含 relaunch）的宽限；助手没碰到对话框才"兵"——taskkill /T /F 强杀。
  if (MODE_V3) {
    if (!alive(killPid)) {
      log(`shell (pid ${killPid}) already exited on its own`)
    } else {
      const handled = await withTimeout(watcher.handled, HANDLED_RACE_MS, { found: false, detail: 'handled race timeout' })
      if (handled.found) {
        log(`recovery dialog of shell (pid ${killPid}) handled [${handled.detail}] — waiting for shell to finish`)
        const quit = await waitUntil(() => !alive(killPid), QUIT_WAIT_MS, 100)
        if (quit) {
          log(`shell (pid ${killPid}) exited on its own after dialog handling`)
        } else {
          log(`shell (pid ${killPid}) still alive ${QUIT_WAIT_MS}ms after dialog handling — force killing tree`)
          await killProcess(killPid, true)
          const gone = await waitUntil(() => !alive(killPid), KILL_CONFIRM_MS, 200)
          log(gone ? `shell (pid ${killPid}) force-killed and confirmed gone` : `shell (pid ${killPid}) may still linger after kill — proceeding anyway`)
        }
      } else {
        log(`no handled recovery dialog for shell (pid ${killPid}) [${handled.detail}] — force killing tree`)
        await killProcess(killPid, true)
        const gone = await waitUntil(() => !alive(killPid), KILL_CONFIRM_MS, 200)
        log(gone ? `shell (pid ${killPid}) force-killed and confirmed gone` : `shell (pid ${killPid}) may still linger after kill — proceeding anyway`)
      }
    }
  }

  // 阶段 3：见证或补位。
  //   新版——助手确认"晚于死亡时刻"的新实例（shell 的 app.relaunch 产物，死后 ~1-3s
  //   出现）即功成身退，不再自己拉起；竞速超时（只点了退出/被强杀/助手失能）才停掉
  //   助手、走旧方案补位自行拉起。
  if (MODE_V3) {
    const verdict = await withTimeout(watcher.done, RELAUNCH_RACE_MS, { relaunched: false, detail: 'done race timeout' })
    watcher.stop()
    if (verdict.relaunched) {
      log(`relaunched instance of ${EXE_NAME} witnessed [${verdict.detail}] — done`)
      process.exit(0)
    }
    log(`no relaunched instance witnessed [${verdict.detail}] — falling back to self launch`)
  }
  log(`waiting ${POST_EXIT_DELAY_MS}ms then launching`)
  setTimeout(() => attemptLaunch(0), POST_EXIT_DELAY_MS)
})().catch((error) => {
  log(`fatal error ${String(error?.stack ?? error)}`)
  process.exit(3)
})
