// @vitest-environment node
/**
 * `src/main/ipc/office.ts`（M3-S2 打开/读 + M3-S3 保存）聚焦单测。
 *
 * 覆盖方案 §6.3/§10.1-G2 的接线面：
 *   1. 七条通道都注册了（S3 起含 `office:save` / `office:save-as`）；
 *   2. 入参先过 `parseIpcArgs`（坏形状直接抛 IpcInputError，不碰注册表）；
 *   3. `office:config` 的 dev / preview 两种 surfaceUrl；
 *   4. 原生选择器取消是一等结果；`KYCLAW_OFFICE_OPEN` / `KYCLAW_OFFICE_SAVE_AS`（测试专用，
 *      仅未打包构建）绕过原生对话框；
 *   5. 会话入口的授权：`resolveInsideWorkspace` 拦越权，渲染端递不了绝对路径；
 *   6. `office:read` 回字节 + sha256，按 sender 做 owner 校验；webContents destroyed 时清算；
 *   7. 保存链路：owner/只读/字节闸 → 写盘/冲突分类透传 → save-as 对话框取消/重定向。
 *
 * Electron 全部 mock（`ipcMain.handle` 收进 Map、dialog 可注入），一个真进程都不起。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  showOpenDialog: vi.fn(),
  destroyed: [] as Array<{ id: number; listener: () => void }>
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    fromWebContents: () => null
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => mocks.showOpenDialog(...args)
  },
  shell: {
    openPath: async () => '',
    showItemInFolder: () => {}
  }
}))

import { IPC_CHANNELS, IpcInputError, parseIpcArgs } from '../../shared/ipc'
import {
  OFFICE_EDITOR_MAX_BYTES,
  OFFICE_MAX_OPEN_DOCUMENTS,
  officeConfigSchema,
  officeOpenFromSessionArgsSchema,
  officeOpenResultSchema,
  officeReadResultSchema,
  officeSaveArgsSchema,
  officeSaveAsArgsSchema,
  officeSaveAsResultSchema,
  officeSaveResultSchema,
  officeSurfaceUrls
} from '../../shared/office-editor'
import { registerOfficeIpc, scriptedOfficeOpenPath, scriptedOfficeSaveAsPath } from '../ipc/office'
import {
  createOfficeDocuments,
  defaultOfficeDocumentIo,
  type OfficeDocumentIo
} from '../office-documents'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  mocks.handlers.clear()
  mocks.destroyed.splice(0)
  mocks.showOpenDialog.mockReset()
})

beforeEach(() => {
  mocks.handlers.clear()
  mocks.destroyed.splice(0)
  mocks.showOpenDialog.mockReset()
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-ipc-'))
  directories.push(directory)
  return directory
}

function writeFile(directory: string, name: string, content = 'docx-bytes'): string {
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

/** 一个够用的 webContents 假件：once 只收 destroyed（清算用） */
function fakeSender(id: number): {
  id: number
  once: (event: string, listener: () => void) => void
} {
  return {
    id,
    once: (event, listener) => {
      if (event === 'destroyed') mocks.destroyed.push({ id, listener })
    }
  }
}

function eventOf(senderId: number): { sender: ReturnType<typeof fakeSender> } {
  return { sender: fakeSender(senderId) }
}

function handlerOf(channel: string): Handler {
  const handler = mocks.handlers.get(channel)
  if (handler === undefined) throw new Error(`通道没注册：${channel}`)
  return handler
}

async function invoke(
  channel: string,
  event: { sender: ReturnType<typeof fakeSender> },
  ...args: unknown[]
): Promise<unknown> {
  return await handlerOf(channel)(event, ...args)
}

/** 注册一组通道：默认会话根 = 临时目录，preview 形态（无 dev URL） */
function register(options: {
  root?: string
  env?: NodeJS.ProcessEnv
  isPackaged?: boolean
  rendererUrl?: string
  io?: OfficeDocumentIo
  documents?: ReturnType<typeof createOfficeDocuments>
  tempDir?: string
  showSaveDialog?: (
    parent: unknown,
    options: unknown
  ) => Promise<{ canceled: boolean; filePath?: string }>
}): ReturnType<typeof registerOfficeIpc> {
  return registerOfficeIpc(tempDir(), {
    isPackaged: options.isPackaged ?? false,
    rendererUrl: options.rendererUrl ?? '',
    env: options.env ?? {},
    rootForThread: () => options.root ?? tempDir(),
    ...(options.io === undefined ? {} : { io: options.io }),
    ...(options.documents === undefined ? {} : { documents: options.documents }),
    ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
    ...(options.showSaveDialog === undefined ? {} : { showSaveDialog: options.showSaveDialog })
  })
}

describe('注册面：通道清单', () => {
  it('注册七条打开/读/写/释放通道（S3 起含 save / save-as）', () => {
    register({})
    expect([...mocks.handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.office.config,
        IPC_CHANNELS.office.createBlank,
        IPC_CHANNELS.office.openDialog,
        IPC_CHANNELS.office.openFromSession,
        IPC_CHANNELS.office.read,
        IPC_CHANNELS.office.release,
        IPC_CHANNELS.office.save,
        IPC_CHANNELS.office.saveAs
      ].sort()
    )
    // 通道名口径（shared/ipc.ts 直接挂 office-editor 的常量）
    expect(IPC_CHANNELS.office.config).toBe('office:config')
    expect(IPC_CHANNELS.office.createBlank).toBe('office:create-blank')
    expect(IPC_CHANNELS.office.openDialog).toBe('office:open-dialog')
    expect(IPC_CHANNELS.office.openFromSession).toBe('office:open-from-session')
    expect(IPC_CHANNELS.office.read).toBe('office:read')
    expect(IPC_CHANNELS.office.release).toBe('office:release')
    expect(IPC_CHANNELS.office.save).toBe('office:save')
    expect(IPC_CHANNELS.office.saveAs).toBe('office:save-as')
  })
})

describe('入参闸门：坏形状不碰注册表', () => {
  it('office:config / open-dialog 不收多余入参', async () => {
    register({})
    await expect(invoke(IPC_CHANNELS.office.config, eventOf(1), 'extra')).rejects.toBeInstanceOf(
      IpcInputError
    )
    await expect(
      invoke(IPC_CHANNELS.office.openDialog, eventOf(1), 'extra')
    ).rejects.toBeInstanceOf(IpcInputError)
  })

  it('open-from-session：缺 threadId / 空相对路径 / readOnly 类型错都被拒', async () => {
    const handle = register({})
    const event = eventOf(1)
    for (const args of [[], [''], ['thread-1', ''], ['thread-1', 'a.docx', 'yes']]) {
      await expect(
        invoke(IPC_CHANNELS.office.openFromSession, event, ...args)
      ).rejects.toBeInstanceOf(IpcInputError)
    }
    expect(handle.documents.size()).toBe(0)
    // 共享 schema 与 handler 用的是同一份（直接打一下闸门）
    expect(() => parseIpcArgs(officeOpenFromSessionArgsSchema, ['t', 'a.docx'], 'x')).not.toThrow()
  })

  it('read / release 只收一个非空 documentId', async () => {
    register({})
    for (const channel of [IPC_CHANNELS.office.read, IPC_CHANNELS.office.release]) {
      await expect(invoke(channel, eventOf(1))).rejects.toBeInstanceOf(IpcInputError)
      await expect(invoke(channel, eventOf(1), '')).rejects.toBeInstanceOf(IpcInputError)
      await expect(invoke(channel, eventOf(1), 42)).rejects.toBeInstanceOf(IpcInputError)
    }
  })
})

describe('office:config：surfaceUrl / origin / 上限', () => {
  it('preview/打包（file://）→ kyclaw-office://surface/', async () => {
    register({ rendererUrl: '' })
    const config = officeConfigSchema.parse(await invoke(IPC_CHANNELS.office.config, eventOf(1)))
    expect(config).toEqual({
      surfaceUrl: 'kyclaw-office://surface/',
      surfaceOrigin: 'kyclaw-office://surface',
      maxBytes: OFFICE_EDITOR_MAX_BYTES,
      maxOpenDocuments: OFFICE_MAX_OPEN_DOCUMENTS
    })
  })

  it('dev（ELECTRON_RENDERER_URL）→ 同源 /office.html（端口由主进程下发）', async () => {
    register({ rendererUrl: 'http://localhost:6123' })
    const config = officeConfigSchema.parse(await invoke(IPC_CHANNELS.office.config, eventOf(1)))
    expect(config.surfaceUrl).toBe('http://localhost:6123/office.html')
    expect(config.surfaceOrigin).toBe('http://localhost:6123')
    expect(officeSurfaceUrls('http://localhost:6123').surfaceOrigin).toBe('http://localhost:6123')
  })
})

describe('office:open-dialog：取消 / 真实选择器 / KYCLAW_OFFICE_OPEN', () => {
  it('取消是一等结果：ok:false + code:cancelled（不抛），且过滤 .docx', async () => {
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    register({})
    const result = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(mocks.showOpenDialog).toHaveBeenCalledTimes(1)
    const options = mocks.showOpenDialog.mock.calls[0]?.[0] as {
      filters?: { extensions: string[] }[]
      properties?: string[]
    }
    expect(options.properties).toContain('openFile')
    expect(options.filters?.[0]?.extensions).toContain('docx')
  })

  it('选中真实 docx：回 document 信息 + alreadyOpen:false；read 回字节与 sha256', async () => {
    const directory = tempDir()
    const path = writeFile(directory, '项目计划.docx', '真实字节')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })
    register({})

    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(3))
    )
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.alreadyOpen).toBe(false)
    expect(opened.document.displayName).toBe('项目计划.docx')
    expect(opened.document.displayPath).toBe(path)
    // absolutePath 是 realpath 归一后的绝对路径（只读回包字段）；displayPath 保留调用方给的写法
    expect(opened.document.absolutePath).toBe(realpathSync.native(path))
    expect(opened.document.size).toBe(Buffer.byteLength('真实字节'))
    expect(opened.document.sha256).toBe(
      createHash('sha256').update(Buffer.from('真实字节')).digest('hex')
    )

    const read = officeReadResultSchema.parse(
      await invoke(IPC_CHANNELS.office.read, eventOf(3), opened.document.documentId)
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(Buffer.from(read.bytes).toString('utf8')).toBe('真实字节')
    expect(read.document.sha256).toBe(opened.document.sha256)
    expect(read.document.absolutePath).toBe(opened.document.absolutePath)

    // 二次打开同一文件：同 id + alreadyOpen（壳只激活既有标签）
    const again = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(3))
    )
    expect(again).toMatchObject({
      ok: true,
      alreadyOpen: true,
      document: { documentId: opened.document.documentId }
    })
  })

  it('KYCLAW_OFFICE_OPEN 绕过原生选择器（测试专用）', async () => {
    const path = writeFile(tempDir(), '探针.docx', 'fixture-bytes')
    register({ env: { KYCLAW_OFFICE_OPEN: path } })

    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    expect(opened).toMatchObject({ ok: true, alreadyOpen: false })
    expect(mocks.showOpenDialog).not.toHaveBeenCalled()

    // 打包态忽略这个 env（生产不存在这条分支）
    mocks.handlers.clear()
    register({ env: { KYCLAW_OFFICE_OPEN: path }, isPackaged: true })
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const packaged = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    expect(packaged).toMatchObject({ ok: false, code: 'cancelled' })
    expect(mocks.showOpenDialog).toHaveBeenCalledTimes(1)
  })

  it('env 指向非 docx / 不存在的文件：分类失败（对话框外仍是同一套分类）', async () => {
    const directory = tempDir()
    const txt = writeFile(directory, 'not-docx.txt', 'x')
    register({ env: { KYCLAW_OFFICE_OPEN: txt } })
    expect(
      officeOpenResultSchema.parse(await invoke(IPC_CHANNELS.office.openDialog, eventOf(1)))
    ).toMatchObject({ ok: false, code: 'unsupported-format' })

    mocks.handlers.clear()
    register({ env: { KYCLAW_OFFICE_OPEN: join(directory, 'missing.docx') } })
    expect(
      officeOpenResultSchema.parse(await invoke(IPC_CHANNELS.office.openDialog, eventOf(1)))
    ).toMatchObject({ ok: false, code: 'unreadable' })
  })

  it('scriptedOfficeOpenPath：仅未打包 + 非空值才生效', () => {
    expect(scriptedOfficeOpenPath({ KYCLAW_OFFICE_OPEN: 'D:\\a.docx' }, false)).toBe('D:\\a.docx')
    expect(scriptedOfficeOpenPath({ KYCLAW_OFFICE_OPEN: '  ' }, false)).toBeUndefined()
    expect(scriptedOfficeOpenPath({}, false)).toBeUndefined()
    expect(scriptedOfficeOpenPath({ KYCLAW_OFFICE_OPEN: 'D:\\a.docx' }, true)).toBeUndefined()
  })
})

describe('office:open-from-session：会话根授权', () => {
  it('相对路径落在会话根内：打开成功，displayPath 保持相对路径', async () => {
    const root = tempDir()
    mkdirSync(join(root, '子目录'), { recursive: true })
    writeFile(join(root, '子目录'), '会议.docx', 'session-bytes')
    register({ root })

    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openFromSession, eventOf(9), 'thread-1', '子目录/会议.docx')
    )
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.document.displayPath).toBe('子目录/会议.docx')
    expect(opened.document.displayName).toBe('会议.docx')
    expect(opened.document.readOnly).toBe(false)
  })

  it('readOnly 透传；越权（../ 逃出会话根）直接抛人话，注册表不动', async () => {
    const root = tempDir()
    writeFile(root, 'ok.docx', 'inside')
    const outside = writeFile(tempDir(), 'outside.docx', 'outside')
    const handle = register({ root })

    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openFromSession, eventOf(1), 'thread-1', 'ok.docx', true)
    )
    expect(opened).toMatchObject({ ok: true, document: { readOnly: true } })

    await expect(
      invoke(IPC_CHANNELS.office.openFromSession, eventOf(1), 'thread-1', '../outside.docx')
    ).rejects.toThrow(/工作区之外/)
    expect(handle.documents.size()).toBe(1)

    // 绝对路径也不认：resolve 之后越界/文件在根外，一律拒
    await expect(
      invoke(IPC_CHANNELS.office.openFromSession, eventOf(1), 'thread-1', outside)
    ).rejects.toThrow()
  })
})

describe('owner 校验与 destroyed 清算', () => {
  it('别的 sender 读同一个 documentId：forbidden；release 也是空操作', async () => {
    const path = writeFile(tempDir(), '归属.docx', 'owned')
    register({ env: { KYCLAW_OFFICE_OPEN: path } })
    const ownerEvent = eventOf(1)
    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, ownerEvent)
    )
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const id = opened.document.documentId

    expect(
      officeReadResultSchema.parse(await invoke(IPC_CHANNELS.office.read, eventOf(2), id))
    ).toMatchObject({ ok: false, code: 'forbidden' })
    await invoke(IPC_CHANNELS.office.release, eventOf(2), id)

    // 另一个窗口再次打开同一文件：拒绝（不允许两边各开一份）
    expect(
      officeOpenResultSchema.parse(await invoke(IPC_CHANNELS.office.openDialog, eventOf(2)))
    ).toMatchObject({ ok: false, code: 'already-open-elsewhere' })

    // 原 owner 仍然可读
    expect(
      officeReadResultSchema.parse(await invoke(IPC_CHANNELS.office.read, ownerEvent, id))
    ).toMatchObject({ ok: true })
  })

  it('webContents destroyed：注册表里属于它的条目被清掉（别的窗口不动）', async () => {
    const root = tempDir()
    writeFile(root, 'a.docx', 'a')
    writeFile(root, 'b.docx', 'b')
    const handle = register({ root })

    const openedA = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openFromSession, eventOf(1), 'thread-1', 'a.docx')
    )
    const openedB = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openFromSession, eventOf(2), 'thread-1', 'b.docx')
    )
    expect(openedA.ok && openedB.ok).toBe(true)
    expect(handle.documents.size()).toBe(2)

    // 只触发窗口 1 的 destroyed（窗口 2 的条目必须留着）
    for (const { id, listener } of [...mocks.destroyed]) {
      if (id === 1) listener()
    }
    expect(handle.documents.size()).toBe(1)

    // 窗口 2 仍能读自己的文档；窗口 1 的 id 已释放（forbidden）
    if (openedB.ok) {
      expect(
        officeReadResultSchema.parse(
          await invoke(IPC_CHANNELS.office.read, eventOf(2), openedB.document.documentId)
        )
      ).toMatchObject({ ok: true })
    }
    if (openedA.ok) {
      expect(
        officeReadResultSchema.parse(
          await invoke(IPC_CHANNELS.office.read, eventOf(1), openedA.document.documentId)
        )
      ).toMatchObject({ ok: false, code: 'forbidden' })
    }
  })
})

describe('office:save（S3 写链路接线）', () => {
  it('save / saveAs 入参闸门：坏形状直接抛 IpcInputError，不碰注册表', async () => {
    const handle = register({})
    const event = eventOf(1)
    const badSaveArgs: unknown[][] = [
      [],
      [{}],
      [{ documentId: 'd', bytes: 'not-bytes' }],
      [{ documentId: '', bytes: new Uint8Array([1]) }],
      [{ documentId: 'd', bytes: new Uint8Array([1]), extra: true }]
    ]
    for (const args of badSaveArgs) {
      await expect(invoke(IPC_CHANNELS.office.save, event, ...args)).rejects.toBeInstanceOf(
        IpcInputError
      )
    }
    const badSaveAsArgs: unknown[][] = [[], [{}], [{ documentId: 'd', bytes: 'x' }]]
    for (const args of badSaveAsArgs) {
      await expect(invoke(IPC_CHANNELS.office.saveAs, event, ...args)).rejects.toBeInstanceOf(
        IpcInputError
      )
    }
    // schema 与 handler 用同一份（直接打闸门）
    expect(() =>
      parseIpcArgs(officeSaveArgsSchema, [{ documentId: 'd', bytes: new Uint8Array([1]) }], 'x')
    ).not.toThrow()
    expect(() =>
      parseIpcArgs(officeSaveAsArgsSchema, [{ documentId: 'd', bytes: new Uint8Array([1]) }], 'x')
    ).not.toThrow()
    expect(handle.documents.size()).toBe(0)
  })

  it('保存成功：磁盘变、read 回新 sha、结果过 officeSaveResultSchema；owner 不符 forbidden', async () => {
    const path = writeFile(tempDir(), '写入.docx', 'v1-bytes')
    register({ env: { KYCLAW_OFFICE_OPEN: path } })
    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    if (!opened.ok) throw new Error('打开失败')
    const next = new TextEncoder().encode('v2-saved-bytes')

    const saved = officeSaveResultSchema.parse(
      await invoke(IPC_CHANNELS.office.save, eventOf(1), {
        documentId: opened.document.documentId,
        expectedSha256: opened.document.sha256,
        bytes: next
      })
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.sha256).toBe(createHash('sha256').update(Buffer.from(next)).digest('hex'))
    expect(readFileSync(path, 'utf8')).toBe('v2-saved-bytes')

    const read = officeReadResultSchema.parse(
      await invoke(IPC_CHANNELS.office.read, eventOf(1), opened.document.documentId)
    )
    expect(read.ok && read.document.sha256).toBe(saved.sha256)

    // 另一个 sender 写同一个 id：forbidden（分类回包，不抛）
    expect(
      officeSaveResultSchema.parse(
        await invoke(IPC_CHANNELS.office.save, eventOf(2), {
          documentId: opened.document.documentId,
          bytes: next
        })
      )
    ).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('写前冲突：外部改文件后保存回 conflict + disk 版本，磁盘不被覆盖', async () => {
    const path = writeFile(tempDir(), '冲突.docx', 'v1')
    register({ env: { KYCLAW_OFFICE_OPEN: path } })
    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    if (!opened.ok) throw new Error('打开失败')
    writeFileSync(path, '外部改过的内容')

    const result = officeSaveResultSchema.parse(
      await invoke(IPC_CHANNELS.office.save, eventOf(1), {
        documentId: opened.document.documentId,
        expectedSha256: opened.document.sha256,
        bytes: new TextEncoder().encode('覆盖')
      })
    )
    expect(result).toMatchObject({ ok: false, code: 'conflict' })
    if (result.ok) return
    expect(result.disk?.sha256).toBe(
      createHash('sha256').update(Buffer.from('外部改过的内容')).digest('hex')
    )
    expect(readFileSync(path, 'utf8')).toBe('外部改过的内容')
  })

  it('写失败分类透传：EPERM → write-locked（注入写 IO）', async () => {
    const path = writeFile(tempDir(), '占用.docx', 'v1')
    const io: OfficeDocumentIo = {
      ...defaultOfficeDocumentIo,
      writeFileExclusive: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      unlink: async () => undefined
    }
    register({ env: { KYCLAW_OFFICE_OPEN: path }, io })
    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    if (!opened.ok) throw new Error('打开失败')
    const result = officeSaveResultSchema.parse(
      await invoke(IPC_CHANNELS.office.save, eventOf(1), {
        documentId: opened.document.documentId,
        bytes: new TextEncoder().encode('x')
      })
    )
    expect(result).toMatchObject({ ok: false, code: 'write-locked' })
  })
})

describe('office:save-as（S3 另存为接线）', () => {
  it('对话框取消是一等结果 cancelled；选中路径成功 → 注册表重定向', async () => {
    const directory = tempDir()
    const path = writeFile(directory, '原件.docx', 'origin')
    const dialogs: number[] = []
    const handle = register({
      env: { KYCLAW_OFFICE_OPEN: path },
      showSaveDialog: async () => {
        dialogs.push(1)
        return { canceled: true }
      }
    })
    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    if (!opened.ok) throw new Error('打开失败')
    const cancelled = officeSaveAsResultSchema.parse(
      await invoke(IPC_CHANNELS.office.saveAs, eventOf(1), {
        documentId: opened.document.documentId,
        bytes: new TextEncoder().encode('x')
      })
    )
    expect(cancelled).toMatchObject({ ok: false, code: 'cancelled' })
    expect(dialogs).toHaveLength(1)
    expect(handle.documents.info(opened.document.documentId, 1)?.absolutePath).toBe(
      realpathSync.native(path)
    )

    // 成功路径：对话框给一个目标文件 → 写盘 + document 重定向（documentId 不变）
    const target = join(directory, '另存为.docx')
    register({
      env: { KYCLAW_OFFICE_OPEN: path },
      showSaveDialog: async () => ({ canceled: false, filePath: target })
    })
    const opened2 = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    if (!opened2.ok) throw new Error('打开失败')
    const saved = officeSaveAsResultSchema.parse(
      await invoke(IPC_CHANNELS.office.saveAs, eventOf(1), {
        documentId: opened2.document.documentId,
        bytes: new TextEncoder().encode('另存内容')
      })
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.document.documentId).toBe(opened2.document.documentId)
    expect(saved.document.displayName).toBe('另存为.docx')
    expect(saved.document.absolutePath).toBe(realpathSync.native(target))
    expect(readFileSync(target, 'utf8')).toBe('另存内容')
  })

  it('KYCLAW_OFFICE_SAVE_AS 绕过保存对话框；打包态忽略 env（走对话框）', async () => {
    const directory = tempDir()
    const path = writeFile(directory, '原件2.docx', 'origin')
    const scriptedTarget = join(directory, 'env另存.docx')
    register({
      env: { KYCLAW_OFFICE_OPEN: path, KYCLAW_OFFICE_SAVE_AS: scriptedTarget }
    })
    const opened = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openDialog, eventOf(1))
    )
    if (!opened.ok) throw new Error('打开失败')
    const saved = officeSaveAsResultSchema.parse(
      await invoke(IPC_CHANNELS.office.saveAs, eventOf(1), {
        documentId: opened.document.documentId,
        bytes: new TextEncoder().encode('env-bytes')
      })
    )
    expect(saved.ok).toBe(true)
    expect(readFileSync(scriptedTarget, 'utf8')).toBe('env-bytes')

    // 打包态：env 不生效 → 对话框被调用（这里注入取消）。用会话入口打开，避免再碰打开侧 dialog
    mocks.handlers.clear()
    let dialogCalls = 0
    register({
      root: directory,
      env: { KYCLAW_OFFICE_OPEN: path, KYCLAW_OFFICE_SAVE_AS: scriptedTarget },
      isPackaged: true,
      showSaveDialog: async () => {
        dialogCalls += 1
        return { canceled: true }
      }
    })
    const opened2 = officeOpenResultSchema.parse(
      await invoke(IPC_CHANNELS.office.openFromSession, eventOf(1), 'thread-1', '原件2.docx')
    )
    if (!opened2.ok) throw new Error('打开失败')
    expect(
      officeSaveAsResultSchema.parse(
        await invoke(IPC_CHANNELS.office.saveAs, eventOf(1), {
          documentId: opened2.document.documentId,
          bytes: new TextEncoder().encode('x')
        })
      )
    ).toMatchObject({ ok: false, code: 'cancelled' })
    expect(dialogCalls).toBe(1)
  })

  it('scriptedOfficeSaveAsPath：仅未打包 + 非空值才生效', () => {
    expect(scriptedOfficeSaveAsPath({ KYCLAW_OFFICE_SAVE_AS: 'D:\\a.docx' }, false)).toBe(
      'D:\\a.docx'
    )
    expect(scriptedOfficeSaveAsPath({ KYCLAW_OFFICE_SAVE_AS: '  ' }, false)).toBeUndefined()
    expect(scriptedOfficeSaveAsPath({}, false)).toBeUndefined()
    expect(scriptedOfficeSaveAsPath({ KYCLAW_OFFICE_SAVE_AS: 'D:\\a.docx' }, true)).toBeUndefined()
    // 打开侧的 env 不受影响（两条独立）
    expect(scriptedOfficeOpenPath({ KYCLAW_OFFICE_OPEN: 'D:\\b.docx' }, false)).toBe('D:\\b.docx')
  })
})

/**
 * task-80（新增标签页 v1）：唯一新通道 `office:create-blank`。
 * 钉：只收 docx / 模板落到注入的临时目录 `kyclaw/未命名-<ts>.docx` / 注册回 info（displayName
 * = 未命名文档）/ 容量拒绝时不留垃圾 / release 后临时文件尽力清理。
 */
describe('office:create-blank（task-80 新建空白 Word 文档）', () => {
  it('写模板到 %TEMP%/kyclaw、注册回 OfficeDocumentInfo（displayName=未命名文档）；release 清临时文件', async () => {
    const temp = tempDir()
    register({ tempDir: temp })
    const event = eventOf(1)

    const result = (await invoke(IPC_CHANNELS.office.createBlank, event, {
      kind: 'docx'
    })) as {
      ok: boolean
      document?: { documentId: string; displayName: string; displayPath: string; size: number }
      alreadyOpen?: boolean
    }

    expect(result.ok).toBe(true)
    expect(result.alreadyOpen).toBe(false)
    expect(result.document?.displayName).toBe('未命名文档')
    expect(result.document?.displayPath).toContain(join(temp, 'kyclaw'))
    expect(result.document?.displayPath).toMatch(/未命名-\d+\.docx$/)
    expect(result.document?.size ?? 0).toBeGreaterThan(0)

    // 落盘是合法 zip（docx 以 PK 开头），不是空占位
    const path = result.document?.displayPath ?? ''
    const bytes = readFileSync(path)
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(bytes.length).toBe(result.document?.size)

    // 关标签（release）→ 未另存为的临时文件被清掉
    await invoke(IPC_CHANNELS.office.release, event, result.document?.documentId)
    expect(existsSync(path)).toBe(false)
  })

  it('入参闸门：只接受 {kind:"docx"}（xlsx / 多余字段 / 缺参都直接拒，不写文件）', async () => {
    const temp = tempDir()
    register({ tempDir: temp })
    const event = eventOf(1)

    await expect(invoke(IPC_CHANNELS.office.createBlank, event, { kind: 'xlsx' })).rejects.toThrow()
    await expect(
      invoke(IPC_CHANNELS.office.createBlank, event, { kind: 'docx', extra: 1 })
    ).rejects.toThrow()
    await expect(invoke(IPC_CHANNELS.office.createBlank, event)).rejects.toThrow()
    expect(existsSync(join(temp, 'kyclaw'))).toBe(false)
  })

  it('容量拒绝（注册表已满）：回 too-many-open 且不留下临时文件', async () => {
    const temp = tempDir()
    const seed = tempDir()
    const seedPath = writeFile(seed, '已有.docx')
    const documents = createOfficeDocuments(defaultOfficeDocumentIo, { maxOpenDocuments: 1 })
    const opened = await documents.open(seedPath, {
      owner: 1,
      openedFrom: 'picker',
      displayPath: seedPath
    })
    expect(opened.ok).toBe(true)
    register({ tempDir: temp, documents, env: {} })

    const result = (await invoke(IPC_CHANNELS.office.createBlank, eventOf(1), {
      kind: 'docx'
    })) as { ok: boolean; code?: string }

    expect(result.ok).toBe(false)
    expect(result.code).toBe('too-many-open')
    // 临时模板写出来后发现注册被拒 → 已清理，目录里不残留
    const leftover = existsSync(join(temp, 'kyclaw')) ? readdirSync(join(temp, 'kyclaw')) : []
    expect(leftover).toEqual([])
  })
})
