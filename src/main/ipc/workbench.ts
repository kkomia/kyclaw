/**
 * workbench / terminal 两组通道的 handler（右侧边栏四项工具的服务端）。
 *
 * 共同纪律（与 workspace 通道同一套）：
 *   1. **会话根只在主进程解析**（`sessionRootForThread`，与文件工具、@ 清单同口径）；
 *      渲染端给 threadId + 相对路径，给不了任意绝对路径；
 *   2. 入参先过闸门（`parseIpcArgs`），非法即抛，不静默吞；
 *   3. 文件/Git 是读类动作（给人话错误）；终端是长会话（start/write/resize/dispose + 推送）。
 *
 * 终端的进程管理交给 `createTerminalService`（这里只负责：把 id 与发起它的 webContents 对上、
 * 把输出/退出推回去、渲染端重新加载或窗口销毁时按 owner 清算）。应用退出时的 disposeAll
 * 由调用方（main/index.ts）在 `will-quit` 里做。
 */
import { statSync } from 'node:fs'
import { ipcMain, shell, type WebContents } from 'electron'
import {
  IPC_CHANNELS,
  parseIpcArgs,
  terminalDisposeArgsSchema,
  terminalResizeArgsSchema,
  terminalStartArgsSchema,
  terminalWriteArgsSchema,
  workbenchGitLogArgsSchema,
  workbenchGitShowArgsSchema,
  workbenchRelativeArgsSchema,
  workbenchThreadArgsSchema
} from '../../shared/ipc'
import {
  WORKBENCH_NO_WORKSPACE,
  WORKBENCH_ROOT_NOT_UNIQUE,
  type FileBytesResult,
  type FilePreview,
  type GitCommit,
  type GitCommitDetail,
  type GitOverview,
  type ListDirResult,
  type TerminalSession
} from '../../shared/workbench'
import { settingsPath } from '../settings'
import { gitLog, gitOverview, gitShow, type GitRunner } from '../workbench-git'
import { listDir, readFileBytes, readFilePreview, revealTarget } from '../workbench-files'
import {
  createTerminalService,
  type TerminalService,
  type TerminalSink
} from '../workbench-terminal'
import { sessionRootForThread, type ProjectIdOf } from './workspace'

/** 会话根解析不出时给渲染端的人话（工作台四工具共用一句） */
const ROOT_MESSAGES = { empty: WORKBENCH_NO_WORKSPACE, multiple: WORKBENCH_ROOT_NOT_UNIQUE }

export interface WorkbenchDeps {
  /** threadId → 项目 id（与 workspace 通道同一个取值器） */
  projectIdOf?: ProjectIdOf
  /** 终端服务（缺省按真 node-pty 新建；测试注入假件） */
  terminals?: TerminalService
  /** git 命令的注入面（入参是仓库根；缺省真跑） */
  git?: (root: string) => GitRunner
}

export interface WorkbenchHandles {
  /** 应用退出时要 disposeAll 的那个服务（调用方持有） */
  terminals: TerminalService
}

/**
 * 终端输出/退出 → 发起它的 webContents（渲染端重新加载或窗口销毁后 senders 里就没有它了）。
 * 抽成函数是为了单测能直接打这条推送的形状（不用起真 PTY）。
 */
export function createTerminalSink(senders: Map<string, WebContents>): TerminalSink {
  return {
    data: (id, data) => {
      const target = senders.get(id)
      if (target !== undefined && !target.isDestroyed()) {
        target.send(IPC_CHANNELS.terminal.data, { id, data })
      }
    },
    exit: (id, exitCode) => {
      const target = senders.get(id)
      senders.delete(id)
      if (target !== undefined && !target.isDestroyed()) {
        target.send(IPC_CHANNELS.terminal.exit, { id, exitCode })
      }
    }
  }
}

export function registerWorkbenchIpc(
  userDataDir: string,
  deps: WorkbenchDeps = {}
): WorkbenchHandles {
  const file = settingsPath(userDataDir)
  const rootOf = (threadId: string): string =>
    sessionRootForThread(file, threadId, deps.projectIdOf, ROOT_MESSAGES)
  const gitOf = deps.git ?? (() => ({}))

  /** 终端 id → 发起它的 webContents（输出/退出据此推回去） */
  const senders = new Map<string, WebContents>()
  /** 已经挂过"销毁即清算"的 webContents id（重启终端不该重复挂监听） */
  const watched = new Set<number>()

  const terminals: TerminalService =
    deps.terminals ?? createTerminalService({ sink: createTerminalSink(senders) })

  ipcMain.handle(IPC_CHANNELS.workbench.listDir, (_event, ...args) => {
    const [threadId, relative] = parseIpcArgs(
      workbenchRelativeArgsSchema,
      args,
      IPC_CHANNELS.workbench.listDir
    )
    const result: ListDirResult = listDir(rootOf(threadId), relative)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.workbench.readFile, (_event, ...args) => {
    const [threadId, relative] = parseIpcArgs(
      workbenchRelativeArgsSchema,
      args,
      IPC_CHANNELS.workbench.readFile
    )
    const preview: FilePreview = readFilePreview(rootOf(threadId), relative)
    return preview
  })

  ipcMain.handle(IPC_CHANNELS.workbench.readBytes, async (_event, ...args) => {
    const [threadId, relative] = parseIpcArgs(
      workbenchRelativeArgsSchema,
      args,
      IPC_CHANNELS.workbench.readBytes
    )
    // 办公档（docx/xlsx/pptx）的解包是异步的，这条通道整体走 await
    const result: FileBytesResult = await readFileBytes(rootOf(threadId), relative)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.workbench.reveal, async (_event, ...args) => {
    const [threadId, relative] = parseIpcArgs(
      workbenchRelativeArgsSchema,
      args,
      IPC_CHANNELS.workbench.reveal
    )
    const target = revealTarget(rootOf(threadId), relative)
    if (statSync(target).isDirectory()) {
      const problem = await shell.openPath(target)
      if (problem !== '') throw new Error(`打不开这个文件夹：${problem}`)
    } else {
      shell.showItemInFolder(target)
    }
    return { path: target }
  })

  ipcMain.handle(IPC_CHANNELS.workbench.gitOverview, async (_event, ...args) => {
    const [threadId] = parseIpcArgs(
      workbenchThreadArgsSchema,
      args,
      IPC_CHANNELS.workbench.gitOverview
    )
    const root = rootOf(threadId)
    const overview: GitOverview = await gitOverview(root, gitOf(root))
    return overview
  })

  ipcMain.handle(IPC_CHANNELS.workbench.gitLog, async (_event, ...args) => {
    const [threadId, limit] = parseIpcArgs(
      workbenchGitLogArgsSchema,
      args,
      IPC_CHANNELS.workbench.gitLog
    )
    const root = rootOf(threadId)
    const commits: GitCommit[] = await gitLog(root, limit, gitOf(root))
    return { commits }
  })

  ipcMain.handle(IPC_CHANNELS.workbench.gitShow, async (_event, ...args) => {
    const [threadId, sha] = parseIpcArgs(
      workbenchGitShowArgsSchema,
      args,
      IPC_CHANNELS.workbench.gitShow
    )
    const root = rootOf(threadId)
    const detail: GitCommitDetail = await gitShow(root, sha, gitOf(root))
    return detail
  })

  ipcMain.handle(IPC_CHANNELS.terminal.start, async (event, ...args) => {
    const [threadId, cols, rows] = parseIpcArgs(
      terminalStartArgsSchema,
      args,
      IPC_CHANNELS.terminal.start
    )
    // id 由主进程发：同一个渲染端在同一毫秒里连开两个也不撞（自增尾巴）
    const id = `term-${event.sender.id}-${Date.now().toString(36)}-${(sessionsSeq += 1)}`
    const session: TerminalSession = await terminals.start(
      id,
      event.sender.id,
      rootOf(threadId),
      cols,
      rows
    )
    senders.set(id, event.sender)
    // 渲染端重新加载 / 窗口销毁：这个 sender 名下的终端全部清算（node-pty 不知道宿主没了）。
    // 每个 webContents 只挂一次（重启终端会再走这条 handler，重复挂会攒一堆监听）。
    if (!watched.has(event.sender.id)) {
      watched.add(event.sender.id)
      event.sender.once('destroyed', () => {
        watched.delete(event.sender.id)
        for (const [key, target] of [...senders]) {
          if (target.id === event.sender.id) senders.delete(key)
        }
        terminals.disposeByOwner(event.sender.id)
      })
    }
    return session
  })

  ipcMain.handle(IPC_CHANNELS.terminal.write, (_event, ...args) => {
    const [id, data] = parseIpcArgs(terminalWriteArgsSchema, args, IPC_CHANNELS.terminal.write)
    terminals.write(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.terminal.resize, (_event, ...args) => {
    const [id, cols, rows] = parseIpcArgs(
      terminalResizeArgsSchema,
      args,
      IPC_CHANNELS.terminal.resize
    )
    terminals.resize(id, cols, rows)
  })

  ipcMain.handle(IPC_CHANNELS.terminal.dispose, (_event, ...args) => {
    const [id] = parseIpcArgs(terminalDisposeArgsSchema, args, IPC_CHANNELS.terminal.dispose)
    senders.delete(id)
    terminals.dispose(id)
  })

  return { terminals }
}

/** 终端 id 的自增尾巴 */
let sessionsSeq = 0
