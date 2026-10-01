// revive.mjs — "一键复活"的脱离进程（reviver）：等旧实例退出，不退就强杀，再拉起新实例。
//
// 由 index.js 以 detached 方式启动：宿主（Node/Electron-as-Node）退出后它继续存活，
// 负责把桌面应用"关掉并重新打开"。
//
// 两代用法（第 2/3 个参数区分）：
//   旧版桌面（2 参数）  node revive.mjs <desktopPid> <desktopExePath>
//     desktopPid 是桌面应用主进程：等它自然退出（宿主退出后监督器通常 app.quit()），
//     8 秒不退就 taskkill /T /F 强杀，确认死透后拉起新实例。
//
//   新版桌面（3 参数）  node revive.mjs <hostPid> <shellPid> <desktopExePath>
//     DSH Desktop 44.x（dsh-desktop-host）：宿主只是 Electron 主进程（shellPid）的
//     Node 子进程（hostPid）。宿主退出后主进程不会自动重启，而是弹出"退出/重启/
//     禁用插件"的致命错误对话框干等用户——所以流程是：先等宿主**优雅退出**
//     （等 Cordis 树 dispose 完、存储落盘），再立即强杀卡在对话框上的主进程整棵树，
//     最后拉起新实例。宿主已死时本进程已脱离其父链，强杀主进程树不会误伤自己。
//
// 为什么总需要强杀：两种桌面都存在"只等自然退出永远等不到"的情形
// （旧版是监督器不 app.quit() 的僵尸；新版是致命错误对话框在等用户点击）。
//
// 日志：{DSH_HOME|~/.dsh}/storages/dsh-restart-revive.log
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [, , waitPidRaw, killPidRaw, exeArg] = process.argv
const exePath = exeArg ?? killPidRaw
// 2 参数（旧版）：killPid = waitPid；3 参数（新版）：宿主 + 主进程分开。
const killPid = exeArg !== undefined ? Number(killPidRaw) : Number(waitPidRaw)
const waitPid = Number(waitPidRaw)
if (!Number.isInteger(waitPid) || waitPid <= 0
  || !Number.isInteger(killPid) || killPid <= 0
  || typeof exePath !== 'string' || exePath.length === 0) {
  process.exit(2)
}
const MODE = exeArg !== undefined ? 'desktop-host(v3)' : 'legacy'

const LOG_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-restart-revive.log')
function log(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志写不了不阻塞主流程 */
  }
}

const GRACE_EXIT_MS = 8_000     // 给宿主/旧实例自然退出的宽限
const KILL_CONFIRM_MS = 5_000   // 强杀后确认退出的最长时间
const SHELL_GRACE_MS = 600      // 新版：宿主死后给主进程的最后宽限（随后强杀，不让错误对话框久留）
const POST_EXIT_DELAY_MS = 1_500 // 旧实例确认退出后再等 1.5 秒才拉起
const SUCCESS_GRACE_MS = 5_000  // 新实例存活超过 5 秒才算成功
const RETRY_DELAYS_MS = [2_000, 3_000, 5_000, 8_000] // 锁竞争退避：2s/3s/5s/8s
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length      // 最多 5 次拉起尝试

log(`=== start === mode=${MODE} waitPid=${waitPid} killPid=${killPid} exe=${exePath} ownPid=${process.pid} ppid=${process.ppid} nodeEnv=${process.env.ELECTRON_RUN_AS_NODE}`)

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

/** taskkill 强杀进程；tree=true 时连子进程树一起杀。 */
function killProcess(pid, tree) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F']
    const child = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve())
    child.once('exit', () => resolve())
  })
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
  // 阶段 1：等宿主（waitPid）自然退出，让它把 Cordis 树 dispose 干净。
  // 超时不退（dispose 卡死等异常）才强杀：
  //   新版——宿主还活着，本进程仍是它的孩子，只能杀单个进程（不带 /T，
  //   否则 /T 树杀会连本进程一起杀掉、重启就永远完不成了）；
  //   旧版——宿主早已退出，本进程已脱离父链，waitPid 即桌面主进程，保持旧版的 /T 树杀。
  const hostExited = await waitUntil(() => !alive(waitPid), GRACE_EXIT_MS, 250)
  if (!hostExited) {
    const tree = MODE === 'legacy'
    log(`host (pid ${waitPid}) did not exit within ${GRACE_EXIT_MS}ms — force killing (tree=${tree})`)
    await killProcess(waitPid, tree)
    await waitUntil(() => !alive(waitPid), KILL_CONFIRM_MS, 200)
    log(`host (pid ${waitPid}) force-killed`)
  } else {
    log(`host (pid ${waitPid}) exited gracefully`)
  }

  // 阶段 2：处理旧实例本体（旧版与 waitPid 相同，此刻已死，直接跳过；
  // 新版是 Electron 主进程：宿主死后它弹致命错误对话框干等用户，短宽限后强杀整棵树。
  // 本进程的父（宿主）已死、父链已断，/T 树杀不会波及自己）。
  if (killPid !== waitPid) {
    if (alive(killPid)) {
      log(`shell (pid ${killPid}) still alive, waiting ${SHELL_GRACE_MS}ms then force killing its tree`)
      await new Promise((resolve) => setTimeout(resolve, SHELL_GRACE_MS))
      await killProcess(killPid, true)
      const shellGone = await waitUntil(() => !alive(killPid), KILL_CONFIRM_MS, 200)
      log(shellGone ? `shell (pid ${killPid}) force-killed and confirmed gone` : `shell (pid ${killPid}) may still linger after kill — proceeding anyway`)
    } else {
      log(`shell (pid ${killPid}) already exited on its own`)
    }
  }

  // 阶段 3：稍等后拉起新实例。
  log(`waiting ${POST_EXIT_DELAY_MS}ms then launching`)
  setTimeout(() => attemptLaunch(0), POST_EXIT_DELAY_MS)
})()
