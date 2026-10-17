import { beforeEach, describe, expect, it } from 'vitest'
import { resetNewTabStore, useNewTabStore } from '../new-tab-store'

/**
 * task-80：新增标签页的单例空白伪标签。
 * 不持久化 / 无 dirty / 不参与容量 —— 这里只钉状态机（open/activate/deactivate/consume/close）。
 */
describe('new-tab-store · 单例空白伪标签', () => {
  beforeEach(() => resetNewTabStore())

  it('初始关闭：isOpen=false / isActive=false', () => {
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: false, isActive: false })
  })

  it('open：没开就开并激活；已开再 open 只激活（单例，不会叠出第二个状态）', () => {
    useNewTabStore.getState().open()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: true, isActive: true })

    useNewTabStore.getState().deactivate()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: true, isActive: false })

    useNewTabStore.getState().open()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: true, isActive: true })
  })

  it('deactivate 只退前台、标签保留（文档被激活后空白仍在条上）', () => {
    useNewTabStore.getState().open()
    useNewTabStore.getState().deactivate()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: true, isActive: false })
  })

  it('consume：本页做出选择后标签消失', () => {
    useNewTabStore.getState().open()
    useNewTabStore.getState().consume()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: false, isActive: false })
  })

  it('close 与 consume 同语义（X / 中键 / Ctrl+W / Esc 无确认关闭）', () => {
    useNewTabStore.getState().open()
    useNewTabStore.getState().close()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: false, isActive: false })
  })

  it('activate 在未开时不会凭空把它打开（先 open）', () => {
    useNewTabStore.getState().activate()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: false, isActive: false })
  })

  it('不持久化：reset 后回到关闭（store 本身没有 storage 写入路径）', () => {
    useNewTabStore.getState().open()
    resetNewTabStore()
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: false, isActive: false })
  })
})
