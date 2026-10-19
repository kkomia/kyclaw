// @vitest-environment node
/**
 * PB-020 A2c：旧路径 import 闸门（可执行版，替代手工 grep 的遗忘风险）。
 *
 * 口径（与 runbook §1.4 / 附录 A 同步）：
 * - `src/main` + `src/shared` 生产代码：静态 + 动态 import 必须 **0**；
 * - `e2e/**`：必须 **0**（PB-021 已清）；
 * - `src/main` + `src/shared` 测试：只允许附录 A 明确批准的条目（当前 3 处 loader 测试依赖），
 *   且批准条目必须真实存在——Step 2 迁移/删除 loader 后本测试会红，提醒同步清空附录 A。
 *
 * 不扫描 `src/mastra/**` 自身：Step 2 前它仍有内部 @mastra import（属删除面，不是宿主残留）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const CODE_EXT = /\.(ts|tsx)$/
const TEST_PATH = /__tests__|\.spec\./

/** 附录 A allowlist：文件相对路径 + import 的模块串（都命中才算批准）。 */
const ALLOWLIST: ReadonlyArray<{ file: string; module: string }> = [
  { file: 'src/main/plugins/__tests__/skill-add.spec.ts', module: 'mastra/skills/loader' },
  { file: 'src/main/plugins/__tests__/skill-add.spec.ts', module: 'mastra/skills/loader' },
  { file: 'src/main/plugins/__tests__/skills.spec.ts', module: 'mastra/skills/loader' }
]

interface Hit {
  file: string
  module: string
  line: number
  text: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'out' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (CODE_EXT.test(entry)) out.push(full)
  }
  return out
}

function scan(roots: readonly string[]): Hit[] {
  const hits: Hit[] = []
  for (const root of roots) {
    for (const file of walk(join(ROOT, root))) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        for (const re of [
          /from\s+['"]([^'"]*mastra\/[^'"]*)['"]/g,
          /import\(\s*['"]([^'"]*mastra\/[^'"]*)['"]/g
        ]) {
          for (const match of line.matchAll(re)) {
            hits.push({
              file: relative(ROOT, file).replaceAll('\\', '/'),
              module: match[1] ?? '',
              line: index + 1,
              text: line.trim()
            })
          }
        }
      })
    }
  }
  return hits
}

function isProd(hit: Hit): boolean {
  return !TEST_PATH.test(hit.file)
}

function allowed(hit: Hit): boolean {
  return ALLOWLIST.some((item) => item.file === hit.file && hit.module.includes(item.module))
}

describe('PB-020 A2c：旧路径 import 闸门', () => {
  it('生产 src/main + src/shared：静态/动态 mastra import = 0', () => {
    const hits = scan(['src/main', 'src/shared']).filter(isProd)
    expect(
      hits,
      `生产旧路径 import 命中：\n${hits.map((h) => `${h.file}:${h.line} ${h.text}`).join('\n')}`
    ).toEqual([])
  })

  it('e2e：旧路径 import = 0', () => {
    const hits = scan(['e2e'])
    expect(
      hits,
      `e2e 旧路径 import 命中：\n${hits.map((h) => `${h.file}:${h.line} ${h.text}`).join('\n')}`
    ).toEqual([])
  })

  it('测试：只允许附录 A 的 3 处 loader 依赖（且必须真实存在）', () => {
    const hits = scan(['src/main', 'src/shared']).filter((hit) => !isProd(hit))
    const unapproved = hits.filter((hit) => !allowed(hit))
    expect(
      unapproved,
      `不在附录 A 的测试 import：\n${unapproved.map((h) => `${h.file}:${h.line} ${h.text}`).join('\n')}`
    ).toEqual([])
    expect(hits.filter(allowed)).toHaveLength(3)
    expect(hits.filter(allowed).every((hit) => hit.module.includes('mastra/skills/loader'))).toBe(
      true
    )
  })
})
