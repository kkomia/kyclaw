// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createThreadCwdResolver } from '../thread-cwd'

const projects = [
  { id: 'p1', path: 'E:\\work\\one' },
  { id: 'p2', path: 'E:\\work\\two' }
]

describe('PB-019 thread-cwd：不依赖旧 store 的 thread→cwd 解析', () => {
  it('project 映射命中 → project.path', () => {
    const resolve = createThreadCwdResolver({
      projectIdOf: (threadId) => (threadId === 't1' ? 'p1' : null),
      projects: () => projects,
      defaultWorkspace: () => 'E:\\default',
      fallback: 'E:\\fallback'
    })
    expect(resolve('t1')).toBe('E:\\work\\one')
  })

  it('无映射 → defaultWorkspace；无默认 → fallback', () => {
    const resolve = createThreadCwdResolver({
      projectIdOf: () => null,
      projects: () => projects,
      defaultWorkspace: () => 'E:\\default',
      fallback: 'E:\\fallback'
    })
    expect(resolve('unknown')).toBe('E:\\default')

    const noDefault = createThreadCwdResolver({
      projectIdOf: () => null,
      projects: () => projects,
      defaultWorkspace: () => null,
      fallback: 'E:\\fallback'
    })
    expect(noDefault('unknown')).toBe('E:\\fallback')
  })

  it('project 映射存在但 path 空 → 不返回空串，回落默认', () => {
    const resolve = createThreadCwdResolver({
      projectIdOf: () => 'empty',
      projects: () => [{ id: 'empty', path: '   ' }],
      defaultWorkspace: () => 'E:\\default',
      fallback: 'E:\\fallback'
    })
    expect(resolve('t1')).toBe('E:\\default')
  })
})
