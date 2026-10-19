import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * PB-041 防回归：renderer **不得再请求旧 `/plans/*`**（5 个 SSE 端点已随旧内核删除，现在 404）。
 *
 * 这是源码级闸门：旧 plans-api / plans-store / plan-runtime / PlanApprovalDock 已下架，
 * 任何重新引入的 `/plans/` 字符串（或把旧模块加回来）都会让这条测试变红。
 * 只扫生产源码，不扫 `__tests__`（测试可以断言"不存在"，但产品代码不行）。
 */
const RENDERER_ROOT = resolve(process.cwd(), 'src/renderer/src')
const LEGACY_MARKERS = ['/plans/', 'plans-api', 'plans-store', 'plan-runtime', 'PlanApprovalDock']

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full)
  }
  return files
}

describe('PB-041：renderer 不再依赖旧 /plans/* 通道', () => {
  it('生产源码里没有 /plans/ 或旧 plans 模块引用', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER_ROOT)) {
      const source = readFileSync(file, 'utf8')
      for (const marker of LEGACY_MARKERS) {
        if (source.includes(marker)) {
          offenders.push(`${file.slice(RENDERER_ROOT.length + 1)}: ${marker}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('旧 plans 文件本身已删除（防"文件还在、只是没被 import"）', () => {
    const files = sourceFiles(RENDERER_ROOT).map((file) => file.slice(RENDERER_ROOT.length + 1))
    expect(
      files.filter((file) => /(?:^|\/)(?:plans-api|plans-store|plan-runtime)\.ts$/.test(file))
    ).toEqual([])
    expect(files.filter((file) => /PlanApprovalDock\.tsx$/.test(file))).toEqual([])
  })
})
