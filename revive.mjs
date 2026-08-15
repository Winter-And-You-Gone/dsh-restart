// revive.mjs — "一键复活"的脱离进程（reviver）：等旧实例退出，不退就强杀，再拉起新实例。
//
// 由 index.js 以 detached 方式启动：宿主（Node/Electron-as-Node）退出后它继续存活，
// 负责把桌面应用"关掉并重新打开"。
//
// 为什么需要强杀：桌面主进程在宿主退出后经常不 app.quit()（会变成无子进程的僵尸
// 一直挂着）。只等它自然退出会永远等不到，所以给 8 秒宽限，不退就 taskkill /F 强杀，
// 确认死透后再拉起新实例，避免两个实例并存。
//
// 用法：node revive.mjs <desktopPid> <desktopExePath>
//
// 日志：{DSH_HOME|~/.dsh}/storages/dsh-restart-revive.log
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [, , pidToWaitRaw, exePath] = process.argv
const pidToWait = Number(pidToWaitRaw)
if (!Number.isInteger(pidToWait) || pidToWait <= 0 || typeof exePath !== 'string' || exePath.length === 0) {
  process.exit(2)
}

const LOG_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-restart-revive.log')
function log(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志写不了不阻塞主流程 */
  }
}

const GRACE_EXIT_MS = 8_000     // 给旧实例自然退出的宽限
const KILL_CONFIRM_MS = 5_000   // 强杀后确认退出的最长时间
const POST_EXIT_DELAY_MS = 1_500 // 旧实例确认退出后再等 1.5 秒才拉起
const SUCCESS_GRACE_MS = 5_000  // 新实例存活超过 5 秒才算成功
const RETRY_DELAYS_MS = [2_000, 3_000, 5_000, 8_000] // 锁竞争退避：2s/3s/5s/8s
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length      // 最多 5 次拉起尝试

log(`=== start === pidToWait=${pidToWait} exe=${exePath} ownPid=${process.pid} ppid=${process.ppid} nodeEnv=${process.env.ELECTRON_RUN_AS_NODE}`)

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

/** taskkill /T /F 强杀旧实例整棵进程树。 */
function killTree(pid) {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
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
  // 阶段 1：给旧实例 GRACE_EXIT_MS 宽限自然退出；不退就强杀。
  const exited = await waitUntil(() => !alive(pidToWait), GRACE_EXIT_MS, 250)
  if (!exited) {
    log(`old instance (pid ${pidToWait}) did not exit within ${GRACE_EXIT_MS}ms — force killing`)
    await killTree(pidToWait)
    const confirmed = await waitUntil(() => !alive(pidToWait), KILL_CONFIRM_MS, 200)
    log(confirmed ? `old instance (pid ${pidToWait}) force-killed and confirmed gone` : `old instance (pid ${pidToWait}) may still linger after kill — proceeding anyway`)
  } else {
    log(`old instance (pid ${pidToWait}) exited gracefully`)
  }

  // 阶段 2：稍等后拉起新实例。
  log(`waiting ${POST_EXIT_DELAY_MS}ms then launching`)
  setTimeout(() => attemptLaunch(0), POST_EXIT_DELAY_MS)
})()
