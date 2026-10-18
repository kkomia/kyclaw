import { beforeEach, describe, expect, it } from 'vitest'
import {
  OFFICE_CAPABILITY_NOTE,
  markCapabilityNoteSeen,
  shouldShowCapabilityNote
} from '../capability-note'

/**
 * PB-020 R1：能力说明「首次一次性」契约。
 * - 首次打开（无 localStorage 标记）→ 显示一次；
 * - 用户关掉后打标记 → 之后不再自动出现（状态栏入口仍可查）；
 * - 文案只写事实，不含假百分比/感叹号。
 */
describe('capability-note：首次一次性', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('首次显示 → 标记后不再显示（两格式独立）', () => {
    expect(shouldShowCapabilityNote('xlsx')).toBe(true)
    expect(shouldShowCapabilityNote('pptx')).toBe(true)
    markCapabilityNoteSeen('xlsx')
    expect(shouldShowCapabilityNote('xlsx')).toBe(false)
    expect(shouldShowCapabilityNote('pptx')).toBe(true)
  })

  it('localStorage 不可用（getItem 抛错）时退化为显示，不崩溃', () => {
    const original = window.localStorage.getItem
    window.localStorage.getItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(shouldShowCapabilityNote('xlsx')).toBe(true)
    } finally {
      window.localStorage.getItem = original
    }
  })

  it('文案只说事实：xlsx 提行列/工作表限制，pptx 提删页/重排限制；不含感叹号', () => {
    expect(OFFICE_CAPABILITY_NOTE.xlsx).toContain('行/列')
    expect(OFFICE_CAPABILITY_NOTE.xlsx).toContain('工作表')
    expect(OFFICE_CAPABILITY_NOTE.pptx).toContain('删页')
    for (const note of Object.values(OFFICE_CAPABILITY_NOTE)) {
      expect(note).not.toContain('!')
      expect(note).not.toContain('！')
    }
  })
})
