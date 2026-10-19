// @vitest-environment node
/**
 * I1 闸门（B2）：**renderer 目录零 `@deepseek-ai/*` import**。
 *
 * 为什么是闸门而不是约定：rc.2 没有 `.d.ts`，一旦 renderer 直接 import 内核包，
 * TypeScript 就失去边界、打包也会把内核实现拖进 renderer bundle。适配层只能待在 main（D1）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(process.cwd(), 'src', 'renderer')

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...walk(full))
      continue
    }
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) files.push(full)
  }
  return files
}

/** 只匹配真正的 import/require 语句，注释/文档里提到包名不算 */
const IMPORT_PATTERN = /(?:from\s+|require\s*\(\s*)['"]@deepseek-ai\//

describe('I1：renderer 不得 import 内核包', () => {
  it('src/renderer 全目录 0 个 @deepseek-ai/* import', () => {
    const files = walk(RENDERER)
    expect(files.length).toBeGreaterThan(50) // 防止路径写错导致空扫描
    const offenders = files.filter((file) => IMPORT_PATTERN.test(readFileSync(file, 'utf8')))
    expect(
      offenders.map((file) => relative(process.cwd(), file)),
      `renderer 不允许直接 import @deepseek-ai/*（见 D1）；命中的文件：`
    ).toEqual([])
  })

  it('适配层自身也不得 import @deepseek-ai/*（只能引用类型垫片）', () => {
    const dirs = [
      join(process.cwd(), 'src', 'shared', 'kernel-port'),
      join(process.cwd(), 'src', 'main', 'kernel')
    ]
    const offenders: string[] = []
    for (const dir of dirs) {
      for (const file of walk(dir)) {
        if (IMPORT_PATTERN.test(readFileSync(file, 'utf8')))
          offenders.push(relative(process.cwd(), file))
      }
    }
    expect(offenders).toEqual([])
  })
})
