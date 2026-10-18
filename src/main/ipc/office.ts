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
  type SaveDialogOptions,
  type WebContents
} from 'electron'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { IPC_CHANNELS, parseIpcArgs } from '../../shared/ipc'
import {
  OFFICE_EDITOR_MAX_BYTES,
  OFFICE_MAX_OPEN_DOCUMENTS,
  officeCreateBlankArgsSchema,
  officeDocumentIdArgsSchema,
  officeNoArgsSchema,
  officeOpenFromSessionArgsSchema,
  officeSaveArgsSchema,
  officeSaveAsArgsSchema,
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
import { blankDocxBytes } from '../office-blank-template'
import { settingsPath } from '../settings'
import { sessionRootForThread, type ProjectIdOf } from './workspace'

/** 会话根判不出时的两种人话（与工作台各入口同口径；渲染端原样显示） */
const ROOT_MESSAGES = {
  empty: '这个会话还没有工作区：先在设置里添加一个文件夹，再打开里面的文档',
  multiple: '这个会话的工作区不唯一：指认默认工作区（或给会话选一个项目）后再打开文档'
} as const

/**
 * Windows 路径大小写/短名差异下的同一性判断（仅用于"临时文件是否还指向原落点"）。
 * 注册表里的 absolutePath 是 realpath 归一后的（可能与写入时字符串不同大小写）。
 */
function samePathIgnoringCase(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

/** 原生选择器的选项（M4-X：Word + Excel；取消是一等结果） */
const OPEN_DIALOG_OPTIONS: OpenDialogOptions = {
  title: '打开 Office 文档',
  properties: ['openFile'],
  filters: [
    { name: 'Office 文档', extensions: ['docx', 'xlsx'] },
    { name: 'Word 文档', extensions: ['docx'] },
    { name: 'Excel 表格', extensions: ['xlsx'] }
  ]
}

/** 一次原生对话框的结果（只留用得到的两个字段，便于测试注入） */
export interface OfficeOpenDialogResult {
  canceled: boolean
  filePaths: readonly string[]
}

/** 另存为对话框选项（每次按当前文档 kind + 文件名现拼默认路径） */
function saveDialogOptions(
  kind: 'docx' | 'xlsx',
  defaultPath: string | undefined
): SaveDialogOptions {
  const isExcel = kind === 'xlsx'
  return {
    title: isExcel ? '另存为 Excel 表格' : '另存为 Word 文档',
    ...(defaultPath === undefined ? {} : { defaultPath }),
    filters: [
      isExcel
        ? { name: 'Excel 表格', extensions: ['xlsx'] }
        : { name: 'Word 文档', extensions: ['docx'] }
    ]
  }
}

/** 一次原生保存对话框的结果（只留用得到的两个字段，便于测试注入） */
export interface OfficeSaveDialogResult {
  canceled: boolean
  filePath?: string
}

export interface OfficeIpcDeps {
  /** 会话 → 项目 id（agent 服务的映射；与工作台同一条） */
  projectIdOf?: ProjectIdOf
  /** 覆盖会话根解析（单测注入；缺省 = settings + sessionRoots 真实口径） */
  rootForThread?: (threadId: string) => string
  /** 覆盖注册表（单测注入；缺省 = 真 IO） */
  documents?: OfficeDocuments
  /** 覆盖注册表的文件 IO（单测伪造 stat/读/写失败用） */
  io?: OfficeDocumentIo
  /** 覆盖原生选择器（单测注入；缺省 = 真 `dialog.showOpenDialog`） */
  showOpenDialog?: (
    parent: BrowserWindow | null,
    options: OpenDialogOptions
  ) => Promise<OfficeOpenDialogResult>
  /** 覆盖原生保存对话框（单测注入；缺省 = 真 `dialog.showSaveDialog`） */
  showSaveDialog?: (
    parent: BrowserWindow | null,
    options: SaveDialogOptions
  ) => Promise<OfficeSaveDialogResult>
  /** 覆盖 `process.env`（单测注入） */
  env?: NodeJS.ProcessEnv
  /** 覆盖 dev 主窗口 URL（缺省 = `ELECTRON_RENDERER_URL`） */
  rendererUrl?: string
  /** 覆盖 `app.isPackaged`（缺省 = 真值；打包后忽略 KYCLAW_OFFICE_OPEN / KYCLAW_OFFICE_SAVE_AS） */
  isPackaged?: boolean
  /**
   * task-80：空白文档的临时根目录（缺省 `app.getPath('temp')`；单测注入临时目录，
   * 不往真实 OS temp 里写）。
   */
  tempDir?: string
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

/** 测试专用另存为落点（同上：仅未打包构建；生产不设即不存在这条分支） */
export function scriptedOfficeSaveAsPath(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean
): string | undefined {
  if (isPackaged) return undefined
  const raw = env.KYCLAW_OFFICE_SAVE_AS
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
  /**
   * task-80 临时文件清理策略（报告 `newtab-impl-report.md` 同步记录）：
   *   - 关标签（`office:release`）时，如果文档**仍指向**我们写的临时文件（用户没另存为），尽力删除
   *     —— 放弃未保存内容的语义下这台空模板文件没有保留价值；
   *   - 另存为后注册表已指向用户选的新路径，临时原件保留（只是空模板，OS 临时目录会回收）；
   *   - webContents destroyed（重载/关窗）时清掉属于该窗口的临时文件；
   *   - **不做 app 级 rm -rf**：避免与用户另存为/外部程序打开临时文件竞态，崩溃残留交给 OS 清理。
   * 根目录在 handler 内惰性取 `deps.tempDir ?? app.getPath('temp')`：单测的 electron mock
   * 没有 app.getPath，不该因为注册面就炸。
   *
   * `realPath` = 注册表回包的 absolutePath（realpath 归一后的长名）；Windows 上临时目录常是
   * 8.3 短名（如 `C:\LMSTUD~1`），不能用写入时的字符串直接比较「是否仍指向原落点」。
   */
  const blankTempFiles = new Map<string, { owner: number; path: string; realPath: string }>()

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

  const showSaveDialog =
    deps.showSaveDialog ??
    (async (
      parent: BrowserWindow | null,
      options: SaveDialogOptions
    ): Promise<OfficeSaveDialogResult> => {
      const result =
        parent === null
          ? await dialog.showSaveDialog(options)
          : await dialog.showSaveDialog(parent, options)
      return {
        canceled: result.canceled,
        filePath: result.filePath === '' ? undefined : result.filePath
      }
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
      // task-80：窗口没了，属于它的空白文档临时文件一并清（尽力而为）
      for (const [documentId, entry] of blankTempFiles) {
        if (entry.owner !== sender.id) continue
        blankTempFiles.delete(documentId)
        void unlink(entry.path).catch(() => undefined)
      }
    })
  }

  ipcMain.handle(IPC_CHANNELS.office.config, (_event, ...args) => {
    parseIpcArgs(officeNoArgsSchema, args, IPC_CHANNELS.office.config)
    const { surfaceUrl, surfaceOrigin } = officeSurfaceUrls(rendererUrl)
    const config: OfficeConfig = {
      surfaceUrl,
      surfaceOrigin,
      maxBytes: OFFICE_EDITOR_MAX_BYTES,
      maxOpenDocuments: OFFICE_MAX_OPEN_DOCUMENTS,
      // D17：canvas 探针缝只在未打包 + env 打开时存在；生产恒 false
      probe: !isPackaged && env.KYCLAW_OFFICE_PROBE === '1'
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

  /**
   * task-80（新增标签页 v1）：新建空白 Word 文档。
   * 唯一允许"主进程自己产生文档"的通道：把随包最小模板写到 `%TEMP%/kyclaw/未命名-<ts>.docx`
   * （wx/0o600），再走与选择器**同一套** `documents.open`（realpath / 大小 / 容量 / owner 全部复用），
   * 回与打开同形状的 `OfficeOpenResult`（displayName = 未命名文档）。
   * 失败时不留下临时文件；v1 只接 docx（xlsx/pptx 编辑器未就绪）。
   */
  ipcMain.handle(IPC_CHANNELS.office.createBlank, async (event, ...args) => {
    const [input] = parseIpcArgs(officeCreateBlankArgsSchema, args, IPC_CHANNELS.office.createBlank)
    watchSender(event.sender)
    if (input.kind !== 'docx') return officeFailure('unsupported-format')

    const directory = join(deps.tempDir ?? app.getPath('temp'), 'kyclaw')
    try {
      await mkdir(directory, { recursive: true })
    } catch {
      return officeFailure('write-failed', '创建临时目录失败')
    }

    const stamp = Date.now()
    let target = ''
    let written = false
    for (let attempt = 0; attempt < 5 && !written; attempt += 1) {
      const name =
        attempt === 0
          ? `未命名-${String(stamp)}.docx`
          : `未命名-${String(stamp)}-${String(attempt)}.docx`
      target = join(directory, name)
      try {
        await writeFile(target, blankDocxBytes(), { flag: 'wx', mode: 0o600 })
        written = true
      } catch {
        // 同一毫秒内连点可能撞名（EEXIST）：换后缀重试；其他 IO 失败在循环后统一回错
      }
    }
    if (!written) return officeFailure('write-failed', '写临时模板失败')

    const opened = await documents.open(target, {
      owner: event.sender.id,
      openedFrom: 'picker',
      displayPath: target,
      displayName: '未命名文档'
    })
    if (!opened.ok) {
      // 注册被拒（容量/读不了）：临时模板没有保留价值，清掉再回分类失败
      await unlink(target).catch(() => undefined)
      return opened
    }
    blankTempFiles.set(opened.document.documentId, {
      owner: event.sender.id,
      path: target,
      realPath: opened.document.absolutePath
    })
    return opened
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

  ipcMain.handle(IPC_CHANNELS.office.release, async (event, ...args) => {
    const [documentId] = parseIpcArgs(officeDocumentIdArgsSchema, args, IPC_CHANNELS.office.release)
    watchSender(event.sender)
    // task-80：释放前先取注册表信息，判断文档是否仍指向 blank 的临时落点（另存为后就不是了）
    const info = documents.info(documentId, event.sender.id)
    documents.release(documentId, event.sender.id)
    const temp = blankTempFiles.get(documentId)
    if (temp !== undefined && temp.owner === event.sender.id) {
      blankTempFiles.delete(documentId)
      if (info === null || samePathIgnoringCase(info.absolutePath, temp.realPath)) {
        // 等删除完成再回包：关标签后立刻重开/检查文件时不会看到残留
        await unlink(temp.path).catch(() => undefined)
      }
    }
    // 幂等、无回包：未知 id / 非本窗口 id 都是空操作
    return undefined
  })

  ipcMain.handle(IPC_CHANNELS.office.save, async (event, ...args) => {
    const [request] = parseIpcArgs(officeSaveArgsSchema, args, IPC_CHANNELS.office.save)
    watchSender(event.sender)
    return documents.save(request.documentId, event.sender.id, {
      bytes: request.bytes,
      expectedSha256: request.expectedSha256
    })
  })

  ipcMain.handle(IPC_CHANNELS.office.saveAs, async (event, ...args) => {
    const [request] = parseIpcArgs(officeSaveAsArgsSchema, args, IPC_CHANNELS.office.saveAs)
    watchSender(event.sender)
    const info = documents.info(request.documentId, event.sender.id)
    if (info === null) return officeFailure('forbidden', '文档没有打开或已关闭')

    // 落点只由主进程给：测试 env（仅未打包）或原生保存对话框；渲染端从未递过路径
    const scripted = scriptedOfficeSaveAsPath(env, isPackaged)
    let target: string
    if (scripted !== undefined) {
      target = scripted
    } else {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const result = await showSaveDialog(parent, saveDialogOptions(info.kind, info.absolutePath))
      if (result.canceled || result.filePath === undefined || result.filePath === '') {
        return officeFailure('cancelled')
      }
      target = result.filePath
    }
    return documents.saveAs(request.documentId, event.sender.id, target, {
      bytes: request.bytes
    })
  })

  return { documents }
}
