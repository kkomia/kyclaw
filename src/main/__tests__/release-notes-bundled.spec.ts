// @vitest-environment node
/**
 * 「本版本发行说明」的读盘：设置页「关于」那块常驻的「更新日志」读它（断网 / 已是最新也能看）。
 *
 * 用临时目录造真文件（不 mock fs）：这条路最大的风险不是逻辑，而是**路径拼错**或"顺手回退到
 * 别的版本的文件"——所以钉四件：①只按版本号找那一个文件名，**别的版本的文件不算数**；
 * ②缺失（missing）与读不出来（unreadable）分开；③大小有上限（超限整份不显示，不截半截冒充全文）；
 * ④打包态 / 开发态两处落点。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RELEASE_NOTES_MAX_BYTES,
  bundledReleaseNotesPath,
  readBundledReleaseNotes
} from '../release-notes'

describe('bundledReleaseNotesPath：打包态 / 开发态两处落点', () => {
  it('打包态：安装目录的 resources/release-notes/<版本>.md', () => {
    expect(
      bundledReleaseNotesPath({
        isPackaged: true,
        resourcesPath: join('D:', 'app', 'resources'),
        appPath: join('D:', 'app', 'resources', 'app.asar'),
        version: '0.1.1'
      })
    ).toBe(join('D:', 'app', 'resources', 'release-notes', '0.1.1.md'))
  })

  it('开发态：仓库的 build/release-notes/<版本>.md（改完日志不用重新打包）', () => {
    expect(
      bundledReleaseNotesPath({
        isPackaged: false,
        resourcesPath: join('D:', 'app', 'resources'),
        appPath: join('E:', 'repo'),
        version: '0.1.1'
      })
    ).toBe(join('E:', 'repo', 'build', 'release-notes', '0.1.1.md'))
  })
})

describe('readBundledReleaseNotes：只读 app.getVersion() 那一份', () => {
  let dir: string | undefined

  /** 造一个假的"安装目录 resources/"（reader 的打包态落点） */
  function resourcesDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-notes-'))
    return dir
  }

  function writeNotes(root: string, fileName: string, text: string): void {
    mkdirSync(join(root, 'release-notes'), { recursive: true })
    writeFileSync(join(root, 'release-notes', fileName), text, 'utf8')
  }

  function read(root: string, version = '0.1.1'): ReturnType<typeof readBundledReleaseNotes> {
    return readBundledReleaseNotes({
      isPackaged: true,
      resourcesPath: root,
      appPath: root,
      version
    })
  }

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('命中本版本那一份：原文照回（版本号取文件名，正文一字不改）', () => {
    const root = resourcesDir()
    const text = 'kyclaw 0.1.1\n\n本次更新内容：\n- 一条\n- 两条'
    writeNotes(root, '0.1.1.md', text)

    expect(read(root)).toEqual({ state: 'ok', version: '0.1.1', notes: text })
  })

  it('文件不在 = missing（开发态没写日志、老包里没有，都是正常情况）', () => {
    expect(read(resourcesDir())).toEqual({ state: 'missing' })
  })

  it('只有别的版本的文件 = missing：不许把别的版本的日志挂到这一版上', () => {
    const root = resourcesDir()
    writeNotes(root, '0.1.2.md', 'kyclaw 0.1.2\n\n下个版本的说明')

    expect(read(root, '0.1.1')).toEqual({ state: 'missing' })
  })

  it('空文件 / 只有空白 = missing（没有可看的内容就不装作有）', () => {
    const root = resourcesDir()
    writeNotes(root, '0.1.1.md', '   \n\n')
    expect(read(root)).toEqual({ state: 'missing' })

    writeNotes(root, '0.1.1.md', '')
    expect(read(root)).toEqual({ state: 'missing' })
  })

  it('这个位置是个目录 = missing（不是文件就不是这一份）', () => {
    const root = resourcesDir()
    mkdirSync(join(root, 'release-notes', '0.1.1.md'), { recursive: true })

    expect(read(root)).toEqual({ state: 'missing' })
  })

  it('超过上限 = unreadable（整份不显示，不截半截冒充全文）', () => {
    const root = resourcesDir()
    writeNotes(root, '0.1.1.md', 'x'.repeat(RELEASE_NOTES_MAX_BYTES + 1))

    expect(read(root)).toMatchObject({ state: 'unreadable' })
    expect(read(root)).toHaveProperty('message', expect.stringContaining('64 KiB') as unknown)
  })

  it('BOM 与首尾空白归一（不把 BOM 带进界面）', () => {
    const root = resourcesDir()
    writeNotes(root, '0.1.1.md', '\uFEFFkyclaw 0.1.1\n\n内容\n\n')

    expect(read(root)).toEqual({ state: 'ok', version: '0.1.1', notes: 'kyclaw 0.1.1\n\n内容' })
  })
})
