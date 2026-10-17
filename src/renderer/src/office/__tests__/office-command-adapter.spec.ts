import { describe, expect, it, vi } from 'vitest'
import {
  OFFICE_COMMAND_EMPTY_STATE,
  createFakeOfficeCommandAdapter,
  officeCommandStateKey,
  type OfficeCommandAdapter,
  type OfficeCommandAdapterFactory,
  type OfficeCommandOutcome
} from '../components/office-command-adapter'

/**
 * 命令适配层契约（A2-prep）。
 *
 * 表现层只依赖 `OfficeCommandAdapter`；这里用 fake adapter 把契约钉死：
 *   - `execute` 记录 id/参数、结果由配置决定；
 *   - `setState` 之后 `subscribe` 的监听者收到通知；退订后不再收；
 *   - 状态按「id + 参数」分桶（对齐 left/center 是两份状态）；
 *   - fake 与真实实现共用同一个接口/工厂签名（B 档换实现时 UI 不改）。
 */
describe('office-command-adapter：fake adapter 的默认值', () => {
  it('未配置的命令：enabled / active=false / 无 options；descriptor 只有 id', () => {
    const adapter = createFakeOfficeCommandAdapter()

    expect(adapter.getState('bold')).toEqual(OFFICE_COMMAND_EMPTY_STATE)
    expect(adapter.getState('zoom')).toEqual({
      active: false,
      enabled: true,
      disabledReason: null,
      value: null,
      options: []
    })
    expect(adapter.getDescriptor('bold')).toEqual({
      id: 'bold',
      shortcut: null,
      mutatesDocument: false
    })
    expect(adapter.listenerCount()).toBe(0)
  })

  it('可配置描述与初始状态（含按参数分桶的状态）', () => {
    const adapter = createFakeOfficeCommandAdapter({
      descriptors: { bold: { shortcut: 'Ctrl+B', mutatesDocument: true } },
      states: {
        bold: { active: true },
        'alignment:{"value":"center"}': { active: true }
      }
    })

    expect(adapter.getDescriptor('bold')).toEqual({
      id: 'bold',
      shortcut: 'Ctrl+B',
      mutatesDocument: true
    })
    expect(adapter.getState('bold')).toMatchObject({ active: true, enabled: true })
    expect(adapter.getState('alignment', { value: 'center' })).toMatchObject({ active: true })
    expect(adapter.getState('alignment', { value: 'left' })).toMatchObject({ active: false })
  })
})

describe('office-command-adapter：execute 契约', () => {
  it('按调用顺序记录 id/args，默认回 executed', async () => {
    const adapter = createFakeOfficeCommandAdapter()

    const result = await adapter.execute('bold')
    await adapter.execute('insertTable', { rows: 2, columns: 3 })

    expect(result).toEqual({ status: 'executed' })
    expect(adapter.calls).toEqual([
      { id: 'bold', args: undefined },
      { id: 'insertTable', args: { rows: 2, columns: 3 } }
    ])
  })

  it('可配置分类失败（failure 带回人话），不抛异常', async () => {
    const failure: OfficeCommandOutcome = {
      status: 'failed',
      failure: { code: 'read-only', message: '文档是只读的' }
    }
    const adapter = createFakeOfficeCommandAdapter({ outcomes: { bold: failure } })

    await expect(adapter.execute('bold')).resolves.toEqual(failure)
  })

  it('clearCalls 只清记录，不清配置', async () => {
    const adapter = createFakeOfficeCommandAdapter()
    await adapter.execute('undo')
    adapter.clearCalls()
    expect(adapter.calls).toEqual([])
  })

  it('setOutcome 可在运行时改写结果（模拟桥接层失败）', async () => {
    const adapter = createFakeOfficeCommandAdapter()
    expect(await adapter.execute('save')).toEqual({ status: 'executed' })

    adapter.setOutcome('save', { status: 'failed', failure: { code: 'io', message: '磁盘满了' } })
    await expect(adapter.execute('save')).resolves.toMatchObject({ status: 'failed' })
  })
})

describe('office-command-adapter：subscribe / 状态切换', () => {
  it('setState 通知所有订阅者；退订后不再通知；listenerCount 对得上', () => {
    const adapter = createFakeOfficeCommandAdapter()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = adapter.subscribe(first)
    const unsubscribeSecond = adapter.subscribe(second)
    expect(adapter.listenerCount()).toBe(2)

    adapter.setState('bold', { active: true })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(adapter.getState('bold')).toMatchObject({ active: true })

    unsubscribeFirst()
    expect(adapter.listenerCount()).toBe(1)
    adapter.emit()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)

    unsubscribeSecond()
    expect(adapter.listenerCount()).toBe(0)
  })

  it('状态按「id + 参数」分桶：改居中不影响左对齐', () => {
    const adapter = createFakeOfficeCommandAdapter()
    adapter.setState('alignment', { active: true }, { value: 'center' })

    expect(adapter.getState('alignment', { value: 'center' })).toMatchObject({ active: true })
    expect(adapter.getState('alignment', { value: 'left' })).toMatchObject({ active: false })
    expect(adapter.getState('alignment')).toMatchObject({ active: false })
  })

  it('setState 是局部合并：没给的字段保留默认/上次值，禁用时带回原因', () => {
    const adapter = createFakeOfficeCommandAdapter({
      states: {
        reviewAccept: {
          enabled: false,
          disabledReason: { code: 'revision-required', message: '没有可处理的修订' }
        }
      }
    })

    expect(adapter.getState('reviewAccept', null)).toMatchObject({
      enabled: false,
      disabledReason: { code: 'revision-required' }
    })

    adapter.setState('reviewAccept', { enabled: true, disabledReason: null }, null)
    expect(adapter.getState('reviewAccept', null)).toMatchObject({
      enabled: true,
      disabledReason: null
    })
  })

  it('officeCommandStateKey：无参数就是 id，有参数带 JSON', () => {
    expect(officeCommandStateKey('bold')).toBe('bold')
    expect(officeCommandStateKey('fontSize')).toBe('fontSize')
    expect(officeCommandStateKey('alignment', { value: 'right' })).toBe(
      'alignment:{"value":"right"}'
    )
  })
})

describe('office-command-adapter：接口/工厂签名（给 A2/B 档共用）', () => {
  it('fake 满足 OfficeCommandAdapter；真实实现的工厂签名只依赖 OfficeCommandSource', async () => {
    const adapter: OfficeCommandAdapter = createFakeOfficeCommandAdapter()
    expect(adapter.getState('undo').enabled).toBe(true)

    // A2 的真实实现（面内 useDocxCommands）按这个签名构造；B 档换 bridge 实现同签名。
    const factory: OfficeCommandAdapterFactory = () => adapter
    const built = factory({
      getDescriptor: () => null,
      getState: () => ({}),
      execute: async () => ({ status: 'executed' }),
      subscribe: () => () => undefined
    })
    await expect(built.execute('bold')).resolves.toEqual({ status: 'executed' })
  })
})
