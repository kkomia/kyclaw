import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Workspace } from '../../shared/settings'
import { addWorkspace, checkWorkspacePath, removeWorkspace, setWorkspaceMode } from '../workspace'

/**
 * 工作区列表操作（workspace:add / set-mode / remove 的实现）与路径校验。
 * 校验口径：只有**存在且是目录**的路径能进授权列表（UNC 直接拒——引擎也不支持）；
 * 列表按路径比对（Windows 下大小写与分隔符等价），所以同一条不会出现两遍、切模式不会变成两行。
 * T13 起 add 与切模式分开：add 一律 ask、set-mode 只认已授权路径（full 只能显式切换）。
 */
const isWindows = process.platform === 'win32'

let tmp: string
let root: string
let rootReal: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-workspace-'))
  root = join(tmp, '项目')
  mkdirSync(join(root, '子目录'), { recursive: true })
  writeFileSync(join(tmp, 'a.txt'), 'a')

  const checked = checkWorkspacePath(root)
  if (!checked.ok) throw new Error(`测试夹具坏了：${checked.reason}`)
  rootReal = checked.path
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('checkWorkspacePath（进授权列表前的校验）', () => {
  it('存在的目录：通过，回的是 realpath 归一后的路径', () => {
    expect(checkWorkspacePath(root)).toEqual({ ok: true, path: rootReal })
    expect(checkWorkspacePath(join(root, '子目录'))).toEqual({
      ok: true,
      path: join(rootReal, '子目录')
    })
  })

  it.skipIf(!isWindows)('大小写不同的同一目录：通过，归一成同一个路径', () => {
    expect(checkWorkspacePath(root.toUpperCase())).toEqual({ ok: true, path: rootReal })
  })

  it('两头的空白会被修掉（粘贴路径时的常见脏数据）', () => {
    expect(checkWorkspacePath(`  ${root}  `)).toEqual({ ok: true, path: rootReal })
  })

  it('不存在的路径 / 文件：拒绝', () => {
    const missing = checkWorkspacePath(join(tmp, 'no-such-dir'))
    expect(missing).toMatchObject({ ok: false })
    if (!missing.ok) expect(missing.reason).toContain('路径不存在或不可访问')

    const file = checkWorkspacePath(join(tmp, 'a.txt'))
    expect(file).toMatchObject({ ok: false })
    if (!file.ok) expect(file.reason).toContain('不是文件夹')
  })

  it('空路径 / UNC 路径：拒绝', () => {
    for (const bad of ['', '   ']) {
      const result = checkWorkspacePath(bad)
      expect(result, JSON.stringify(bad)).toMatchObject({ ok: false })
      if (!result.ok) expect(result.reason).toContain('路径为空')
    }

    const unc = checkWorkspacePath('\\\\server\\share\\项目')
    expect(unc).toMatchObject({ ok: false })
    if (!unc.ok) expect(unc.reason).toContain('UNC')
  })

  it('选中的是链接（junction）：通过，但存的是链接指向的真实目录', () => {
    const real = join(tmp, '链接目标')
    mkdirSync(real, { recursive: true })
    const link = join(tmp, '链接')
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      return // 造不出链接的环境（理论上不会有）跳过这一条
    }

    expect(checkWorkspacePath(link)).toEqual({ ok: true, path: real })
  })
})

describe('addWorkspace（workspace:add：新增一律 ask，已有保持原模式）', () => {
  it('空列表 + 一条：以 ask 新增', () => {
    expect(addWorkspace([], 'D:\\ws')).toEqual([{ path: 'D:\\ws', mode: 'ask' }])
  })

  it('已在列表里：模式不动（不把 full 悄悄降级，也不把它当新增）', () => {
    const list: Workspace[] = [
      { path: 'D:\\ws', mode: 'full' },
      { path: 'D:\\other', mode: 'ask' }
    ]

    expect(addWorkspace(list, 'D:\\ws')).toEqual([
      { path: 'D:\\ws', mode: 'full' },
      { path: 'D:\\other', mode: 'ask' }
    ])
  })

  it('新路径追加在尾部，原来的顺序不动', () => {
    const list: Workspace[] = [{ path: 'D:\\ws', mode: 'full' }]

    expect(addWorkspace(list, 'D:\\other')).toEqual([
      { path: 'D:\\ws', mode: 'full' },
      { path: 'D:\\other', mode: 'ask' }
    ])
  })

  it.skipIf(!isWindows)(
    'Windows 上大小写 / 分隔符不同的同一路径算同一条：模式与**原写法**都保持（重选不改写授权表）',
    () => {
      const list: Workspace[] = [{ path: 'D:\\ws', mode: 'full' }]

      expect(addWorkspace(list, 'd:/WS')).toEqual([{ path: 'D:\\ws', mode: 'full' }])
    }
  )

  it('不改传入的列表（调用方手里的那份保持原样）', () => {
    const list: Workspace[] = [{ path: 'D:\\ws', mode: 'ask' }]

    const next = addWorkspace(list, 'D:\\ws')

    expect(list).toEqual([{ path: 'D:\\ws', mode: 'ask' }])
    expect(next).not.toBe(list)
  })
})

describe('setWorkspaceMode（workspace:set-mode：只认已授权路径）', () => {
  it('已授权路径：切模式，其余条目不动', () => {
    const list: Workspace[] = [
      { path: 'D:\\ws', mode: 'ask' },
      { path: 'D:\\other', mode: 'ask' }
    ]

    expect(setWorkspaceMode(list, 'D:\\ws', 'full')).toEqual([
      { path: 'D:\\ws', mode: 'full' },
      { path: 'D:\\other', mode: 'ask' }
    ])
  })

  it('不在列表里：回 null（调用方抛错），绝不顺手新增一条', () => {
    expect(setWorkspaceMode([{ path: 'D:\\ws', mode: 'ask' }], 'D:\\没授权', 'full')).toBeNull()
    expect(setWorkspaceMode([], 'D:\\ws', 'full')).toBeNull()
  })

  it.skipIf(!isWindows)('写法归一后命中同一条；**落盘保留列表里的原 path**，只改 mode', () => {
    const list: Workspace[] = [{ path: 'D:\\ws', mode: 'ask' }]

    expect(setWorkspaceMode(list, 'd:/WS', 'full')).toEqual([{ path: 'D:\\ws', mode: 'full' }])
  })

  it('调用方给的字符串不被采纳：切模式不会改写授权表里的路径写法', () => {
    const list: Workspace[] = [{ path: 'D:\\项目\\demo', mode: 'ask' }]

    expect(setWorkspaceMode(list, 'D:/项目/demo/', 'full')).toEqual([
      { path: 'D:\\项目\\demo', mode: 'full' }
    ])
  })
})

describe('removeWorkspace（workspace:remove）', () => {
  it('按路径移除，其余保持顺序', () => {
    const list: Workspace[] = [
      { path: 'D:\\a', mode: 'ask' },
      { path: 'D:\\b', mode: 'full' },
      { path: 'D:\\c', mode: 'ask' }
    ]

    expect(removeWorkspace(list, 'D:\\b')).toEqual([
      { path: 'D:\\a', mode: 'ask' },
      { path: 'D:\\c', mode: 'ask' }
    ])
  })

  it.skipIf(!isWindows)('大小写不同的同一路径也删得掉', () => {
    const list: Workspace[] = [{ path: 'D:\\项目', mode: 'full' }]

    expect(removeWorkspace(list, 'd:\\项目')).toEqual([])
  })

  it('不在列表里的路径：空操作（不抛、也不动别人的行）', () => {
    const list: Workspace[] = [{ path: 'D:\\a', mode: 'ask' }]

    expect(removeWorkspace(list, 'D:\\no-such')).toEqual(list)
  })

  it('不改传入的列表', () => {
    const list: Workspace[] = [{ path: 'D:\\a', mode: 'ask' }]

    removeWorkspace(list, 'D:\\a')

    expect(list).toEqual([{ path: 'D:\\a', mode: 'ask' }])
  })
})
