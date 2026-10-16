import { describe, expect, it } from 'vitest'
import { codeLanguageOf, extensionOf, previewModeOf } from '../modes'

/**
 * 预览路由：后缀 → 走哪条通道 / 哪个渲染器。
 * 认不出的后缀一律回落现有文本通道（行为与 round40 之前一致，不悄悄改变既有预览）。
 * 代码高亮的语言映射只覆盖**高亮器真打包了的**语言（清单在 features/chat/parts/CodeBlock.tsx）。
 */
describe('previewModeOf：后缀决定渲染方式', () => {
  it('markdown 两种后缀都走 markdown', () => {
    expect(previewModeOf('README.md')).toBe('markdown')
    expect(previewModeOf('docs/说明.MARKDOWN')).toBe('markdown')
  })

  it('认得图片八种后缀（大小写不敏感；svg / ico 是本轮新收的两种）', () => {
    expect(previewModeOf('a.png')).toBe('image')
    expect(previewModeOf('a.JPG')).toBe('image')
    expect(previewModeOf('a.jpeg')).toBe('image')
    expect(previewModeOf('a.GIF')).toBe('image')
    expect(previewModeOf('a.webp')).toBe('image')
    expect(previewModeOf('a.BMP')).toBe('image')
    expect(previewModeOf('icon.SVG')).toBe('image')
    expect(previewModeOf('favicon.ico')).toBe('image')
  })

  it('html / htm 走静态隔离预览（压过 code：这两个后缀本来按源码高亮看）', () => {
    expect(previewModeOf('index.html')).toBe('html')
    expect(previewModeOf('页面.HTM')).toBe('html')
    // 语言映射还在：谁要按代码看谁自己问（路由这一层按"有真渲染器就用真的"说话）
    expect(codeLanguageOf('index.html')).toBe('html')
    // xml 不在 html 那一档（它仍是代码高亮）
    expect(previewModeOf('数据.xml')).toBe('code')
  })

  it('pdf / 办公档 / 表格各走各的', () => {
    expect(previewModeOf('报告.PDF')).toBe('pdf')
    // 办公四件（含旧版 .doc / .ppt）：页式预览（主进程转 PDF，渲染端新阅读器按页看）
    expect(previewModeOf('方案.docx')).toBe('office')
    expect(previewModeOf('旧方案.doc')).toBe('office')
    expect(previewModeOf('汇报.pptx')).toBe('office')
    expect(previewModeOf('旧汇报.ppt')).toBe('office')
    // 表格四种（含旧版 .xls）：原始字节通道，交给渲染端 ExcelPreview
    expect(previewModeOf('台账.xlsx')).toBe('table')
    expect(previewModeOf('旧台账.xls')).toBe('table')
    expect(previewModeOf('名单.csv')).toBe('table')
    expect(previewModeOf('名单.TSV')).toBe('table')
  })

  it('办公档与表格不串线：xlsx 不当办公档（不进 PDF 管线），docx 不当表格', () => {
    expect(previewModeOf('台账.xlsx')).not.toBe('office')
    expect(previewModeOf('旧台账.xls')).not.toBe('office')
    expect(previewModeOf('方案.docx')).not.toBe('table')
    expect(previewModeOf('旧方案.doc')).not.toBe('table')
  })

  it('代码扩展名走高亮那条（语言由 codeLanguageOf 定）', () => {
    expect(previewModeOf('src/index.ts')).toBe('code')
    expect(previewModeOf('package.json')).toBe('code')
    expect(previewModeOf('脚本/构建.mjs')).toBe('code')
    expect(previewModeOf('styles/site.css')).toBe('code')
  })

  it('认不出的（含无后缀、隐藏文件、未打包语法的扩展名）回落文本', () => {
    expect(previewModeOf('Makefile')).toBe('text')
    expect(previewModeOf('.gitignore')).toBe('text')
    expect(previewModeOf('目录.d/')).toBe('text')
    // 这几个后缀是代码、但高亮器没打包对应语法 → 回落纯文本（行为与以前完全一致）
    expect(previewModeOf('run.log')).toBe('text')
    expect(previewModeOf('schema.sql')).toBe('text')
    expect(previewModeOf('config.toml')).toBe('text')
    expect(previewModeOf('desktop.ini')).toBe('text')
    expect(previewModeOf('start.ps1')).toBe('text')
    expect(previewModeOf('run.bat')).toBe('text')
  })

  it('反斜杠路径也认（Windows 上复制出来的写法）', () => {
    expect(previewModeOf('子目录\\图片.png')).toBe('image')
    expect(previewModeOf('子目录\\说明.md')).toBe('markdown')
    expect(previewModeOf('子目录\\index.tsx')).toBe('code')
  })

  it('extensionOf：只取最后一段后缀，没有后缀给空串', () => {
    expect(extensionOf('a/b/c.tar.gz')).toBe('gz')
    expect(extensionOf('没有后缀')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })
})

describe('codeLanguageOf：扩展名 → shiki 语言 id', () => {
  it('常见代码后缀各自对号（可高亮的那几种）', () => {
    const cases: Array<[string, string]> = [
      ['a.js', 'javascript'],
      ['a.mjs', 'javascript'],
      ['a.cjs', 'javascript'],
      ['a.jsx', 'javascript'],
      ['a.ts', 'typescript'],
      ['a.mts', 'typescript'],
      ['a.cts', 'typescript'],
      ['a.tsx', 'tsx'],
      ['a.json', 'json'],
      ['a.css', 'css'],
      ['a.html', 'html'],
      ['a.htm', 'html'],
      ['a.xml', 'html'],
      ['a.py', 'python'],
      ['a.sh', 'bash'],
      ['a.bash', 'bash'],
      ['a.zsh', 'zsh'],
      ['a.yaml', 'yaml'],
      ['a.yml', 'yaml'],
      ['A.TSX', 'tsx']
    ]
    for (const [name, language] of cases)
      expect([name, codeLanguageOf(name)]).toEqual([name, language])
  })

  it('没打包语法的后缀给 null（调用方回落纯文本）', () => {
    for (const name of [
      'run.log',
      'a.sql',
      'a.toml',
      'a.ini',
      'a.ps1',
      'a.bat',
      'Makefile',
      'a.md'
    ]) {
      expect([name, codeLanguageOf(name)]).toEqual([name, null])
    }
  })
})
