/**
 * 命令文本的**目标抽取**（round 71 起；round 75 改定位）：审批判定在命令这一层的唯一入口。
 *
 * ## 它是干什么的
 *
 * 一次 bash 调用要碰的东西写在 `command` 里 —— 审批要判"这次碰的是工作区内还是区外"，
 * 就得先把命令里**要动的路径**抽出来（删除类动词的参数、重定向落点、搬运目的地、`dd of=`），
 * 再交给调用方按路径引擎判内外。抽取结果给 `guard.needsApproval` 用，与工具自己的
 * `path` / `save_to` 字段一起汇总成"这次调用落在哪个区"。
 *
 * 另外返回一件事实：**形态本身就落不到工作区里**的命令（下面的 `unbounded`）——
 * 磁盘 / 系统级（`format X:`、`diskpart`、`mkfs`、`fdisk`、`dd of=/dev/…`、`shred`、`cipher /w`、
 * fork bomb）、把网络取回的内容直接喂 shell（`curl … | sh`、`irm … | iex`）、强制推送
 * （`git push -f` / `--force`：改写的是**远端**历史，远端在工作区之外）。这类命令没有可判定的
 * 文件目标，效果也证明不了落在哪个工作区里 —— 一律按**区外**处理，交给"区外档"说话。
 *
 * `unbounded` 的具体条目见 `UNBOUNDED_REASONS`（每条都带一句给用户看的话，进审批卡）。
 *
 * ## 它**不**再干什么（round 75，用户口径）
 *
 * round 71 曾把这里当"危险命令红线"：命令文本里出现高危形态（递归删除 / 磁盘级 / git 丢改动 /
 * 网络喂 shell / 目标在区外）就**即使 full、即使有『永久允许』规则也要问**。用户口径是
 * "`full` 就是真免审（限定了范围：工作区内）"＋"工作区之外可以单独设成也免审"，所以：
 *   - **递归删除**（`rm -rf` / `rd /s` / `Remove-Item -Recurse` / `find -delete` / `git clean -f`）
 *     不再是一条"永远问"的判据：它删的路径在哪，就按哪个区判（区内的 full 工作区 → 免审）；
 *   - **`git reset --hard`**（丢的是本地未提交改动，落在工作区内）同理，按区判；
 *   - 只剩"落不到工作区里"的形态按**区外**处理（区外档默认问；用户设成完全访问就照办）。
 * 抽取本身照旧保守：认不出的东西不因为"没进任何名单"就放行（判不出 → 区外 → 默认问）。
 *
 * ## 为什么放在 shared
 *
 * 主进程要拿它判审批，审批卡也要用它说清"为什么问"（渲染端自己现算一遍给用户看）。两处必须
 * 同一把尺，否则会出现"卡上没提、实际被拦了"这种自相矛盾的提示（同 `shared/permissions.ts` 的理由）。
 * 唯一的差异点是"这个路径在不在工作区里"——主进程走路径引擎（realpath，防符号链接逃逸），
 * 渲染端只做词法前缀比较（展示用，不是安全边界），所以由调用方注入 `ZoneOf` 回调。
 */

/** 一条形态判据（给测试与调用方判形用；用户只看 reason） */
export type CommandRiskCode =
  'disk-destructive' | 'git-destructive' | 'remote-shell' | 'outside-workspace'

export interface CommandRisk {
  code: CommandRiskCode
  /** 给用户看的一句话（进审批卡；不解释实现、不引内部名词） */
  reason: string
}

/** 一个候选路径"能不能证明它在授权工作区里"：inside = 证明得了；outside = 证明不了（一律按外） */
export type PathZone = 'inside' | 'outside'
export type ZoneOf = (rawPath: string) => PathZone

/** 命令扫出来的两件东西：要动的路径 + "形态上落不到工作区里"的那一类（没有就是 null） */
export interface CommandScan {
  /** 命令**要动**的路径字面量（顺序即出现顺序；相对路径由调用方按基准目录解析） */
  targets: readonly string[]
  /** 形态落不到工作区里（磁盘级 / 网络喂 shell / 强制推送）→ 调用方按"区外"处理 */
  unbounded: CommandRisk | null
}

const UNBOUNDED_REASONS: Record<'disk-destructive' | 'git-destructive' | 'remote-shell', string> = {
  'disk-destructive': '这条命令动的是磁盘或系统本身，不属于任何工作区。',
  'remote-shell': '这条命令把从网上下载的内容直接交给 shell 执行，效果没法限定在工作区里。',
  'git-destructive': '这条命令会改写远端仓库的历史（强制推送），远端在工作区之外。'
}

const OUTSIDE_REASON = '这条命令要动的是授权工作区之外的路径。'

function unboundedRisk(code: 'disk-destructive' | 'git-destructive' | 'remote-shell'): CommandRisk {
  return { code, reason: UNBOUNDED_REASONS[code] }
}

/**
 * 命令名的前缀守卫：`rm` 不能匹配到 `charm` 里，但 `/usr/bin/rm`、`./rm`、`xargs rm` 都要算。
 * `-` 也排除掉，免得把 `foo-rm` 这种当命令名。
 */
const BOUNDARY = '(^|[^\\w-])'

/** 磁盘 / 系统级形态（与目标无关，命中就足以按"区外"处理） */
const NETS_DISK: readonly RegExp[] = [
  new RegExp(`${BOUNDARY}format\\s+[a-z]:`, 'i'),
  new RegExp(`${BOUNDARY}diskpart\\b`, 'i'),
  new RegExp(`${BOUNDARY}mkfs(\\.[a-z0-9]+)?\\b`, 'i'),
  new RegExp(`${BOUNDARY}fdisk\\b`, 'i'),
  new RegExp(`${BOUNDARY}dd\\b[^\\n]*\\bof=/dev/`, 'i'),
  new RegExp(`${BOUNDARY}cipher\\s+/w`, 'i'),
  // fork bomb：`:(){ :|:& };:`（空白随意）
  /:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*\}[^\n]*;/
]

/** `git push --force` / `-f`（`--force-with-lease` 是安全那一档，不在此列）——改的是远端历史 */
const NET_GIT_PUSH_FORCE = new RegExp(
  `${BOUNDARY}git\\s+push\\s+(?:\\S+\\s+)*?(?:-f\\b|--force(?![\\w-]))`
)

/** 网络取回 → 直接喂 shell（bash 系 / PowerShell 系各一条） */
const NET_FETCH = `${BOUNDARY}(?:curl|wget|irm|iwr|invoke-webrequest)\\b`
const NET_REMOTE_SHELL = new RegExp(
  `${NET_FETCH}[^\\n]*\\|\\s*(?:sudo\\s+)?(?:ba|da|z|k)?sh\\b`,
  'i'
)
const NET_REMOTE_POWERSHELL = new RegExp(
  `${NET_FETCH}[^\\n]*\\|\\s*(?:pwsh|powershell|iex|invoke-expression)\\b`,
  'i'
)

/** `find … -delete`：起始目录（第一个非选项参数）就是要动的东西 —— 在 destructiveTargets 里处理 */

/** 包装类命令里只有 `of=` 那个参数是落点（`dd`） */
const VERBS_OF_ARG = new Set(['dd'])

/** 删/改类命令：所有非选项参数都是"要动的东西" */
const VERBS_ALL_ARGS = new Set([
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'unlink',
  'shred',
  'truncate',
  'ri',
  'remove-item',
  'tee'
])

/** 搬运类命令：只有**最后一个**参数是落点（前面的可能是工作区外的来源，不该误伤） */
const VERBS_LAST_ARG = new Set(['mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy'])

/** 命令名前面可以出现的包装词：跳过它们才拿到真正的动词 */
const VERB_PREFIXES = new Set([
  'sudo',
  'doas',
  'command',
  'nohup',
  'nice',
  'time',
  'xargs',
  'busybox',
  'env'
])

/** 一个"简单命令"：词元 + 重定向目标（`>` / `>>` 的落点） */
interface Segment {
  words: string[]
  redirects: string[]
}

const OPERATORS = new Set([';', '&', '|', '<', '>', '(', ')'])

/** 空白分词：认引号（引号内容原样进词元）、认操作符；`\` 是转义（引号外）。 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let redirects: string[] = []
  let word = ''
  let started = false
  let pendingRedirect = false

  const flushWord = (): void => {
    if (!started) return
    const value = word
    word = ''
    started = false
    if (value === '') return
    if (pendingRedirect) {
      redirects.push(value)
      pendingRedirect = false
      return
    }
    words.push(value)
  }

  const closeSegment = (): void => {
    flushWord()
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects })
    words = []
    redirects = []
    pendingRedirect = false
  }

  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === '\\' && i + 1 < command.length) {
      word += command[i + 1]
      started = true
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < command.length) {
        const inner = command[i]
        // 双引号里只有 `"`、`\`、`` ` ``、`$`、换行才吃反斜杠 —— 否则 Windows 路径
        // `"C:\Users\x"` 里的 `\U` 会被当成转义吃掉（词元变成 `C:Usersx`，判不出盘符）
        if (quote === '"' && inner === '\\' && i + 1 < command.length) {
          const next = command[i + 1]
          if (next === '"' || next === '\\' || next === '`' || next === '$' || next === '\n') {
            word += next
            i += 2
            continue
          }
        }
        if (inner === quote) {
          i += 1
          break
        }
        word += inner
        i += 1
      }
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flushWord()
      i += 1
      continue
    }
    if (OPERATORS.has(ch)) {
      flushWord()
      let run = ''
      while (i < command.length && OPERATORS.has(command[i])) {
        run += command[i]
        i += 1
      }
      // `>` / `>>` 后面那个词是落点；`>&` 这种 fd 复制不是文件目标
      if (run.includes('>') && !run.includes('&')) pendingRedirect = true
      else closeSegment()
      continue
    }
    word += ch
    started = true
    i += 1
  }
  closeSegment()
  return segments
}

/** 词元 → 命令名：取路径末段、去 `.exe`、小写；跳过 `sudo` 这类包装词（返回它在词元里的位置） */
function verbOf(words: readonly string[]): { name: string; index: number } | null {
  for (let index = 0; index < words.length; index += 1) {
    const raw = words[index]
    const base = raw.split(/[\\/]/).at(-1) ?? raw
    const name = base.replace(/\.exe$/i, '').toLowerCase()
    if (name === '') continue
    if (VERB_PREFIXES.has(name)) continue
    return { name, index }
  }
  return null
}

/** 选项（`-x` / `--xxx` / cmd 的 `/s`）—— 不当作目标；`/srv` 这种多字母的是路径 */
function isFlag(value: string): boolean {
  if (value === '') return true
  if (value.startsWith('-')) return true
  return /^\/[a-z]$/i.test(value)
}

/** 一条简单命令里"会被改动的路径"（重定向落点 + 动词决定的目标位） */
function destructiveTargets(segment: Segment): string[] {
  const targets: string[] = [...segment.redirects]
  const verb = verbOf(segment.words)
  if (verb === null) return targets
  const args = segment.words.slice(verb.index + 1)

  if (VERBS_OF_ARG.has(verb.name)) {
    for (const arg of args) {
      if (arg.startsWith('of=')) targets.push(arg.slice('of='.length))
    }
    return targets
  }

  if (VERBS_ALL_ARGS.has(verb.name)) {
    for (const arg of args) {
      if (isFlag(arg)) continue
      if (arg.startsWith('of=')) targets.push(arg.slice('of='.length))
      else targets.push(arg)
    }
    return targets
  }

  // `find <起始目录> … -delete`：起始目录是第一个非选项参数（`find` 其它参数是条件，不是落点）
  if (verb.name === 'find' && segment.words.some((word) => word === '-delete')) {
    const start = args.find((arg) => !isFlag(arg))
    if (start !== undefined) targets.push(start)
    return targets
  }

  if (VERBS_LAST_ARG.has(verb.name)) {
    const last = [...args].reverse().find((arg) => !isFlag(arg))
    if (last !== undefined) targets.push(last)
  }
  return targets
}

/**
 * 命令文本 → 目标抽取 + "落不到工作区里"的那一类。
 * `unbounded` 的顺序即优先级：磁盘级 / 网络喂 shell / 强制推送各报各的（口径见文件头注）。
 */
export function scanCommand(command: string): CommandScan {
  const text = command.trim()
  if (text === '') return { targets: [], unbounded: null }

  const targets: string[] = []
  for (const segment of splitSegments(text)) {
    for (const target of destructiveTargets(segment)) {
      const token = target.trim()
      if (token !== '') targets.push(token)
    }
  }

  const unbounded = NETS_DISK.some((net) => net.test(text))
    ? unboundedRisk('disk-destructive')
    : NET_REMOTE_SHELL.test(text) || NET_REMOTE_POWERSHELL.test(text)
      ? unboundedRisk('remote-shell')
      : NET_GIT_PUSH_FORCE.test(text)
        ? unboundedRisk('git-destructive')
        : null

  return { targets, unbounded }
}

/**
 * 命令文本 → 命中哪一条"区外"判据（没命中回 null）。
 * 抽取档（`targets`）里只要有一个路径证明不了在工作区内就算命中 `outside-workspace`。
 * 渲染端用它给审批卡写"为什么问"（真判定在主进程：那里的 `ZoneOf` 走路径引擎）。
 */
export function assessCommandRisk(command: string, zone: ZoneOf): CommandRisk | null {
  const scan = scanCommand(command)
  if (scan.unbounded !== null) return scan.unbounded
  for (const target of scan.targets) {
    if (zone(target) === 'outside') return { code: 'outside-workspace', reason: OUTSIDE_REASON }
  }
  return null
}
