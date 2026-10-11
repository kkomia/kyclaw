/**
 * 「终端」工具的服务端：一个渲染端 id ↔ 一个真 PTY（node-pty + Git Bash）。
 *
 * 生命周期（与界面的约定）：
 *   - **进入 tab 才起**（渲染端懒启动）；**切走/面板收起都不杀**（进程活着，回来还有上下文）；
 *   - 渲染端重新加载 / 窗口销毁 → 按 owner（webContents id）把它的终端全杀掉，不留孤儿；
 *   - **应用退出（will-quit）→ disposeAll**，一个不漏；
 *   - 重启按钮 = dispose + start 一个新 id（旧进程一定被杀）。
 *
 * node-pty 是原生模块（N-API 预编译件，见报告里的 ABI 结论）：这里**动态 import** 并缓存结果 ——
 * 加载不了（缺件 / ABI 不对）只让「终端」这一个 tab 报一句人话，不拦住应用启动。
 *
 * shell 走 `main/git-bash.ts` 的探测链（与 bash 工具同口径，`KYCLAW_GIT_BASH` 可覆盖），
 * 参数用 `--login -i`：/etc/profile 会配好 PS1 与 MSYS 的 PATH，与用户双击 Git Bash 的观感一致
 * （启动多 ~0.5s，对交互式终端是值得的）。cwd = 会话根（主进程解析，渲染端传不了任意路径）。
 */
import { GIT_BASH_MISSING, gitBashPath } from './git-bash'
import type { IPty } from 'node-pty'
import type { TerminalSession } from '../shared/workbench'

/** 输出与结束的回调（IPC 层把它接成推到渲染端的消息） */
export interface TerminalSink {
  data(id: string, chunk: string): void
  exit(id: string, exitCode: number | null): void
}

export interface TerminalServiceOptions {
  sink: TerminalSink
  /** shell 解析（缺省 Git Bash 探测链；测试注入假件） */
  resolveShell?: () => string | null
  /** node-pty 的加载（缺省真 require；测试注入假件） */
  loadPty?: () => Promise<typeof import('node-pty')>
  /** 环境变量（缺省 process.env + TERM/LANG 兜底） */
  env?: NodeJS.ProcessEnv
}

export interface TerminalService {
  /** 起一个终端（`owner` = 发起它的 webContents id，用于 reload/销毁时清算） */
  start(
    id: string,
    owner: number,
    cwd: string,
    cols: number,
    rows: number
  ): Promise<TerminalSession>
  /** 写输入；id 不认识就是空操作（渲染端的写可能晚于 kill 到达） */
  write(id: string, data: string): void
  /** 同步尺寸（FitAddon 算出来的 cols/rows） */
  resize(id: string, cols: number, rows: number): void
  /** 关掉一个终端（幂等） */
  dispose(id: string): void
  /** 关掉某个渲染端起的所有终端（reload / 窗口销毁） */
  disposeByOwner(owner: number): void
  /** 关掉全部（应用退出） */
  disposeAll(): void
  /** 当前活着的 id（排障与测试用） */
  ids(): string[]
}

/** 加载 node-pty：失败的结果也缓存（不每次重试一个必失败的 require） */
let ptyModule: typeof import('node-pty') | null = null
let ptyError: unknown = null

async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (ptyModule !== null) return ptyModule
  if (ptyError !== null) throw ptyError
  try {
    ptyModule = await import('node-pty')
    return ptyModule
  } catch (cause) {
    ptyError = cause
    throw cause
  }
}

/** 终端进程的环境：LANG/LC_ALL 都没设时补 C.UTF-8（MSYS 输出保持 UTF-8） */
function terminalEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: 'xterm-256color' }
  if (env.LANG === undefined && env.LC_ALL === undefined) env.LANG = 'C.UTF-8'
  return env
}

export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  const resolveShell = options.resolveShell ?? gitBashPath
  const loadPty = options.loadPty ?? loadNodePty
  const env = terminalEnv(options.env ?? process.env)
  const sessions = new Map<string, { term: IPty; owner: number }>()

  const kill = (id: string): void => {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    try {
      session.term.kill()
    } catch {
      // 已经退出的终端再 kill 会抛：dispose 是幂等动作，这里吞掉
    }
  }

  return {
    start: async (id, owner, cwd, cols, rows) => {
      const shell = resolveShell()
      if (shell === null) throw new Error(GIT_BASH_MISSING)
      // 同一个 id 重启：先把老的杀掉，免得两条进程共用一个 id
      kill(id)

      const pty = await loadPty().catch((cause: unknown) => {
        // 加载不了原生模块（缺件 / ABI 不对）只让「终端」这一个 tab 报一句人话
        const detail = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`终端组件加载失败（node-pty）：${detail}`)
      })
      const term = pty.spawn(shell, ['--login', '-i'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env
      })

      sessions.set(id, { term, owner })
      term.onData((chunk) => {
        // 已被 dispose 的会话不再往渲染端推（老进程的迟到输出不该画到新终端上）
        if (sessions.get(id)?.term === term) options.sink.data(id, chunk)
      })
      term.onExit(({ exitCode }) => {
        if (sessions.get(id)?.term === term) sessions.delete(id)
        options.sink.exit(id, exitCode ?? null)
      })

      return { id, shell, cwd }
    },

    write: (id, data) => {
      try {
        sessions.get(id)?.term.write(data)
      } catch {
        // 写一个刚退出的终端会抛：忽略（渲染端本来就可能晚一步）
      }
    },

    resize: (id, cols, rows) => {
      try {
        sessions.get(id)?.term.resize(cols, rows)
      } catch {
        // 已退出 / 尺寸非法：忽略
      }
    },

    dispose: (id) => {
      kill(id)
    },

    disposeByOwner: (owner) => {
      for (const [id, session] of [...sessions]) {
        if (session.owner === owner) kill(id)
      }
    },

    disposeAll: () => {
      for (const id of [...sessions.keys()]) kill(id)
    },

    ids: () => [...sessions.keys()]
  }
}
