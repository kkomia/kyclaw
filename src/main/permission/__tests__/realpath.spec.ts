import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveInsideWorkspace } from '../realpath'

/**
 * 路径逃逸清单（Review Focus #1 / plan T10 Step 1）：每一条都给出明确的 allow / deny。
 *
 * 目录形状（都在系统临时目录下，互不包含）：
 *   tmp/
 *     workspace/            工作区根（realpath 之后拿它做基准）
 *       a.txt  sub/b.txt    正常文件
 *       junction -> tmp/outside    （junction，不需要管理员）
 *       symlink  -> tmp/outside    （真 symlink，需要开发者模式；造不出来就 skip 并在用例名里说清）
 *     outside/secret.txt    工作区外
 *     workspace-evil/       名字前缀与工作区相同，但不是工作区（前缀边界）
 *
 * 口径：Windows 优先（本仓开发机就是 Windows）。盘符大小写、反斜杠这些用例只在 win32 下有意义，
 * POSIX 上语义不同（大小写敏感、反斜杠是普通字符），所以用 it.skipIf 标出来。
 */
const isWindows = process.platform === 'win32'

let tmp: string
let root: string
let outside: string
let rootReal: string
let linked = false
let symlinked = false

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-permission-'))
  root = join(tmp, 'workspace')
  outside = join(tmp, 'outside')

  mkdirSync(join(root, 'sub'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(join(tmp, 'workspace-evil'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'a')
  writeFileSync(join(root, 'sub', 'b.txt'), 'b')
  writeFileSync(join(outside, 'secret.txt'), 's')

  // junction：无需权限，覆盖"链接指向外部"这一类
  try {
    symlinkSync(outside, join(root, 'junction'), 'junction')
    linked = true
  } catch {
    linked = false
  }
  // 真 symlink：Windows 上多数机器没有开发者模式 → EPERM，造不出来就跳过
  try {
    symlinkSync(outside, join(root, 'symlink'), 'dir')
    symlinked = true
  } catch {
    symlinked = false
  }

  // 基准：真实根（本进程只读它做断言，不写回）
  const probe = resolveInsideWorkspace(root, '.')
  if (!probe.ok) throw new Error(`测试夹具坏了：工作区自身都解析不了（${probe.reason}）`)
  rootReal = probe.abs
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 断言：拒绝（可顺带钉住原因文案） */
function expectDenied(target: string, reason?: string): void {
  const result = resolveInsideWorkspace(root, target)
  expect(result, `target=${target}`).toMatchObject({ ok: false })
  if (reason !== undefined && !result.ok)
    expect(result.reason, `target=${target}`).toContain(reason)
}

/** 断言：放行，且返回的是归一后的绝对路径 */
function expectAllowed(target: string, abs: string): void {
  expect(resolveInsideWorkspace(root, target)).toEqual({ ok: true, abs })
}

describe('工作区内的正常路径：放行', () => {
  it('相对路径（文件 / 子目录 / 点号开头）', () => {
    expectAllowed('a.txt', join(rootReal, 'a.txt'))
    expectAllowed('sub/b.txt', join(rootReal, 'sub', 'b.txt'))
    expectAllowed('./a.txt', join(rootReal, 'a.txt'))
  })

  it.skipIf(!isWindows)('反斜杠分隔的 relative 路径（Windows 习惯）', () => {
    expectAllowed('sub\\b.txt', join(rootReal, 'sub', 'b.txt'))
  })

  it('绝对路径落在工作区里：放行，且返回 realpath 归一后的值', () => {
    expectAllowed(join(root, 'sub', 'b.txt'), join(rootReal, 'sub', 'b.txt'))
    expectAllowed(join(root, 'a.txt'), join(rootReal, 'a.txt'))
  })

  it('不存在的路径（新建文件/目录）：放行，缺的那段接在真实目录后面', () => {
    expectAllowed(join('sub', 'new.txt'), join(rootReal, 'sub', 'new.txt'))
    expectAllowed(
      join('新目录', '深一层', 'new.txt'),
      join(rootReal, '新目录', '深一层', 'new.txt')
    )
    expectAllowed(join(root, 'sub', 'brand-new.txt'), join(rootReal, 'sub', 'brand-new.txt'))
  })

  it('根自身：放行（工作区自己也是工作区里的一条路径）', () => {
    expectAllowed(root, rootReal)
    expectAllowed('.', rootReal)
    expectAllowed(root + sep, rootReal)
    expectAllowed(join(rootReal, '.'), rootReal)
  })

  it('原地绕一圈的 ..：归一后仍在工作区内就放行', () => {
    expectAllowed(join('sub', '..', 'a.txt'), join(rootReal, 'a.txt'))
    expectAllowed(join('sub', '..'), rootReal)
  })

  it('尾部分隔符不影响判定', () => {
    expectAllowed('sub/', join(rootReal, 'sub'))
    expectAllowed('sub\\', join(rootReal, 'sub'))
  })

  it.skipIf(!isWindows)('盘符大小写不敏感：大小写不同的同一路径放行', () => {
    expectAllowed(root.toUpperCase(), rootReal)
    // 已存在的文件解析到盘上的真实大小写；不存在的尾段保留调用方给的大小写
    expectAllowed(join(root.toUpperCase(), 'A.TXT'), join(rootReal, 'a.txt'))
    expectAllowed(join(root.toUpperCase(), 'NEW.TXT'), join(rootReal, 'NEW.TXT'))
  })
})

describe('.. 逃逸：拒绝', () => {
  it('相对路径往外爬一层 / 多层', () => {
    expectDenied(join('..', 'outside', 'secret.txt'), '工作区之外')
    expectDenied(join('sub', '..', '..', 'outside', 'secret.txt'), '工作区之外')
    expectDenied(join('..', '..', '..', 'anything.txt'), '工作区之外')
  })

  it('绝对路径指向工作区外（同盘别处）', () => {
    expectDenied(join(outside, 'secret.txt'), '工作区之外')
    expectDenied(outside, '工作区之外')
  })

  it('不存在的路径想落在外边（父目录就是工作区外）', () => {
    expectDenied(join(outside, 'new.txt'), '工作区之外')
    expectDenied(join('..', 'outside', 'new.txt'), '工作区之外')
  })

  it('前缀相同的兄弟目录不是工作区（C:\\ws 不能匹配 C:\\ws-evil）', () => {
    expectDenied(join('..', 'workspace-evil', 'x.txt'), '工作区之外')
    expectDenied(join(tmp, 'workspace-evil', 'x.txt'), '工作区之外')
    if (isWindows) expectDenied(join(tmp.toUpperCase(), 'WORKSPACE-EVIL', 'x.txt'), '工作区之外')
  })
})

describe('链接指向外部（symlink / junction）：拒绝', () => {
  it('junction 目录整体：拒绝', ({ skip }) => {
    if (!linked) skip()

    expectDenied(join('junction'), '工作区之外')
  })

  it('穿过 junction 的路径：拒绝（这是"符号链接逃逸"的主用例）', ({ skip }) => {
    if (!linked) skip()

    expectDenied(join('junction', 'secret.txt'), '工作区之外')
    expectDenied(join('junction', 'sub-not-exist', 'x.txt'), '工作区之外')
  })

  it('junction + .. 往外爬：拒绝', ({ skip }) => {
    if (!linked) skip()

    expectDenied(join('junction', '..', '..', 'outside', 'secret.txt'), '工作区之外')
  })

  it('链接 + .. 绕回工作区：放行，但返回的是归一后的路径（绝不是那条链接本身）', ({ skip }) => {
    if (!linked) skip()

    // junction/.. 在系统语义里是 tmp/outside 的父目录，词法归一后是工作区里的 a.txt。
    // 引擎返回归一后的 abs，调用方拿它去操作文件 —— 系统再也看不到链接与 ..
    expectAllowed(join('junction', '..', 'a.txt'), join(rootReal, 'a.txt'))
  })

  it('真 symlink 指向外部目录：拒绝（造链需要开发者模式，造不出来则跳过）', ({ skip }) => {
    if (!symlinked) skip()

    expectDenied(join('symlink'), '工作区之外')
    expectDenied(join('symlink', 'secret.txt'), '工作区之外')
  })
})

describe('UNC / 设备路径：拒绝', () => {
  for (const unc of [
    '\\\\server\\share\\file.txt',
    '//server/share/file.txt',
    '\\\\?\\C:\\Windows\\System32\\drivers\\etc\\hosts',
    '\\\\.\\PHYSICALDRIVE0'
  ]) {
    it(`目标 ${unc} 一律拒绝`, () => {
      expectDenied(unc, 'UNC')
    })
  }

  it('UNC 当工作区根也拒绝：realpath 之前就拦下（网络路径语义另说）', () => {
    const result = resolveInsideWorkspace('\\\\server\\share', 'a.txt')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('UNC')
  })
})

describe('输入本身不合法：拒绝（fail closed）', () => {
  it('空目标 / 空工作区', () => {
    expectDenied('', '目标路径为空')
    const emptyRoot = resolveInsideWorkspace('', 'a.txt')
    expect(emptyRoot).toMatchObject({ ok: false })
    if (!emptyRoot.ok) expect(emptyRoot.reason).toContain('工作区路径为空')
  })

  it('NUL 字符（路径注入的老朋友）', () => {
    expectDenied(`a.txt${String.fromCharCode(0)}.exe`)
  })

  it('工作区不存在 / 工作区是文件', () => {
    for (const badRoot of [join(tmp, 'no-such-dir'), join(root, 'a.txt')]) {
      const result = resolveInsideWorkspace(badRoot, 'a.txt')
      expect(result, badRoot).toMatchObject({ ok: false })
      if (!result.ok) expect(result.reason).toContain('工作区不存在或不是目录')
    }
  })

  it('目标把文件当目录用：拒绝（不是目录）', () => {
    expectDenied(join('a.txt', 'inside.txt'), '不是目录')
  })

  it('原因永远是一句能给人看的话（非空字符串）', () => {
    const denied: Array<{ ok: boolean; reason?: string }> = []
    for (const target of ['', '..\\x', '\\\\srv\\share\\x']) {
      denied.push(resolveInsideWorkspace(root, target))
    }
    for (const result of denied) {
      expect(result.ok).toBe(false)
      expect(result.reason).toBeTruthy()
      expect(result.reason).not.toContain('\n')
    }
  })
})
