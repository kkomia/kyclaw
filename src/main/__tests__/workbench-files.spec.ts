import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertOpenable,
  DIR_ENTRY_LIMIT,
  listDir,
  PREVIEW_BYTES,
  PREVIEW_MAX_BYTES,
  readFilePreview,
  revealTarget,
  trimIncompleteTail
} from '../workbench-files'

/**
 * 文件树读侧：列一层目录（目录在前、排序稳定、只收真文件/真目录）、有界读预览、
 * containment（相对路径逃逸一律拒）。全部在 mkdtemp 的真目录上跑，不碰用户目录。
 */
let root: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-files-'))
  outside = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-outside-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'README.md'), '# 标题\n')
  writeFileSync(join(root, 'src', 'index.ts'), 'export {}\n')
  writeFileSync(join(outside, 'secret.txt'), '不该看到\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('listDir：列一层目录', () => {
  it('目录在前、按名字排序、文件带字节数（不递归）', () => {
    const result = listDir(root, '')

    expect(result.truncated).toBe(false)
    expect(result.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'dir:node_modules',
      'dir:src',
      'file:README.md'
    ])
    expect(result.entries[2]?.size).toBe(Buffer.byteLength('# 标题\n'))
    // 不递归：src 里的东西不在这一层
    expect(result.entries.some((entry) => entry.name === 'index.ts')).toBe(false)
  })

  it('子目录相对路径（正斜杠）与不跳 node_modules 的懒加载口径一致', () => {
    const result = listDir(root, 'src')
    expect(result.entries).toEqual([{ name: 'index.ts', kind: 'file', size: 10 }])
  })

  it('条目数到上限如实截断', () => {
    const many = join(root, 'many')
    mkdirSync(many)
    for (let index = 0; index < DIR_ENTRY_LIMIT + 5; index += 1) {
      writeFileSync(join(many, `f${String(index).padStart(4, '0')}.txt`), 'x')
    }

    const result = listDir(root, 'many')
    expect(result.entries).toHaveLength(DIR_ENTRY_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('符号链接不进列表（避免穿出根 / 成环）', () => {
    try {
      symlinkSync(outside, join(root, '带毒链接'), 'junction')
    } catch {
      return // 造不出链接的环境跳过
    }
    const names = listDir(root, '').entries.map((entry) => entry.name)
    expect(names).not.toContain('带毒链接')
  })

  it('文件当目录列 / 目录不存在：都是人话错误', () => {
    expect(() => listDir(root, 'README.md')).toThrow(/不是文件夹/)
    expect(() => listDir(root, '没有这个目录')).toThrow(/不在磁盘上/)
  })
})

describe('containment：渲染端只能给相对路径', () => {
  it('`..` 逃逸、根外绝对路径、UNC 一律拒', () => {
    expect(() => listDir(root, '../' + 'x')).toThrow(/在工作区之外|路径不可用/)
    expect(() => listDir(root, 'src/../../x')).toThrow(/在工作区之外|路径不可用/)
    expect(() => listDir(root, outside)).toThrow(/在工作区之外/)
    expect(() => listDir(root, '\\\\server\\share')).toThrow(/UNC|路径不可用/)
    expect(() => readFilePreview(root, '../secret.txt')).toThrow(/在工作区之外|路径不可用/)
  })

  it('穿过符号链接的路径也拒（链接不进列表，路径解析同样不认）', () => {
    try {
      symlinkSync(outside, join(root, '带毒链接'), 'junction')
    } catch {
      return
    }
    expect(() => readFilePreview(root, '带毒链接/secret.txt')).toThrow(/在工作区之外/)
  })
})

describe('readFilePreview：有界读', () => {
  it('文本档：原样回内容 + 字节数', () => {
    const preview = readFilePreview(root, 'README.md')
    expect(preview).toEqual({
      kind: 'text',
      text: '# 标题\n',
      size: Buffer.byteLength('# 标题\n'),
      truncated: false
    })
  })

  it('大文件：只读前 64KB 并标 truncated，截断点收在字符边界上', () => {
    // 每行 3 字节的汉字 + 换行 = 4 字节；读到 64KB 附近正好切在字符中间的可能性很大
    const line = '中'.repeat(1023) + '\n'
    writeFileSync(join(root, 'big.txt'), line.repeat(40))

    const preview = readFilePreview(root, 'big.txt')
    expect(preview.kind).toBe('text')
    if (preview.kind !== 'text') return
    expect(preview.truncated).toBe(true)
    const bytes = Buffer.byteLength(preview.text, 'utf8')
    // 读到上限附近，且**收在字符边界上**：不完整的那 1–3 个字节被丢掉（否则会出现 U+FFFD）
    expect(bytes).toBeLessThanOrEqual(PREVIEW_BYTES)
    expect(bytes).toBeGreaterThan(PREVIEW_BYTES - 4)
    expect(preview.text).not.toContain('\uFFFD')
  })

  it('二进制档：读到 NUL 就不吐乱码', () => {
    writeFileSync(join(root, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]))
    expect(readFilePreview(root, 'logo.bin')).toEqual({ kind: 'binary', size: 5 })
  })

  it('超大文件：连头部都不传', () => {
    writeFileSync(join(root, 'huge.bin'), Buffer.alloc(PREVIEW_MAX_BYTES + 1, 0x61))
    expect(readFilePreview(root, 'huge.bin')).toEqual({
      kind: 'too-large',
      size: PREVIEW_MAX_BYTES + 1
    })
  })

  it('读目录 / 不存在的文件：人话错误', () => {
    expect(() => readFilePreview(root, 'src')).toThrow(/文件夹/)
    expect(() => readFilePreview(root, 'src/没有.ts')).toThrow(/不在磁盘上/)
  })
})

describe('trimIncompleteTail：UTF-8 边界', () => {
  it('切在多字节字符中间时把不完整的那段丢掉', () => {
    const full = Buffer.from('中', 'utf8')
    expect(trimIncompleteTail(full.subarray(0, 2)).toString('utf8')).toBe('')
    expect(trimIncompleteTail(full).toString('utf8')).toBe('中')
    // ASCII 尾巴原样留下
    expect(trimIncompleteTail(Buffer.from('ab')).toString('utf8')).toBe('ab')
  })
})

describe('revealTarget', () => {
  /**
   * 交给系统的那条路径经 `resolveInsideWorkspace`（`realpathSync.native`）归一 —— Windows 上会把
   * tmpdir 的 8.3 短名（本机 `C:\LMSTUD~1`）展开成长名，断言按归一后的写。
   */
  const canonical = (path: string): string => realpathSync.native(path)

  it('回绝对路径（目录与文件都行）；不存在给人话', () => {
    expect(revealTarget(root, '')).toBe(canonical(root))
    expect(revealTarget(root, 'src/index.ts')).toBe(canonical(join(root, 'src', 'index.ts')))
    expect(() => revealTarget(root, 'src/没有.ts')).toThrow(/不在磁盘上/)
  })
})

/**
 * round 77：`workbench:open` 的扩展名闸门。这张表就是"什么能交给 ShellExecute"的唯一定义 ——
 * 工作区里的文件模型也能写，`.exe` / `.bat` / `.js` / `.lnk` 交过去是**执行**，绝不能放行。
 */
describe('assertOpenable：只放行文档与媒体', () => {
  it('文档与媒体放行（含旧版 Office 与纯文本）：不抛', () => {
    for (const name of [
      '方案.docx',
      '旧方案.doc',
      '台账.xlsx',
      '旧台账.xls',
      '汇报.pptx',
      '旧汇报.ppt',
      '报告.pdf',
      '图片.PNG',
      '名单.csv',
      '说明.md',
      '笔记.txt',
      'src/子目录/数据.json'
    ]) {
      expect(() => assertOpenable(name), name).not.toThrow()
    }
  })

  it('可执行 / 脚本 / 快捷方式 / 没有扩展名：一律拒，并指路「在文件资源管理器中定位」', () => {
    for (const name of [
      '安装包.exe',
      '更新.bat',
      'run.cmd',
      'x.ps1',
      'x.js',
      'x.vbs',
      'x.msi',
      'x.lnk',
      'noext'
    ]) {
      expect(() => assertOpenable(name), name).toThrow(/不用系统应用打开这类文件/)
    }
    expect(() => assertOpenable('noext')).toThrow(/没有扩展名/)
    expect(() => assertOpenable('安装包.exe')).toThrow(/在文件资源管理器中定位/)
  })
})
