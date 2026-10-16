// @vitest-environment node
/**
 * 出包侧的发行日志链路（0.1.1）——两个脚本各自钉一件事：
 *   - `scripts/make-feed.mjs`：本地静态源能不能造出**带 releaseNotes** 的渠道 yml
 *     （e2e 探针与冒烟都靠它模拟"源上有更新日志"）；
 *   - `scripts/package.mjs`：发行日志与版本的绑定（文件就叫 `<版本>.md`）、内容自检
 *     （空文件 / 写着别的版本号一律拦下）、以及"渠道 yml 里真带上了这份日志"的落点自检。
 *
 * 两个都是零依赖的纯 JS CLI：make-feed 起**子进程**跑（它一被执行就读 argv），
 * package.mjs 用动态 import 取导出（它自己守卫了"直接执行才出包"，import 不会真打包；
 * TS 读不到 .mjs 的类型，所以这里显式声明用到的那几个函数）。
 *
 * 这里**不**断言"仓库当前 package.json 的版本必须有日志文件"：版本号是发布时升的
 * （0.1.1 的日志先备好、版本仍是 0.1.0），那种断言会把正常流程误判成红。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../')
const packageScriptPath = join(repoRoot, 'scripts', 'package.mjs')
const makeFeedPath = join(repoRoot, 'scripts', 'make-feed.mjs')

/** package.mjs 里用到的那几个纯函数（.mjs 没有类型，这里按实现声明） */
interface PackageScriptExports {
  releaseNotesRelativePath(version: string): string
  releaseNotesPath(version: string, root?: string): string
  releaseNotesProblem(version: string, text: string): string | null
  channelReleaseProblem(channelYml: string, notes: string): string | null
  bundledNotesProblem(unpackedResourcesDir: string, version: string, notes: string): string | null
}

const packageScript = (await import(
  /* @vite-ignore */ pathToFileURL(packageScriptPath).href
)) as unknown as PackageScriptExports

/** 起一次 make-feed（它一被执行就读 argv，只有子进程这条路） */
function runMakeFeed(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [makeFeedPath, ...args], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr ?? '' }
}

describe('scripts/make-feed.mjs：造带更新日志的本地源', () => {
  let dir: string | undefined

  function feedDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-feed-'))
    return dir
  }

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('--notes-file：日志逐行进 releaseNotes，sha512/size 仍是真算的（下载要过校验）', () => {
    const target = feedDir()
    const notes = 'kyclaw 9.9.9\n\n- 第一行：改了什么\n- 第二行：注意什么\n'
    const notesFile = join(target, 'notes.md')
    writeFileSync(notesFile, notes, 'utf8')

    const result = runMakeFeed([target, '9.9.9', '4096', '--notes-file', notesFile])
    expect(result.status, result.stderr).toBe(0)

    const yml = readFileSync(join(target, 'latest.yml'), 'utf8')
    expect(yml).toMatch(/^version: 9\.9\.9$/m)
    expect(yml).toMatch(/^releaseNotes: \|$/m)
    expect(yml).toMatch(/^releaseDate: '/m)

    // 假安装包与 yml 里的 sha512/size 对得上（electron-updater 下载时就校验它）
    const payload = readFileSync(join(target, 'kyclaw-9.9.9-setup.exe'))
    expect(payload).toHaveLength(4096)
    expect(yml).toContain(`size: ${payload.length}`)
    expect(yml).toContain(`sha512: ${createHash('sha512').update(payload).digest('base64')}`)

    // 与出包侧同一份口径：这份 yml 应当过得了 package.mjs 的渠道自检
    expect(packageScript.channelReleaseProblem(yml, notes)).toBeNull()
  })

  it('--channel beta + --name：文件落到 beta.yml，发行名也写进去（真 YAML 串，带冒号也不坏）', () => {
    const target = feedDir()
    const result = runMakeFeed([
      target,
      '9.9.9',
      '2048',
      '--channel',
      'beta',
      '--name',
      'kyclaw 9.9.9: 内测',
      '--notes',
      'kyclaw 9.9.9\\n- 一条'
    ])
    expect(result.status, result.stderr).toBe(0)

    const yml = readFileSync(join(target, 'beta.yml'), 'utf8')
    expect(existsSync(join(target, 'latest.yml'))).toBe(false)
    expect(yml).toContain('releaseName: "kyclaw 9.9.9: 内测"')
    // `\n` 在文本里转成真换行（块标量逐行比对得上）
    expect(packageScript.channelReleaseProblem(yml, 'kyclaw 9.9.9\n- 一条')).toBeNull()
  })

  it('不给日志：yml 里就没有 releaseNotes（界面那一块不显示）', () => {
    const target = feedDir()
    const result = runMakeFeed([target, '9.9.9'])
    expect(result.status, result.stderr).toBe(0)

    const yml = readFileSync(join(target, 'latest.yml'), 'utf8')
    expect(yml).not.toContain('releaseNotes')
    expect(yml).not.toContain('releaseName')
    expect(packageScript.channelReleaseProblem(yml, '随便一段')).toContain('没有 releaseNotes')
  })

  it('日志里有空行/多段：写出来的 yml 与原文逐行对得上（块标量不吞空行）', () => {
    const target = feedDir()
    const notes = 'kyclaw 9.9.9\n\n第一节：\n- A\n\n第二节：\n- B\n'
    const notesFile = join(target, 'notes.md')
    writeFileSync(notesFile, notes, 'utf8')

    expect(runMakeFeed([target, '9.9.9', '1024', '--notes-file', notesFile]).status).toBe(0)
    const yml = readFileSync(join(target, 'latest.yml'), 'utf8')
    expect(yml).toMatch(/^releaseNotes: \|$/m)
    expect(packageScript.channelReleaseProblem(yml, notes)).toBeNull()
  })
})

describe('scripts/package.mjs：版本与发行日志绑定 + 渠道落点自检', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('日志文件按版本取名（相对 build/ 与绝对路径同一口径，换版本号就换文件）', () => {
    expect(packageScript.releaseNotesRelativePath('0.1.1')).toBe('release-notes/0.1.1.md')
    expect(packageScript.releaseNotesRelativePath('0.2.0')).not.toBe(
      packageScript.releaseNotesRelativePath('0.1.1')
    )
    expect(packageScript.releaseNotesPath('0.1.1', 'D:/repo')).toBe(
      join('D:/repo', 'build', 'release-notes', '0.1.1.md')
    )
  })

  it('内容自检：空文件、写着别的版本号都拦下（"下一版复用上一版日志"就是这个形状）', () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-pkg-'))
    mkdirSync(join(dir, 'build', 'release-notes'), { recursive: true })
    const file = packageScript.releaseNotesPath('0.1.1', dir)
    writeFileSync(file, 'kyclaw 0.1.1\n\n- 这一版做了什么\n', 'utf8')

    expect(packageScript.releaseNotesProblem('0.1.1', readFileSync(file, 'utf8'))).toBeNull()
    expect(packageScript.releaseNotesProblem('0.1.1', '   \n ')).toContain('空的')
    expect(packageScript.releaseNotesProblem('0.1.1', 'kyclaw 0.1.0\n\n上一版的日志')).toContain(
      '没提到版本号'
    )
  })

  /** electron-builder 写渠道 yml 的形状（js-yaml：多行文本落成块标量 `|`，空行不缩进） */
  function channelYml(lines: string[], notesBlock: string[]): string {
    return [
      'version: 0.1.1',
      'path: kyclaw-0.1.1-setup.exe',
      ...lines,
      'releaseNotes: |',
      ...notesBlock,
      "releaseDate: '2026-10-15T00:00:00.000Z'",
      ''
    ].join('\n')
  }

  const NOTES = 'kyclaw 0.1.1\n\n- 一条\n- 另一条'
  /** 这份日志按块标量写进 yml 的样子 */
  const NOTES_BLOCK = ['  kyclaw 0.1.1', '', '  - 一条', '  - 另一条']

  it('渠道自检：releaseNotes 比的是**字段值**（顺序、多一行、少一行都拦下）', () => {
    const yml = channelYml([], NOTES_BLOCK)

    expect(packageScript.channelReleaseProblem(yml, NOTES)).toBeNull()
    // 同一批行但顺序不同：拦下（逐行搜"这些行在不在文件里"看不出顺序）
    expect(packageScript.channelReleaseProblem(yml, 'kyclaw 0.1.1\n\n- 另一条\n- 一条')).toContain(
      '不一致'
    )
    // 多一行 / 少一行：都拦下
    expect(packageScript.channelReleaseProblem(yml, `${NOTES}\n- 第三条`)).toContain('不一致')
    expect(packageScript.channelReleaseProblem(yml, 'kyclaw 0.1.1\n\n- 一条')).toContain('不一致')
    // 尾随换行与 CRLF 不算差异（块标量的 clip 与文件的末尾换行本来就差一个）
    expect(packageScript.channelReleaseProblem(yml, `${NOTES}\n`)).toBeNull()
    expect(packageScript.channelReleaseProblem(yml, NOTES.replace(/\n/g, '\r\n'))).toBeNull()
  })

  it('渠道自检：别的字段碰巧含同一段文字不算数（看的就是 releaseNotes 这一格）', () => {
    // 每行都能在文件里搜到（version/ path/ releaseName 里都有），但 releaseNotes 是别的内容
    const yml = channelYml(
      ['releaseName: "kyclaw 0.1.1 - 一条"'],
      ['  kyclaw 0.1.1', '', '  - 完全不同的内容']
    )

    const problem = packageScript.channelReleaseProblem(yml, 'kyclaw 0.1.1\n\n- 一条')
    expect(problem).toContain('不一致')
    // 报的是 releaseNotes 里**实际**那段（出包时一眼看得出写进去的是什么）
    expect(problem).toContain('完全不同的内容')
  })

  it('渠道自检：缺字段 / 写法认不出来，各给一句人话（不装作一致）', () => {
    expect(
      packageScript.channelReleaseProblem("version: 0.1.1\nreleaseDate: 'x'\n", NOTES)
    ).toContain('没有 releaseNotes')
    expect(
      packageScript.channelReleaseProblem(
        'version: 0.1.1\nreleaseNotes: |\n  kyclaw 0.1.1\n',
        NOTES
      )
    ).toContain('没有 releaseDate')
    // 折叠块（>）没实现解码：明确报"认不出来"，不放过
    expect(
      packageScript.channelReleaseProblem(
        "version: 0.1.1\nreleaseNotes: >\n  kyclaw 0.1.1\n  - 一条\nreleaseDate: 'x'\n",
        NOTES
      )
    ).toContain('认不出来')
  })

  it('渠道自检：块标量的 chomping 与单行标量都按 YAML 还原', () => {
    const date = "releaseDate: '2026-10-15T00:00:00.000Z'"

    // 裸值与引号串（单行日志的形状）
    expect(
      packageScript.channelReleaseProblem(
        `version: 0.1.1\nreleaseNotes: kyclaw 0.1.1 一条\n${date}\n`,
        'kyclaw 0.1.1 一条'
      )
    ).toBeNull()
    expect(
      packageScript.channelReleaseProblem(
        `version: 0.1.1\nreleaseNotes: "kyclaw 0.1.1: 一条"\n${date}\n`,
        'kyclaw 0.1.1: 一条'
      )
    ).toBeNull()

    // `|-`：内容末尾没有换行（文件末尾没换行时 js-yaml 就是这个形状）
    const strip = `version: 0.1.1\nreleaseNotes: |-\n  kyclaw 0.1.1\n  - 一条\n${date}\n`
    expect(packageScript.channelReleaseProblem(strip, 'kyclaw 0.1.1\n- 一条')).toBeNull()
    expect(packageScript.channelReleaseProblem(strip, 'kyclaw 0.1.1\n- 一条\n- 另一条')).toContain(
      '不一致'
    )

    // `|+`：尾随空行留着（内容照样对得上）
    const keep = `version: 0.1.1\nreleaseNotes: |+\n  kyclaw 0.1.1\n  - 一条\n\n${date}\n`
    expect(packageScript.channelReleaseProblem(keep, 'kyclaw 0.1.1\n- 一条\n')).toBeNull()
  })

  it('本轮·随包自检：解包目录里的 release-notes/<版本>.md 与 build 那份逐字一致才过', () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-unpacked-'))
    const resources = join(dir, 'resources')
    const notes = 'kyclaw 0.1.1\n\n- 一条\n- 另一条'
    mkdirSync(join(resources, 'release-notes'), { recursive: true })
    writeFileSync(join(resources, 'release-notes', '0.1.1.md'), notes, 'utf8')

    expect(packageScript.bundledNotesProblem(resources, '0.1.1', notes)).toBeNull()
    // 尾随换行 / CRLF 不算差异（与渠道自检同一口径：块标量与文件末尾本来就差一个换行）
    expect(packageScript.bundledNotesProblem(resources, '0.1.1', `${notes}\n`)).toBeNull()
    expect(
      packageScript.bundledNotesProblem(resources, '0.1.1', notes.replace(/\n/g, '\r\n'))
    ).toBeNull()
  })

  it('本轮·随包自检：没拷进去 / 内容不一致 / 只有别的版本 —— 三种都拦下并指路', () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-unpacked-'))
    const resources = join(dir, 'resources')
    const notes = 'kyclaw 0.1.1\n\n- 一条'

    // 整个目录都没有（extraResources 漏了/写错落点）——报的是"该在哪"，不是"读了没"
    const missing = packageScript.bundledNotesProblem(resources, '0.1.1', notes)
    expect(missing).toContain('release-notes')
    expect(missing).toContain('0.1.1.md')

    // 只有别的版本：不算数（客户端的「更新日志」只认 app.getVersion() 那一个文件名）
    mkdirSync(join(resources, 'release-notes'), { recursive: true })
    writeFileSync(join(resources, 'release-notes', '0.1.2.md'), notes, 'utf8')
    expect(packageScript.bundledNotesProblem(resources, '0.1.1', notes)).toContain('0.1.1.md')

    // 拷了但内容不一样（拷的还是旧文件）
    writeFileSync(join(resources, 'release-notes', '0.1.1.md'), 'kyclaw 0.1.1\n\n- 别的', 'utf8')
    expect(packageScript.bundledNotesProblem(resources, '0.1.1', notes)).toContain('不一致')
  })

  it('仓库里已备的发行日志：文件名就是版本号，内容里也写着那个版本号', () => {
    const dirWithNotes = join(repoRoot, 'build', 'release-notes')
    const files = existsSync(dirWithNotes)
      ? readdirSync(dirWithNotes).filter((name) => name.endsWith('.md'))
      : []
    expect(files.length).toBeGreaterThan(0)

    for (const name of files) {
      const version = name.replace(/\.md$/, '')
      expect(version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
      expect(
        packageScript.releaseNotesProblem(version, readFileSync(join(dirWithNotes, name), 'utf8')),
        name
      ).toBeNull()
    }
  })
})
