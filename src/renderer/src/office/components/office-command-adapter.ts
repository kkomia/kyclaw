/**
 * 命令适配层（A2-prep，`spec §6.3` 的"表现层 / 命令层分离"）。
 *
 * 为什么要有这一层：
 *   - **A 档**（隔离面内自绘 ribbon）里，表现层应该只依赖这里定义的 `OfficeCommandAdapter`，
 *     而不是直接 import `useDocxCommand*`；这样组件可以在 jsdom 里用 fake adapter 单测；
 *   - **B 档**（shell 侧 ribbon + 命令桥）落地时，只要换一个"把命令转发到 postMessage 桥"的实现，
 *     UI 层零改动（见 office-ui-redesign-spec.md §6.3）。
 *
 * 本文件**不 import BetterOffice 运行时**：只用 `import type` 拿命令 id / 参数类型；
 * 真实实现由 A2 在面内用 `useDocxCommands()`（或 `DocxCommandProvider`）构造，见
 * `OfficeCommandAdapterFactory` 的类型占位。
 *
 * 状态口径（与 d.mts 的 `CommandState` 对齐但收窄为可序列化）：
 *   - `enabled=false` 时一定有 `disabledReason`；
 *   - `active` 支持 `'mixed'`（选区格式不一致）；
 *   - `value` / `options` 是格式自有的可序列化数据，本层不解释。
 */
import type { DocxCommandArgs, DocxCommandId } from '@betteroffice/docx-react'

/** 命令执行结果（`failed` 是适配层新增：桥接/适配实现自己的失败） */
export type OfficeCommandStatus = 'executed' | 'noop' | 'opened' | 'requested' | 'failed'

/** 命令不可用/失败原因（code 给逻辑分支，message 给人话） */
export interface OfficeCommandFailure {
  readonly code: string
  readonly message: string
}

/** 一次命令执行的结果（与 d.mts 的 DocxCommandResult 同构，多一个 failed） */
export interface OfficeCommandOutcome {
  readonly status: OfficeCommandStatus
  readonly failure?: OfficeCommandFailure
}

/** 命令的静态描述（只放表现层要用的：快捷键、是否改文档；label 用 ribbon 模型里的中文） */
export interface OfficeCommandDescriptor {
  readonly id: DocxCommandId
  /** 主快捷键（如 `Ctrl+B`）；没有就是 null */
  readonly shortcut: string | null
  /** 是否修改文档（只读态/审阅态可以用来提前置灰） */
  readonly mutatesDocument: boolean
}

/** 选择器命令的一个选项（字体/字号/样式/对齐/行距/缩放…） */
export interface OfficeCommandOption {
  readonly label: string
  /** 执行时传给命令的参数（可序列化；B 档可直接过桥） */
  readonly args: unknown
  /** 预览信息（字体族/字号/粗斜体/颜色…），表现层自由使用 */
  readonly preview?: unknown
}

/** 某一时刻的命令状态（可序列化；B 档可由 bridge 推送） */
export interface OfficeCommandState {
  /** toggle 激活态；`mixed` = 选区格式不一致 */
  readonly active: boolean | 'mixed'
  readonly enabled: boolean
  /** enabled=false 时必有；enabled=true 时为 null */
  readonly disabledReason: OfficeCommandFailure | null
  /** 命令当前值（如选中样式/字号），格式自有，本层不解释 */
  readonly value: unknown
  /** 选择器选项（非选择器命令为空数组） */
  readonly options: readonly OfficeCommandOption[]
}

/**
 * 表现层唯一依赖的命令接口。
 *
 * 约定：`getState` 是同步快照（订阅后由 `subscribe` 通知重取）；`execute` 不抛分类失败，
 * 用 `OfficeCommandOutcome.failure` 回传（渲染端不 try/catch 业务错误）。
 */
export interface OfficeCommandAdapter {
  getDescriptor(id: DocxCommandId): OfficeCommandDescriptor | null
  getState(id: DocxCommandId, args?: DocxCommandArgs[DocxCommandId]): OfficeCommandState
  execute(id: DocxCommandId, args?: DocxCommandArgs[DocxCommandId]): Promise<OfficeCommandOutcome>
  /** 命令状态变化通知；返回退订函数 */
  subscribe(listener: () => void): () => void
}

/**
 * 面内真实实现的**依赖面**（类型层占位，A2 实现）。
 *
 * A2 在隔离面里这样接（示意，不在本任务写）：
 *   const commands = useDocxCommands()   // DocxCommandStore
 *   const adapter = useMemo(() => createOfficeCommandAdapter(commands), [commands])
 * 其中真实 factory 只做归一化（descriptor.shortcuts[0] → shortcut；CommandState →
 * OfficeCommandState；execute 结果 → OfficeCommandOutcome），不改变命令语义。
 */
export interface OfficeCommandSource {
  getDescriptor(id: DocxCommandId): {
    readonly shortcut?: string | null
    readonly shortcuts?: readonly { readonly chord: string }[]
    readonly mutatesDocument?: boolean
  } | null
  getState(id: DocxCommandId, args?: DocxCommandArgs[DocxCommandId]): unknown
  execute(id: DocxCommandId, args?: DocxCommandArgs[DocxCommandId]): Promise<unknown>
  subscribe(listener: () => void): () => void
}

/** A2 实现真实 adapter 的工厂签名（B 档换实现时也实现这个签名） */
export type OfficeCommandAdapterFactory = (source: OfficeCommandSource) => OfficeCommandAdapter

/** 适配层的空状态（命令还没算出来 / fake 的默认值） */
export const OFFICE_COMMAND_EMPTY_STATE: OfficeCommandState = {
  active: false,
  enabled: true,
  disabledReason: null,
  value: null,
  options: []
}

/**
 * 状态键：`id` 或 `id:{参数字典序 JSON}`。
 * 同一个命令带不同参数（对齐 4 个按钮）是**不同状态**，所以适配层也要按参数分桶。
 */
export function officeCommandStateKey(
  id: DocxCommandId,
  args?: DocxCommandArgs[DocxCommandId]
): string {
  return args === undefined ? id : `${id}:${JSON.stringify(args)}`
}

/* ═══════════════════════════════════════════════════════════════════════
 * fake adapter（单测 / A2 组件层 story 用）
 * ═══════════════════════════════════════════════════════════════════════ */
export interface FakeOfficeCommandCall {
  readonly id: DocxCommandId
  readonly args?: DocxCommandArgs[DocxCommandId]
}

export interface FakeOfficeCommandAdapterOptions {
  /** 按命令 id 覆盖描述（shortcut / mutatesDocument） */
  readonly descriptors?: Partial<
    Record<DocxCommandId, Partial<Pick<OfficeCommandDescriptor, 'shortcut' | 'mutatesDocument'>>>
  >
  /** 初始状态：key 可以是命令 id（同参默认）或 `officeCommandStateKey(id, args)`（按参数覆盖） */
  readonly states?: Readonly<Record<string, Partial<OfficeCommandState>>>
  /** 按命令 id 配置 execute 结果（默认 `executed`） */
  readonly outcomes?: Partial<Record<DocxCommandId, OfficeCommandOutcome>>
}

export interface FakeOfficeCommandAdapter extends OfficeCommandAdapter {
  /** 执行记录（按调用顺序） */
  readonly calls: readonly FakeOfficeCommandCall[]
  /** 改状态并通知订阅者（可选参数 → 写入按参数分桶的状态） */
  setState(
    id: DocxCommandId,
    patch: Partial<OfficeCommandState>,
    args?: DocxCommandArgs[DocxCommandId]
  ): void
  /** 配置/覆盖某个命令的 execute 结果 */
  setOutcome(id: DocxCommandId, outcome: OfficeCommandOutcome): void
  /** 手动广播一次（模拟内核 command state 变化） */
  emit(): void
  /** 当前订阅者数量（断言退订） */
  listenerCount(): number
  /** 清空执行记录（不影响配置） */
  clearCalls(): void
}

/** 造一个可配置的 fake adapter（生产代码不要用；它只活在单测与组件 story 里） */
export function createFakeOfficeCommandAdapter(
  options: FakeOfficeCommandAdapterOptions = {}
): FakeOfficeCommandAdapter {
  const states = new Map<string, Partial<OfficeCommandState>>(Object.entries(options.states ?? {}))
  const outcomes = new Map<DocxCommandId, OfficeCommandOutcome>(
    Object.entries(options.outcomes ?? {}) as Array<[DocxCommandId, OfficeCommandOutcome]>
  )
  const descriptors = new Map<DocxCommandId, Partial<OfficeCommandDescriptor>>(
    Object.entries(options.descriptors ?? {}) as Array<
      [DocxCommandId, Partial<OfficeCommandDescriptor>]
    >
  )
  const listeners = new Set<() => void>()
  const calls: FakeOfficeCommandCall[] = []

  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    get calls(): readonly FakeOfficeCommandCall[] {
      return calls
    },
    getDescriptor(id): OfficeCommandDescriptor {
      const override = descriptors.get(id)
      return {
        id,
        shortcut: override?.shortcut ?? null,
        mutatesDocument: override?.mutatesDocument ?? false
      }
    },
    getState(id, args): OfficeCommandState {
      const key = officeCommandStateKey(id, args)
      const override = states.get(key) ?? states.get(id)
      return override === undefined
        ? OFFICE_COMMAND_EMPTY_STATE
        : { ...OFFICE_COMMAND_EMPTY_STATE, ...override }
    },
    async execute(id, args): Promise<OfficeCommandOutcome> {
      calls.push({ id, args })
      return outcomes.get(id) ?? { status: 'executed' }
    },
    subscribe(listener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setState(id, patch, args): void {
      const key = officeCommandStateKey(id, args)
      states.set(key, { ...(states.get(key) ?? states.get(id) ?? {}), ...patch })
      emit()
    },
    setOutcome(id, outcome): void {
      outcomes.set(id, outcome)
    },
    emit,
    listenerCount(): number {
      return listeners.size
    },
    clearCalls(): void {
      calls.length = 0
    }
  }
}
