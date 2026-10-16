// @vitest-environment node
/**
 * `scripts/app-deps.mjs` 的判据：预构建"齐"（常规非空文件，目录/空文件都算缺）、N-API 证据、
 * 真 Electron 冒烟的失败面，以及**三条任一不成立都不忽略**（fail closed）。
 * 真冒烟要起 Electron，属串行验证阶段的命令，这里只测它起不来时如实回失败。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../')
const scriptPath = join(repoRoot, 'scripts', 'app-deps.mjs')

/** app-deps.mjs 用到的导出（.mjs 没有类型，按实现声明） */
interface PrebuildState {
  platform: string
  known: boolean
  dir: string | null
  required: string[]
  missing: string[]
  complete: boolean
}
interface SmokeResult {
  ok: boolean
  status: number | null
  output: string
  electron: string | null
  abi: string | null
  napi: string | null
  marker: string | null
  prebuildLoaded: boolean
  loaderDirs: string[] | null
  usedPrebuild: boolean | null
}
interface AppDepsExports {
  PTY_SMOKE_MARKER: string
  PTY_SMOKE_PATTERN: string
  NATIVE_MODULES: Record<string, string[]>
  REQUIRED_PREBUILDS: Record<string, string[]>
  prebuildState(input: { platform: string; arch: string; ptyDir: string }): PrebuildState
  napiEvidence(ptyDir: string): { ok: boolean; reasons: string[] }
  electronPtySmoke(input: {
    electronBinary: string
    ptyDir: string
    platform?: string
    timeoutMs?: number
  }): SmokeResult
  decideNodePtyAction(conditions: {
    prebuilds: PrebuildState
    napi: { ok: boolean; reasons: string[] }
    smoke: SmokeResult
  }): { ignore: boolean; reasons: string[] }
}

const appDeps = (await import(
  /* @vite-ignore */ pathToFileURL(scriptPath).href
)) as unknown as AppDepsExports

const passingPrebuilds = (platform = 'win32'): PrebuildState => ({
  platform,
  known: true,
  dir: `/tmp/node-pty/prebuilds/${platform}-x64`,
  required: appDeps.REQUIRED_PREBUILDS[platform] ?? [],
  missing: [],
  complete: true
})
const passingNapi = { ok: true, reasons: [] }
const passingSmoke: SmokeResult = {
  ok: true,
  status: 0,
  output: 'PREBUILD OK / SMOKE seen',
  electron: '44.7.0',
  abi: '149',
  napi: '10',
  marker: 'KYCLAW_PTY_OK_12345',
  prebuildLoaded: true,
  loaderDirs: ['pty=../prebuilds/win32-x64/'],
  usedPrebuild: true
}

let tempDir: string | undefined

/** 造一棵"像 node-pty 的包"：package.json / binding.gyp / prebuilds/<platform>-<arch>/ 下的条目 */
function fakePtyDir(options: {
  platform: string
  arch: string
  files?: string[]
  dirs?: string[]
  napi?: boolean
}): string {
  tempDir = mkdtempSync(join(tmpdir(), 'kyclaw-app-deps-'))
  const { platform, arch, files = [], dirs = [], napi = true } = options
  writeFileSync(
    join(tempDir, 'package.json'),
    JSON.stringify({
      name: 'node-pty',
      version: '1.1.0',
      dependencies: napi ? { 'node-addon-api': '^7.1.0' } : {}
    })
  )
  writeFileSync(join(tempDir, 'binding.gyp'), napi ? "require('node-addon-api').targets" : '{}')
  const root = join(tempDir, 'prebuilds', `${platform}-${arch}`)
  for (const file of files) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'x')
  }
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
  return tempDir
}

afterEach(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('预构建清单：只有官方发预构建的平台有清单', () => {
  it('win32 / darwin 有，linux 没有（→ 一定不忽略）', () => {
    expect(Object.keys(appDeps.REQUIRED_PREBUILDS).sort()).toEqual(['darwin', 'win32'])
    expect(appDeps.REQUIRED_PREBUILDS.linux).toBeUndefined()
  })

  it('清单按运行期真正加载的原生件 + 随包附件给', () => {
    expect(appDeps.PTY_SMOKE_MARKER).toBe('KYCLAW_PTY_OK')
    expect(appDeps.NATIVE_MODULES.win32).toEqual(['pty', 'conpty', 'conpty_console_list'])
    expect(appDeps.REQUIRED_PREBUILDS.win32).toContain('conpty_console_list.node')
    expect(appDeps.REQUIRED_PREBUILDS.win32).toContain('conpty/conpty.dll')
    expect(appDeps.REQUIRED_PREBUILDS.darwin).toContain('spawn-helper')
  })
})

describe('prebuildState：齐不齐', () => {
  it('都在（常规非空文件）→ complete', () => {
    const ptyDir = fakePtyDir({
      platform: 'win32',
      arch: 'x64',
      files: appDeps.REQUIRED_PREBUILDS.win32
    })
    const state = appDeps.prebuildState({ platform: 'win32', arch: 'x64', ptyDir })

    expect(state.known).toBe(true)
    expect(state.complete).toBe(true)
    expect(state.missing).toEqual([])
    expect(state.dir).toBe(join(ptyDir, 'prebuilds', 'win32-x64'))
  })

  it('缺一件就点名（不齐 = 后面一定不忽略）', () => {
    const files = appDeps.REQUIRED_PREBUILDS.win32.filter((name) => name !== 'conpty.node')
    const ptyDir = fakePtyDir({ platform: 'win32', arch: 'x64', files })
    const state = appDeps.prebuildState({ platform: 'win32', arch: 'x64', ptyDir })

    expect(state.complete).toBe(false)
    expect(state.missing).toEqual(['conpty.node'])
  })

  it('同名**目录**不算文件（只看 exists+size 会误判成齐）', () => {
    const files = appDeps.REQUIRED_PREBUILDS.win32.filter((name) => name !== 'pty.node')
    const ptyDir = fakePtyDir({ platform: 'win32', arch: 'x64', files, dirs: ['pty.node'] })
    const state = appDeps.prebuildState({ platform: 'win32', arch: 'x64', ptyDir })

    expect(state.complete).toBe(false)
    expect(state.missing).toEqual(['pty.node'])
  })

  it('空文件也算缺', () => {
    const ptyDir = fakePtyDir({
      platform: 'darwin',
      arch: 'arm64',
      files: ['spawn-helper']
    })
    writeFileSync(join(ptyDir, 'prebuilds', 'darwin-arm64', 'pty.node'), '')
    const state = appDeps.prebuildState({ platform: 'darwin', arch: 'arm64', ptyDir })

    expect(state.missing).toEqual(['pty.node'])
  })

  it('平台不在清单里 → known:false', () => {
    const ptyDir = fakePtyDir({ platform: 'linux', arch: 'x64' })
    const state = appDeps.prebuildState({ platform: 'linux', arch: 'x64', ptyDir })

    expect(state.known).toBe(false)
    expect(state.complete).toBe(false)
    expect(state.dir).toBeNull()
  })
})

describe('napiEvidence：结构上确认是 N-API', () => {
  it('node-addon-api 依赖 + binding.gyp 引用都在 → ok', () => {
    expect(appDeps.napiEvidence(fakePtyDir({ platform: 'win32', arch: 'x64' })).ok).toBe(true)
  })

  it('少了 node-addon-api → 不 ok，并说清为什么', () => {
    const evidence = appDeps.napiEvidence(
      fakePtyDir({ platform: 'win32', arch: 'x64', napi: false })
    )

    expect(evidence.ok).toBe(false)
    expect(evidence.reasons.join('')).toMatch(/node-addon-api/)
  })
})

describe('decideNodePtyAction：三条都成立才忽略，否则 fail closed', () => {
  it('三条都成立 → 忽略', () => {
    const decision = appDeps.decideNodePtyAction({
      prebuilds: passingPrebuilds(),
      napi: passingNapi,
      smoke: passingSmoke
    })

    expect(decision.ignore).toBe(true)
    expect(decision.reasons).toEqual([])
  })

  it('预构建缺一件 → 不忽略（点名缺哪件）', () => {
    const decision = appDeps.decideNodePtyAction({
      prebuilds: { ...passingPrebuilds(), complete: false, missing: ['conpty.node'] },
      napi: passingNapi,
      smoke: passingSmoke
    })

    expect(decision.ignore).toBe(false)
    expect(decision.reasons.join('')).toContain('conpty.node')
  })

  it('平台没有清单（linux）→ 不忽略', () => {
    const decision = appDeps.decideNodePtyAction({
      prebuilds: { ...passingPrebuilds('linux'), known: false, complete: false },
      napi: passingNapi,
      smoke: passingSmoke
    })

    expect(decision.ignore).toBe(false)
    expect(decision.reasons.join('')).toContain('linux')
  })

  it('N-API 证据不足 → 不忽略', () => {
    const decision = appDeps.decideNodePtyAction({
      prebuilds: passingPrebuilds(),
      napi: { ok: false, reasons: ['没有 node-addon-api'] },
      smoke: passingSmoke
    })

    expect(decision.ignore).toBe(false)
    expect(decision.reasons.join('')).toContain('node-addon-api')
  })

  it('冒烟里 PTY 没读到回显 → 不忽略', () => {
    const decision = appDeps.decideNodePtyAction({
      prebuilds: passingPrebuilds(),
      napi: passingNapi,
      smoke: { ...passingSmoke, ok: false, status: 4 }
    })

    expect(decision.ignore).toBe(false)
    expect(decision.reasons.join('')).toContain('冒烟')
  })

  it('**预构建件没能按确切路径加载**（例如只有旧 build/Release 能用）→ 不忽略，且理由点明这一点', () => {
    const decision = appDeps.decideNodePtyAction({
      prebuilds: passingPrebuilds(),
      napi: passingNapi,
      smoke: {
        ...passingSmoke,
        ok: false,
        status: 4,
        prebuildLoaded: false,
        loaderDirs: ['pty=../build/Release/'],
        usedPrebuild: false
      }
    })

    expect(decision.ignore).toBe(false)
    expect(decision.reasons.join('')).toContain('确切路径')
  })
})

describe('electronPtySmoke：起不来的情况如实回失败', () => {
  it('Electron 二进制不存在 → ok:false 且 prebuildLoaded:false（不当成"预构建可用"）', () => {
    const ptyDir = fakePtyDir({
      platform: 'win32',
      arch: 'x64',
      files: appDeps.REQUIRED_PREBUILDS.win32
    })
    const smoke = appDeps.electronPtySmoke({
      electronBinary: join(ptyDir, 'no-such-electron.exe'),
      ptyDir,
      platform: process.platform,
      timeoutMs: 5_000
    })

    expect(smoke.ok).toBe(false)
    expect(smoke.prebuildLoaded).toBe(false)
    expect(smoke.loaderDirs).toBeNull()
    expect(smoke.marker).toBeNull()
  })
})

describe('当前这棵树：装出来的 node-pty 预构建必须齐（有清单的平台才断言）', () => {
  it('该平台有官方清单时，prebuilds 一件不缺', () => {
    if (appDeps.REQUIRED_PREBUILDS[process.platform] === undefined) return
    const require = createRequire(import.meta.url)
    const ptyDir = dirname(require.resolve('node-pty/package.json'))
    const state = appDeps.prebuildState({ platform: process.platform, arch: process.arch, ptyDir })

    expect(state.known).toBe(true)
    expect(state.complete).toBe(true)
  })
})

describe('冒烟标记：只有真执行出来的形态才算', () => {
  it('匹配 `KYCLAW_PTY_OK_<数字>`，**匹配不上**回声里的占位符形态', () => {
    const pattern = new RegExp(appDeps.PTY_SMOKE_PATTERN)

    expect(pattern.test('KYCLAW_PTY_OK_12345')).toBe(true)
    expect(pattern.test('KYCLAW_PTY_OK_7')).toBe(true)
    // 这两种是命令自己的回声（cmd 的 %RANDOM% / sh 的 $$），只回显没执行时必须不算
    expect(pattern.test('KYCLAW_PTY_OK_%RANDOM%')).toBe(false)
    expect(pattern.test('KYCLAW_PTY_OK_$$')).toBe(false)
    expect(pattern.test('KYCLAW_PTY_OK_')).toBe(false)
  })
})
