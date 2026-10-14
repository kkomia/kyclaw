import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createTerminalSink, registerWorkbenchIpc, type WorkbenchDeps } from '../workbench'
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
  const deps: WorkbenchDeps = {
    terminals,
    git: () => ({ run: async () => ({ text: '', exitCode: 0, failed: false, spawnError: null }) })
  }
  registerWorkbenchIpc(dir, deps)
  writeSettings(settingsPath(dir), {
    ...defaultSettings(),
    workspaces: [{ path: project, mode: 'ask' }]
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('通道注册与入参闸门', () => {
  it('十三条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'terminal:dispose',
      'terminal:resize',
      'terminal:start',
      'terminal:write',
      'workbench:git-log',
      'workbench:git-overview',
      'workbench:git-show',
      'workbench:list-dir',
      'workbench:open',
      'workbench:read-bytes',
      'workbench:read-file',
      'workbench:reveal',
      'workbench:search'
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

  it('open：只把文档/媒体交给系统 —— 可执行文件、脚本、快捷方式一律拒（不碰 shell）', async () => {
    for (const name of ['安装包.exe', '更新.bat', 'run.ps1', '脚本.js', '快捷方式.lnk', 'noext']) {
      writeFileSync(join(project, name), 'x')
      await expect(handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', name), name).rejects.toThrow(
        /不用系统应用打开这类文件/
      )
    }
    expect(mocks.openPath).not.toHaveBeenCalled()

    // 放行的那些照旧走 shell（含旧版 Office 与纯文本）
    for (const name of ['方案.docx', '旧方案.doc', '说明.md', '笔记.txt']) {
      writeFileSync(join(project, name), 'x')
      await handlerOf(IPC_CHANNELS.workbench.open)(EVENT, 't', name)
    }
    expect(mocks.openPath).toHaveBeenCalledTimes(4)
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
