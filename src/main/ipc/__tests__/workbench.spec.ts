import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
/**
 * workbench / terminal 两组通道的 handler：
 *   1. 通道都注册了、入参先过闸门（非法调用不碰磁盘、不起进程）；
 *   2. 会话根在主进程解析（项目 → 默认工作区下的会话子目录（round 55）→ 唯一授权目录），判不出给人话；
 *   3. 文件/Git 把结果原样回吐；终端把 id 与发起它的 webContents 对上并推输出/退出。
 *
 * 交给系统的那几条路径（reveal / open）在断言里要过一遍 `canonical()`：`revealTarget` 走
 * `resolveInsideWorkspace`，那里用 `realpathSync.native` 归一 —— Windows 上会把 8.3 短名展开成
 * 长名（本机 tmpdir 是 `C:\LMSTUD~1`，native realpath 给 `C:\lmstudio-temp`）。不归一的话这些
 * 断言在"临时目录带短名"的机器上必红，而那与被测行为无关。
 */
const canonical = (path: string): string => realpathSync.native(path)
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>(),
    send: vi.fn(),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    destroyedListeners: [] as Array<() => void>
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder }
}))

import { IPC_CHANNELS, IpcInputError, WORKBENCH_LOG_LIMIT } from '../../../shared/ipc'
import { sessionDirOf } from '../../../shared/session-dir'
import { defaultSettings } from '../../../shared/settings'
import { readSettings, settingsPath, writeSettings } from '../../settings'
import {
  createOfficePreviewRequests,
  createTerminalSink,
  registerWorkbenchIpc,
  type WorkbenchDeps
} from '../workbench'
import { createOfficePreview, type OfficePreviewRunSpec } from '../../office-preview'
import type { TerminalService } from '../../workbench-terminal'

const EVENT = {
  sender: {
    id: 42,
    send: mocks.send,
    isDestroyed: () => false,
    once: (_event: string, listener: () => void) => {
      mocks.destroyedListeners.push(listener)
    }
  }
}

/** 另一个窗口（测"取消绑发起者"用）：同一个形状，只有 id 不同 */
const OTHER_WINDOW = {
  sender: {
    id: 7,
    send: mocks.send,
    isDestroyed: () => false,
    once: (_event: string, listener: () => void) => {
      mocks.destroyedListeners.push(listener)
    }
  }
}

/** 一份真的最小 PDF（`readPreviewPdf` 认头认尾，回包里的字节就是它） */
const PROBE_PDF = Buffer.from('%PDF-1.7\nprobe\n%%EOF\n')

/** 办公档转换的假引擎现场：跑过的 spec、读到的输入副本、自建过的临时目录，以及一道可选闸门 */
const officeDirs: string[] = []
function fakeOfficePreview(options: { pdf?: Buffer | null; gate?: () => Promise<void> } = {}): {
  preview: ReturnType<typeof createOfficePreview>
  runs: OfficePreviewRunSpec[]
  copies: Buffer[]
  dirs: string[]
} {
  const runs: OfficePreviewRunSpec[] = []
  const copies: Buffer[] = []
  const dirs: string[] = []
  const preview = createOfficePreview(
    {},
    {
      // 一个真进程都不起：引擎那层由 `run` 接管（kit 的解析也不跟着开发机变）
      kitCli: 'C:/fake/libreoffice-kit/cli.js',
      run: async (spec) => {
        runs.push(spec)
        // 引擎"读"到的那份输入：就是服务自己落的副本（不是用户文件那条路径）
        const input = spec.args[spec.args.indexOf('--input') + 1]
        if (typeof input === 'string') copies.push(readFileSync(input))
        await options.gate?.()
        const output = spec.args[spec.args.indexOf('--output') + 1]
        const pdf = options.pdf === undefined ? PROBE_PDF : options.pdf
        if (output !== undefined && pdf !== null) writeFileSync(output, pdf)
        return {
          spawnError: null,
          aborted: false,
          timedOut: false,
          exitCode: 0,
          text: `${JSON.stringify({ backend: 'native', missingFonts: ['字体A'] })}\n`
        }
      },
      makeTempDir: async () => {
        const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-preview-ipc-'))
        dirs.push(directory)
        officeDirs.push(directory)
        return directory
      }
    }
  )
  return { preview, runs, copies, dirs }
}

/** 在会话根里落一份真的 docx（产出器产的就是真文件）；`directory` 可以指定子目录 */
async function writeDocxFixture(
  name = '方案.docx',
  text = '正文一段',
  directory = project
): Promise<void> {
  const { renderDocx } = await import('../../../mastra/tools/docx')
  writeFileSync(
    join(directory, name),
    await renderDocx({ title: '方案', blocks: [{ type: 'paragraph', text }] })
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

/** 假终端服务：只记调用，不起真进程 */
function fakeTerminals(): TerminalService & {
  calls: { start: unknown[][]; write: unknown[][]; resize: unknown[][]; dispose: string[] }
} {
  const calls = {
    start: [] as unknown[][],
    write: [] as unknown[][],
    resize: [] as unknown[][],
    dispose: [] as string[]
  }
  const terminals: TerminalService = {
    start: async (id, owner, cwd, cols, rows) => {
      calls.start.push([id, owner, cwd, cols, rows])
      return { id, shell: 'D:\\Git\\bin\\bash.exe', cwd }
    },
    write: (id, data) => {
      calls.write.push([id, data])
    },
    resize: (id, cols, rows) => {
      calls.resize.push([id, cols, rows])
    },
    dispose: (id) => {
      calls.dispose.push(id)
    },
    disposeByOwner: (owner) => {
      calls.dispose.push(`owner:${owner}`)
    },
    disposeAll: () => undefined,
    ids: () => []
  }
  return Object.assign(terminals, { calls })
}

let dir: string
let project: string
let terminals: ReturnType<typeof fakeTerminals>
/** 默认注入的办公档假引擎（**任何用例都不许起真进程**：没注入就会走懒建的真件） */
let office: ReturnType<typeof fakeOfficePreview>

beforeEach(() => {
  mocks.handlers.clear()
  mocks.send.mockReset()
  mocks.openPath.mockReset()
  mocks.openPath.mockResolvedValue('')
  mocks.showItemInFolder.mockReset()
  mocks.destroyedListeners.length = 0

  dir = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-ipc-'))
  project = join(dir, '工作区')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'README.md'), '# 标题\n')
  mkdirSync(join(dir, '别的'), { recursive: true })

  terminals = fakeTerminals()
  office = fakeOfficePreview()
  const deps: WorkbenchDeps = {
    terminals,
    officePreview: office.preview,
    git: () => ({ run: async () => ({ text: '', exitCode: 0, failed: false, spawnError: null }) })
  }
  registerWorkbenchIpc(dir, deps)
  writeSettings(settingsPath(dir), {
    ...defaultSettings(),
    workspaces: [{ path: project, mode: 'ask' }]
  })
})

afterEach(() => {
  for (const directory of officeDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  rmSync(dir, { recursive: true, force: true })
})

/** 换一台"带闸门的假引擎"重新注册（取消类用例要在转换跑起来之后再动手） */
function registerWithGate(gate: () => Promise<void>): { runs: OfficePreviewRunSpec[] } {
  const next = fakeOfficePreview({ gate })
  mocks.handlers.clear()
  registerWorkbenchIpc(dir, {
    terminals,
    officePreview: next.preview,
    git: () => ({ run: async () => ({ text: '', exitCode: 0, failed: false, spawnError: null }) })
  })
  return { runs: next.runs }
}

/** 等某个条件成立（不引入假计时器：闸门用真 Promise） */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('通道注册与入参闸门', () => {
  it('十八条通道都注册了（本轮新增文本分页两条）', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'terminal:dispose',
      'terminal:resize',
      'terminal:start',
      'terminal:write',
      'workbench:cancel-office-pdf',
      'workbench:git-log',
      'workbench:git-overview',
      'workbench:git-show',
      'workbench:list-dir',
      'workbench:office-pdf',
      'workbench:open',
      'workbench:read-bytes',
      'workbench:read-file',
      'workbench:read-text-page',
      'workbench:reveal',
      'workbench:search',
      'workbench:table-bytes',
      'workbench:text-version'
    ])
  })

  it('相对路径族（list-dir / read-file / read-bytes / reveal / open）：缺参、空 threadId、走样一律拒', async () => {
    // 同步的那三个（立刻给人话）
    for (const channel of [IPC_CHANNELS.workbench.listDir, IPC_CHANNELS.workbench.readFile]) {
      const handler = handlerOf(channel)
      for (const args of [[], [''], ['t'], ['t', 1], ['t', 'a', 'b']]) {
        expect(() => handler(EVENT, ...args), `${channel} ${JSON.stringify(args)}`).toThrow(
          IpcInputError
        )
      }
    }

    // round 43：read-bytes 变 async（办公档的解包是异步的）—— 闸门照旧，拒的方式是 reject
    const readBytes = handlerOf(IPC_CHANNELS.workbench.readBytes)
    for (const args of [[], [''], ['t'], ['t', 1], ['t', 'a', 'b']]) {
      await expect(readBytes(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }

    // reveal 与 open 都是 async（要 await shell）、闸门同一套
    for (const channel of [IPC_CHANNELS.workbench.reveal, IPC_CHANNELS.workbench.open]) {
      const handler = handlerOf(channel)
      for (const args of [[], [''], ['t'], ['t', 1], ['t', 'a', 'b']]) {
        await expect(handler(EVENT, ...args), `${channel} ${JSON.stringify(args)}`).rejects.toThrow(
          IpcInputError
        )
      }
    }
  })

  it('git-log 的条数上限与 git-show 的 sha 非空都过闸门', async () => {
    const log = handlerOf(IPC_CHANNELS.workbench.gitLog)
    for (const args of [['t'], ['t', 0], ['t', WORKBENCH_LOG_LIMIT + 1]]) {
      await expect(log(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }

    const show = handlerOf(IPC_CHANNELS.workbench.gitShow)
    for (const args of [['t', ''], ['t']]) {
      await expect(show(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }
  })

  it('read-text-page / text-version 的入参闸门（游标是可选的第三参）', async () => {
    const page = handlerOf(IPC_CHANNELS.workbench.readTextPage)
    for (const args of [
      [],
      ['t'],
      [''],
      ['t', 1],
      ['t', 'a.txt', '不是游标'], // 第三参只收 null 或 { offset, version }
      ['t', 'a.txt', { offset: -1, version: 'v' }],
      ['t', 'a.txt', { offset: 0 }],
      ['t', 'a.txt', { offset: 0, version: '' }],
      ['t', 'a.txt', null, '第四个']
    ]) {
      await expect(page(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }

    const version = handlerOf(IPC_CHANNELS.workbench.textVersion)
    for (const args of [[], [''], ['t'], ['t', 1], ['t', 'a', 'b']]) {
      expect(() => version(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }
  })

  it('office-pdf / cancel-office-pdf / table-bytes 的入参闸门', async () => {
    const officePdf = handlerOf(IPC_CHANNELS.workbench.officePdf)
    for (const args of [
      [],
      ['t'],
      ['t', '方案.docx'],
      ['t', '方案.docx', 'foreground'],
      ['', '方案.docx', 'foreground', 'r1'],
      ['t', '方案.docx', '前台', 'r1'],
      ['t', '方案.docx', 'foreground', ''],
      ['t', '方案.docx', 'foreground', 'r1', '第五个']
    ]) {
      await expect(officePdf(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }

    const cancel = handlerOf(IPC_CHANNELS.workbench.cancelOfficePdf)
    for (const args of [[], [''], [1]]) {
      expect(() => cancel(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    const table = handlerOf(IPC_CHANNELS.workbench.tableBytes)
    for (const args of [[], [''], ['t'], ['t', 1], ['t', 'a', 'b']]) {
      await expect(table(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }
    // 这些非法入参一个都不该碰到引擎
    expect(office.runs).toHaveLength(0)
  })

  it('search 的入参闸门：缺参 / 空 query / 一个字 / 走样的 mode 一律拒', () => {
    const search = handlerOf(IPC_CHANNELS.workbench.search)
    for (const args of [
      [],
      ['t'],
      ['t', 'ab'],
      ['t', 'a', 'name'],
      ['t', '  a  ', 'name'],
      ['t', 'ab', 'filename'],
      ['t', '', 'content']
    ]) {
      expect(() => search(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    // 两个字起步就放行（trim 之后够长才算）
    expect(() => search(EVENT, 't', ' ab ', 'name')).not.toThrow()
    expect(() => search(EVENT, 't', '中文', 'content')).not.toThrow()
  })

  it('search：会话根在主进程解析，结果只有相对路径', () => {
    const result = handlerOf(IPC_CHANNELS.workbench.search)(EVENT, 't', 'readme', 'name') as {
      results: { path: string; name: string }[]
      scanned: number
    }
    expect(result.results).toEqual([{ path: 'README.md', name: 'README.md' }])
    expect(result.scanned).toBeGreaterThan(0)

    // 没有工作区 / 多条并列：与文件族同一句人话
    writeSettings(settingsPath(dir), { ...defaultSettings() })
    expect(() => handlerOf(IPC_CHANNELS.workbench.search)(EVENT, 't', 'readme', 'name')).toThrow(
      /还没有工作区/
    )
  })

  it('terminal 四条的入参闸门（尺寸必须是 1..1000 的整数）', async () => {
    const start = handlerOf(IPC_CHANNELS.terminal.start)
    for (const args of [
      [],
      ['t'],
      ['t', 80],
      ['t', 0, 24],
      ['t', 80, 0],
      ['t', 80.5, 24],
      ['t', 80, 24, 1]
    ]) {
      await expect(start(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }
    expect(terminals.calls.start).toHaveLength(0)

    const write = handlerOf(IPC_CHANNELS.terminal.write)
    expect(() => write(EVENT, '')).toThrow(IpcInputError)
    write(EVENT, 't1', '') // 空串是合法的（修饰键单独到达）

    const resize = handlerOf(IPC_CHANNELS.terminal.resize)
    expect(() => resize(EVENT, 't1', 80)).toThrow(IpcInputError)

    const dispose = handlerOf(IPC_CHANNELS.terminal.dispose)
    expect(() => dispose(EVENT)).toThrow(IpcInputError)
  })
})

describe('文件族', () => {
  it('list-dir：回一层目录（会话根在主进程解析）', async () => {
    const result = (await handlerOf(IPC_CHANNELS.workbench.listDir)(EVENT, 't', '')) as {
      entries: { name: string }[]
      truncated: boolean
    }
    expect(result.entries.map((entry) => entry.name).sort()).toEqual(['README.md', 'src'])
    expect(result.truncated).toBe(false)
  })

  it('read-file：文本档回内容；越权路径给人话错误', async () => {
    const preview = await handlerOf(IPC_CHANNELS.workbench.readFile)(EVENT, 't', 'README.md')
    expect(preview).toEqual({
      kind: 'text',
      text: '# 标题\n',
      size: Buffer.byteLength('# 标题\n'),
      truncated: false
    })

    expect(() => handlerOf(IPC_CHANNELS.workbench.readFile)(EVENT, 't', '../别的')).toThrow(
      /路径不可用/
    )
  })

  it('read-text-page / text-version：真读一页（会话根 + 相对路径 + 版本）；越权给人话', async () => {
    const page = (await handlerOf(IPC_CHANNELS.workbench.readTextPage)(
      EVENT,
      't',
      'README.md',
      null
    )) as {
      kind: string
      text: string
      nextOffset: number
      size: number
      version: string
      eof: boolean
    }
    expect(page.kind).toBe('page')
    expect(page.text).toBe('# 标题\n')
    expect(page.nextOffset).toBe(Buffer.byteLength('# 标题\n'))
    expect(page.eof).toBe(true)

    const version = handlerOf(IPC_CHANNELS.workbench.textVersion)(EVENT, 't', 'README.md') as {
      kind: string
      version: string
      size: number
    }
    expect(version.kind).toBe('version')
    expect(version.version).toBe(page.version)
    expect(version.size).toBe(page.size)

    await expect(
      handlerOf(IPC_CHANNELS.workbench.readTextPage)(EVENT, 't', '../别的', null)
    ).rejects.toThrow(/路径不可用/)
    expect(() => handlerOf(IPC_CHANNELS.workbench.textVersion)(EVENT, 't', '../别的')).toThrow(
      /路径不可用/
    )
  })

  it('read-bytes：认得的后缀回字节（Uint8Array），认不出回 unsupported；越权路径给人话', async () => {
    writeFileSync(
      join(project, '图片.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    const result = (await handlerOf(IPC_CHANNELS.workbench.readBytes)(EVENT, 't', '图片.png')) as {
      kind: string
      format: string
      bytes: Uint8Array
      size: number
    }
    expect(result.kind).toBe('bytes')
    expect(result.format).toBe('image-png')
    expect(result.size).toBe(8)
    expect(Array.from(result.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const unsupported = await handlerOf(IPC_CHANNELS.workbench.readBytes)(EVENT, 't', 'README.md')
    expect(unsupported).toEqual({ kind: 'unsupported', size: Buffer.byteLength('# 标题\n') })

    await expect(
      handlerOf(IPC_CHANNELS.workbench.readBytes)(EVENT, 't', '../别的')
    ).rejects.toThrow(/路径不可用/)
  })

  it('read-bytes：办公档（docx/xlsx）真过桥回抽好的结构，不是原始字节', async () => {
    const { renderDocx } = await import('../../../mastra/tools/docx')
    const { renderXlsx } = await import('../../../mastra/tools/excel')
    writeFileSync(
      join(project, '方案.docx'),
      await renderDocx({ blocks: [{ type: 'paragraph', text: '正文一段' }] })
    )
    writeFileSync(
      join(project, '台账.xlsx'),
      await renderXlsx([{ name: '汇总', rows: [['项目'], ['房租']] }])
    )

    expect(await handlerOf(IPC_CHANNELS.workbench.readBytes)(EVENT, 't', '方案.docx')).toEqual({
      kind: 'docx',
      markdown: '正文一段',
      truncated: false
    })
    expect(await handlerOf(IPC_CHANNELS.workbench.readBytes)(EVENT, 't', '台账.xlsx')).toEqual({
      kind: 'xlsx',
      sheets: [{ name: '汇总', rows: [['项目'], ['房租']], truncated: false }],
      truncated: false
    })
    // round 54：满载全跑里这条两次顶穿 5s 默认超时（单跑 <1s）——体内现导入 docx/exceljs 并真渲染，
    // 与 round37 的同类去抖一致：给足超时，不放宽断言
  }, 30_000)

  it('reveal：目录走 shell.openPath，文件走 showItemInFolder', async () => {
    await handlerOf(IPC_CHANNELS.workbench.reveal)(EVENT, 't', 'src')
    expect(mocks.openPath).toHaveBeenCalledWith(canonical(join(project, 'src')))
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()

    await handlerOf(IPC_CHANNELS.workbench.reveal)(EVENT, 't', 'README.md')
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(canonical(join(project, 'README.md')))
  })

  it('openPath 回非空 = 没打开成：转成人话错误', async () => {
    mocks.openPath.mockResolvedValueOnce('拒绝访问')
    await expect(handlerOf(IPC_CHANNELS.workbench.reveal)(EVENT, 't', 'src')).rejects.toThrow(
      /打不开这个文件夹：拒绝访问/
    )
  })

  /* round 77：workbench:open —— 用系统默认应用打开文件（个人 PC 上通常就是 Word / WPS / Excel） */
  it('open：文件交给 shell.openPath（本机默认应用），回真正给出去的那条绝对路径', async () => {
    const result = await handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', 'README.md')
    expect(mocks.openPath).toHaveBeenCalledWith(canonical(join(project, 'README.md')))
    // 与 reveal 分工不同：这里**不**走 showItemInFolder（那是"在资源管理器里定位"）
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
    expect(result).toEqual({ path: canonical(join(project, 'README.md')) })
  })

  it('open：目录一律拒（打开文件夹是 reveal 的语义，别混），也不碰 shell', async () => {
    await expect(handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', 'src')).rejects.toThrow(
      /这是一个文件夹/
    )
    expect(mocks.openPath).not.toHaveBeenCalled()
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it('open：越界路径与不存在的文件都拒（containment / 存在性与 reveal 同一条闸门）', async () => {
    await expect(handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', '../别的')).rejects.toThrow(
      /路径不可用/
    )
    await expect(
      handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', '没有这个.docx')
    ).rejects.toThrow(/不在磁盘上/)
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('open：只把文档/媒体交给系统 —— 可执行文件、脚本、快捷方式、**网页与可脚本化 SVG** 一律拒（不碰 shell）', async () => {
    for (const name of [
      '安装包.exe',
      '更新.bat',
      'run.ps1',
      '脚本.js',
      '快捷方式.lnk',
      'noext',
      // 本轮新增：网页与可脚本化 SVG 在预览里"永不执行"，交给 ShellExecute（浏览器）就等于执行
      '页面.html',
      '页面.htm',
      '矢量图.svg'
    ]) {
      writeFileSync(join(project, name), 'x')
      await expect(handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', name), name).rejects.toThrow(
        /不用系统应用打开这类文件/
      )
    }
    expect(mocks.openPath).not.toHaveBeenCalled()

    // 放行的那些照旧走 shell（含旧版 Office、纯文本与光栅/图标图片）
    for (const name of ['方案.docx', '旧方案.doc', '说明.md', '笔记.txt', '图标.ico']) {
      writeFileSync(join(project, name), 'x')
      await handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', name)
    }
    expect(mocks.openPath).toHaveBeenCalledTimes(5)
  })

  it('open：shell.openPath 回非空（系统没能用默认应用打开）→ 人话错误，不假装打开', async () => {
    mocks.openPath.mockResolvedValueOnce('没有与此文件关联的应用')
    await expect(handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', 'README.md')).rejects.toThrow(
      /打不开这个文件（系统没能用默认应用打开它）：没有与此文件关联的应用/
    )
  })

  it('open：会话根判不出时与人话拒绝（与其余工作台通道共用同一句）', async () => {
    writeSettings(settingsPath(dir), { ...defaultSettings() })
    await expect(handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', 'README.md')).rejects.toThrow(
      /还没有工作区/
    )
    expect(mocks.openPath).not.toHaveBeenCalled()
  })
})

describe('会话根解析（与 workspace 通道同口径）', () => {
  // round 55：无项目会话的根是默认工作区下的会话子目录；下面两条钉住"没工作区/多根给人话"不变
  it('没有工作区 / 多条并列：人话拒绝（工作台四工具共用一句）', async () => {
    writeSettings(settingsPath(dir), { ...defaultSettings() })
    expect(() => handlerOf(IPC_CHANNELS.workbench.listDir)(EVENT, 't', '')).toThrow(/还没有工作区/)

    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      workspaces: [
        { path: project, mode: 'ask' },
        { path: join(dir, '别的'), mode: 'ask' }
      ]
    })
    expect(() => handlerOf(IPC_CHANNELS.workbench.listDir)(EVENT, 't', '')).toThrow(/不唯一/)
  })

  it('指认默认工作区后，根是它下面的会话子目录（round 55，解析时顺手建出来）', async () => {
    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      workspaces: [
        { path: project, mode: 'ask' },
        { path: join(dir, '别的'), mode: 'ask' }
      ],
      defaultWorkspace: project
    })
    const sessionDir = sessionDirOf(project, 't')
    const list = async (): Promise<string[]> => {
      const result = (await handlerOf(IPC_CHANNELS.workbench.listDir)(EVENT, 't', '')) as {
        entries: { name: string }[]
      }
      return result.entries.map((entry) => entry.name)
    }

    // 目录由主进程在解析会话根时建出来（引擎要求根真实存在），刚建好时是空的
    expect(existsSync(sessionDir)).toBe(false)
    expect(await list()).toEqual([])
    expect(existsSync(sessionDir)).toBe(true)

    // 会话根确实是它：放进去的文件能列出来，而默认工作区根里的 README.md 不在清单里
    writeFileSync(join(sessionDir, '笔记.md'), 'x')
    expect(await list()).toEqual(['笔记.md'])
  })

  it('读的是当前落盘的设置（改完下一轮就换根）', () => {
    writeSettings(settingsPath(dir), { ...defaultSettings() })
    expect(readSettings(settingsPath(dir)).workspaces).toEqual([])
  })
})

describe('git 族', () => {
  it('gitOverview / gitLog / gitShow 经过注入的 runner 并把结果回吐', async () => {
    mocks.handlers.clear()
    registerWorkbenchIpc(dir, {
      terminals,
      git: () => ({
        run: async (args) => {
          const key = args.join(' ')
          if (key.startsWith('rev-parse --is-inside-work-tree')) {
            return { text: 'true\n', exitCode: 0, failed: false, spawnError: null }
          }
          if (key.startsWith('rev-parse --abbrev-ref')) {
            return { text: 'main\n', exitCode: 0, failed: false, spawnError: null }
          }
          if (key.startsWith('rev-parse --verify')) {
            return { text: 'abc\n', exitCode: 0, failed: false, spawnError: null }
          }
          if (key.startsWith('status --porcelain')) {
            return { text: ' M a.ts\0', exitCode: 0, failed: false, spawnError: null }
          }
          if (key.startsWith('log'))
            return { text: '', exitCode: 0, failed: false, spawnError: null }
          if (key.startsWith('show -s')) {
            return {
              text: 'sha\x1fshort\x1f张三\x1fz@example.com\x1f2026-10-11T10:00:00+08:00\x1f标题\n',
              exitCode: 0,
              failed: false,
              spawnError: null
            }
          }
          return { text: '1\t0\ta.ts\n', exitCode: 0, failed: false, spawnError: null }
        }
      })
    })

    const overview = await handlerOf(IPC_CHANNELS.workbench.gitOverview)(EVENT, 't')
    expect(overview).toEqual({
      isRepo: true,
      empty: false,
      branch: 'main',
      changes: [{ path: 'a.ts', status: 'modified', staged: false }]
    })

    const log = (await handlerOf(IPC_CHANNELS.workbench.gitLog)(EVENT, 't', 5)) as {
      commits: unknown[]
    }
    expect(log.commits).toEqual([])

    const detail = (await handlerOf(IPC_CHANNELS.workbench.gitShow)(EVENT, 't', 'abc')) as {
      author: string
      files: unknown[]
    }
    expect(detail.author).toBe('张三')
    expect(detail.files).toEqual([{ path: 'a.ts', additions: 1, deletions: 0 }])
  })
})

describe('终端族的推送（createTerminalSink）', () => {
  it('按 id 推给发起它的 webContents；退出后那条对应关系就摘掉', () => {
    const senders = new Map<string, unknown>()
    const target = {
      send: mocks.send,
      isDestroyed: () => false
    }
    senders.set('term-1', target as never)
    const sink = createTerminalSink(senders as never)

    sink.data('term-1', 'hello')
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.terminal.data, {
      id: 'term-1',
      data: 'hello'
    })

    sink.exit('term-1', 3)
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.terminal.exit, {
      id: 'term-1',
      exitCode: 3
    })

    // 退过一次就摘了：之后的输出不再推
    mocks.send.mockClear()
    sink.data('term-1', 'late')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('已经销毁的 webContents 不再推（也不抛）', () => {
    const senders = new Map<string, unknown>()
    senders.set('term-2', { send: mocks.send, isDestroyed: () => true } as never)
    const sink = createTerminalSink(senders as never)

    expect(() => sink.data('term-2', 'x')).not.toThrow()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
describe('终端族：handler 把 id / sender / 会话根 / 尺寸交给服务', () => {
  it('start：回会话，并把参数原样交给服务', async () => {
    const session = await handlerOf(IPC_CHANNELS.terminal.start)(EVENT, 't', 120, 40)

    expect(session).toMatchObject({
      shell: String.raw`D:\Git\bin\bash.exe`,
      cwd: project
    })
    expect(terminals.calls.start).toHaveLength(1)
    const [id, owner, cwd, cols, rows] = terminals.calls.start[0] as [
      string,
      number,
      string,
      number,
      number
    ]
    expect(owner).toBe(42)
    expect(cwd).toBe(project)
    expect(cols).toBe(120)
    expect(rows).toBe(40)
    expect(id).toMatch(/^term-42-/)
  })

  it('write / resize / dispose 透传；webContents 销毁后按 owner 清算', async () => {
    await handlerOf(IPC_CHANNELS.terminal.start)(EVENT, 't', 80, 24)
    const id = (terminals.calls.start[0] as [string])[0]

    handlerOf(IPC_CHANNELS.terminal.write)(EVENT, id, 'ls\n')
    handlerOf(IPC_CHANNELS.terminal.resize)(EVENT, id, 100, 30)
    expect(terminals.calls.write).toEqual([[id, 'ls\n']])
    expect(terminals.calls.resize).toEqual([[id, 100, 30]])

    handlerOf(IPC_CHANNELS.terminal.dispose)(EVENT, id)
    expect(terminals.calls.dispose).toContain(id)

    // webContents 销毁 → 按 owner 清算（node-pty 不知道宿主没了）
    for (const listener of mocks.destroyedListeners) listener()
    expect(terminals.calls.dispose).toContain('owner:42')
  })
})

/* ── 办公档页式预览（office-pdf / cancel-office-pdf）────────────────────── */

describe('办公档页式预览：转换与授权', () => {
  it('授权过的 docx 真过一遍队列：回 PDF 字节 + 缺字体 + 版本/代次；引擎只吃到自建目录里的副本', async () => {
    await writeDocxFixture()
    const userFile = readFileSync(join(project, '方案.docx'))

    const result = (await handlerOf(IPC_CHANNELS.workbench.officePdf)(
      EVENT,
      't',
      '方案.docx',
      'foreground',
      'req-1'
    )) as {
      kind: string
      path: string
      version: string
      pdf: Uint8Array
      size: number
      missingFonts: string[]
      generation: string
    }

    expect(result.kind).toBe('pdf')
    expect(result.path).toBe('方案.docx')
    expect(Buffer.from(result.pdf)).toEqual(PROBE_PDF)
    expect(result.size).toBe(PROBE_PDF.byteLength)
    expect(result.missingFonts).toEqual(['字体A'])
    expect(result.generation).toBe(office.preview.getGeneration())
    // 版本与 stat 同口径（`size:mtime`）——这里只核前缀，mtime 由主进程在调用那一刻取
    expect(result.version.startsWith(`${userFile.byteLength}:`)).toBe(true)

    // 引擎被叫了一次，输入是**服务自建目录里的副本**（扩展名钉成 source.docx），字节与用户那份一致
    expect(office.runs).toHaveLength(1)
    const spec = office.runs[0]
    const input = spec.args[spec.args.indexOf('--input') + 1] ?? ''
    const output = spec.args[spec.args.indexOf('--output') + 1] ?? ''
    expect(dirname(input)).toBe(office.dirs[0])
    expect(dirname(output)).toBe(office.dirs[0])
    expect(input.endsWith('source.docx')).toBe(true)
    expect(output.endsWith('preview.pdf')).toBe(true)
    expect(office.copies[0]).toEqual(userFile)
    // 用户文件一个字节没动
    expect(readFileSync(join(project, '方案.docx'))).toEqual(userFile)
    // 收尾：自建临时目录不留
    expect(existsSync(office.dirs[0])).toBe(false)
  })

  it('越权路径照旧抛人话（fail closed），一个引擎调用都不发生', async () => {
    await writeDocxFixture()
    await expect(
      handlerOf(IPC_CHANNELS.workbench.officePdf)(
        EVENT,
        't',
        '../别的/方案.docx',
        'foreground',
        'r1'
      )
    ).rejects.toThrow(/路径不可用/)
    await expect(
      handlerOf(IPC_CHANNELS.workbench.officePdf)(
        EVENT,
        't',
        join(dir, '别的') + '/x.docx',
        'foreground',
        'r2'
      )
    ).rejects.toThrow(/路径不可用/)
    expect(office.runs).toHaveLength(0)
  })

  it('后缀不在四种里 / 文件没了 / 是目录：各自的判别结果（都不碰引擎）', async () => {
    const officePdf = handlerOf(IPC_CHANNELS.workbench.officePdf)
    writeFileSync(join(project, '笔记.txt'), '纯文本\n')
    // 目录也要带 .docx 后缀才会走到"这是一个文件夹"那一支（后缀闸门在最前面 —— 见实现）
    mkdirSync(join(project, '文件夹.docx'))

    expect(await officePdf(EVENT, 't', '笔记.txt', 'foreground', 'r1')).toMatchObject({
      kind: 'failed',
      path: '笔记.txt',
      code: 'unsupported-format'
    })
    expect(await officePdf(EVENT, 't', '没有这个.docx', 'foreground', 'r2')).toMatchObject({
      kind: 'failed',
      code: 'missing'
    })
    await expect(officePdf(EVENT, 't', '文件夹.docx', 'foreground', 'r3')).rejects.toThrow(
      /这是一个文件夹/
    )
    expect(office.runs).toHaveLength(0)
  })

  it('缓存命中也必须先授权：清掉工作区后，即便刚转过也照抛（不查缓存、不碰引擎）', async () => {
    await writeDocxFixture()
    const officePdf = handlerOf(IPC_CHANNELS.workbench.officePdf)
    await expect(officePdf(EVENT, 't', '方案.docx', 'foreground', 'r1')).resolves.toMatchObject({
      kind: 'pdf'
    })
    expect(office.runs).toHaveLength(1)

    // 同一份文件再点一次：命中内容缓存，不再起引擎
    await expect(officePdf(EVENT, 't', '方案.docx', 'foreground', 'r2')).resolves.toMatchObject({
      kind: 'pdf'
    })
    expect(office.runs).toHaveLength(1)

    // 会话根判不出（工作区被移除）→ 连授权都过不去：**缓存不许绕过它**
    writeSettings(settingsPath(dir), { ...defaultSettings() })
    await expect(officePdf(EVENT, 't', '方案.docx', 'foreground', 'r3')).rejects.toThrow(
      /还没有工作区/
    )
    expect(office.runs).toHaveLength(1)
  })

  it('源文件改了（内容变）→ 版本变 → 重新转一次，不拿旧 PDF 充数', async () => {
    await writeDocxFixture('方案.docx', '第一版')
    const officePdf = handlerOf(IPC_CHANNELS.workbench.officePdf)
    const first = (await officePdf(EVENT, 't', '方案.docx', 'foreground', 'r1')) as {
      version: string
    }
    // 等一小会再写，保证 mtime 真的动了（同一毫秒内改写时版本可能一样）
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 内容也换成长度不同的，版本与内容标识两条路都变
    await writeDocxFixture('方案.docx', '第二版：多写了一些内容，字节数不一样')

    const second = (await officePdf(EVENT, 't', '方案.docx', 'foreground', 'r2')) as {
      version: string
    }
    expect(second.version).not.toBe(first.version)
    expect(office.runs).toHaveLength(2)
  })

  it('工作区内的链接会解到真实路径正常转；指到区外的链接由授权挡下', async () => {
    // 用 junction（目录链接）而不是文件符号链接：Windows 上文件的符号链接要开发模式/特权，本机没有；
    // junction 不需要特权，且一样能证明"链接会被解到真实路径"（与既有 workbench-files-bytes.spec 同手法）
    mkdirSync(join(project, '真目录'))
    await writeDocxFixture('目标.docx', '正文一段', join(project, '真目录'))
    try {
      symlinkSync(join(project, '真目录'), join(project, '链接'), 'junction')
    } catch {
      console.warn('[skip] 本机建不了 junction，跳过这一条')
      return
    }
    await expect(
      handlerOf(IPC_CHANNELS.workbench.officePdf)(EVENT, 't', '链接/目标.docx', 'foreground', 'r1')
    ).resolves.toMatchObject({ kind: 'pdf' })

    // 穿过 junction 指到工作区外：containment 就把它挡在外面（fail closed 抛人话）
    symlinkSync(join(dir, '别的'), join(project, '外链'), 'junction')
    await expect(
      handlerOf(IPC_CHANNELS.workbench.officePdf)(EVENT, 't', '外链/x.docx', 'foreground', 'r2')
    ).rejects.toThrow(/路径不可用/)
  })
})

describe('办公档页式预览：取消（requestId + 发起者绑定）', () => {
  it('本窗口能取消：取消后那一轮回 kind:failed + code:cancelled，且不再等引擎', async () => {
    await writeDocxFixture()
    const gate = deferred()
    const { runs } = registerWithGate(() => gate.promise)

    const pending = handlerOf(IPC_CHANNELS.workbench.officePdf)(
      EVENT,
      't',
      '方案.docx',
      'foreground',
      'req-1'
    )
    await until(() => runs.length === 1)
    handlerOf(IPC_CHANNELS.workbench.cancelOfficePdf)(EVENT, 'req-1')
    await expect(pending).resolves.toMatchObject({ kind: 'failed', code: 'cancelled' })
    gate.resolve()
  })

  it('别的窗口来取消是空操作：转换照常跑完', async () => {
    await writeDocxFixture()
    const gate = deferred()
    const { runs } = registerWithGate(() => gate.promise)

    const pending = handlerOf(IPC_CHANNELS.workbench.officePdf)(
      EVENT,
      't',
      '方案.docx',
      'foreground',
      'req-1'
    )
    await until(() => runs.length === 1)
    // 另一个窗口（id=7）拿同一个 requestId 来取消 —— 不许掐掉 42 号的转换
    handlerOf(IPC_CHANNELS.workbench.cancelOfficePdf)(OTHER_WINDOW, 'req-1')
    gate.resolve()
    await expect(pending).resolves.toMatchObject({ kind: 'pdf' })
  })

  it('同一个窗口重发同一个 requestId：旧的按取消收尾，新的照常转', async () => {
    await writeDocxFixture()
    const gate = deferred()
    const { runs } = registerWithGate(() => gate.promise)
    const officePdf = handlerOf(IPC_CHANNELS.workbench.officePdf)

    const first = officePdf(EVENT, 't', '方案.docx', 'foreground', 'same')
    await until(() => runs.length === 1)
    const second = officePdf(EVENT, 't', '方案.docx', 'foreground', 'same')
    await expect(first).resolves.toMatchObject({ kind: 'failed', code: 'cancelled' })
    gate.resolve()
    await expect(second).resolves.toMatchObject({ kind: 'pdf' })
  })

  it('requestId 被另一个窗口占着：拒绝（不许抢别人的账）', async () => {
    await writeDocxFixture()
    const gate = deferred()
    const { runs } = registerWithGate(() => gate.promise)
    const officePdf = handlerOf(IPC_CHANNELS.workbench.officePdf)

    const held = officePdf(EVENT, 't', '方案.docx', 'foreground', 'busy-id')
    await until(() => runs.length === 1)
    await expect(
      officePdf(OTHER_WINDOW, 't', '方案.docx', 'foreground', 'busy-id')
    ).rejects.toThrow(/已被另一个窗口占用/)
    handlerOf(IPC_CHANNELS.workbench.cancelOfficePdf)(EVENT, 'busy-id')
    await expect(held).resolves.toMatchObject({ kind: 'failed', code: 'cancelled' })
    gate.resolve()
  })

  it('不存在的 requestId：取消是空操作（幂等、不抛）', () => {
    expect(() =>
      handlerOf(IPC_CHANNELS.workbench.cancelOfficePdf)(EVENT, 'never-started')
    ).not.toThrow()
  })

  it('webContents 销毁：它名下的在途转换全部按取消收尾', async () => {
    await writeDocxFixture()
    const gate = deferred()
    const { runs } = registerWithGate(() => gate.promise)

    const pending = handlerOf(IPC_CHANNELS.workbench.officePdf)(
      EVENT,
      't',
      '方案.docx',
      'foreground',
      'req-1'
    )
    await until(() => runs.length === 1)
    for (const listener of mocks.destroyedListeners) listener()
    await expect(pending).resolves.toMatchObject({ kind: 'failed', code: 'cancelled' })
    gate.resolve()
  })

  it('应用退出清算（handles.disposeOfficePreview）：在途转换被取消', async () => {
    await writeDocxFixture()
    const gate = deferred()
    const next = fakeOfficePreview({ gate: () => gate.promise })
    mocks.handlers.clear()
    const handles = registerWorkbenchIpc(dir, {
      terminals,
      officePreview: next.preview,
      git: () => ({ run: async () => ({ text: '', exitCode: 0, failed: false, spawnError: null }) })
    })

    const pending = handlerOf(IPC_CHANNELS.workbench.officePdf)(
      EVENT,
      't',
      '方案.docx',
      'foreground',
      'req-1'
    )
    await until(() => next.runs.length === 1)
    handles.disposeOfficePreview()
    await expect(pending).resolves.toMatchObject({ kind: 'failed', code: 'cancelled' })
    gate.resolve()
  })
})

describe('办公档预览的请求账（createOfficePreviewRequests）', () => {
  it('按 owner 归属：别人取消是空操作，本人才有效', () => {
    const requests = createOfficePreviewRequests()
    const mine = requests.begin('r1', 42)
    expect(mine.signal.aborted).toBe(false)
    requests.cancel('r1', 7)
    expect(mine.signal.aborted).toBe(false)
    expect(requests.ids()).toEqual(['r1'])
    requests.cancel('r1', 42)
    expect(mine.signal.aborted).toBe(true)
    expect(requests.ids()).toEqual([])
  })

  it('release 只摘"还是我这条"：同 id 的新请求不会被旧请求的收尾误摘', () => {
    const requests = createOfficePreviewRequests()
    const first = requests.begin('r1', 42)
    const second = requests.begin('r1', 42)
    // 旧的被顶掉
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    // 旧的 handler 收尾：不许把新的这条摘掉
    first.release()
    expect(requests.ids()).toEqual(['r1'])
    second.release()
    expect(requests.ids()).toEqual([])
  })

  it('跨窗口抢同一个 id 直接拒；disposeByOwner 只收那一个窗口的', () => {
    const requests = createOfficePreviewRequests()
    const mine = requests.begin('r1', 42)
    expect(() => requests.begin('r1', 7)).toThrow(/已被另一个窗口占用/)

    const other = requests.begin('r2', 7)
    requests.disposeByOwner(7)
    expect(other.signal.aborted).toBe(true)
    expect(mine.signal.aborted).toBe(false)
    requests.disposeAll()
    expect(mine.signal.aborted).toBe(true)
    expect(requests.ids()).toEqual([])
  })
})

/* ── 表格原始字节通道 ─────────────────────────────────────────────────── */

describe('表格原始字节通道（table-bytes）', () => {
  it('xls / xlsx / csv 各回原始字节（与 read-bytes 那条抽结构的路互不影响）', async () => {
    const { renderXlsx } = await import('../../../mastra/tools/excel')
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32, 7)
    ])
    writeFileSync(join(project, '老表.xls'), ole)
    writeFileSync(
      join(project, '台账.xlsx'),
      await renderXlsx([{ name: '汇总', rows: [['项目'], ['房租']] }])
    )
    writeFileSync(join(project, '数据.csv'), '项目,金额\n房租,1200\n')

    const table = handlerOf(IPC_CHANNELS.workbench.tableBytes)
    const xls = (await table(EVENT, 't', '老表.xls')) as {
      kind: string
      format: string
      bytes: Uint8Array
    }
    expect(xls.kind).toBe('bytes')
    expect(xls.format).toBe('xls')
    expect(Buffer.from(xls.bytes)).toEqual(ole)

    const xlsx = (await table(EVENT, 't', '台账.xlsx')) as {
      kind: string
      format: string
      size: number
    }
    expect(xlsx).toMatchObject({ kind: 'bytes', format: 'xlsx' })
    expect(xlsx.size).toBe(readFileSync(join(project, '台账.xlsx')).byteLength)

    const csv = (await table(EVENT, 't', '数据.csv')) as {
      kind: string
      format: string
      bytes: Uint8Array
    }
    expect(csv).toMatchObject({ kind: 'bytes', format: 'csv' })
    expect(Buffer.from(csv.bytes).toString('utf8')).toBe('项目,金额\n房租,1200\n')

    // 老消费者那条路一个字没变：`.xls` 在 read-bytes 里仍是 unsupported（结构通道不认它）
    expect(await handlerOf(IPC_CHANNELS.workbench.readBytes)(EVENT, 't', '老表.xls')).toEqual({
      kind: 'unsupported',
      size: ole.byteLength
    })
    // 而 xlsx / csv 在 read-bytes 里仍是**抽好的结构**（不是字节）
    expect(
      await handlerOf(IPC_CHANNELS.workbench.readBytes)(EVENT, 't', '台账.xlsx')
    ).toMatchObject({
      kind: 'xlsx',
      sheets: [{ name: '汇总' }]
    })
  })

  it('后缀与文件头对不上 / 文件没了 / 越权：各自的判别结果', async () => {
    writeFileSync(join(project, '伪装.xls'), 'MZ\x90\x00')
    writeFileSync(join(project, '笔记.txt'), '纯文本\n')
    const table = handlerOf(IPC_CHANNELS.workbench.tableBytes)

    expect(await table(EVENT, 't', '伪装.xls')).toMatchObject({ kind: 'unsupported' })
    expect(await table(EVENT, 't', '笔记.txt')).toMatchObject({ kind: 'unsupported' })
    expect(await table(EVENT, 't', '没有这个.csv')).toEqual({ kind: 'missing' })
    await expect(table(EVENT, 't', '../别的/x.csv')).rejects.toThrow(/路径不可用/)
    await expect(table(EVENT, 't', 'src')).rejects.toThrow(/这是一个文件夹/)
  })
})
