/**
 * Office 文档通道（M3-S2）：`office:config / open-dialog / open-from-session / read / release`。
 *
 * 这一层只做三件事（`.superpowers/handover/office-docx-plan.md` §6.3）：
 *   1. **入参闸门**：一律 `parseIpcArgs`（渲染端是不可信侧）；
 *   2. **授权**：选择器路径由主进程拿；会话入口用 `sessionRootForThread` + `resolveInsideWorkspace`
 *      解析并拦截越权 —— 渲染端永远递不了绝对路径；
 *   3. **归属清算**：照 `ipc/workbench.ts` 的 `watchSender`，webContents destroyed 时
 *      `releaseAll(owner)`（注册表里只有元数据，没有内容要落盘）。
 *
 * 原生对话框不可自动化：沿用 `KYCLAW_CLOSE_PROMPT` 那一类**测试专用 env**
 * `KYCLAW_OFFICE_OPEN=<绝对路径>` 绕过选择器。生产口径：
 *   - 只在**未打包**的构建里认它（与 dev/preview 探针一致；打包后即使设了也忽略）；
 *   - 不设 = 完全不存在这条分支，走的还是真 `dialog.showOpenDialog`。
 *
 * `office:save` / `office:save-as` 的形状已在 shared/office-editor.ts 冻结，但 S2 **不注册**：
 * 保存链路是 S3（DocxEditor 接入 + 原子写 + 冲突检测）。
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type WebContents
} from 'electron'
import { IPC_CHANNELS, parseIpcArgs } from '../../shared/ipc'
import {
  OFFICE_EDITOR_MAX_BYTES,
  OFFICE_MAX_OPEN_DOCUMENTS,
  officeDocumentIdArgsSchema,
  officeNoArgsSchema,
  officeOpenFromSessionArgsSchema,
  officeSurfaceUrls,
  type OfficeConfig
} from '../../shared/office-editor'
import {
  createOfficeDocuments,
  officeFailure,
  type OfficeDocumentIo,
  type OfficeDocuments
} from '../office-documents'
import { resolveInsideWorkspace } from '../permission/realpath'
import { settingsPath } from '../settings'
import { sessionRootForThread, type ProjectIdOf } from './workspace'

/** 会话根判不出时的两种人话（与工作台各入口同口径；渲染端原样显示） */
const ROOT_MESSAGES = {
  empty: '这个会话还没有工作区：先在设置里添加一个文件夹，再打开里面的文档',
  multiple: '这个会话的工作区不唯一：指认默认工作区（或给会话选一个项目）后再打开文档'
} as const

/** 原生选择器的选项（`.docx` 过滤；取消是一等结果） */
const OPEN_DIALOG_OPTIONS: OpenDialogOptions = {
  title: '打开 Word 文档',
  properties: ['openFile'],
  filters: [{ name: 'Word 文档', extensions: ['docx'] }]
}

/** 一次原生对话框的结果（只留用得到的两个字段，便于测试注入） */
export interface OfficeOpenDialogResult {
  canceled: boolean
  filePaths: readonly string[]
}

export interface OfficeIpcDeps {
  /** 会话 → 项目 id（agent 服务的映射；与工作台同一条） */
  projectIdOf?: ProjectIdOf
  /** 覆盖会话根解析（单测注入；缺省 = settings + sessionRoots 真实口径） */
  rootForThread?: (threadId: string) => string
  /** 覆盖注册表（单测注入；缺省 = 真 IO） */
  documents?: OfficeDocuments
  /** 覆盖注册表的文件 IO（单测伪造 stat/读失败用） */
  io?: OfficeDocumentIo
  /** 覆盖原生选择器（单测注入；缺省 = 真 `dialog.showOpenDialog`） */
  showOpenDialog?: (
    parent: BrowserWindow | null,
    options: OpenDialogOptions
  ) => Promise<OfficeOpenDialogResult>
  /** 覆盖 `process.env`（单测注入） */
  env?: NodeJS.ProcessEnv
  /** 覆盖 dev 主窗口 URL（缺省 = `ELECTRON_RENDERER_URL`） */
  rendererUrl?: string
  /** 覆盖 `app.isPackaged`（缺省 = 真值；打包后忽略 KYCLAW_OFFICE_OPEN） */
  isPackaged?: boolean
}

export interface OfficeIpcHandle {
  /** 注册表句柄（排障/单测用；主进程不保存文档内容，退出无需额外清算） */
  documents: OfficeDocuments
}

/**
 * 测试专用打开路径（与 `KYCLAW_CLOSE_PROMPT` 同类）。
 * **只在未打包构建里生效**：打包产物上这个环境变量不存在这条分支。
 */
export function scriptedOfficeOpenPath(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean
): string | undefined {
  if (isPackaged) return undefined
  const raw = env.KYCLAW_OFFICE_OPEN
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

export function registerOfficeIpc(userDataDir: string, deps: OfficeIpcDeps = {}): OfficeIpcHandle {
  const env = deps.env ?? process.env
  const isPackaged = deps.isPackaged ?? app.isPackaged
  const rendererUrl = deps.rendererUrl ?? process.env.ELECTRON_RENDERER_URL
  const documents = deps.documents ?? createOfficeDocuments(deps.io)
  const settingsFile = settingsPath(userDataDir)

  const rootOf =
    deps.rootForThread ??
    ((threadId: string): string =>
      sessionRootForThread(settingsFile, threadId, deps.projectIdOf, ROOT_MESSAGES))

  const showOpenDialog =
    deps.showOpenDialog ??
    (async (
      parent: BrowserWindow | null,
      options: OpenDialogOptions
    ): Promise<OfficeOpenDialogResult> => {
      const result =
        parent === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(parent, options)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })

  /**
   * 每个 webContents 只挂一次"销毁即清算"：窗口关掉 / 渲染端重载时，注册表里属于它的条目
   * 全部释放（别的窗口的不动）。与 `ipc/workbench.ts` 的 watchSender 同构。
   */
  const watched = new Set<number>()
  const watchSender = (sender: WebContents): void => {
    if (watched.has(sender.id)) return
    watched.add(sender.id)
    sender.once('destroyed', () => {
      watched.delete(sender.id)
      documents.releaseAll(sender.id)
    })
  }

  ipcMain.handle(IPC_CHANNELS.office.config, (_event, ...args) => {
    parseIpcArgs(officeNoArgsSchema, args, IPC_CHANNELS.office.config)
    const { surfaceUrl, surfaceOrigin } = officeSurfaceUrls(rendererUrl)
    const config: OfficeConfig = {
      surfaceUrl,
      surfaceOrigin,
      maxBytes: OFFICE_EDITOR_MAX_BYTES,
      maxOpenDocuments: OFFICE_MAX_OPEN_DOCUMENTS
    }
    return config
  })

  ipcMain.handle(IPC_CHANNELS.office.openDialog, async (event, ...args) => {
    parseIpcArgs(officeNoArgsSchema, args, IPC_CHANNELS.office.openDialog)
    watchSender(event.sender)

    const scripted = scriptedOfficeOpenPath(env, isPackaged)
    let target: string
    if (scripted !== undefined) {
      target = scripted
    } else {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const result = await showOpenDialog(parent, OPEN_DIALOG_OPTIONS)
      if (result.canceled || result.filePaths.length === 0) {
        return officeFailure('cancelled')
      }
      target = result.filePaths[0]
    }

    // 绝对路径只在这里出现：选择器给的，或测试 env 给的；渲染端从未递过路径
    return documents.open(target, {
      owner: event.sender.id,
      openedFrom: 'picker',
      displayPath: target
    })
  })

  ipcMain.handle(IPC_CHANNELS.office.openFromSession, async (event, ...args) => {
    const [threadId, relative, readOnly] = parseIpcArgs(
      officeOpenFromSessionArgsSchema,
      args,
      IPC_CHANNELS.office.openFromSession
    )
    watchSender(event.sender)

    // 授权：会话根在主进程解析，渲染端只给"树上的哪一条"
    const root = rootOf(threadId)
    const resolved = resolveInsideWorkspace(root, relative)
    if (!resolved.ok) throw new Error(resolved.reason)

    return documents.open(resolved.abs, {
      owner: event.sender.id,
      openedFrom: 'session',
      readOnly,
      displayPath: relative
    })
  })

  ipcMain.handle(IPC_CHANNELS.office.read, async (event, ...args) => {
    const [documentId] = parseIpcArgs(officeDocumentIdArgsSchema, args, IPC_CHANNELS.office.read)
    watchSender(event.sender)
    return documents.read(documentId, event.sender.id)
  })

  ipcMain.handle(IPC_CHANNELS.office.release, (event, ...args) => {
    const [documentId] = parseIpcArgs(officeDocumentIdArgsSchema, args, IPC_CHANNELS.office.release)
    watchSender(event.sender)
    documents.release(documentId, event.sender.id)
    // 幂等、无回包：未知 id / 非本窗口 id 都是空操作
    return undefined
  })

  return { documents }
}
