import { publishDraft } from './composer-inbox'
import { CAPABILITIES } from './capabilities'

/**
 * 初始页输入卡下方那一排「能力入口」（round 75）：点一下把**起始提示词**填进输入框。
 *
 * 为什么要这一排（用户口径：功能完整度）：空会话时只有一个输入框 +「选择项目」+「PPT」，
 * 第一次打开的人**不知道这个 agent 能干什么**——想干一件事却不知道从哪儿着手。
 * 参照 Kimi 初始页的做法：输入卡下面一排能力胶囊，把"能干的活"直接摆出来。
 *
 * 口径：
 *   - **入口集合只有一处**：`capabilities.ts`（加一条能力改那里一行，这里不写死任何标签）。
 *   - **点一下有着手点**：把该条的起始提示词填进输入框并聚焦，**不自动发送**。
 *     走的是 round 61 那条现成通道（`composer-inbox` 的 `publishDraft`）——与「撤回消息回填
 *     输入框」**同一条**，不另造接口：对话页拿不到 Composer 的内部草稿 state，只有这条路。
 *     落草稿时那条通道顺手把光标落到末尾、把焦点交回输入框（见 Composer 的订阅与落位 effect）。
 *   - **不覆盖已经写下的东西**（round 76，用户口径）：输入框空着就直接填入，里面已经有草稿
 *     就**追加到末尾**（保留用户写的那半句）—— 所以这里传的是 `mode: 'append'`；
 *     通道缺省仍是 `'replace'`（撤回回填那一路的语义不动，见 composer-inbox）。
 *   - 形态与「PPT」胶囊同族（h-8 / rounded-pill / 同一条 hairline 描边、同档字号）：它们**同一行**，
 *     看着必须是一排。**显隐不在这里管**：宿主 ChatPage 按初始页判定渲染这一行，与「选择项目」
 *     「PPT」同一个生命周期，进对话整行不渲染。
 *   - 动效：hover 走 --motion-fast 过渡（雷点 5：不硬切）。进场跟着宿主那一行挂的
 *     `animate-message-in`（ChatPage 页脚那条），这里不另加一套动画——两段动画叠着会打架。
 *   - 雷点：零 emoji（1）；不用小字解释（2）；多出一个入口不算"铺二级菜单"（3，一排胶囊是入口）；
 *     圆角容器里不出现直角框（6）；不叠框线（7）。
 */
export interface CapabilityRowProps {
  /** 当前会话（草稿 id 也是真 id；`publishDraft` 拿它做归属过滤） */
  threadId: string
}

export function CapabilityRow({ threadId }: CapabilityRowProps): React.JSX.Element {
  return (
    // `mr-1` 而不是让宿主那一行加 gap：同一行右边还挂着 PPT 胶囊，宿主那行本来没有 gap ——
    // 用外边距就不必去改宿主那行的类名（间距与胶囊内部同档，整行看着仍是一排）。
    <div data-testid="composer-capability-row" className="mr-1 flex items-center gap-1">
      {CAPABILITIES.map((capability) => {
        const Icon = capability.icon
        return (
          <button
            key={capability.id}
            type="button"
            data-testid={`composer-capability-${capability.id}`}
            onClick={() => publishDraft({ threadId, text: capability.prompt, mode: 'append' })}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill border-(length:--hairline-width) border-hairline px-3 text-b2 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span>{capability.label}</span>
          </button>
        )
      })}
    </div>
  )
}
