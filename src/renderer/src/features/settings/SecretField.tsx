import { Eye, EyeOff } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Input } from '@renderer/components/ui/input'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { unwrapIpcError } from '@renderer/lib/ipc-error'

/**
 * 已存密钥的圆点占位：固定 12 个，纯视觉——不读取 secret、不草稿、不落盘、不进请求。
 * 它只是**掩码态的视觉**；用户点眼睛后必须显示真实 key（用户复验口径）。
 */
const SAVED_KEY_DOTS = '••••••••••••'

/** 没有可回显内容时的明文态提示（不要再用圆点冒充"已显示"） */
const SAVED_KEY_HINT = '输入新密钥以替换已存密钥'

/** 显式回显的本地状态：明文只在 `key` 里，且只在当次展示期间存在 */
interface RevealState {
  phase: 'idle' | 'loading' | 'failed'
  key: string | null
  message?: string
  /** 这一份状态属于哪一次显式点击；迟到的回包只认自己那一次（复位后 requestId 对不上就丢弃） */
  requestId: number
}

const NO_REVEAL: RevealState = { phase: 'idle', key: null, requestId: 0 }

export interface SecretFieldProps {
  /** 真实输入框的 test id */
  testId: string
  /** 眼睛按钮的 test id */
  toggleTestId: string
  /** 与外部 <label htmlFor> 配对（label 不包住按钮，避免点击按钮触发 label 激活） */
  id: string
  value: string
  onValueChange: (value: string) => void
  /** 这一次的明文展示态（父级按"展开 / 保存 / 切 provider / 关闭弹窗"复位） */
  visible: boolean
  onVisibleChange: (visible: boolean) => void
  /** 已有可用密钥、但本次没有输入：掩码态给圆点占位；点眼睛可显式回显真实 key */
  saved: boolean
  /** 已存密钥所属 provider（`saved` 为真时点眼睛才用它调 reveal 通道） */
  providerId?: string
}

/**
 * API Key 输入框 + 显隐眼睛（行内编辑与新增弹窗共用）。
 *
 * 四条硬口径：
 *   1. **本次输入优先**：`value` 只装这次新输入；非空时眼睛只切换 `password` / `text`，
 *      不碰已存密钥。
 *   2. **显式点击才回显**：本次没有输入、但已有可用密钥时，点眼睛才调一次
 *      `settings:reveal-provider-key` 拿真实 key 并显示；再点一次回掩码并立即清掉本地明文。
 *      未配置 / `needsReentry` 不调用、不显示（保持原有状态文案）。
 *   3. **用完即清**：收起、切 provider、保存、取消/关闭弹窗都会把 `visible` 复位；
 *      这里同步清掉本地明文（state 与 DOM 都不留），卸载时实例状态随组件销毁；
 *      在途回包用 `requestId` 对不上就丢弃。
 *   4. **眼睛不抢焦点**：mousedown 先 preventDefault 再把焦点送回输入框——真实浏览器里点按钮
 *      会聚焦按钮；如果不处理，"点眼睛再直接键入"的字符会落在按钮上（输入框一直空白）。
 *      label 也不再包住按钮（按钮不在 label 内，label 只通过 htmlFor 关联输入框）。
 */
export function SecretField({
  testId,
  toggleTestId,
  id,
  value,
  onValueChange,
  visible,
  onVisibleChange,
  saved,
  providerId
}: SecretFieldProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  /** 显式回显的本地明文：只在当次展示期间存在，复位/重新输入立即清空 */
  const [reveal, setReveal] = useState<RevealState>(NO_REVEAL)
  /** 点击序号：只在事件处理器里写；复位后迟到的回包拿它对不上当前状态就丢弃 */
  const requestCounterRef = useRef(0)
  /** 换 input type 前记下的光标位置：浏览器切 password / text 会把光标打回开头 */
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null)
  /** 延迟一次补放光标的定时器（同一时刻只留一个） */
  const selectionTimerRef = useRef<number | null>(null)

  // 类型切换提交后把光标放回点击前的位置（否则"中间点眼睛再键入"会插到开头）。
  // Chromium 会在事件收尾时再把 selection 打回 0，所以布局阶段放一次、下一个宏任务再补一次。
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current
    if (pending === null) return
    pendingSelectionRef.current = null
    const input = inputRef.current
    if (input === null) return
    const expectedValue = input.value
    const restore = (): void => {
      if (inputRef.current !== input || document.activeElement !== input) return
      if (input.value !== expectedValue) return
      const max = input.value.length
      input.setSelectionRange(Math.min(pending.start, max), Math.min(pending.end, max))
    }
    restore()
    if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current)
    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = null
      restore()
    }, 0)
  })

  // 父级把 visible 复位（收起 / 切 provider / 保存 / 关闭弹窗）时立即清掉本地明文；
  // 已存密钥消失（删除 / 进入 needsReentry）或用户重新输入时同样清掉。
  // 用 render 期间的条件 setState（与 ProviderRow 的 reveal 复位同一手法），
  // 保证这一帧起 DOM 里就是新的输入值；在途回包靠 requestId 对不上自然作废。
  if ((!visible || !saved || value !== '') && (reveal.phase !== 'idle' || reveal.key !== null)) {
    setReveal(NO_REVEAL)
  }

  const showSavedPlaceholder = saved && value === ''
  /** 明文态且本次无输入：输入框显示显式拉回来的真实 key（没有就留空） */
  const inputValue = visible && showSavedPlaceholder ? (reveal.key ?? '') : value
  const placeholder = showSavedPlaceholder
    ? visible
      ? reveal.key === null && reveal.phase !== 'loading'
        ? SAVED_KEY_HINT
        : undefined
      : SAVED_KEY_DOTS
    : undefined

  const focusInput = (): void => {
    inputRef.current?.focus()
  }

  /** 眼睛即将切换 type：先记住光标位置，等 DOM 提交后由 layout effect 还原 */
  const captureSelection = (): void => {
    const input = inputRef.current
    if (input === null) return
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    pendingSelectionRef.current = { start, end }
  }

  /** 清掉本地明文：requestId 回到 0，任何在途回包都会对不上而作废 */
  const clearReveal = (): void => {
    setReveal(NO_REVEAL)
  }

  const toggle = async (): Promise<void> => {
    if (visible) {
      captureSelection()
      onVisibleChange(false)
      clearReveal()
      focusInput()
      return
    }

    // 本次已有输入：只切换掩码 / 明文，显示的就是用户刚敲的值
    if (value !== '') {
      captureSelection()
      onVisibleChange(true)
      focusInput()
      return
    }

    // 未配置 / needsReentry（saved=false）/ 不知道 provider：没有可回显的东西，
    // 保持掩码与既有状态文案，不调用 reveal
    if (!saved || providerId === undefined) {
      focusInput()
      return
    }

    // 显式点击：进入明文态并显示轻量加载提示；拿到真实 key 才画出来
    onVisibleChange(true)
    const requestId = ++requestCounterRef.current
    setReveal({ phase: 'loading', key: null, requestId })
    try {
      const api = window.kyclaw?.settings
      if (!api?.revealProviderKey) {
        throw new Error('设置通道不可用（window.kyclaw 缺失），读不到已存密钥')
      }
      const result = await api.revealProviderKey(providerId)
      // 等待期间用户重新输入 / 收起 / 切换 / 保存都会把状态复位（requestId 对不上），
      // 迟到的回包不许再显示。
      setReveal((current) => {
        if (current.requestId !== requestId) return current
        return result.ok
          ? { phase: 'idle', key: result.key, requestId }
          : { phase: 'failed', key: null, message: result.message, requestId }
      })
    } catch (error) {
      setReveal((current) => {
        if (current.requestId !== requestId) return current
        // 人话化；错误里不含密钥（主进程契约保证）
        return { phase: 'failed', key: null, message: unwrapIpcError(error), requestId }
      })
    } finally {
      focusInput()
    }
  }

  let revealStatus: string | undefined
  if (reveal.phase === 'loading') {
    revealStatus = '正在读取已存密钥…'
  } else if (reveal.phase === 'failed') {
    revealStatus = reveal.message ?? '读取已存密钥失败，请重新录入'
  }

  return (
    <span className="block">
      {/* 眼睛按钮相对这一层居中：状态行是它的兄弟，不能把按钮的中心带偏 */}
      <span className="relative block">
        <Input
          ref={inputRef}
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          className={cn(
            'pr-11',
            // 圆点占位要像真的掩码串（用户口径：已有密钥用圆点串表示），不能淡到看不见
            showSavedPlaceholder && !visible && 'placeholder:text-ink'
          )}
          data-testid={testId}
          value={inputValue}
          placeholder={placeholder}
          onChange={(event) => {
            // 用户开始输入新 key：这次回显作废，明文不再留在本地状态里
            if (reveal.phase !== 'idle' || reveal.key !== null) clearReveal()
            onValueChange(event.target.value)
          }}
        />
        <Tooltip label={visible ? '隐藏 API Key' : '显示 API Key'}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={visible ? '隐藏 API Key' : '显示 API Key'}
            aria-pressed={visible}
            aria-controls={id}
            data-testid={toggleTestId}
            className="absolute top-1/2 right-1 z-10 size-8 min-w-0 -translate-y-1/2 px-0"
            icon={visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            onMouseDown={(event) => {
              // 点眼睛时输入框不能失焦：否则用户接着键入的字符会落在按钮上
              event.preventDefault()
              focusInput()
            }}
            onClick={() => {
              void toggle()
              // 键盘激活（Enter / Space）不会走 mousedown：这里再补一次焦点
              focusInput()
            }}
          />
        </Tooltip>
      </span>
      {revealStatus === undefined ? null : (
        <span
          data-testid={`${testId}-reveal-status`}
          role={reveal.phase === 'failed' ? 'alert' : 'status'}
          className={cn(
            'mt-1 block text-c1',
            reveal.phase === 'failed' ? 'text-danger' : 'text-ink-tertiary'
          )}
        >
          {revealStatus}
        </span>
      )}
    </span>
  )
}
