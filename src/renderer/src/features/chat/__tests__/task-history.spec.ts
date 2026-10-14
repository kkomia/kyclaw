import { describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '@shared/tasks'
import { projectTaskSnapshot, projectTodoOutput, taskProgress } from '../task-history'

const time = '2026-10-14T00:00:00.000Z'
const snapshot: TaskSnapshot = {
  revision: 2,
  updatedAt: time,
  items: [
    { id: 'a', title: '<script>data</script>', status: 'done', createdAt: time, updatedAt: time },
    { id: 'b', title: '未完成', status: 'blocked', note: '等待', createdAt: time, updatedAt: time }
  ]
}
describe('任务历史纯投影', () => {
  it('有未完项或空清单均不显示全部完成', () => {
    expect(taskProgress(snapshot)).toEqual({
      done: 1,
      total: 2,
      inProgress: 0,
      blocked: 1,
      allDone: false
    })
    expect(taskProgress(null).allDone).toBe(false)
    expect(projectTaskSnapshot(snapshot)?.summary).toBe('任务 1/2 · 1 项阻塞')
    expect(projectTaskSnapshot({ ...snapshot, items: [snapshot.items[0]] })?.summary).toContain(
      '全部完成'
    )
  })
  it('标题原样保留为纯数据，冲突有独立标记，坏回包不投影', () => {
    expect(projectTaskSnapshot(snapshot)?.items[0].title).toBe('<script>data</script>')
    expect(projectTodoOutput({ status: 'conflict', snapshot })?.conflict).toBe(true)
    expect(projectTodoOutput({ status: 'ok', snapshot })?.conflict).toBe(false)
    expect(projectTodoOutput('bad')).toBeNull()
    expect(
      projectTaskSnapshot({ ...snapshot, items: [{ ...snapshot.items[1], note: '' }] })
    ).toBeNull()
  })
})
