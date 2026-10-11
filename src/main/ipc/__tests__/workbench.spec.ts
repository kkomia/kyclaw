import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * workbench / terminal 两组通道的 handler：
 *   1. 通道都注册了、入参先过闸门（非法调用不碰磁盘、不起进程）；
 *   2. 会话根在主进程解析（项目 → 默认工作区 → 唯一授权目录），判不出给人话；
 *   3. 文件/Git 把结果原样回吐；终端把 id 与发起它的 webContents 对上并推输出/退出。
 */
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
  it('十二条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'terminal:dispose',
      'terminal:resize',
      'terminal:start',
      'terminal:write',
      'workbench:git-log',
      'workbench:git-overview',
      'workbench:git-show',
      'workbench:list-dir',
      'workbench:read-bytes',
      'workbench:read-file',
      'workbench:reveal',
      'workbench:search'
    ])
  })

  it('相对路径族（list-dir / read-file / read-bytes / reveal）：缺参、空 threadId、走样一律拒', async () => {
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

    const reveal = handlerOf(IPC_CHANNELS.workbench.reveal)
    for (const args of [[], [''], ['t'], ['t', 1], ['t', 'a', 'b']]) {
      await expect(reveal(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
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
  })

  it('reveal：目录走 shell.openPath，文件走 showItemInFolder', async () => {
    await handlerOf(IPC_CHANNELS.workbench.reveal)(EVENT, 't', 'src')
    expect(mocks.openPath).toHaveBeenCalledWith(join(project, 'src'))
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()

    await handlerOf(IPC_CHANNELS.workbench.reveal)(EVENT, 't', 'README.md')
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(join(project, 'README.md'))
  })

  it('openPath 回非空 = 没打开成：转成人话错误', async () => {
    mocks.openPath.mockResolvedValueOnce('拒绝访问')
    await expect(handlerOf(IPC_CHANNELS.workbench.reveal)(EVENT, 't', 'src')).rejects.toThrow(
      /打不开这个文件夹：拒绝访问/
    )
  })
})

describe('会话根解析（与 workspace 通道同口径）', () => {
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

  it('指认默认工作区后唯一的那个就是根（项目映射优先，同 workspace 通道的取值器）', async () => {
    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      workspaces: [
        { path: project, mode: 'ask' },
        { path: join(dir, '别的'), mode: 'ask' }
      ],
      defaultWorkspace: project
    })
    const result = (await handlerOf(IPC_CHANNELS.workbench.listDir)(EVENT, 't', '')) as {
      entries: { name: string }[]
    }
    expect(result.entries.map((entry) => entry.name)).toContain('README.md')
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
