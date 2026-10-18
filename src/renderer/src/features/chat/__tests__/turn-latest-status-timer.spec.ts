import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/chat/parts/TurnLatestStatus.tsx'),
  'utf8'
)

describe('P0-1 · TurnLatestStatus 定时器生命周期', () => {
  it('interval 只在 running 时创建；deps 含 running；完成/卸载必清理', () => {
    // 不许再无守卫的常驻 interval
    expect(source).toContain('if (!running) return undefined')
    expect(source).toMatch(/setInterval\([\s\S]*?clearInterval\(timer\)/)
    expect(source).toContain('}, [running])')
    // 完成态不渲染 + 不排 interval
    expect(source).toContain('if (!running) return null')
  })

  it('源码里只有一个 interval 创建点（不新增第二条常驻计时）', () => {
    expect(source.match(/window\.setInterval/g)?.length ?? 0).toBe(1)
  })
})
