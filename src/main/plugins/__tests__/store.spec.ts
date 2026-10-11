// @vitest-environment node
/**
 * round 23 · 插件目录的健壮删除与残骸清扫（"移除没反应"的根修）：
 *   ① removeDirRobust：普通删 / 只读残骸 / rm 抛错→改名兜底 / 改名也失败→人话错误；
 *   ② sweepPluginResidue：`*.trash-*` 三处清扫 + marketplaces/ 下无主目录清掉、
 *      有主的与 local（用户自己的目录）绝不碰。
 * 改名/删除注入只是为了把"rm 半途抛错"这种难复现的形态钉进测试（生产走真实现）。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pluginsDirs, removeDirRobust, sweepPluginResidue } from '../store'
import type { PluginMarketplace } from '../../../shared/settings'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-plugin-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

function market(overrides: Partial<PluginMarketplace>): PluginMarketplace {
  return {
    id: 'm1',
    name: 'm1',
    source: 'owner/repo',
    kind: 'git',
    path: join(pluginsDirs(dir).marketplaces, 'm1'),
    addedAt: '2026-10-11T00:00:00.000Z',
    ...overrides
  }
}

describe('removeDirRobust', () => {
  it('普通删除：目录连内容一起删除；不存在 = 空操作', () => {
    const target = join(dir, 'goner')
    mkdirSync(join(target, 'nested'), { recursive: true })
    writeFileSync(join(target, 'nested', 'a.txt'), 'x')

    removeDirRobust(target)
    expect(existsSync(target)).toBe(false)

    expect(() => removeDirRobust(join(dir, 'never-existed'))).not.toThrow()
  })

  it('半删除残骸（只读文件）：清只读后照样删得掉', () => {
    const target = join(dir, 'readonly-residue')
    mkdirSync(join(target, '.git', 'objects'), { recursive: true })
    const pack = join(target, '.git', 'objects', 'pack')
    writeFileSync(pack, 'x')
    try {
      chmodSync(pack, 0o444) // Windows 上等价"只读属性"
    } catch {
      /* 设不上就按普通文件测 */
    }

    removeDirRobust(target)
    expect(existsSync(target)).toBe(false)
  })

  it('rm 半途抛错 → 顶层改名到 .trash-<ts>：原路径当作已移除，trash 尽力清', () => {
    const target = join(dir, 'locked')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'pack'), 'x')

    const renamed: Array<[string, string]> = []
    removeDirRobust(target, {
      rm: () => {
        throw new Error('EBUSY（模拟 .git/objects 被占用）')
      },
      rename: (from, to) => {
        renamed.push([from, to])
        renameSync(from, to)
      }
    })

    expect(existsSync(target)).toBe(false)
    expect(renamed).toHaveLength(1)
    const trash = renamed[0]?.[1] as string
    expect(trash).toMatch(/\.trash-\d+$/)
    // 改名后的 trash 尽力清 → 清掉了
    expect(existsSync(trash)).toBe(false)
  })

  it('连改名都失败 → 抛人话「删除被占用」，目录原样留着', () => {
    const target = join(dir, 'stubborn')
    mkdirSync(target, { recursive: true })

    expect(() =>
      removeDirRobust(target, {
        rm: () => {
          throw new Error('EBUSY')
        },
        rename: () => {
          throw new Error('EPERM')
        }
      })
    ).toThrow(/删除被占用/)
    expect(existsSync(target)).toBe(true)
  })
})

describe('sweepPluginResidue（启动清扫）', () => {
  it('清三处 trash；marketplaces 下有主的留着、无主的（git 孤儿残骸）清掉；local 用户目录不碰', () => {
    const dirs = pluginsDirs(dir)
    // 有主的市场（settings 里在册）
    mkdirSync(join(dirs.marketplaces, 'm1'), { recursive: true })
    writeFileSync(join(dirs.marketplaces, 'm1', 'keep.txt'), 'x')
    // 无主残骸（半删除的 git 孤儿）
    mkdirSync(join(dirs.marketplaces, 'kimi-plugin-cc', '.git', 'objects'), { recursive: true })
    // trash 残骸（三处）
    mkdirSync(join(dirs.marketplaces, 'old.trash-1720000000000'), { recursive: true })
    mkdirSync(join(dirs.installed, 'demo-p1.trash-1720000000000'), { recursive: true })
    mkdirSync(join(dirs.skills, 'demo-p1-s1.trash-1720000000000'), { recursive: true })
    // local 市场：用户自己的目录（不在 plugins/ 树下）
    const localDir = join(dir, '我的市场')
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'marketplace.json'), '{}')

    const logs: string[] = []
    const result = sweepPluginResidue({
      dirs,
      marketplaces: [market({ path: join(dirs.marketplaces, 'm1') })],
      log: (message) => logs.push(message)
    })

    expect(existsSync(join(dirs.marketplaces, 'm1', 'keep.txt'))).toBe(true)
    expect(existsSync(join(dirs.marketplaces, 'kimi-plugin-cc'))).toBe(false)
    expect(existsSync(join(dirs.marketplaces, 'old.trash-1720000000000'))).toBe(false)
    expect(existsSync(join(dirs.installed, 'demo-p1.trash-1720000000000'))).toBe(false)
    expect(existsSync(join(dirs.skills, 'demo-p1-s1.trash-1720000000000'))).toBe(false)
    expect(existsSync(localDir)).toBe(true)
    expect(result.removedTrash).toHaveLength(3)
    expect(result.removedOrphans).toHaveLength(1)
    expect(logs.some((line) => line.includes('没有主人的市场目录'))).toBe(true)
  })

  it('local 类型的市场记录：路径在用户自己的目录里，孤儿清扫不碰它', () => {
    const dirs = pluginsDirs(dir)
    const localDir = join(dir, '用户目录')
    mkdirSync(localDir, { recursive: true })
    mkdirSync(dirs.marketplaces, { recursive: true }) // 空树

    sweepPluginResidue({
      dirs,
      marketplaces: [market({ kind: 'local', path: localDir })],
      log: () => {}
    })

    expect(existsSync(localDir)).toBe(true)
  })

  it('目录都不存在：空跑不抛（读不到 = 空表，也不凭空建目录）', () => {
    const fresh = join(dir, 'fresh')
    const dirs = pluginsDirs(fresh)
    expect(() => sweepPluginResidue({ dirs, marketplaces: [], log: () => {} })).not.toThrow()
    expect(existsSync(fresh)).toBe(false)
  })
})
