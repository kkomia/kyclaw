// @vitest-environment node
/**
 * B4 / PB-006：出包脚本的内核自检（验收③⑤）。
 * - `kernelInputProblem`：仓库 `resources/kernel` 缺件时必须在清产物前停；
 * - `kernelBundledProblem`：随包副本与仓库输入一致（版本/入口/文件数/SHA256）；
 * - `asarContainsPath`：手写 asar 头遍历（不引新依赖），确认 app.asar 里没有 kernel。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../')
const scriptUrl = pathToFileURL(join(repoRoot, 'scripts', 'package.mjs')).href

interface PackageScript {
  kernelInputProblem: (kernelDir?: string) => string | null
  kernelBundledProblem: (unpackedResourcesDir: string, kernelDir?: string) => string | null
  asarContainsPath: (asarFile: string, segments: readonly string[]) => boolean
}

let scriptPromise: Promise<PackageScript> | null = null
function loadScript(): Promise<PackageScript> {
  scriptPromise ??= import(scriptUrl).then((module) => module as PackageScript)
  return scriptPromise
}

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-kernel-package-'))
  created.push(dir)
  return dir
}

function writeFile(root: string, relative: string, content: string): void {
  const file = join(root, ...relative.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

const SHA = 'BD1CB9075F497155F45B2D11A520C861173E32694569FF98D2E0477E12E7B241'

function makeKernelTree(): string {
  const root = tempDir()
  writeFile(root, 'current.json', JSON.stringify({ version: 'rc.2', path: 'rc.2', sha256: SHA }))
  writeFile(root, 'rc.2/SNAPSHOT.json', JSON.stringify({ packagesKept: 524, files: 11930 }))
  writeFile(root, 'rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js', '// fake\n')
  return root
}

/** 造一个最小 asar：16 字节头 + JSON 文件树（与 @electron/asar 的格式同形） */
function makeAsar(filesTree: unknown): string {
  const file = join(tempDir(), 'app.asar')
  const header = Buffer.from(JSON.stringify(filesTree), 'utf8')
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(header.length + 8, 4) // pickle 长度（只需非零；本实现只读 offset 12）
  prefix.writeUInt32LE(header.length, 12)
  writeFileSync(file, Buffer.concat([prefix, header]), { flag: 'w' })
  return file
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

describe('kernelInputProblem：仓库输入缺件 → 出包前停', () => {
  it('完整树返回 null', async () => {
    const { kernelInputProblem } = await loadScript()
    expect(kernelInputProblem(makeKernelTree())).toBeNull()
  })

  it('缺 current.json → 提示 pnpm fetch:kernel', async () => {
    const { kernelInputProblem } = await loadScript()
    const root = tempDir()
    const problem = kernelInputProblem(root)
    expect(problem).not.toBeNull()
    expect(problem).toContain('pnpm fetch:kernel')
  })

  it('缺 bin.js → 指出入口路径', async () => {
    const { kernelInputProblem } = await loadScript()
    const root = tempDir()
    writeFile(root, 'current.json', JSON.stringify({ version: 'rc.2', path: 'rc.2', sha256: SHA }))
    writeFile(root, 'rc.2/SNAPSHOT.json', '{}')
    const problem = kernelInputProblem(root)
    expect(problem).toContain('bin.js')
  })
})

describe('kernelBundledProblem：随包副本与仓库输入一致', () => {
  it('完整副本（含 current.json/版本树）→ null', async () => {
    const { kernelBundledProblem } = await loadScript()
    const input = makeKernelTree()
    const unpackedResources = tempDir()
    const bundled = join(unpackedResources, 'kernel')
    // 直接把输入树拷成随包副本（模拟 extraResources 原样拷贝）
    for (const relative of [
      'current.json',
      'rc.2/SNAPSHOT.json',
      'rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
    ]) {
      const text = readFileSync(join(input, ...relative.split('/')), 'utf8')
      writeFile(bundled, relative, text)
    }
    expect(kernelBundledProblem(unpackedResources, input)).toBeNull()
  })

  it('随包版本号与仓库不一致 → 报出来', async () => {
    const { kernelBundledProblem } = await loadScript()
    const input = makeKernelTree()
    const unpackedResources = tempDir()
    writeFile(
      unpackedResources,
      'kernel/current.json',
      JSON.stringify({ version: 'rc.1', path: 'rc.1', sha256: SHA })
    )
    writeFile(unpackedResources, 'kernel/rc.1/SNAPSHOT.json', '{}')
    writeFile(
      unpackedResources,
      'kernel/rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '// fake\n'
    )
    const problem = kernelBundledProblem(unpackedResources, input)
    expect(problem).not.toBeNull()
    expect(problem).toContain('随包内核版本')
  })
})

describe('asarContainsPath：手写 asar 头遍历（不引 @electron/asar）', () => {
  it('files 树里有 resources/kernel → true；没有 → false', async () => {
    const { asarContainsPath } = await loadScript()
    expect(
      asarContainsPath(makeAsar({ files: { resources: { files: { kernel: { files: {} } } } } }), [
        'resources',
        'kernel'
      ])
    ).toBe(true)
    expect(
      asarContainsPath(makeAsar({ files: { resources: { files: { llama: { files: {} } } } } }), [
        'resources',
        'kernel'
      ])
    ).toBe(false)
  })
})
