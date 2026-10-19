import { lookup as dnsLookup } from 'node:dns/promises'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { isIP } from 'node:net'
import { basename, dirname, join } from 'node:path'
import {
  blockedIpReason,
  blockedTargetReason,
  FETCH_ALLOW_HOSTS_ENV,
  FETCH_MAX_REDIRECTS,
  isLocalHostName,
  normalizeHost
} from '../tools/fetch-policy'
import { slugify } from '../../shared/plugins'
import type { InstalledPlugin } from '../../shared/settings'
import {
  SKILL_FILE,
  isWindowsReservedName,
  parseSkillFrontmatter,
  readSkillHeader,
  skillNameProblem,
  type SkillSource
} from '../../shared/skills'
import { readSkillZip, type SkillZipFile } from './skill-zip'
import { skillSourcesFor } from './skills'
import { ensureDir, removeDirRobust } from './store'

/**
 * **单个技能的导入**（round 94，用户反馈 004）：不走插件市场那条路，直接注册一份技能。
 *
 * 三条来源，落到同一个地方（`<userData>/skills/<名字>/`，与插件复制进来的技能、模型用 create_skill
 * 建的技能同一个目录 —— 因为 `skillSourcesFor` 扫的就是它，导入完**下一轮对话就能被 use_skill 读到**）：
 *   - **HTTP(S) 直链**：`SKILL.md`，或一个单技能 zip（≤8MiB 下载上限）；
 *   - **本地文件**：`.md`，或 zip（不按扩展名判内容：先看魔数，不是 zip 就当文本 SKILL.md）；
 *   - **本地目录**：根目录里有 `SKILL.md` 的那一层，整份复制（资源保留）。
 *
 * 口径（都是硬边界，逐条有理由）：
 *   - **出站边界复用 fetch 那一套**（`mastra/tools/fetch` 的 `blockedTargetReason`）：
 *     `redirect: 'manual'` 自己跟，**每一跳都重新过闸**（公网 URL 302 到 127.0.0.1 的经典形状），
 *     环回 / 私网 / 链路本地 / 本机名默认一律拒；用户显式授权的白名单是唯一出口
 *     （界面上的"允许这台主机"按钮写的就是同一份设置，或环境变量 `KYCLAW_FETCH_ALLOW_HOSTS`）。
 *     **残留风险（与 fetch 同一条，如实记录）**：判定用一次 DNS 解析、真正连接时 undici 会再解析一次，
 *     理论上存在 DNS rebinding 的错开窗口（TOCTOU）；要彻底堵死得把连接钉在校验过的 IP 上，而 fetch
 *     没有这个口子。所以这里**不宣称"绝对 SSRF 安全"**，只保证"每一跳都按当下的解析结果过闸"。
 *   - **默认不执行、不解释任何包内内容**：脚本（`.sh` / `.py` / `.ps1`…）**原样保存但不执行**，
 *     也不按扩展名白名单筛资源 —— 技能的资源形态由技能作者决定，我们只当字节搬。
 *   - **上界**：下载 8MiB；解包/目录合计 10MiB、最多 200 个文件、单文件 2MiB；`SKILL.md` 走**读取侧**
 *     的那条 256KiB（`SKILL_TEXT_MAX_BYTES`，见 SKILL_MD_MAX_BYTES 的注释）。
 *   - **名字**：进 frontmatter `name`（没有就用"来源名"回落：zip 的顶层包装目录名 / 文件名 / 目录名），
 *     必须过 `SKILL_NAME_PATTERN`（它同时是目录名与 `+ → 引用技能` 的引用名）。不合规**拒并给 slug 建议**，
 *     不静默改名 —— 名字是模型 findSkill 的唯一凭据，偷偷换一个等于给用户一份"名字对不上"的技能。
 *   - **同名拒**（大小写不敏感；内置 / 我的 / 插件带来的都算），**不静默覆盖**：目录名是引用名，
 *     覆盖会让"用户以为是更新"的动作变成替换别人的技能。
 *   - **原子发布**：先写进**技能扫描根之外**的自建暂存根（`<skillsDir>.staging/skill-import-<pid>-<ts>/`，
 *     `SKILL.md` 最后写 —— 它是"这个技能存在"的唯一标志），再 `renameSync` 进目标目录（同盘原子）。
 *     失败只清**自己那一次建的**暂存目录，且清理失败不覆盖原始错误（见 publishSkill）。
 *
 * 与 create_skill 的分工：那个给模型用（写盘内容由模型给），这个给人用（内容来自 URL / 文件），
 * 名字与冲突口径两边一致，落地目录同一处。
 */
export interface SkillImportDeps {
  /** `<userData>/skills`（插件技能复制到的同一个目录） */
  skillsDir: string
  /** 内置技能根（`resources/skills`）；缺省 = 没有内置技能 */
  builtinDir?: string | null
  /** 已安装插件记录（插件技能目录的归属，同名冲突要认得出它们） */
  installed?: readonly InstalledPlugin[]
  /** 出站白名单**现读**（设置 `network.allowLocalHosts`；缺省 = 一个都不放行） */
  allowHosts?: () => readonly string[]
  /** 主机名解析（测试注入；缺省走系统解析器，与 fetch 同口径） */
  lookup?: (host: string) => Promise<readonly string[]>
  /** 下载超时（测试注入口；缺省 30 秒） */
  timeoutMs?: number
  /**
   * 测试注入口（缺省 = node:fs 的 renameSync / plugins/store 的 removeDirRobust）：
   * 用来钉"改名失败只清自建暂存"与"清理失败不覆盖原始导入错误"这两条 —— 真机上要造出
   * "删不掉"（杀软/索引器占用）而同时不改动任何真实文件，靠注入是唯一可控又诚实的办法。
   */
  fs?: {
    rename?: (from: string, to: string) => void
    remove?: (dir: string) => void
  }
}

/** 导入结果：技能名（frontmatter 的 name / 回落名）与目录名（= 名字，同一份口径） */
export interface ImportedSkill {
  name: string
  dir: string
}

/**
 * 被出站边界拦下（round 94）：`local` = 这个目标**本身就是**本机/内网语义
 * （字面 IP 落在被拒网段，或 `localhost` / `*.local` / `*.internal` 这类本机名）——
 * 只有这一档，界面才给"允许这台主机（写进同一份白名单）"的按钮。
 *
 * 其余被拦的形状（域名解析不到 IP、域名解析到私网、协议不支持）**不给按钮**：按钮的语义是
 * "用户授权这一台机器"，前两种要么判不出、要么得替用户再解析一次才判得出；给按钮等于把
 * fail-closed 的解析判定变成"点一下绕过"，而那一步该由用户去设置里显式写白名单。
 */
export class SkillEgressBlockedError extends Error {
  readonly host: string
  readonly url: string
  readonly reason: string
  readonly local: boolean

  constructor(
    block: { host: string; url: string; reason: string; local: boolean },
    message: string
  ) {
    super(message)
    this.name = 'SkillEgressBlockedError'
    this.host = block.host
    this.url = block.url
    this.reason = block.reason
    this.local = block.local
  }
}

/**
 * 目标**本身**是不是"确定的局域语义"（字面 IP 落在被拒网段，或本机/内网名后缀）。
 * 只看目标自己，不解析域名 —— 解析类（域名指向私网）与解析失败都不在这一档，见上面的说明。
 */
export function isLocalTarget(target: URL): boolean {
  const host = normalizeHost(target.hostname)
  if (host === '') return false
  if (isIP(host) !== 0) return blockedIpReason(host) !== null
  return isLocalHostName(host)
}

/**
 * 白名单条目的写法（`主机:生效端口`）：按用户确认的那一个地址精确放行，不留通配。
 *
 * IPv6 必须写成 `[::1]:8080`（带方括号）：`hostAllowed` 认的带端口写法是
 * `/^(\[.+\]|[^:]+):(\d+)$/` —— 裸的 `::1:8080` 既匹配不上"带端口"那一支，也不等于主机名
 * `::1`，写进去等于没放行（用户点了允许却还是被拦，是最糟的那种"看起来成功"）。
 */
export function allowEntryFor(target: URL): string {
  const host = normalizeHost(target.hostname)
  const bracketed = isIP(host) === 6 ? `[${host}]` : host
  return `${bracketed}:${effectivePortOf(target)}`
}

/** URL 的生效端口（默认端口在 URL 里是空串，白名单要能写 `host:80`；与 fetch 同口径） */
function effectivePortOf(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/** 下载上限（字节）：超过就中止并拒绝（8MiB 对一份技能包足够） */
export const SKILL_URL_MAX_BYTES = 8 * 1024 * 1024
/** 下载超时（毫秒） */
export const SKILL_URL_TIMEOUT_MS = 30_000
/** 本地 zip 的文件大小上限（字节）：解压后的总量另有 10MiB 闸；这里只防"读进内存时就已经很大" */
export const SKILL_LOCAL_ZIP_MAX_BYTES = 64 * 1024 * 1024
/** 解包/目录的体量闸（与 create_skill 的上界同一量级） */
export const SKILL_ARCHIVE_MAX_FILES = 200
export const SKILL_ARCHIVE_MAX_ENTRY_BYTES = 2 * 1024 * 1024
export const SKILL_ARCHIVE_MAX_TOTAL_BYTES = 10 * 1024 * 1024
/**
 * `SKILL.md` 的上限 = **读取侧的那条**：`mastra/skills/loader.ts` 的 `SKILL_TEXT_MAX_BYTES`
 * （256KiB，`use_skill` 读全文的字节上界，超了截断）。导入不该比它更严 —— 比读取侧更严只是拦掉
 * 一份本来读得回来的手册（旧口径的 64KiB 是照 create_skill 的单文件上限写的，那是**写**侧的上限，
 * 与这里无关）。两处必须相等：`skill-add.spec.ts` 直接断言这条耦合，改了一边另一边会红。
 */
export const SKILL_MD_MAX_BYTES = 256 * 1024
/** 暂存目录前缀（只出现在**技能扫描根之外**的自建暂存根里，见 skillStagingRoot） */
export const SKILL_IMPORT_STAGING_PREFIX = 'skill-import-'

const ZIP_LIMITS = {
  maxFiles: SKILL_ARCHIVE_MAX_FILES,
  maxEntryBytes: SKILL_ARCHIVE_MAX_ENTRY_BYTES,
  maxTotalBytes: SKILL_ARCHIVE_MAX_TOTAL_BYTES
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 一次导入的"包内文件表 + 名字回落候选" */
interface SkillPayload {
  /** 归一后的文件（必含根目录的 SKILL.md） */
  files: SkillZipFile[]
  /** frontmatter 没写 name 时的候选来源名，按优先序（写了 name 就以它为准，不合规直接拒） */
  fallbackNames: string[]
}

/** HTTP(S) 直链导入：下载 → 判形态（zip / md）→ 发布 */
export async function importSkillFromUrl(
  deps: SkillImportDeps,
  rawUrl: string
): Promise<ImportedSkill> {
  const url = parseHttpUrl(rawUrl)
  const bytes = await downloadSkill(deps, url)
  const payload = payloadFromBytes(bytes, [stemOf(url.pathname)])
  return publishSkill(deps, payload)
}

/** 本地导入：目录整份复制；文件按内容判（zip 魔数 → 解包，否则当 SKILL.md 文本） */
export async function importSkillFromLocal(
  deps: SkillImportDeps,
  rawPath: string
): Promise<ImportedSkill> {
  const path = rawPath.trim()
  if (path === '') throw new Error('没有给出路径')
  if (!existsSync(path)) throw new Error(`读不了这个路径：${path}（不存在或没有权限）`)
  const stat = statSync(path)

  if (stat.isDirectory()) {
    const payload = payloadFromFiles(collectDirectory(path), [baseName(path)], '目录')
    return publishSkill(deps, payload)
  }
  if (!stat.isFile()) {
    throw new Error(`只能导入文件或文件夹：${path}`)
  }

  const head = readHead(path, 4)
  if (isZipHead(head)) {
    if (stat.size > SKILL_LOCAL_ZIP_MAX_BYTES) {
      throw new Error(
        `zip 文件太大（${stat.size} 字节，超过 ${Math.round(SKILL_LOCAL_ZIP_MAX_BYTES / 1024 / 1024)}MB 上限）：${path}`
      )
    }
    const payload = payloadFromBytes(readFileSync(path), [stemOf(path)])
    return publishSkill(deps, payload)
  }

  if (stat.size > SKILL_URL_MAX_BYTES) {
    throw new Error(
      `文件太大（${stat.size} 字节，超过 ${Math.round(SKILL_URL_MAX_BYTES / 1024 / 1024)}MB 上限）：${path}`
    )
  }
  const payload = payloadFromBytes(readFileSync(path), [stemOf(path)])
  return publishSkill(deps, payload)
}

/** 形如 `http://…` / `https://…` 的绝对地址（其余协议在"出站边界"之前就挡下，错误更直白） */
function parseHttpUrl(raw: string): URL {
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`这不是一个合法的网址：「${value}」`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http:// 与 https:// 链接（收到 ${url.protocol}//）`)
  }
  return url
}

/** 下载（逐跳出站校验 + 超时 + 字节上限）；返回响应体字节 */
async function downloadSkill(deps: SkillImportDeps, start: URL): Promise<Buffer> {
  const allow = allowHostsFor(deps)
  const lookup = deps.lookup ?? defaultLookup
  const timeoutMs = deps.timeoutMs ?? SKILL_URL_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let current = start
    for (let hop = 0; ; hop += 1) {
      // 每一跳都过闸（与 fetch 同一口径）：不被"公网 URL 302 到本机"绕过
      const reason = await blockedTargetReason(current, allow, lookup)
      if (reason !== null) throw blockedDownloadError(start, current, reason, hop)

      let response: Response
      try {
        response = await fetch(current.href, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: '*/*' }
        })
      } catch (error) {
        if (timedOut) throw timeoutError(start, timeoutMs)
        throw new Error(`下载失败：${detailOf(error)}（${current.href}）`)
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (location === null || location.trim() === '') {
          throw new Error(`下载失败：HTTP ${response.status}（${current.href}）`)
        }
        if (hop >= FETCH_MAX_REDIRECTS) {
          throw new Error(
            `下载失败：重定向次数超过 ${FETCH_MAX_REDIRECTS} 次（起点 ${start.href}），已停止跟随`
          )
        }
        try {
          current = new URL(location, current)
        } catch {
          throw new Error(`下载失败：重定向给了一个看不懂的地址（${location}）`)
        }
        continue
      }

      if (!response.ok) {
        throw new Error(`下载失败：HTTP ${response.status}（${current.href}）`)
      }
      try {
        return await readCapped(response, SKILL_URL_MAX_BYTES)
      } catch (error) {
        if (timedOut) throw timeoutError(start, timeoutMs)
        throw error
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

function timeoutError(start: URL, timeoutMs: number): Error {
  return new Error(`下载超时：超过 ${Math.round(timeoutMs / 1000)} 秒没有响应（${start.href}）`)
}

/** 读响应体，最多 `limit` 字节；超了中止并拒绝（不把整包读完再说） */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (reader === undefined) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const buffer = Buffer.from(value)
    total += buffer.length
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error(
        `下载失败：内容超过 ${Math.round(limit / 1024 / 1024)}MB 上限（${response.url || '请求地址'}）`
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * 被出站边界拦下的人话（含"怎么放行"的出口；与 fetch 的 blockedError 同一口径）。
 *
 * **压成一行**是刻意的：这条错误经 IPC 抛到渲染端，界面显示走 `unwrapIpcError`——它**只留第一行**
 * （多行会把"下一步"整段吃掉，用户就看不到怎么放行）。所以原因与出口必须同在第一行里。
 * 同时把 `local` / `host` 带上（`SkillEgressBlockedError`）：本机/内网那一档界面会多给一个
 * "允许这台主机"的按钮（写的就是同一份白名单，见插件页的网址导入对话框）。
 */
function blockedDownloadError(start: URL, target: URL, reason: string, hop: number): Error {
  const head =
    hop === 0
      ? `导入已阻断：这个地址是${reason} —— 导入默认只访问公网地址，请求没有发出去。`
      : `导入已阻断：请求被重定向到 ${target.href}（第 ${hop} 跳），那是${reason}，已停止跟随。`
  const local = isLocalTarget(target)
  const hint = local
    ? `这一步可以直接在导入框里点「允许这台主机」把 ${allowEntryFor(target)} 加进白名单，`
    : // 判不出 / 域名指向私网这一档没有按钮（见 SkillEgressBlockedError 的说明），
      // 所以这里只给真正可用的那条出口（环境变量），不指向一个还不存在的设置页
      '要放行它，设环境变量 '
  return new SkillEgressBlockedError(
    { host: allowEntryFor(target), url: target.href, reason, local },
    `${head}${hint}${FETCH_ALLOW_HOSTS_ENV}=${target.hostname}（起点 ${start.href}）。`
  )
}

/** 现读的白名单：设置 + 环境变量逃生门（与 fetch 的 allowHostsFor 同一份取法） */
function allowHostsFor(deps: SkillImportDeps): readonly string[] {
  const fromSettings = deps.allowHosts?.() ?? []
  const fromEnv = (process.env[FETCH_ALLOW_HOSTS_ENV] ?? '')
    .split(/[,\s]+/)
    .filter((entry) => entry !== '')
  return [...fromSettings, ...fromEnv]
}

/** 系统解析器（与 fetch 的 defaultLookup 同形：一次拿全 A/AAAA） */
async function defaultLookup(host: string): Promise<readonly string[]> {
  const entries = await dnsLookup(host, { all: true })
  return entries.map((entry) => entry.address)
}

/** 字节 → 包（zip 魔数走解包，否则当一份 SKILL.md 文本） */
function payloadFromBytes(bytes: Buffer, fallbackNames: string[]): SkillPayload {
  if (isZipHead(bytes.subarray(0, 4))) {
    const { files, wrapper } = stripWrapper(readSkillZip(bytes, ZIP_LIMITS))
    return payloadFromFiles(
      files,
      wrapper === null ? fallbackNames : [wrapper, ...fallbackNames],
      'zip'
    )
  }
  const names = fallbackNames.filter((name) => name !== '')
  return { files: [{ path: SKILL_FILE, data: bytes }], fallbackNames: names }
}

/** 文件表 → 包：根目录必须有 SKILL.md（zip 可剥一层顶层包装，见 stripWrapper） */
function payloadFromFiles(
  files: SkillZipFile[],
  fallbackNames: string[],
  label: 'zip' | '目录'
): SkillPayload {
  if (!files.some((file) => file.path === SKILL_FILE)) {
    throw new Error(
      label === 'zip'
        ? `这个 zip 里没有根目录的 ${SKILL_FILE}：技能包 = 根目录含 SKILL.md，或整包套一层目录`
        : `这个目录的根目录里没有 ${SKILL_FILE}：技能 = 一个目录 + 里面的 ${SKILL_FILE}，请选到技能目录本身`
    )
  }
  return { files, fallbackNames: fallbackNames.filter((name) => name !== '') }
}

/**
 * 单一顶层包装目录可剥离（zip 的常见形状：`demo/SKILL.md` + `demo/reference/…`）。
 * 只在一件事上生效：所有文件的顶层段**完全相同**，且没有任何文件就叫这个名字（否则那不是包装目录）。
 * 顶层两样以上（`a/SKILL.md` + `b/SKILL.md`）= 不止一个技能 → 不剥，交给调用方拒。
 */
function stripWrapper(files: SkillZipFile[]): { files: SkillZipFile[]; wrapper: string | null } {
  const tops = new Set<string>()
  for (const file of files) {
    const slash = file.path.indexOf('/')
    tops.add(slash === -1 ? file.path : file.path.slice(0, slash))
  }
  if (tops.size !== 1) return { files, wrapper: null }
  const wrapper = [...tops][0] as string
  if (files.some((file) => file.path === wrapper)) return { files, wrapper: null }
  return {
    files: files.map((file) => ({ path: file.path.slice(wrapper.length + 1), data: file.data })),
    wrapper
  }
}

/** 本机目录 → 文件表（整份复制；符号链接与非常规文件一律拒，体量按解包同一套闸） */
function collectDirectory(root: string): SkillZipFile[] {
  const files: SkillZipFile[] = []
  let total = 0

  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      throw new Error(`读不了目录 ${dir}：${detailOf(error)}`)
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      // 符号链接（含 Windows 的 junction）不跟、也不复制：技能目录里出现链接只可能是想把外面拉进来
      if (entry.isSymbolicLink()) {
        throw new Error(`目录里含符号链接（${relative}）：技能包不接收链接，请先换成真文件`)
      }
      if (entry.isDirectory()) {
        walk(full, relative)
        continue
      }
      if (!entry.isFile()) throw new Error(`目录里有非常规文件（${relative}）：拒绝读入`)
      const size = statSync(full).size
      if (size > SKILL_ARCHIVE_MAX_ENTRY_BYTES) {
        throw new Error(
          `技能文件 ${relative} 有 ${size} 字节，超过单文件上限（${SKILL_ARCHIVE_MAX_ENTRY_BYTES} 字节）`
        )
      }
      total += size
      if (total > SKILL_ARCHIVE_MAX_TOTAL_BYTES) {
        throw new Error(
          `技能包合计超过总量上限（${Math.round(SKILL_ARCHIVE_MAX_TOTAL_BYTES / 1024 / 1024)}MB）：${root}`
        )
      }
      if (files.length >= SKILL_ARCHIVE_MAX_FILES) {
        throw new Error(`技能包里的文件数超过上限（${SKILL_ARCHIVE_MAX_FILES} 个）：只接收一个技能`)
      }
      files.push({ path: relative, data: readFileSync(full) })
    }
  }

  walk(root, '')
  return files
}

/**
 * 文件表 → 落盘（原子发布：写在**技能扫描根之外**的自建暂存根里，改名进目标）。
 *
 * 暂存根本身在 `skillStagingRoot`（`<skillsDir>.staging`，与技能目录同级）：它不进 `skillDirNames`
 * 的扫描（那是 skillsDir 的一级子目录），所以"改名失败/清理失败留下的半截"天然**不可发现**、
 * 也**不占正式技能名** —— 这正是上一版把暂存放进 skillsDir 里的教训（一个删不掉的 `.skill-import-*`
 * 会顶着 frontmatter 里的名字把该技能名永久占住）。
 *
 * 失败路径两条硬口径：
 *   ① **只清自己那一次建的暂存目录**（严格格式命名，见 sweepStaging），绝不动别的目录；
 *   ② **清理失败不覆盖原始错误** —— 原始错误原样抛给调用方，清理失败只记一条日志
 *      （否则用户看到的会是"删不掉"而不是"为什么导入失败"）。
 */
function publishSkill(deps: SkillImportDeps, payload: SkillPayload): ImportedSkill {
  const entry = payload.files.find((file) => file.path === SKILL_FILE)
  if (entry === undefined) {
    throw new Error(`技能包里没有 ${SKILL_FILE}`)
  }
  if (entry.data.length > SKILL_MD_MAX_BYTES) {
    throw new Error(
      `${SKILL_FILE} 有 ${entry.data.length} 字节，超过上限（${SKILL_MD_MAX_BYTES} 字节）：请精简后重试`
    )
  }

  const docs = parseSkillFrontmatter(entry.data.toString('utf8'))
  if (!docs.frontmatter) {
    throw new Error(
      `${SKILL_FILE} 没有 frontmatter：技能必须以 --- 包围的元数据开头（至少写 name 与 description）`
    )
  }

  const declared = (docs.data.name ?? '').trim()
  const name = resolveSkillName(declared, payload.fallbackNames)
  assertNameFree(deps, name)

  const target = join(deps.skillsDir, name)
  if (existsSync(target)) throw nameTakenError(name, '「我的技能」里已有的', deps.skillsDir)

  ensureDir(deps.skillsDir)
  const stagingRoot = skillStagingRoot(deps.skillsDir)
  const remove = deps.fs?.remove ?? removeDirRobust
  try {
    ensureDir(stagingRoot)
  } catch (error) {
    throw new Error(
      `导入暂存目录建不起来：${stagingRoot}（${detailOf(error)}）—— 那个位置被同名文件占着？`
    )
  }
  sweepStaging(stagingRoot, remove)
  const staging = join(stagingRoot, `${SKILL_IMPORT_STAGING_PREFIX}${process.pid}-${Date.now()}`)
  const rename = deps.fs?.rename ?? renameSync
  try {
    mkdirSync(staging, { recursive: true })
    for (const file of payload.files) {
      // SKILL.md 最后写：它是"这个技能存在"的唯一标志，先写它会留下半个可见的技能
      if (file.path === SKILL_FILE) continue
      const abs = join(staging, file.path)
      if (!abs.startsWith(staging)) throw new Error(`条目 ${file.path} 越出了技能目录：拒绝写盘`)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, file.data)
    }
    writeFileSync(join(staging, SKILL_FILE), entry.data)
    rename(staging, target)
    // 成功之后顺手收掉空的暂存根（下一次导入会再建）；非空/被占用就留着 —— rmdir 只在空目录上成功
    try {
      rmdirSync(stagingRoot)
    } catch {
      /* 还有残留或有人正在用：留着 */
    }
  } catch (error) {
    try {
      remove(staging)
    } catch (cleanup) {
      console.warn(
        `[kyclaw] 技能导入：暂存目录没能清掉（留在 ${stagingRoot}，它不在技能扫描里，不影响已装技能）`,
        cleanup
      )
    }
    throw error
  }
  return { name, dir: name }
}

/**
 * 暂存根：`<skillsDir>.staging`（与技能目录**同级**、由我们自建）。
 * 为什么是同级而不是 skillsDir 里面：`skillDirNames` 扫的是 skillsDir 的一级子目录 ——
 * 放进里面就得靠命名约定去"排除自己"，还要在冲突名单里特判；放在外面则**结构上**不可能被扫到。
 * 同级保证 `rename` 仍在同一个卷上（改名是原子的）。
 */
export function skillStagingRoot(skillsDir: string): string {
  return join(dirname(skillsDir), `${basename(skillsDir)}.staging`)
}

/**
 * 清掉**上次崩溃留下的**暂存目录（写暂存与改名之间进程被杀才会留下）。
 *
 * 归属证明有两层，缺一不可（不做"按宽泛前缀乱删"）：
 *   ① 根目录是我们自建的（`skillStagingRoot` 这个固定名字，只有导入流程会写它）；
 *   ② 条目名必须是**严格专用格式** `skill-import-<pid>-<毫秒时间戳>`（`STAGING_NAME_PATTERN`）。
 * 只删同时满足两条的条目；清不掉（杀软/索引器占用）就留着 —— 它在扫描根之外，用户看不见、
 * agent 扫不到、也不占名字，下一次导入再试。
 */
function sweepStaging(stagingRoot: string, remove: (dir: string) => void): void {
  let entries: string[]
  try {
    entries = readdirSync(stagingRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!STAGING_NAME_PATTERN.test(entry)) continue
    try {
      remove(join(stagingRoot, entry))
    } catch (error) {
      console.warn(`[kyclaw] 技能导入：旧暂存目录没能清掉（留到下次再试）：${entry}`, error)
    }
  }
}

/** 暂存条目名的严格格式（`skill-import-<pid>-<ts>`；见 sweepStaging 的归属证明） */
const STAGING_NAME_PATTERN = /^skill-import-\d+-\d+$/

/** 名字：frontmatter 的 name 优先（写了就必须合规），其次来源回落名；都不合规 → 拒并给 slug 建议 */
function resolveSkillName(declared: string, fallbackNames: readonly string[]): string {
  // frontmatter 写了 name：它就是要落盘的名字，合规才收 —— **不退回来源名**（偷偷换个名字等于
  // 给用户一份"引用名与作者声明对不上"的技能），把不合规的地方直说、给 slug 建议让人自己改。
  if (declared !== '') return assertNameUsable(declared)

  const candidates = fallbackNames.map((value) => value.trim()).filter((value) => value !== '')
  for (const candidate of candidates) {
    try {
      return assertNameUsable(candidate)
    } catch {
      /* 来源名不合规（`my skill/` 这种目录名）：试下一个候选 */
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `${SKILL_FILE} 的 frontmatter 里没有 name，也推不出来源名：请写上 name（1-64 位小写字母、数字或短横线）后重试`
    )
  }
  throw new Error(
    `${SKILL_FILE} 的 frontmatter 里没有 name，来源名（${candidates.join('、')}）也不合规：` +
      `请在 frontmatter 里补一个 name（1-64 位小写字母、数字或短横线）后重试。`
  )
}

/** 名字必须过白名单且不是 Windows 保留名；不合规按同一句人话拒（带 slug 建议） */
function assertNameUsable(candidate: string): string {
  const problem = skillNameProblem(candidate)
  if (problem !== null) {
    const suggestion = slugify(candidate)
    throw new Error(
      `技能名「${candidate}」不合规：${problem}。` +
        `可以把 ${SKILL_FILE} 的 name 改成 ${suggestion === '' ? '一个英文短名（如 my-skill）' : suggestion} 后重试。`
    )
  }
  if (isWindowsReservedName(candidate)) {
    throw new Error(
      `技能名「${candidate}」是 Windows 保留设备名（落盘会打不开或被改写）：请换一个名字` +
        `（比如 my-${candidate}）后重试。`
    )
  }
  return candidate
}

/** 名字是否已被占用（内置 / 我的 / 插件带来的，**大小写不敏感**）：占用就拒，不静默覆盖 */
function assertNameFree(deps: SkillImportDeps, name: string): void {
  const taken = takenSkillNames(deps)
  const where = taken.get(name.toLowerCase())
  if (where !== undefined) throw nameTakenError(name, where, deps.skillsDir)
}

function nameTakenError(name: string, where: string, skillsDir: string): Error {
  const hint =
    where === '内置技能'
      ? '内置技能随应用分发，改不了：请换一个名字（改 SKILL.md 里的 name）再试'
      : where.startsWith('插件')
        ? '它由插件管着（卸载那个插件会一起清掉）：请换一个名字再试'
        : `导入不覆盖：请先删掉它（在对话里让 kyclaw 删掉，或删掉目录 ${join(skillsDir, name)}）再试`
  return new Error(`已经有一个同名技能「${name}」了（${where}）：${hint}。`)
}

/**
 * 已被占用的名字（小写 → 展示用的出处），三处都算：
 *   - `skillsDir` 下的**所有**一级目录名（没有 SKILL.md 的也算：改名会撞同一个目录）；
 *   - 插件技能目录名去掉 `<插件 id>-` 前缀的那段（`+ → 引用技能` 引用的就是它）；
 *   - 每份技能 SKILL.md 里声明的 name（`findSkill` 按它匹配，重了会读到另一份）。
 */
function takenSkillNames(deps: SkillImportDeps): Map<string, string> {
  const taken = new Map<string, string>()
  const add = (name: string, where: string): void => {
    const key = name.trim().toLowerCase()
    if (key !== '' && !taken.has(key)) taken.set(key, where)
  }

  for (const dir of listDirs(deps.builtinDir ?? null)) add(dir, '内置技能')
  const sources = skillSourcesFor({
    skillsDir: deps.skillsDir,
    installed: deps.installed ?? [],
    builtinDir: deps.builtinDir ?? null
  })
  for (const source of sources) add(source.dir, whereOf(source))
  for (const source of sources) {
    const header = readSkillHeader(source)
    if (header !== null) add(header.name, whereOf(source))
  }
  for (const dir of listDirs(deps.skillsDir)) add(dir, '「我的技能」里已有的')
  return taken
}

function whereOf(source: SkillSource): string {
  if (source.kind === 'builtin') return '内置技能'
  if (source.pluginId === null) return '「我的技能」里已有的'
  return `插件「${source.pluginName ?? source.pluginId}」带来的`
}

/** 目录下的一级子目录名（读不了 = 空表） */
function listDirs(root: string | null): string[] {
  if (root === null || root === '') return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 指名的前 `count` 个字节（判 zip 魔数用；读不了 = 空） */
function readHead(path: string, count: number): Buffer {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return Buffer.alloc(0)
  }
  try {
    const buffer = Buffer.allocUnsafe(count)
    const read = readSync(fd, buffer, 0, count, 0)
    return buffer.subarray(0, read)
  } catch {
    return Buffer.alloc(0)
  } finally {
    closeSync(fd)
  }
}

/** zip 的四种魔数（PK\x03\x04 / PK\x05\x06 空包 / PK\x07\x08 分卷） */
function isZipHead(head: Buffer): boolean {
  if (head.length < 4) return false
  if (head[0] !== 0x50 || head[1] !== 0x4b) return false
  const third = head[2]
  const fourth = head[3]
  return (
    (third === 0x03 && fourth === 0x04) ||
    (third === 0x05 && fourth === 0x06) ||
    (third === 0x07 && fourth === 0x08)
  )
}

/** 文件名/路径最后一段（zip 与 md 的来源名回落） */
function baseName(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const last = slashed.slice(slashed.lastIndexOf('/') + 1)
  return last
}

/**
 * 来源名回落：去扩展名的最后一段（`invoice-helper.zip` → `invoice-helper`）。
 * `SKILL.md` / `skill` 这类通用名没有信息量（它不是技能名，只是文件名），回落时跳过。
 */
function stemOf(path: string): string {
  const base = baseName(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.trim().toLowerCase() === 'skill' ? '' : stem
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code
    if (typeof code === 'string' && code !== '') return code
    return error.message
  }
  return String(error)
}
