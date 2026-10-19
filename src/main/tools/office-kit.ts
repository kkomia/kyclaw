import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/** 直接指向**随包 kit 根目录**的逃生门（排障用：换一份 kit、或指到别处的安装） */
const KIT_DIR_ENV = 'KYCLAW_LIBREOFFICE_KIT'

/** 随包 kit 的入口（相对 kit 根目录；`pnpm fetch:libreoffice-kit` 落的 npm 平铺布局） */
const KIT_CLI_RELATIVE = join('node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')

/** kit 根目录名（extraResources 把它放在 `<resources>/libreoffice-kit`，仓库里在 `resources/`） */
const KIT_DIR_NAME = 'libreoffice-kit'

/**
 * 随包 kit 的根目录候选（按优先级；第一个真的有 CLI 的为准）。
 * 三个来源对应三种跑法，**都是路径存在性判断，不起进程**：
 *   1. 环境变量显式指定（排障 / 内测换一份 kit）；
 *   2. **打包态**：extraResources 把仓库的 `resources/libreoffice-kit` 原样放到
 *      `<install>/resources/libreoffice-kit`，即 `process.resourcesPath/libreoffice-kit`
 *      （与 llama / skills 同一个范式，见 `src/main/index.ts`）；
 *   3. **开发态**：仓库里那份（`pnpm fetch:libreoffice-kit` 落的，不入库）—— 先看进程工作目录
 *      （`electron-vite dev` / vitest 的工作目录就是仓库根），再从本模块所在目录往上找
 *      （打包成 CJS 后模块目录是 `out/main`，往上两层就是仓库根）。
 */
function kitRootCandidates(): string[] {
  const candidates: string[] = []
  const explicit = process.env[KIT_DIR_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') candidates.push(explicit)
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(join(process.resourcesPath, KIT_DIR_NAME))
  }
  candidates.push(join(process.cwd(), 'resources', KIT_DIR_NAME))
  for (const ancestor of moduleAncestors()) {
    candidates.push(join(ancestor, 'resources', KIT_DIR_NAME))
  }
  return candidates
}

/**
 * 本模块所在目录往上几层。electron-vite 把主进程打成 CJS，`__dirname` 就是 `out/main`；
 * 但这段代码也会在测试的 ESM 里跑（那里没有 `__dirname`），所以先 `typeof` 探一下再走。
 */
function moduleAncestors(): string[] {
  if (typeof __dirname !== 'string' || __dirname === '') return []
  const out: string[] = []
  let dir = __dirname
  for (let level = 0; level < 3; level += 1) {
    dir = dirname(dir)
    out.push(dir)
  }
  return out
}

/**
 * 找随包 kit 的 CLI（找不到回 null）。
 * 只看文件在不在：**探测不启动任何进程**（真起一次要几秒），AI 真的渲染时起不来会在回执里说清。
 */
export function resolveKitCli(): string | null {
  for (const root of kitRootCandidates()) {
    const cli = join(root, ...KIT_CLI_RELATIVE.split(sep))
    if (existsSync(cli)) return cli
  }
  return null
}
