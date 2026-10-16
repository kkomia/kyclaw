/**
 * 思考段的**手动开合表**：用户点过开/合的思考段，按「消息内 reasoning 序号」记住选择。
 *
 * 为什么住在消息这一层：助手消息的渲染形态会变 —— 纯思考时思考块直接挂在消息下，
 * 一旦来了一条工具行，同一块要换成过程块（TraceBlock）。**组件类型一变，整棵子树重挂**，
 * 思考块自己的 state 会丢；而用户口径是"自动折叠之后我再点开，后面来工具不能再压回去"，
 * 所以这份选择必须存在重挂之上（`Message` 的 state，不落任何全局 store）。
 *
 * 段身份（三条一起定）：
 *   1. **消息身份**：换了一条消息（`message.id` 变）就整表作废 —— 重新生成 / 编辑重发
 *      都是换一条消息，边界在这一层收掉；
 *   2. **消息内 reasoning 序号**：只数 reasoning part、按出现顺序编号。工具行插进两段思考之间
 *      不会改动这个序号（part 下标会，所以不用下标）；同一消息里**两段正文相同 / 互相是前缀**
 *      也各有各的序号，不共享选择；流式追加只是这一段变长，序号不变；
 *   3. **正文只做辅助**：记下时那份正文仍是**现在这段的开头**才算"同一段"（流式追加）。
 *      反过来的情况（记下的比现在的长）说明这一段被换了，旧选择丢掉。
 *
 * 纯逻辑放这里（不引 React）：组件文件只导出组件，`parts/` 层也不该反向依赖 `Message.tsx`。
 */

/**
 * 一条思考段的手动开合选择。
 *
 * `text` = 做这次选择时**已经写到那儿**的正文（不是"这一段最终正文"，那会随流式一直长）。
 */
export interface ReasoningChoice {
  open: boolean
  text: string
}

/** 键 = 这一段在消息里的 reasoning 序号（只数 reasoning part） */
export type ReasoningOverrides = ReadonlyMap<number, ReasoningChoice>

/** 只取"这一条是思考段"的正文（别的 part 给 null）：调用方不必自己窄化联合 */
export function reasoningTextOf(part: { type: string; text?: unknown }): string | null {
  return part.type === 'reasoning' && typeof part.text === 'string' ? part.text : null
}

/**
 * 每个 part 下标 → 它是第几段思考（只数 reasoning，从 0 起；非 reasoning 不给键）。
 *
 * 这个序号就是段身份的载体：工具行插进来、正文增长都不改它，所以用户的选择不会"漂"到别人身上。
 */
export function reasoningOrdinalsOf(
  parts: readonly { type: string }[]
): ReadonlyMap<number, number> {
  const ordinals = new Map<number, number>()
  let ordinal = 0
  parts.forEach((part, index) => {
    if (part.type !== 'reasoning') return
    ordinals.set(index, ordinal)
    ordinal += 1
  })
  return ordinals
}

/** 记下时那份正文仍是现在这段的**开头**（流式追加；或这一段当时还空着） */
function isSameSegment(recorded: string, current: string): boolean {
  return current.startsWith(recorded)
}

/**
 * 查这一段现在的手动选择（没选过 = undefined → 思考块自己按自动档走）。
 *
 * 同一消息里两段正文相同 / 互相是前缀也互不影响：查的是**这一段的序号**，
 * 正文只用来判"这一段还是不是当初那一段"。
 */
export function lookupReasoningChoice(
  overrides: ReasoningOverrides,
  ordinal: number,
  text: string
): ReasoningChoice | undefined {
  const choice = overrides.get(ordinal)
  if (choice === undefined) return undefined
  return isSameSegment(choice.text, text) ? choice : undefined
}

/**
 * 记下一次用户点击。
 *
 * 保留条件：某条记录的序号**现在还是那段思考**，且正文仍是同一段（前缀关系）。
 * 被清掉的只有"这一段已经被换掉了"的旧记录（记下的正文不再是现在这段的开头）。
 *
 * @param overrides 现有表
 * @param parts 当前消息的 parts + 它们的序号表（用来核对记录还在不在）
 * @param ordinal 用户点的那一段的序号
 * @param choice 这次的选择（含做选择时的正文）
 * @returns 新表（原表不动）
 */
export function withReasoningChoice(
  overrides: ReasoningOverrides,
  parts: readonly { type: string; text?: unknown }[],
  ordinals: ReadonlyMap<number, number>,
  ordinal: number,
  choice: ReasoningChoice
): ReasoningOverrides {
  const next = new Map<number, ReasoningChoice>()
  overrides.forEach((value, key) => {
    if (key === ordinal) return
    const sameSegment = parts.some((part, index) => {
      if (ordinals.get(index) !== key) return false
      const text = reasoningTextOf(part)
      return text !== null && isSameSegment(value.text, text)
    })
    if (sameSegment) next.set(key, value)
  })
  next.set(ordinal, choice)
  return next
}
