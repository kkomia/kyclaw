import { describe, expect, it, vi } from 'vitest'
import { createTerminalService, type TerminalSink } from '../workbench-terminal'

/**
 * 终端服务的生命周期（用假 PTY 打：真 PTY 由探针在 Electron 里验）：
 *   - start 的 spawn 参数（shell / `--login -i` / cwd / 尺寸）；
 *   - 输出与退出的推送、退出后会话移除；
 *   - dispose / disposeByOwner / disposeAll 的清算口径；
 *   - 重启同 id 先杀老的；老进程的迟到输出不画到新终端上；
 *   - shell 找不到 / node-pty 加载失败的人话错误（且失败结果被缓存）。
 */
interface FakeTerm {
  onData: (callback: (chunk: string) => void) => void
  onExit: (callback: (event: { exitCode: number }) => void) => void
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emitData: (chunk: string) => void
  emitExit: (exitCode: number) => void
}

function fakeTerm(): FakeTerm {
  let dataCallback: (chunk: string) => void = () => {}
  let exitCallback: (event: { exitCode: number }) => void = () => {}
  return {
    onData: (callback) => {
      dataCallback = callback
    },
    onExit: (callback) => {
      exitCallback = callback
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (chunk) => dataCallback(chunk),
    emitExit: (exitCode) => exitCallback({ exitCode })
  }
}

function fakePty(terms: FakeTerm[]): { spawn: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn(() => {
      const term = fakeTerm()
      terms.push(term)
      return term
    })
  }
}

function sinkOf(): TerminalSink & {
  dataCalls: Array<[string, string]>
  exits: Array<[string, number | null]>
} {
  const dataCalls: Array<[string, string]> = []
  const exits: Array<[string, number | null]> = []
  return {
    dataCalls,
    exits,
    data: (id, data) => dataCalls.push([id, data]),
    exit: (id, exitCode) => exits.push([id, exitCode])
  }
}

describe('createTerminalService', () => {
  it('start：用 Git Bash 的 `--login -i` 在 cwd 起 PTY，回 id/shell/cwd', async () => {
    const terms: FakeTerm[] = []
    const pty = fakePty(terms)
    const service = createTerminalService({
      sink: sinkOf(),
      resolveShell: () => ({ kind: 'git-bash', path: 'D:\\Git\\bin\\bash.exe' }),
      loadPty: async () => pty as unknown as typeof import('node-pty'),
      env: { PATH: 'C:\\' }
    })

    const session = await service.start('t1', 7, 'D:\\工作区', 100, 30)

    expect(session).toEqual({ id: 't1', shell: 'D:\\Git\\bin\\bash.exe', cwd: 'D:\\工作区' })
    expect(pty.spawn).toHaveBeenCalledTimes(1)
    const [command, argv, options] = pty.spawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ]
    expect(command).toBe('D:\\Git\\bin\\bash.exe')
    expect(argv).toEqual(['--login', '-i'])
    expect(options.cwd).toBe('D:\\工作区')
    expect(options.cols).toBe(100)
    expect(options.rows).toBe(30)
    expect((options.env as NodeJS.ProcessEnv).TERM).toBe('xterm-256color')
    expect(service.ids()).toEqual(['t1'])
  })

  it('输出推给 sink；退出推一次并把会话摘掉（之后 write 是空操作）', async () => {
    const terms: FakeTerm[] = []
    const sink = sinkOf()
    const service = createTerminalService({
      sink,
      resolveShell: () => ({ kind: 'git-bash', path: 'bash' }),
      loadPty: async () => fakePty(terms) as unknown as typeof import('node-pty')
    })

    await service.start('t1', 1, '/tmp', 80, 24)
    terms[0]?.emitData('hello\r\n')
    expect(sink.dataCalls).toEqual([['t1', 'hello\r\n']])

    terms[0]?.emitExit(0)
    expect(sink.exits).toEqual([['t1', 0]])
    expect(service.ids()).toEqual([])

    service.write('t1', 'ls\n')
    expect(terms[0]?.write).not.toHaveBeenCalled()
  })

  it('dispose / disposeByOwner / disposeAll 各清各的账', async () => {
    const terms: FakeTerm[] = []
    const service = createTerminalService({
      sink: sinkOf(),
      resolveShell: () => ({ kind: 'git-bash', path: 'bash' }),
      loadPty: async () => fakePty(terms) as unknown as typeof import('node-pty')
    })

    await service.start('a', 1, '/tmp', 80, 24)
    await service.start('b', 1, '/tmp', 80, 24)
    await service.start('c', 2, '/tmp', 80, 24)

    service.dispose('a')
    expect(terms[0]?.kill).toHaveBeenCalled()
    expect(service.ids()).toEqual(['b', 'c'])

    service.disposeByOwner(1)
    expect(terms[1]?.kill).toHaveBeenCalled()
    expect(service.ids()).toEqual(['c'])

    service.disposeAll()
    expect(terms[2]?.kill).toHaveBeenCalled()
    expect(service.ids()).toEqual([])
  })

  it('同一个 id 再 start：先杀老的，老进程的迟到输出不画到新终端上', async () => {
    const terms: FakeTerm[] = []
    const sink = sinkOf()
    const service = createTerminalService({
      sink,
      resolveShell: () => ({ kind: 'git-bash', path: 'bash' }),
      loadPty: async () => fakePty(terms) as unknown as typeof import('node-pty')
    })

    await service.start('t', 1, '/tmp', 80, 24)
    await service.start('t', 1, '/tmp', 80, 24)

    expect(terms[0]?.kill).toHaveBeenCalled()
    terms[0]?.emitData('老终端的迟到输出')
    expect(sink.dataCalls).toEqual([])

    terms[1]?.emitData('新终端')
    expect(sink.dataCalls).toEqual([['t', '新终端']])
  })

  it('resize / write 透给 PTY（退出后不抛）', async () => {
    const terms: FakeTerm[] = []
    const service = createTerminalService({
      sink: sinkOf(),
      resolveShell: () => ({ kind: 'git-bash', path: 'bash' }),
      loadPty: async () => fakePty(terms) as unknown as typeof import('node-pty')
    })

    await service.start('t', 1, '/tmp', 80, 24)
    service.write('t', 'echo hi\n')
    service.resize('t', 120, 40)
    expect(terms[0]?.write).toHaveBeenCalledWith('echo hi\n')
    expect(terms[0]?.resize).toHaveBeenCalledWith(120, 40)

    terms[0]?.emitExit(0)
    expect(() => service.write('t', 'x')).not.toThrow()
    expect(() => service.resize('t', 10, 10)).not.toThrow()
  })

  it('一个 shell 都没有（Git Bash 与 PowerShell 都缺）→ 中文错误，不起进程', async () => {
    const pty = fakePty([])
    const service = createTerminalService({
      sink: sinkOf(),
      resolveShell: () => null,
      loadPty: async () => pty as unknown as typeof import('node-pty')
    })

    await expect(service.start('t', 1, '/tmp', 80, 24)).rejects.toThrow(/找不到可用的 shell/)
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('回落 PowerShell：用 `-NoLogo` 起 PTY，会话回的 shell 是 powershell 路径（round 33）', async () => {
    const terms: FakeTerm[] = []
    const pty = fakePty(terms)
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const service = createTerminalService({
      sink: sinkOf(),
      resolveShell: () => ({ kind: 'powershell', path: ps }),
      loadPty: async () => pty as unknown as typeof import('node-pty')
    })

    const session = await service.start('t1', 1, 'D:\\工作区', 80, 24)
    expect(session).toEqual({ id: 't1', shell: ps, cwd: 'D:\\工作区' })
    const [command, argv] = pty.spawn.mock.calls[0] as [string, string[]]
    expect(command).toBe(ps)
    expect(argv).toEqual(['-NoLogo'])
  })

  it('node-pty 加载失败：人话错误 + 结果缓存（不每次重试）', async () => {
    const loadPty = vi.fn(async () => {
      throw new Error('was compiled against a different Node.js version')
    })
    const service = createTerminalService({
      sink: sinkOf(),
      resolveShell: () => ({ kind: 'git-bash', path: 'bash' }),
      loadPty
    })

    await expect(service.start('t', 1, '/tmp', 80, 24)).rejects.toThrow(
      /终端组件加载失败（node-pty）：was compiled against a different Node.js version/
    )
    await expect(service.start('t', 1, '/tmp', 80, 24)).rejects.toThrow(/终端组件加载失败/)
  })
})
