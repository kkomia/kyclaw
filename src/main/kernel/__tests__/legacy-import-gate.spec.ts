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

// Step 2 之后：`src/mastra` 已删除，测试侧的旧路径 import 也一并清零。
// 这里**没有再留 allowlist**：留一个空数组 + 过滤断言会变成永不失败的假闸门（Step 2 前它确实有 3 条例外）。

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

  it('测试：旧路径 import = 0（Step 2 后 allowlist 已清空，没有例外）', () => {
    const hits = scan(['src/main', 'src/shared']).filter((hit) => !isProd(hit))
    // 不写成 `hits.filter(allowlist)`：allowlist 为空时那个 filter 恒空，会变成永不失败的假闸门。
    expect(
      hits,
      `测试里仍有旧路径 import（src/mastra 已删除，这些 import 必然解析失败）：\n${hits
        .map((h) => `${h.file}:${h.line} ${h.text}`)
        .join('\n')}`
    ).toEqual([])
  })
})
