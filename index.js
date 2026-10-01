// dsh-restart: DeepSeek Harness 插件（宿主半边）。
//
// 一键复活 + 自动续跑：桌面托管下注册 POST /dsh-revive，兼容三代桌面宿主：
//   - 旧版桌面（DSH_DESKTOP=1，宿主是独立进程）：脱离地拉起 revive.mjs
//     （等桌面主进程退出，不退则强杀，再重新拉起应用），随后请求宿主退出；
//   - 中间版桌面（dsh-plugin-desktop v2，宿主即 Electron 主进程，提供
//     ctx.desktopRuntime）：直接用宿主自带的 desktopRuntime.requestRestart()
//     原生 relaunch——绝不能用 revive.mjs：此时 process.ppid 不是应用本体，
//     taskkill 会杀错进程；
//   - 新版桌面（DSH Desktop 44.x / dsh-desktop-host，desktopRuntime 已不存在）：
//     宿主降级回"Electron 主进程的 Node 子进程"（ELECTRON_RUN_AS_NODE=1，desktop
//     profile）。宿主意外退出时主进程不会自动重启，而是弹"退出/重启/禁用插件"
//     的致命错误对话框干等用户——所以重启旧版思路：先脱离地拉起 revive.mjs，
//     再让宿主优雅退出（Cordis 树 dispose、存储落盘），revive.mjs 等宿主死后
//     强杀卡在对话框上的主进程整棵树，最后重新拉起应用（process.execPath 即
//     应用 exe，不带 ELECTRON_RUN_AS_NODE 启动它就是 GUI）。
//     重启途中主进程可能闪现一次错误对话框并写一份崩溃报告，属预期、无害。
// 请求体可携带 { sessionId, text }：带 sessionId 且 agent 运行中时先写"续跑标记"
// （重启后自动向该会话发送 text，默认"继续"）。
// 自动续跑：监听 agent/created —— 被标记的会话一旦由 web 端以完整 setup 创建/恢复
// （重开该会话）即注入"继续"并清标记。
// 注意：绝不能在启动时自己 agents.resume —— 那会造出一个"半成品 agent"
// （缺 agent preset / 工具呈现 / 权限），导致该会话的模型工具大面积 UNKNOWN_TOOL。
import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-restart'

const REVIVE_PATH = '/dsh-revive'
const AUTO_CONTINUE_ENABLED = true
const MARKER_MAX_AGE_MS = 5 * 60 * 1000 // 标记 5 分钟内有效，防陈旧标记复活旧会话
const HOOK_INJECT_DELAY_MS = 50

function markerPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-restart-resume.json')
}

function reviveScriptPath() {
  return fileURLToPath(new URL('./revive.mjs', import.meta.url))
}

/** 启动脱离的复活进程：宿主退出后它仍存活，等待并重新拉起桌面应用。 */
function spawnReviver(waitPid, killPid, exePath) {
  const child = spawn(process.execPath, [reviveScriptPath(), String(waitPid), String(killPid), exePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env, // 继承 ELECTRON_RUN_AS_NODE=1 → 复活进程以 Node 运行
  })
  child.unref()
}

function continueMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text: typeof text === 'string' && text ? text : '继续' }],
    source: { kind: 'user' },
  })
}

async function writeMarker(sessionId, text) {
  const file = markerPath()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify({ sessionId, text, writtenAt: Date.now() }), 'utf8')
}

async function readMarker() {
  try {
    const raw = await readFile(markerPath(), 'utf8')
    const m = JSON.parse(raw)
    if (m && typeof m.sessionId === 'string' && m.sessionId.startsWith('session-')) {
      // 只在 5 分钟窗口内有效；过期（或缺失/异常的 writtenAt，视为陈旧）直接清掉，
      // 防陈旧标记复活旧会话。
      const ageMs = typeof m.writtenAt === 'number' ? Date.now() - m.writtenAt : Infinity
      if (ageMs >= 0 && ageMs <= MARKER_MAX_AGE_MS) return m
      await clearMarker()
    }
  } catch {
    /* 无标记或损坏：忽略 */
  }
  return null
}

async function clearMarker() {
  await unlink(markerPath()).catch(() => {})
}

async function injectContinue(agent, marker) {
  agent.followup(continueMessage(marker.text))
  await clearMarker()
}

export function apply(ctx) {
  // 桌面宿主识别，兼容三代：
  //   旧版：DSH_DESKTOP=1（独立宿主进程，无 desktopRuntime）；
  //   中间版：dsh-plugin-desktop v2 提供 ctx.desktopRuntime（宿主即 Electron 主进程）；
  //   新版（44.x）：宿主降级回 Electron 主进程的 Node 子进程，其 spawn 命令行里固定带有
  //   dsh-desktop-host 的入口路径——这是决定性特征（argv 在进程出生时就固定，不依赖
  //   任何 cordis 服务查找）。CLI（包括手动跑 desktop profile）的 argv 不会有它；
  //   有它的进程 ppid 必是 Electron 主进程。
  // 纯 CLI / 无桌面宿主时保持纯占位。
  const desktopRuntime = ctx.get('desktopRuntime')
  const legacyDesktop = process.env.DSH_DESKTOP === '1'
  const desktopHostChild = process.argv.some((arg) => String(arg).includes('dsh-desktop-host'))
  if (!legacyDesktop && !desktopRuntime && !desktopHostChild) return

  // ---- 一键复活路由 ----
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      return wctx.webServer.register({
        kind: 'exact',
        path: REVIVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          // 可选 body：{ sessionId, text } → 写续跑标记
          let body = {}
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const raw = Buffer.concat(chunks).toString('utf8')
            if (raw) body = JSON.parse(raw)
          } catch {
            body = {}
          }
          // 只有 agent 正在运行（回合未结束）才写"继续"标记；已停止则只重启、不自动续跑。
          let markerWritten = false
          if (body && typeof body.sessionId === 'string' && body.sessionId.startsWith('session-')) {
            const agents = ctx.get('agents')
            const agent = agents?.get(body.sessionId)
            const running = agent?.status === 'running'
            if (running) {
              try {
                await writeMarker(body.sessionId, typeof body.text === 'string' ? body.text : '继续')
                markerWritten = true
              } catch (error) {
                res.writeHead(500)
                res.end(String(error))
                return
              }
            }
          }

          if (desktopRuntime) {
            // ---- 中间版桌面：宿主即 Electron 主进程，用原生 relaunch ----
            // 由 dsh-plugin-desktop 的 launcher 完成 app.relaunch() + app.exit(0)，
            // 不需要、也不能再用 revive.mjs（旧方案针对的是"宿主是独立子进程"的旧桌面）。
            res.writeHead(200)
            res.end('ok')
            // 稍等让响应发出，再请求重启。
            setTimeout(() => {
              desktopRuntime.requestRestart().catch((error) => {
                console.error('[dsh-restart] requestRestart failed:', error)
                // 兜底：干净退出（不 relaunch），用户可手动再开一次。
                const exit = ctx.get('appExit')
                if (typeof exit === 'function') {
                  try { exit(0) } catch {}
                  setTimeout(() => process.exit(0), 3000)
                } else {
                  process.exit(0)
                }
              })
            }, 400)
            return
          }

          if (desktopHostChild) {
            // ---- 新版桌面（44.x / dsh-desktop-host）：宿主是 Electron 主进程的 Node 子进程 ----
            //  revive.mjs 的等待目标改为宿主自己（优雅退出、树 dispose），确认宿主死后
            //  立即强杀主进程（process.ppid）整棵树，再重新拉起应用（process.execPath）。
            const hostPid = process.pid
            const shellPid = process.ppid
            const exePath = process.execPath
            try {
              spawnReviver(hostPid, shellPid, exePath)
            } catch (error) {
              // 复活进程拉起失败 → 不重启；若本请求已写标记则清掉，
              // 避免孤儿标记日后误触发续跑。
              if (markerWritten) await clearMarker().catch(() => {})
              res.writeHead(500)
              res.end(String(error))
              return
            }
            res.writeHead(200)
            res.end('ok')
            // 稍等让响应发出，再优雅退出宿主：appExit 走 shutdown.shutdown(0)
            // （树 dispose，5 秒兜底强退）；进程仍可能被 IPC 管道挂住，3 秒后强制退出，
            // 保证宿主必死 —— revive.mjs 看到宿主死后会去强杀主进程并拉起新实例。
            setTimeout(() => {
              const exit = ctx.get('appExit')
              if (typeof exit === 'function') {
                try { exit(0) } catch {}
                setTimeout(() => process.exit(0), 3000)
              } else {
                process.exit(0)
              }
            }, 400)
            return
          }

          // ---- 旧版桌面（DSH_DESKTOP=1）：保留原"复活进程 + 强杀"方案 ----
          const desktopPid = process.ppid
          const exePath = process.execPath
          try {
            spawnReviver(desktopPid, desktopPid, exePath)
          } catch (error) {
            // 复活进程拉起失败 → 不重启；若本请求已写标记则清掉，
            // 避免孤儿标记日后误触发续跑。
            if (markerWritten) await clearMarker().catch(() => {})
            res.writeHead(500)
            res.end(String(error))
            return
          }
          res.writeHead(200)
          res.end('ok')
          // 稍等让响应发出，再请求退出。appExit 可能挂起（树销毁卡住），3 秒兜底强退，
          // 保证宿主必退 —— 桌面监督器看到宿主退出才会 app.quit()，复活进程才能拉起新实例。
          setTimeout(() => {
            const exit = ctx.get('appExit')
            if (typeof exit === 'function') {
              try { exit(0) } catch {}
              setTimeout(() => process.exit(0), 3000)
            } else {
              process.exit(0)
            }
          }, 400)
        },
      })
    })
  })

  if (!AUTO_CONTINUE_ENABLED) return

  // ---- 自动续跑 · agent/created 统一注入 ----
  ctx.on('agent/created', ({ agent }) => {
    readMarker()
      .then((marker) => {
        if (!marker || marker.sessionId !== agent.id) return
        // 等创建事务 unwind 后再注入，避免与驱动启动竞争
        setTimeout(() => {
          injectContinue(agent, marker).catch((error) => {
            console.error('[dsh-restart] auto-continue hook failed:', error)
          })
        }, HOOK_INJECT_DELAY_MS)
      })
      .catch(() => {})
  })
}
