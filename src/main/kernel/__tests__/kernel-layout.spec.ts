// @vitest-environment node
/**
 * B4 / PB-006：内核布局解析（验收①：resources/kernel/rc.2 可被找到；验收④：缺件给人话）。
 *
 * 只碰临时目录，不动仓库 `resources/kernel`（真快照 113.6 MiB，单测不该依赖它）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultKernelRoot, resolveKernelLayout } from '../kernel-layout'

const created: string[] = []

function makeTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'kyclaw-kernel-layout-'))
  created.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, ...relative.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  return root
}

const POINTER = JSON.stringify({
  version: 'rc.2',
  path: 'rc.2',
  sha256: 'BD1CB9075F497155F45B2D11A520C861173E32694569FF98D2E0477E12E7B241'
})

const BIN_RELATIVE = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

describe('resolveKernelLayout：随包内核树（resources/kernel/current.json → rc.2/）', () => {
  it('完整快照：返回 kernel-tree、版本目录、入口与 SHA256（取自 current.json）', () => {
    const root = makeTree({
      'current.json': POINTER,
      'rc.2/SNAPSHOT.json': JSON.stringify({ packagesKept: 524, files: 11930 }),
      [`rc.2/${BIN_RELATIVE}`]: '// fake bin\n'
    })
    const layout = resolveKernelLayout({ kernelRoot: root })
    expect(layout.ok).toBe(true)
    if (!layout.ok) return
    expect(layout.kind).toBe('kernel-tree')
    expect(layout.version).toBe('rc.2')
    expect(layout.versionDir).toBe(join(root, 'rc.2'))
    expect(layout.scriptPath).toBe(join(root, 'rc.2', ...BIN_RELATIVE.split('/')))
    expect(layout.sha256).toBe('BD1CB9075F497155F45B2D11A520C861173E32694569FF98D2E0477E12E7B241')
  })

  it('直接指到版本目录（resources/kernel/rc.2）也认（集成测试 KYCLAW_KERNEL_ASAR 注入用）', () => {
    const root = makeTree({
      'SNAPSHOT.json': JSON.stringify({ packagesKept: 524, files: 12236 }),
      [`${BIN_RELATIVE}`]: '// fake bin\n'
    })
    const layout = resolveKernelLayout({ kernelRoot: root })
    expect(layout.ok).toBe(true)
    if (!layout.ok) return
    expect(layout.kind).toBe('kernel-tree')
    expect(layout.versionDir).toBe(root)
    expect(layout.version).toBe(root.split(/[\\/]/u).pop())
    expect(layout.scriptPath).toBe(join(root, ...BIN_RELATIVE.split('/')))
  })

  it('缺 current.json → KERNEL_MANIFEST_MISSING（消息给出该跑什么）', () => {
    const root = makeTree({ 'rc.2/SNAPSHOT.json': '{}' })
    const layout = resolveKernelLayout({ kernelRoot: root })
    expect(layout.ok).toBe(false)
    if (layout.ok) return
    expect(layout.code).toBe('KERNEL_MANIFEST_MISSING')
    expect(layout.detail).toContain('pnpm fetch:kernel')
    expect(layout.candidates.manifest).toBe(join(root, 'current.json'))
  })

  it('current.json 坏 JSON → KERNEL_MANIFEST_INVALID', () => {
    const root = makeTree({ 'current.json': '{ not json' })
    const layout = resolveKernelLayout({ kernelRoot: root })
    expect(layout.ok).toBe(false)
    if (layout.ok) return
    expect(layout.code).toBe('KERNEL_MANIFEST_INVALID')
  })

  it('current.json.path 指到目录外（../x）→ KERNEL_MANIFEST_INVALID（不信任打包产物）', () => {
    const root = makeTree({
      'current.json': JSON.stringify({ version: 'rc.2', path: '../outside', sha256: 'x' })
    })
    const layout = resolveKernelLayout({ kernelRoot: root })
    expect(layout.ok).toBe(false)
    if (layout.ok) return
    expect(layout.code).toBe('KERNEL_MANIFEST_INVALID')
  })

  it('指针指向的版本目录缺 SNAPSHOT.json → KERNEL_SNAPSHOT_MISSING', () => {
    const root = makeTree({ 'current.json': POINTER })
    const layout = resolveKernelLayout({ kernelRoot: root })
    expect(layout.ok).toBe(false)
    if (layout.ok) return
    expect(layout.code).toBe('KERNEL_SNAPSHOT_MISSING')
    expect(layout.candidates.versionEntry).toBe(join(root, 'rc.2', ...BIN_RELATIVE.split('/')))
  })

  it('旧 asar 布局（开发/集成测试注入 app.asar）→ asar-layout，行为与 B3.x 一致', () => {
    const root = makeTree({ [`dsh/${BIN_RELATIVE}`]: '// fake bin\n' })
    const layout = resolveKernelLayout({ kernelRoot: root })
    expect(layout.ok).toBe(true)
    if (!layout.ok) return
    expect(layout.kind).toBe('asar-layout')
    expect(layout.versionDir).toBe(root)
    expect(layout.scriptPath).toBe(join(root, 'dsh', ...BIN_RELATIVE.split('/')))
  })

  it('`.asar` 路径在 plain Node 下 existsSync=false 也按 asar 布局放行（回归：不能误判缺件）', () => {
    const layout = resolveKernelLayout({
      kernelRoot: 'F:\\deepseekharness\\resources\\app.asar',
      // plain Node 看不见 asar 内部
      exists: () => false
    })
    expect(layout.ok).toBe(true)
    if (!layout.ok) return
    expect(layout.kind).toBe('asar-layout')
    expect(layout.versionDir).toBe('F:\\deepseekharness\\resources\\app.asar')
    expect(layout.scriptPath).toBe(
      'F:\\deepseekharness\\resources\\app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    )
  })
})

describe('defaultKernelRoot：打包态/开发态/env 覆盖（e2e 的注入 seam）', () => {
  it('打包态 = resourcesPath/kernel；开发态 = appPath/resources/kernel', () => {
    expect(
      defaultKernelRoot({
        isPackaged: true,
        resourcesPath: 'C:\\Program Files\\kyclaw\\resources',
        appPath: 'C:\\repo'
      })
    ).toBe(join('C:\\Program Files\\kyclaw\\resources', 'kernel'))
    expect(
      defaultKernelRoot({ isPackaged: false, resourcesPath: 'C:\\x', appPath: 'C:\\repo' })
    ).toBe(join('C:\\repo', 'resources', 'kernel'))
  })

  it('KYCLAW_KERNEL_ROOT 覆盖一切（e2e 用临时树；空串视为未设）', () => {
    const env = { KYCLAW_KERNEL_ROOT: 'D:\\tmp\\kernel-tree' }
    expect(
      defaultKernelRoot({
        isPackaged: true,
        resourcesPath: 'C:\\ignored',
        appPath: 'C:\\ignored',
        env
      })
    ).toBe('D:\\tmp\\kernel-tree')
    expect(
      defaultKernelRoot({
        isPackaged: true,
        resourcesPath: 'C:\\resources',
        appPath: 'C:\\repo',
        env: { KYCLAW_KERNEL_ROOT: '   ' }
      })
    ).toBe(join('C:\\resources', 'kernel'))
  })
})
