import { describe, expect, it } from 'vitest'
import { SESSION_DIR_PARENT, sessionDirNameOf, sessionDirOf } from '../session-dir'

describe('session-dir：无项目会话的落点（round 55）', () => {
  it('目录名 = threadId 前 8 位小写', () => {
    expect(sessionDirNameOf('B55EB49D-AB63-44D5-A613-9B028D6D2C4A')).toBe('b55eb49d')
    expect(sessionDirNameOf('thread-1')).toBe('thread-1')
    expect(sessionDirNameOf('abc')).toBe('abc')
  })

  it('Windows 默认工作区：反斜杠拼接、去尾部分隔符', () => {
    expect(sessionDirOf('D:\\测试', 'b55eb49d-ab63')).toBe(
      `D:\\测试\\${SESSION_DIR_PARENT}\\b55eb49d`
    )
    expect(sessionDirOf('D:\\测试\\', 'b55eb49d-ab63')).toBe(
      `D:\\测试\\${SESSION_DIR_PARENT}\\b55eb49d`
    )
    expect(sessionDirOf('D:\\测试///', 'b55eb49d-ab63')).toBe(
      `D:\\测试\\${SESSION_DIR_PARENT}\\b55eb49d`
    )
  })

  it('POSIX 默认工作区：正斜杠拼接', () => {
    expect(sessionDirOf('/home/u/ws', 'b55eb49d-ab63')).toBe('/home/u/ws/tasks/b55eb49d')
  })

  it('同一会话多次计算恒等（跨重启稳定、无状态）', () => {
    const first = sessionDirOf('D:\\测试', 'b55eb49d-ab63-44d5')
    const second = sessionDirOf('D:\\测试', 'b55eb49d-ab63-44d5')
    expect(first).toBe(second)
  })
})
