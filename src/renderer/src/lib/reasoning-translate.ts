/**
 * 思考翻译的渲染端状态表 + 队列（round 32）。
 *
 * 状态表 **就是缓存**：键 = `目标语言\n原文`（刻意不用 hash —— 这里要的是零碰撞，命中错了比多占几十字节内存糟得多；
 * 原文本来就在各自的思考段里活着）。一段文本一篇记录：pending / done（带译文）/ error（带一句人话）。
 * 生命周期 = **只活在本次运行的内存里**：跨会话复用，应用重启后重翻（v1 口径，见报告）。
 * 失败**不进 done**（服务没开、模型不在是暂时的，用户点重试就该真再打一次）。
 *
 * 这是一个**外部状态**（module 级 Map + 订阅），组件用 useSyncExternalStore 读它 ——
 * 翻译是异步的、又有跨组件共享（同一段文本两处引用只该翻一次），放进 React state 反而更容易打出
 * 重复请求与"setState 进 effect"的坏味道。
 *
 * 队列：一次会话里可能同时挂出十几段思考（打开旧会话 = 所有历史思考段都要翻），直接并发打过去会把
 * 局域网那台小机器排满。这里限 2 并发、FIFO 排队，翻完一段放一个走。
 */
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { TRANSLATE_MAX_CHARS } from '@shared/translate'

/** 一段文本的翻译状态 */
export type TranslationState =
  { status: 'pending' } | { status: 'done'; text: string } | { status: 'error'; message: string }

/** 同时最多几个在途请求（小机器；FIFO 排队，超出的等前一个放行） */
const MAX_CONCURRENT = 2

let active = 0
const waiting: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      active += 1
      resolve()
    })
  })
}

function release(): void {
  active -= 1
  const next = waiting.shift()
  if (next) next()
}

const states = new Map<string, TranslationState>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(key: string, next: TranslationState): void {
  states.set(key, next)
  emit()
}

/** 缓存/状态键：目标语言 + 原文（同一个原文翻成不同语言是两条） */
export function translationKeyOf(text: string, targetLanguage: string): string {
  return `${targetLanguage}\n${text}`
}

/** 这一段现在的翻译状态（没有 = 还没翻过）；组件现读它决定显示什么 */
export function translationStateOf(
  text: string,
  targetLanguage: string
): TranslationState | undefined {
  return states.get(translationKeyOf(text, targetLanguage))
}

/** 订阅状态变化（useSyncExternalStore 用）；返回退订函数 */
export function subscribeTranslations(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 请一段文本的翻译：已经在翻 / 已经翻好就不重复打服务（同一段文本多处引用共享同一条记录）；
 * 上次失败（error）允许再来一次 —— 那就是「重试」。入口是同步的（状态立刻变 pending），
 * 结果落在状态表里，组件从订阅里看到。
 */
export function requestTranslation(text: string, targetLanguage: string): void {
  const key = translationKeyOf(text, targetLanguage)
  const current = states.get(key)
  if (current !== undefined && current.status !== 'error') return
  setState(key, { status: 'pending' })
  void run(key, text, targetLanguage)
}

async function run(key: string, text: string, targetLanguage: string): Promise<void> {
  const api = window.kyclaw?.translate
  if (!api) {
    setState(key, {
      status: 'error',
      message: '翻译通道不可用（window.kyclaw 缺失），这段没有翻译'
    })
    return
  }
  if (text.length > TRANSLATE_MAX_CHARS) {
    setState(key, {
      status: 'error',
      message: `这段思考太长（超过 ${TRANSLATE_MAX_CHARS} 字），没有翻译`
    })
    return
  }

  await acquire()
  try {
    const result = await api.run({ text, targetLanguage })
    setState(
      key,
      result.ok
        ? { status: 'done', text: result.text }
        : { status: 'error', message: result.message }
    )
  } catch (error) {
    setState(key, { status: 'error', message: unwrapIpcError(error) })
  } finally {
    release()
  }
}

/** 只给测试用：清掉状态表与在途计数（模块级单例，用例之间要干净；订阅关系不动） */
export function resetReasoningTranslateCache(): void {
  states.clear()
  active = 0
  waiting.length = 0
}
