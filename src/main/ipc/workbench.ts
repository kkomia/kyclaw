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
  workbenchSearchArgsSchema,
  workbenchThreadArgsSchema
} from '../../shared/ipc'
import {
  officePreviewArgsSchema,
  officePreviewCancelArgsSchema,
  type OfficePreviewResult
} from '../../shared/office-preview'
import {
  textPageArgsSchema,
  textVersionArgsSchema,
  type TextPageResult,
  type TextVersionResult
} from '../../shared/workbench-text'
import { readTextPage, textVersionOf } from '../workbench-text'
import {
  WORKBENCH_NO_WORKSPACE,
  WORKBENCH_ROOT_NOT_UNIQUE,
  type FileBytesResult,
  type FilePreview,
  type GitCommit,
  type GitCommitDetail,
  type GitOverview,
  type ListDirResult,
  type TableBytesResult,
  type TerminalSession,
  type WorkbenchSearchResult
} from '../../shared/workbench'
import { settingsPath } from '../settings'
import { gitLog, gitOverview, gitShow, type GitRunner } from '../workbench-git'
import {
  assertOpenable,
  convertOfficeToPdf,
  listDir,
  readFileBytes,
  readFilePreview,
  readTableBytes,
  revealTarget,
  searchWorkspace
} from '../workbench-files'
import type { OfficePreview } from '../office-preview'
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
  /**
   * 办公档预览服务（缺省**懒建**真件：第一次真要转的时候才把引擎那坨加载进来）。
   * 测试注入一个带假引擎的实例，就能把"通道 → 授权 → 有界读 → 队列"整条路真跑过而不起进程。
   */
  officePreview?: OfficePreview
}

export interface WorkbenchHandles {
  /** 应用退出时要 disposeAll 的那个服务（调用方持有） */
  terminals: TerminalService
  /**
   * 收掉在途的办公档转换（kit 子进程不随主进程退出）。
   * **故意不返回 Promise**：取消是同步发起的（`runProcess` 用 unref 过的 `taskkill /T /F` 杀进程树，
   * 主进程退出后它自己跑完），等收尾记账只会拖住退出流程。懒建的服务没建过就是空操作。
   */
  disposeOfficePreview: () => void
}

/* ── 办公档预览的请求账（requestId ↔ 发起它的 webContents）──────────────── */

/** 一次请求的账目：给 handler 一个 signal，以及"还是我这条才摘账"的 release */
export interface OfficePreviewRequestHandle {
  readonly signal: AbortSignal
  release: () => void
}

/**
 * requestId 的账本。三条纪律：
 *   1. **取消只对本窗口有效**：`cancel(id, owner)` 在别人（另一个 webContents）手上是空操作 ——
 *      多窗口下不能让一个窗口把另一个窗口正在看的转换掐掉；
 *   2. **同名 id 不能跨窗口抢**：`begin` 撞上别人的 id 直接抛（这是"跑歪了"，不是常态）；
 *   3. **同一个窗口重发同一个 id = 新请求顶掉旧的**（旧的按取消收尾），
 *      所以"重发"本身就是一种取消，不用先 cancel 再 officePdf。
 *
 * 不依赖 electron：owner 就是一个数字（webContents.id），单测直接打这张表。
 */
export interface OfficePreviewRequests {
  begin(requestId: string, owner: number): OfficePreviewRequestHandle
  cancel(requestId: string, owner: number): void
  /** 这个窗口名下的请求全部取消（窗口销毁/重新加载时调） */
  disposeByOwner(owner: number): void
  /** 全部取消（应用退出时调） */
  disposeAll(): void
  /** 账上还有哪些 requestId（测试与排障） */
  ids(): string[]
}

export function createOfficePreviewRequests(): OfficePreviewRequests {
  const entries = new Map<string, { owner: number; controller: AbortController }>()
  const drop = (requestId: string, entry: { controller: AbortController }): void => {
    entries.delete(requestId)
    entry.controller.abort()
  }
  return {
    begin: (requestId, owner) => {
      const existing = entries.get(requestId)
      if (existing !== undefined) {
        if (existing.owner !== owner) {
          throw new Error(`这个 requestId 已被另一个窗口占用：${requestId}`)
        }
        drop(requestId, existing)
      }
      const controller = new AbortController()
      entries.set(requestId, { owner, controller })
      return {
        signal: controller.signal,
        release: () => {
          // 只有"账上还是我这条"才摘：否则会误摘同 id 的新请求
          if (entries.get(requestId)?.controller === controller) entries.delete(requestId)
        }
      }
    },
    cancel: (requestId, owner) => {
      const entry = entries.get(requestId)
      if (entry === undefined || entry.owner !== owner) return
      drop(requestId, entry)
    },
    disposeByOwner: (owner) => {
      for (const [requestId, entry] of [...entries]) {
        if (entry.owner === owner) drop(requestId, entry)
      }
    },
    disposeAll: () => {
      for (const [requestId, entry] of [...entries]) drop(requestId, entry)
    },
    ids: () => [...entries.keys()]
  }
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
  /** 办公档预览的请求账（requestId ↔ 发起它的 webContents） */
  const officeRequests = createOfficePreviewRequests()
  /** 懒建的办公档服务（真要用时才把引擎那坨加载进来；`null` = 还没建过） */
  let officePreview: OfficePreview | null = deps.officePreview ?? null

  const terminals: TerminalService =
    deps.terminals ?? createTerminalService({ sink: createTerminalSink(senders) })

  /**
   * 每个 webContents 只挂一次"销毁即清算"（渲染端重新加载 / 窗口关掉时）：终端（node-pty
   * 不知道宿主没了）与办公档转换（kit 子进程还在跑）共用这一条 —— 只收**它自己发起的**那些，
   * 别的窗口的照跑。
   */
  const watchSender = (sender: WebContents): void => {
    if (watched.has(sender.id)) return
    watched.add(sender.id)
    sender.once('destroyed', () => {
      watched.delete(sender.id)
      for (const [key, target] of [...senders]) {
        if (target.id === sender.id) senders.delete(key)
      }
      terminals.disposeByOwner(sender.id)
      officeRequests.disposeByOwner(sender.id)
    })
  }

  /** 办公档预览服务：第一次真要用时才 `import` 引擎那一坨（启动路径上不付这份代价） */
  const officePreviewOf = async (): Promise<OfficePreview> => {
    if (officePreview !== null) return officePreview
    const module = await import('../office-preview')
    // 等 import 的这段时间里，另一个请求可能已经建好了：先看它，再建
    const created = officePreview ?? deps.officePreview ?? module.createOfficePreview()
    officePreview = created
    return created
  }

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

  ipcMain.handle(IPC_CHANNELS.workbench.search, (_event, ...args) => {
    const [threadId, query, mode] = parseIpcArgs(
      workbenchSearchArgsSchema,
      args,
      IPC_CHANNELS.workbench.search
    )
    const result: WorkbenchSearchResult = searchWorkspace(rootOf(threadId), { query, mode })
    return result
  })

  /**
   * 文本分页（预览里的"加载更多"）。
   *
   * **没有跨请求状态**：一次调用开一次文件、读一页、关掉；没有 watcher、没有缓存、不按 sender 记账
   * —— 所以这里不需要 `watchSender` 那套清算（渲染端卸载时它自己的轮询定时器会停）。
   * 版本校验（`changed`）在服务里做：渲染端只需把上一页回的 `{ offset, version }` 原样带回来。
   */
  ipcMain.handle(IPC_CHANNELS.workbench.readTextPage, async (_event, ...args) => {
    const [threadId, relative, cursor] = parseIpcArgs(
      textPageArgsSchema,
      args,
      IPC_CHANNELS.workbench.readTextPage
    )
    const result: TextPageResult = await readTextPage(rootOf(threadId), relative, cursor)
    return result
  })

  /** 只 stat 的版本探询（轮询用）：同样没有跨请求状态。 */
  ipcMain.handle(IPC_CHANNELS.workbench.textVersion, (_event, ...args) => {
    const [threadId, relative] = parseIpcArgs(
      textVersionArgsSchema,
      args,
      IPC_CHANNELS.workbench.textVersion
    )
    const result: TextVersionResult = textVersionOf(rootOf(threadId), relative)
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

  /**
   * 用**系统默认应用**打开一个文件（个人 PC 上通常就是 Word / WPS / Excel 这件）。
   *
   * 与 reveal 的分工是刻意的：reveal 是"在资源管理器里定位"（目录也认，走 openPath/showItemInFolder），
   * 这里是"把文件交给用户装的那件应用"。三道闸门按顺序：
   *   1. containment / 存在性复用 `revealTarget`（resolveInsideWorkspace + stat 一次，同一条闸门）；
   *   2. **目录一律拒**：openPath 打在目录上会打开资源管理器，那就把 reveal 的语义混进来了，
   *      用户会以为"用本地应用打开"= 打开文件夹；
   *   3. **扩展名闸门** `assertOpenable`：`shell.openPath` 在 Windows 上就是 ShellExecute，
   *      一个 .exe / .bat / .ps1 / .lnk 交过去是**执行** —— 工作区里的文件模型也能写，
   *      这条通道不能变成"模型写、用户点、系统跑"（只有文档与媒体放行，见那张表）。
   *      认不出的类型也给不出"用哪个应用开"这件事 —— 那本该由用户自己决定（先定位再开）。
   * `shell.openPath` 失败时回**非空字符串**（不是抛），在这里翻成人话错误 —— 不假装打开。
   */
  ipcMain.handle(IPC_CHANNELS.workbench.open, async (_event, ...args) => {
    const [threadId, relative] = parseIpcArgs(
      workbenchRelativeArgsSchema,
      args,
      IPC_CHANNELS.workbench.open
    )
    const target = revealTarget(rootOf(threadId), relative)
    if (statSync(target).isDirectory()) {
      throw new Error('这是一个文件夹：文件夹请用「在文件资源管理器中打开」，这里只打开文件')
    }
    assertOpenable(relative)
    const problem = await shell.openPath(target)
    if (problem !== '') {
      throw new Error(`打不开这个文件（系统没能用默认应用打开它）：${problem}`)
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

  /**
   * 表格（xls / xlsx / csv / tsv）的**原始字节**：与 `read-bytes` 那条"抽结构"的路分开，
   * 形状与判别口径（missing / too-large / unsupported / changed）都在 `readTableBytes` 里。
   */
  ipcMain.handle(IPC_CHANNELS.workbench.tableBytes, async (_event, ...args) => {
    const [threadId, relative] = parseIpcArgs(
      workbenchRelativeArgsSchema,
      args,
      IPC_CHANNELS.workbench.tableBytes
    )
    const result: TableBytesResult = await readTableBytes(rootOf(threadId), relative)
    return result
  })

  /**
   * 办公档（doc / docx / ppt / pptx）→ PDF。顺序是刻意的：
   *   1. 会话根先解析（判不出直接抛人话，**不留任何账目**）；
   *   2. 懒建服务（第一次用到才把引擎那坨加载进来）；
   *   3. 记账 + 挂发布者清算（`requestId` 只对本窗口有效，见 `createOfficePreviewRequests`）；
   *   4. 转换本体（授权四道闸门 + 有界读都在 `convertOfficeToPdf` 里）。
   * 收尾一律 `release()`：无论成、败、取消，这条账都要摘掉（release 只摘"还是我这条"）。
   */
  ipcMain.handle(IPC_CHANNELS.workbench.officePdf, async (event, ...args) => {
    const [threadId, relative, priority, requestId] = parseIpcArgs(
      officePreviewArgsSchema,
      args,
      IPC_CHANNELS.workbench.officePdf
    )
    const root = rootOf(threadId)
    const preview = await officePreviewOf()
    const request = officeRequests.begin(requestId, event.sender.id)
    watchSender(event.sender)
    try {
      const result: OfficePreviewResult = await convertOfficeToPdf(
        root,
        relative,
        priority,
        preview,
        request.signal
      )
      return result
    } finally {
      request.release()
    }
  })

  /**
   * 取消一次办公档转换。**只认本窗口的 requestId**（`cancel(id, owner)` 在别人手上是空操作）——
   * 多窗口下不能让一个窗口把另一个窗口正在看的转换掐掉。幂等：没这条账就是空操作，不抛。
   */
  ipcMain.handle(IPC_CHANNELS.workbench.cancelOfficePdf, (event, ...args) => {
    const [requestId] = parseIpcArgs(
      officePreviewCancelArgsSchema,
      args,
      IPC_CHANNELS.workbench.cancelOfficePdf
    )
    officeRequests.cancel(requestId, event.sender.id)
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
    // 渲染端重新加载 / 窗口销毁：这个 sender 名下的终端与在途转换全部清算
    watchSender(event.sender)
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

  return {
    terminals,
    disposeOfficePreview: () => {
      // 在途的转换先取消（同步发起杀进程树），再让服务自己收尾（不 await：见 handles 的说明）
      officeRequests.disposeAll()
      void officePreview?.dispose()
    }
  }
}

/** 终端 id 的自增尾巴 */
let sessionsSeq = 0
