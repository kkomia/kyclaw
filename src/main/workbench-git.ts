/**
 * 「Git」工具的读侧（右侧边栏的 git 树）：仓库总览（分支 + 未提交变更）、提交历史、单提交详情。
 *
 * 三个只读动作，都在**会话根**里跑 `git -C <root>`；不加依赖，直接 spawn 可执行文件
 * （argv 数组，不经 shell —— 路径与提交信息没有注入面）。git 可执行文件走
 * `main/git-bash.ts` 的探测链（`KYCLAW_GIT` → PATH → Git Bash 安装位推导）。
 *
 * 契约与取舍：
 *   - **非仓库 / 空仓库不抛错**：`isRepo` / `empty` 两个布尔表达，界面给空态
 *     （"这不是一个 git 仓库" / "这个仓库还没有提交"）；
 *   - 输出上限 256KB（比工具侧的 64KB 宽：200 条历史 + 大仓库的 status 要放得下），
 *     解析型命令被截断会让最后一条不完整，所以截断时**丢掉最后一段**（按行/按 NUL 收尾）；
 *   - 单条命令 60s 超时、超时杀进程树（交给 exec 的 runProcess）；
 *   - `-c core.quotepath=false`：中文文件名不转义成 \344\270\255。
 */
import { runProcess } from '../mastra/tools/exec'
import { gitExecutable, GIT_MISSING } from './git-bash'
import type {
  GitChange,
  GitChangeStatus,
  GitCommit,
  GitCommitDetail,
  GitFileStat,
  GitOverview
} from '../shared/workbench'

/** 单条 git 命令的超时（毫秒） */
export const GIT_COMMAND_TIMEOUT_MS = 60_000

/** 结构化输出的字节上限（历史 200 条 + 大仓库 status 都放得下） */
export const GIT_OUTPUT_LIMIT = 256 * 1024

/** `git log` 的字段分隔（\x1e 记录起、\x1f 字段分隔；提交信息/路径里都不会出现） */
const RECORD = '\x1e'
const FIELD = '\x1f'

export interface GitRun {
  text: string
  exitCode: number | null
  /** 非零退出或启动失败（git 自己的输出就是最好的解释，调用方按需处理） */
  failed: boolean
  /** 启动失败（找不到 git 可执行文件等）时的原因 */
  spawnError: Error | null
}

/** 注入点：测试用假件替掉真实 spawn 与 git 解析 */
export interface GitRunner {
  resolveGit?: () => string | null
  run?: (args: readonly string[]) => Promise<GitRun>
}

/**
 * 在 `root` 里跑一条 git 命令（`-C root` 钉住仓库；不带 shell）。
 * 输出超上限时按 `\n` 收尾（解析型输出宁可少最后一条，也不要半条）。
 */
export function createGitRunner(
  root: string,
  options: GitRunner = {}
): (args: readonly string[]) => Promise<GitRun> {
  const resolveGit = options.resolveGit ?? gitExecutable
  if (options.run !== undefined) return options.run

  return async (args) => {
    const git = resolveGit()
    if (git === null) throw new Error(GIT_MISSING)

    const result = await runProcess({
      command: git,
      args: ['-c', 'core.quotepath=false', '-C', root, ...args],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_LIMIT
    })
    if (result.spawnError !== null) throw new Error(`git 启动失败：${result.spawnError.message}`)

    const text = result.timedOut ? dropLastLine(result.text) : result.text
    return {
      text,
      exitCode: result.exitCode,
      failed: result.exitCode !== 0 || result.timedOut,
      spawnError: null
    }
  }
}

/** 截断/超时后的收尾：去掉可能不完整的最后一段 */
function dropLastLine(text: string): string {
  const index = text.lastIndexOf('\n')
  return index === -1 ? '' : text.slice(0, index)
}

/**
 * 仓库总览：是不是仓库（`rev-parse --is-inside-work-tree`）→ 分支 → 有没有提交 → 变更列表。
 * 不是仓库就直接回 `isRepo: false`（后面三件事不再问 git）。
 */
export async function gitOverview(root: string, options: GitRunner = {}): Promise<GitOverview> {
  const run = createGitRunner(root, options)

  const inside = await run(['rev-parse', '--is-inside-work-tree'])
  if (inside.failed || inside.text.trim() !== 'true') {
    return { isRepo: false, empty: false, branch: null, changes: [] }
  }

  const branch = await resolveBranch(run)
  // 空仓库：还没有 HEAD。此时 status 仍有意义（全部是新文件），照常给。
  const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD'])
  const empty = head.failed || head.text.trim() === ''

  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return {
    isRepo: true,
    empty,
    branch,
    changes: status.failed ? [] : parsePorcelain(status.text)
  }
}

/** 分支短名：正常用 `rev-parse --abbrev-ref HEAD`；空仓库退到 `symbolic-ref`（未出生分支也有名字） */
async function resolveBranch(
  run: (args: readonly string[]) => Promise<GitRun>
): Promise<string | null> {
  const head = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.failed) {
    const name = head.text.trim()
    if (name !== '') return name
  }
  const symbolic = await run(['symbolic-ref', '--short', '--quiet', 'HEAD'])
  if (!symbolic.failed) {
    const name = symbolic.text.trim()
    if (name !== '') return name
  }
  return null
}

/**
 * 解析 `status --porcelain=v1 -z`：每条 `XY<空格>路径\0`；`R`/`C` 后面还跟一条**原路径**（也以 \0 结尾）。
 * 重命名保留新路径（用户看的是"现在叫什么"），后续那条原路径跳过不产出条目。
 */
export function parsePorcelain(text: string): GitChange[] {
  const parts = text.split('\0')
  const changes: GitChange[] = []

  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    if (entry === undefined || entry.length < 4) continue
    const x = entry.slice(0, 1)
    const y = entry.slice(1, 2)
    // `XY<空格>path`：-z 下分隔空格仍在，防御性地兼容"没有空格"的写法
    const path = entry.slice(entry.slice(2, 3) === ' ' ? 3 : 2)
    if (path === '') continue
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index += 1 // 跳过原路径那条
    changes.push({ path, status: classify(x, y), staged: isStaged(x, y) })
  }
  return changes
}

/**
 * 有没有已暂存的那一半。冲突条目不按"暂存"理解（两列都可能有内容，说"已暂存"会误导），
 * 未跟踪也没有；其余看第一列非空。
 */
function isStaged(x: string, y: string): boolean {
  if (x === '?' || x === 'U' || y === 'U') return false
  if ((x === 'D' && y === 'D') || (x === 'A' && y === 'A')) return false
  return x !== ' '
}

/** 两字母码 → 归类。冲突组合（DD/AU/UD/UA/DU/AA/UU）先判；未跟踪单独一档 */
export function classify(x: string, y: string): GitChangeStatus {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) {
    return 'conflicted'
  }
  // 有暂存的那一半就看第一列；只有工作区改动（第二列）时看第二列
  const code = x !== ' ' ? x : y
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    default:
      return 'modified'
  }
}

/**
 * 提交历史：`git log --graph --decorate=short --pretty=format:` 的结构化解析。
 * 每条提交一行（`%s` 只有标题行，所以不会跨行）；图形列是那一行的前缀（含 `| \ /` 与缩进），
 * 渲染端用 monospace 原样画。纯图形的连接行（`|/` 这种）没有记录标记，不产出条目。
 */
export async function gitLog(
  root: string,
  limit: number,
  options: GitRunner = {}
): Promise<GitCommit[]> {
  const run = createGitRunner(root, options)
  const format = `${RECORD}%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%D${FIELD}%s`
  const result = await run([
    'log',
    '--graph',
    '--decorate=short',
    `--pretty=format:${format}`,
    `-n${limit}`
  ])
  if (result.failed || result.text.trim() === '') return []
  return parseGraphLog(result.text)
}

/** 逐行解析 `--graph` 输出：取 `\x1e` 之前的部分当图形列，之后按 `\x1f` 切字段 */
export function parseGraphLog(text: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const line of text.split('\n')) {
    const marker = line.indexOf(RECORD)
    if (marker === -1) continue
    const fields = line.slice(marker + 1).split(FIELD)
    const [sha, short, author, date, refs, subject] = fields
    if (sha === undefined || short === undefined || sha === '') continue
    commits.push({
      sha,
      short,
      graph: line.slice(0, marker),
      refs: refs ?? '',
      subject: subject ?? '',
      author: author ?? '',
      date: date ?? ''
    })
  }
  return commits
}

/** 单提交详情：作者/时间/完整 message（`%B`）+ 变更文件统计（`--numstat`） */
export async function gitShow(
  root: string,
  sha: string,
  options: GitRunner = {}
): Promise<GitCommitDetail> {
  const run = createGitRunner(root, options)

  const metaFormat = `%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%B`
  const meta = await run(['show', '-s', `--format=${metaFormat}`, sha])
  if (meta.failed) {
    throw new Error(`看不了这条提交：${meta.text.trim() || 'git 没有给出原因'}`)
  }

  const fields = meta.text.split(FIELD)
  const [full, short, author, email, date] = fields
  const message = fields.slice(5).join(FIELD).replace(/\s+$/, '')

  // `--first-parent`：合并提交默认不给 diff，按第一父提交给（与 GitHub 的展示口径一致）
  const stats = await run(['show', '--numstat', '--format=', '--first-parent', sha])

  return {
    sha: full ?? sha,
    short: short ?? sha.slice(0, 7),
    author: author ?? '',
    email: email ?? '',
    date: date ?? '',
    message,
    files: stats.failed ? [] : parseNumstat(stats.text)
  }
}

/** 解析 `--numstat`：`<新增>\t<删除>\t<路径>`；二进制文件的两列是 `-`（给 null） */
export function parseNumstat(text: string): GitFileStat[] {
  const files: GitFileStat[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const [added, removed, ...rest] = line.split('\t')
    const path = rest.join('\t').trim()
    if (path === '' || added === undefined || removed === undefined) continue
    files.push({
      path,
      additions: added === '-' ? null : Number.parseInt(added, 10),
      deletions: removed === '-' ? null : Number.parseInt(removed, 10)
    })
  }
  return files
}
