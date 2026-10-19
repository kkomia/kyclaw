/**
 * B4 / PB-006：内核布局解析（打包态 = 安装目录 `resources/kernel`，开发态 = 仓库 `resources/kernel`）。
 *
 * 两种布局（**以实际存在为准，不靠版本号/flag 猜**）：
 *   - `kernel-tree`（新，随包）：`<kernelRoot>/current.json` → `{version,path,sha256}`；
 *     入口 `<kernelRoot>/<path>/node_modules/@deepseek-ai/dsh/lib/bin.js`；
 *   - `asar-layout`（旧，开发/测试/兜底）：`<root>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`
 *     直接存在（B3.x 集成测试注入本机 DSH 安装的 `app.asar` 走这一支，行为不变）。
 *
 * 判不出来（既没有 current.json，也没有旧布局入口）就抛带 code 的错误并列出候选路径，
 * 让用户/开发者知道"缺哪份、该跑什么"（验收④：可诊断）。
 *
 * 启动期只做**轻校验**（current.json + SNAPSHOT.json + 入口存在）：11,930 个文件的逐文件
 * SHA256 是打包 / `pnpm fetch:kernel --verify` 的事，运行期算会明显拖慢冷启动。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DSH_KERNEL_SCRIPT_IN_ASAR, DSH_KERNEL_SCRIPT_IN_KERNEL_TREE } from './kernel-entry'
import { KernelStartupError, type KernelStartupCode } from './kernel-startup'

export const KERNEL_ROOT_ENV = 'KYCLAW_KERNEL_ROOT'

export interface KernelRootInput {
  isPackaged: boolean
  /** 打包态 = process.resourcesPath */
  resourcesPath: string
  /** 开发态 = app.getAppPath()（仓库根） */
  appPath: string
  env?: Readonly<Record<string, string | undefined>>
}

/** 默认内核根：`KYCLAW_KERNEL_ROOT` 覆盖 > 打包态 resources/kernel > 开发态仓库 resources/kernel */
export function defaultKernelRoot(input: KernelRootInput): string {
  const override = input.env?.[KERNEL_ROOT_ENV]?.trim()
  if (override !== undefined && override !== '') return override
  return input.isPackaged
    ? join(input.resourcesPath, 'kernel')
    : join(input.appPath, 'resources', 'kernel')
}

export interface KernelLayoutCandidates {
  /** 旧布局入口（asar 根下 dsh/node_modules/...） */
  legacyEntry: string
  /** 新布局清单（current.json） */
  manifest: string
  /** 新布局入口（内核根下 node_modules/...） */
  kernelTreeEntry: string
  /** 指针指向的版本目录入口（manifest 缺失/坏时为 null） */
  versionEntry: string | null
}

export interface KernelLayoutOk {
  ok: true
  /** `kernel-tree` = 随包新布局；`asar-layout` = 旧 asar（开发/测试） */
  kind: 'kernel-tree' | 'asar-layout'
  kernelRoot: string
  /** 实际内核目录（新布局 = <root>/<version>；旧布局 = <root>） */
  versionDir: string
  version: string
  sha256: string
  /** 内核入口（绝对路径；存在性由 kernel-process 再判一次） */
  scriptPath: string
  manifestPath: string
  snapshotPath: string
}

export interface KernelLayoutProblem {
  ok: false
  code: KernelStartupCode
  detail: string
  candidates: KernelLayoutCandidates
}

export type KernelLayout = KernelLayoutOk | KernelLayoutProblem

export interface KernelLayoutInput {
  kernelRoot: string
  /** 测试注入（默认 fs） */
  exists?: (path: string) => boolean
  readFile?: (path: string) => string
}

interface KernelPointer {
  version: string
  path: string
  sha256: string
}

function readPointer(text: string, manifestPath: string): KernelPointer {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new KernelStartupError(
      'KERNEL_MANIFEST_INVALID',
      `内核清单不是合法 JSON（KERNEL_MANIFEST_INVALID）：${manifestPath}：${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new KernelStartupError(
      'KERNEL_MANIFEST_INVALID',
      `内核清单结构不对（KERNEL_MANIFEST_INVALID）：${manifestPath}（应为对象）`
    )
  }
  const record = raw as Partial<KernelPointer>
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const dir = typeof record.path === 'string' ? record.path.trim() : ''
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim() : ''
  if (version === '' || dir === '' || sha256 === '') {
    throw new KernelStartupError(
      'KERNEL_MANIFEST_INVALID',
      `内核清单缺字段（KERNEL_MANIFEST_INVALID）：${manifestPath}（需要 version/path/sha256）`
    )
  }
  // path 只允许单段目录名：防清单写坏后指到安装目录/仓库外（不能只相信打包产物）
  if (!/^[A-Za-z0-9._-]+$/u.test(dir) || dir === '.' || dir === '..') {
    throw new KernelStartupError(
      'KERNEL_MANIFEST_INVALID',
      `内核清单的 path 不合法（KERNEL_MANIFEST_INVALID）：${manifestPath} → ${JSON.stringify(dir)}`
    )
  }
  return { version, path: dir, sha256 }
}

function candidatesOf(kernelRoot: string, version: string | null): KernelLayoutCandidates {
  return {
    legacyEntry: join(kernelRoot, ...DSH_KERNEL_SCRIPT_IN_ASAR.split('/')),
    manifest: join(kernelRoot, 'current.json'),
    kernelTreeEntry: join(kernelRoot, ...DSH_KERNEL_SCRIPT_IN_KERNEL_TREE.split('/')),
    versionEntry:
      version === null
        ? null
        : join(kernelRoot, version, ...DSH_KERNEL_SCRIPT_IN_KERNEL_TREE.split('/'))
  }
}

function problem(
  code: KernelStartupCode,
  detail: string,
  kernelRoot: string,
  version: string | null
): KernelLayoutProblem {
  return { ok: false, code, detail, candidates: candidatesOf(kernelRoot, version) }
}

/**
 * 解析内核布局（纯读盘、无副作用）。
 * 旧布局优先判"入口实际存在"（集成测试注入的 asar 根）；否则按新布局读 current.json。
 */
export function resolveKernelLayout(input: KernelLayoutInput): KernelLayout {
  const exists = input.exists ?? existsSync
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const kernelRoot = input.kernelRoot

  // 旧 asar 布局（开发/集成测试注入本机 DSH 的 app.asar）：**按路径形态直接放行**。
  // 普通 Node 的 existsSync 看不见 asar 内部（Electron 的 fs 补丁才行），这里绝不能
  // 用"asar 内文件是否存在"来做布局判定 —— 否则 plain Node 下会被误判成缺件（PB-005 回归）。
  if (/\.asar$/iu.test(kernelRoot)) {
    return {
      ok: true,
      kind: 'asar-layout',
      kernelRoot,
      versionDir: kernelRoot,
      version: 'asar',
      sha256: '',
      scriptPath: `${kernelRoot}/${DSH_KERNEL_SCRIPT_IN_ASAR}`,
      manifestPath: join(kernelRoot, 'current.json'),
      snapshotPath: join(kernelRoot, 'SNAPSHOT.json')
    }
  }

  const legacyEntry = join(kernelRoot, ...DSH_KERNEL_SCRIPT_IN_ASAR.split('/'))
  if (exists(legacyEntry)) {
    return {
      ok: true,
      kind: 'asar-layout',
      kernelRoot,
      versionDir: kernelRoot,
      version: 'asar',
      sha256: '',
      scriptPath: legacyEntry,
      manifestPath: join(kernelRoot, 'current.json'),
      snapshotPath: join(kernelRoot, 'SNAPSHOT.json')
    }
  }

  // 直接指到某个版本目录（`resources/kernel/rc.2`）也认：e2e/集成测试用
  // `KYCLAW_KERNEL_ASAR=<repo>/resources/kernel/rc.2` 注入，主进程不必再拼 current.json。
  const directTreeEntry = join(kernelRoot, ...DSH_KERNEL_SCRIPT_IN_KERNEL_TREE.split('/'))
  if (exists(directTreeEntry)) {
    return {
      ok: true,
      kind: 'kernel-tree',
      kernelRoot,
      versionDir: kernelRoot,
      version: basename(kernelRoot),
      sha256: '',
      scriptPath: directTreeEntry,
      manifestPath: join(kernelRoot, 'current.json'),
      snapshotPath: join(kernelRoot, 'SNAPSHOT.json')
    }
  }

  const manifestPath = join(kernelRoot, 'current.json')
  if (!exists(manifestPath)) {
    return problem(
      'KERNEL_MANIFEST_MISSING',
      [
        `内核目录里没有 current.json（KERNEL_MANIFEST_MISSING）：${manifestPath}`,
        '  打包态应由 electron-builder 的 extraResources 把 resources/kernel 拷到安装目录；',
        '  开发态先跑 `pnpm fetch:kernel`（快照落到 resources/kernel/rc.2，并生成 current.json）。'
      ].join('\n'),
      kernelRoot,
      null
    )
  }

  let pointer: KernelPointer
  try {
    pointer = readPointer(readFile(manifestPath), manifestPath)
  } catch (error) {
    if (error instanceof KernelStartupError) {
      return problem(error.code, error.message, kernelRoot, null)
    }
    throw error
  }

  const versionDir = join(kernelRoot, pointer.path)
  const snapshotPath = join(versionDir, 'SNAPSHOT.json')
  if (!exists(snapshotPath)) {
    return problem(
      'KERNEL_SNAPSHOT_MISSING',
      [
        `内核快照目录不完整（KERNEL_SNAPSHOT_MISSING）：${snapshotPath}`,
        `  current.json 指向 ${pointer.path}（版本 ${pointer.version}），但该目录下没有 SNAPSHOT.json。`,
        '  重新跑 `pnpm fetch:kernel -- --force`，或重装应用。'
      ].join('\n'),
      kernelRoot,
      pointer.path
    )
  }

  return {
    ok: true,
    kind: 'kernel-tree',
    kernelRoot,
    versionDir,
    version: pointer.version,
    sha256: pointer.sha256,
    scriptPath: join(versionDir, ...DSH_KERNEL_SCRIPT_IN_KERNEL_TREE.split('/')),
    manifestPath,
    snapshotPath
  }
}
