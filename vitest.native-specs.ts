import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 「真库 / 真服务」组的成员表 —— 交给 `vitest.config.ts` 分成两个 project。
 *
 * ## 为什么要分组（round 70 治本，取代"逐例补超时"）
 *
 * 宽口径 sweep 跑崩过一个 worker：`Worker exited unexpectedly with exit code 3221226505`
 * （`0xC0000409` = `STATUS_STACK_BUFFER_OVERRUN`，Windows 上原生模块崩的典型码），
 * 当时的挂点是旧内核里的一个 spec（已随 Step 2 删除 `src/mastra` 移除）；**同一个文件单跑全绿**。
 *
 * 这一组 spec 的共同点是：进程里会真的装进 **libsql 原生插件**
 * （`@libsql/win32-x64-msvc/index.node`）。Step 2 之后 `@mastra/*` 已移除，标记随之收敛，
 * 但"同时几份原生插件 + 几份临时库"这个维度还在，限流仍然有效。
 * 默认满并发时本机是
 * `os.availableParallelism()` = 8 个 fork 同时在跑，也就是**同时有 8 份原生插件 + 8 份
 * 临时 libsql 库**在跑；单跑时只有 1 份。把这一组收敛到更小的并发，就是冲着这个维度去的
 * （不碰任何业务代码）。
 *
 * ## 成员判定（按 import/调用判，不按文件名猜）
 *
 * 扫 `src/**` 下的 spec/test，正文里出现下列任一标记即入组：
 *   - `startAgentServer(` —— 走 `main/agent/service.ts`，会起真宿主服务（存储/插件/终端）。
 *
 * 带左括号是为了只认"真的调用/导入"，不认注释里顺口提一句的（例如
 * `src/main/agent/__tests__/authoring-runtime.spec.ts` 只在头注里提了 `startAgentServer`，
 * 它实际只 import 了 `authoringRuntimeFor`，不碰原生插件）。
 *
 * 扫描而不是写死清单：写死的清单会漂（新加一个真库 spec 忘了登记，就悄悄回到满并发）。
 *
 * **宁可误收，不可漏收**：漏收 = 把一份原生并发放回满并发（正是要治的那件事），
 * 误收只是"多限流一个文件"，代价可忽略。已知的误收一处：
 * `src/main/__tests__/telemetry-env.spec.ts` 把 `startAgentServer(` 当**字符串**找
 * （`source.indexOf(...)`），它其实只读 `index.ts` 的源码文本做断言。
 *
 * **刻意不收进来的**（避免把组撑大、把聚焦跑拖慢）：
 *   - 只是 `createKyclawAgent`（装配 Agent 对象，不碰原生插件）；
 *   - 只起 node 内 HTTP stub（`createServer`）或只假注入 pty 的 spec；
 *   - `src/main/__tests__/llama-engine.spec.ts`（真起 node 子进程跑 stub 引擎，但子进程里
 *     没有原生插件，不属这个维度）。
 * `node-pty` 在测试里从没被真加载过（一律注入假件），`git` 子进程是同步短命令，都留在并行池。
 */
const MARKERS = ['startAgentServer(']

/** 只扫测试文件；`out/`、`dist` 系产物目录不进 */
const TEST_FILE = /\.(spec|test)\.tsx?$/
const SCAN_ROOT = 'src'
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'dist-alt', 'dist-r63', 'build'])

function collectFiles(dir: string, found: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(path, found)
    } else if (TEST_FILE.test(entry.name)) {
      found.push(path)
    }
  }
}

/**
 * 会加载 libsql 原生插件（或起真 Mastra）的 spec，relative-to-cwd 的 posix 路径。
 *
 * 用 `process.cwd()` 定位仓库根：与本文件旁边 `vitest.config.ts` 里既有的
 * `resolve('src/renderer/src')` 同一口径（`vitest` 从仓库根跑）。
 */
export function nativeSpecs(cwd: string = process.cwd()): string[] {
  const found: string[] = []
  collectFiles(join(cwd, SCAN_ROOT), found)

  const matched: string[] = []
  for (const path of found) {
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (MARKERS.some((marker) => source.includes(marker))) {
      matched.push(relative(cwd, path).split(sep).join('/'))
    }
  }
  return matched.sort()
}
