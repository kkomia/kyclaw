/**
 * 思考块的翻译状态（round 32）：把"这段思考要不要翻、翻没翻好、现在显示哪一份"收在一个 hook 里，
 * ReasoningPart 只负责画。设置从 useSettingsStore 现读（**改完当场生效**，不用重启）。
 *
 * 三种时机：
 *   - **全量翻译**（mode: full）：这一段写完（streaming 变 false）后自动翻一次；进行中显示原文；
 *     翻好后默认显示译文，用户可切回原文；
 *   - **翻译按钮**（mode: button）：显示原文 + 一个「翻译」，点了才翻（翻了之后可来回切）；
 *   - **语言一致**（needsTranslation 为假）：什么都不做，控件也不出现 —— 中文思考不该被再翻一遍。
 *
 * 语言判定只在**这一段写完**之后做：流式期间每来一个字就扫一遍全文是白花的（那时既不显示控件、
 * 也不会发请求），而且判定结果在写完之前本来就没有意义。
 *
 * 翻译结果从外部状态表（lib/reasoning-translate）现读（useSyncExternalStore）——
 * 同一段文本在多处出现时共享一份结果，也不会因为组件重挂而重翻。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  requestTranslation,
  subscribeTranslations,
  translationKeyOf,
  translationStateOf
} from '@renderer/lib/reasoning-translate'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { effectiveReasoningTranslate, type ReasoningTranslateMode } from '@shared/settings'
import { needsTranslation } from '@shared/translate'

export interface ReasoningTranslation {
  /** 要不要显示翻译相关的控件（开关开着 + 目标语言判出来不一致 + 这一段已经写完） */
  needed: boolean
  mode: ReasoningTranslateMode
  /** 当前显示的是译文（false = 原文） */
  showing: boolean
  /** 已翻好的译文（null = 还没有） */
  translated: string | null
  /** 正在翻 */
  pending: boolean
  /** 最近一次失败的人话原因（有它就能重试） */
  error: string | null
  /** 立刻翻（按钮模式的「翻译」、失败后的「重试」） */
  request: () => void
  showOriginal: () => void
  showTranslated: () => void
}

export interface ReasoningTranslationInput {
  text: string
  /** 这一段自己正在被写（写完才做语言判定与自动翻译） */
  streaming: boolean
}

export function useReasoningTranslation({
  text,
  streaming
}: ReasoningTranslationInput): ReasoningTranslation {
  const settings = useSettingsStore((state) => state.settings.reasoningTranslate)
  const target = useMemo(() => effectiveReasoningTranslate(settings).targetLanguage, [settings])

  const needed = settings.enabled && !streaming && needsTranslation(text, target)
  const key = needed ? translationKeyOf(text, target) : ''

  const getState = useCallback(
    () => (needed ? translationStateOf(text, target) : undefined),
    [needed, text, target]
  )
  const state = useSyncExternalStore(subscribeTranslations, getState)

  // 用户切回原文的偏好只对"这一段"有效：文本/目标语言/开关一变就复位
  // （渲染期间按 props 调整 state 的写法，同 TraceFold —— 不走 effect 就没有级联渲染）
  const [viewKey, setViewKey] = useState(key)
  const [showOriginal, setShowOriginal] = useState(false)
  if (viewKey !== key) {
    setViewKey(key)
    setShowOriginal(false)
  }

  const translated = needed && state?.status === 'done' ? state.text : null
  const pending = needed && state?.status === 'pending'
  const error = needed && state?.status === 'error' ? state.message : null

  const request = useCallback((): void => {
    if (!needed) return
    requestTranslation(text, target)
  }, [needed, target, text])

  // 全量模式：这一段写完就自动翻（进行中显示原文 —— 逐字翻译不现实，见报告）。
  // 已经有记录（翻好 / 在翻 / 上次失败）就不再自动重来：失败要用户点「重试」。
  useEffect(() => {
    if (!needed || settings.mode !== 'full') return
    if (state !== undefined) return
    request()
  }, [needed, settings.mode, state, request])

  const showOriginalText = useCallback((): void => setShowOriginal(true), [])
  const showTranslatedText = useCallback((): void => setShowOriginal(false), [])

  return {
    needed,
    mode: settings.mode,
    showing: translated !== null && !showOriginal,
    translated,
    pending,
    error,
    request,
    showOriginal: showOriginalText,
    showTranslated: showTranslatedText
  }
}
