import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW_STATE, readWindowState, windowStatePath, writeWindowState } from '../store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('窗口状态存储（userData 下的 JSON）', () => {
  it('往返：写进去什么就读出来什么（几何 + 最大化标记）', () => {
    const file = windowStatePath(dir)
    const state = { width: 1120, height: 720, x: 120, y: 64, maximized: true }

    writeWindowState(file, state)

    expect(readWindowState(file)).toEqual(state)
  })

  it('没有落过盘（首启动）→ 默认值', () => {
    expect(readWindowState(windowStatePath(dir))).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('文件不是 JSON（写坏/被改）→ 默认值，不抛', () => {
    const file = windowStatePath(dir)
    writeFileSync(file, '{不是 json', 'utf8')

    expect(readWindowState(file)).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('字段过不了 zod 校验（负宽 / 缺键 / 多键）→ 默认值，不抛', () => {
    const file = windowStatePath(dir)

    for (const bad of [
      { width: -1, height: 720, x: 0, y: 0, maximized: false },
      { width: 1120, height: 720, maximized: false },
      { width: 1120, height: 720, x: 0, y: 0, maximized: false, evil: 1 }
    ]) {
      writeFileSync(file, JSON.stringify(bad), 'utf8')
      expect(readWindowState(file), JSON.stringify(bad)).toEqual(DEFAULT_WINDOW_STATE)
    }
  })

  it('目录还不存在时写入会自己建目录（userData 首次创建）', () => {
    const file = windowStatePath(join(dir, 'nested', 'deeper'))

    writeWindowState(file, { ...DEFAULT_WINDOW_STATE, x: 8, y: 8 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      ...DEFAULT_WINDOW_STATE,
      x: 8,
      y: 8
    })
  })

  it('读出来的默认值是新对象（调用方改了不会污染模块级默认）', () => {
    const first = readWindowState(windowStatePath(dir))
    first.width = 1

    expect(DEFAULT_WINDOW_STATE.width).not.toBe(1)
    expect(readWindowState(windowStatePath(dir))).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('写不进去就静默（只读介质/父路径被占）：窗口状态是尽力而为，不拦关窗', () => {
    // 父路径是个文件 → mkdir 必失败
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x', 'utf8')

    expect(() => writeWindowState(windowStatePath(blocked), DEFAULT_WINDOW_STATE)).not.toThrow()
  })
})
