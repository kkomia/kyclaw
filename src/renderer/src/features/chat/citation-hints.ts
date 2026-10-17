/**
 * 本轮的已知来源 allowlist（provenance）通过 context 往下传。
 *
 * 为什么叫 hints：它同时携带 web_search / fetch 工具结果里的 title/snippet，供 hover 卡补全；
 * 但更重要的是**键存在即授权** —— TextPart 只把命中 allowlist 的数字链接渲染成角标。
 *
 * 为什么不把 map 塞进 `TextPartProps` 的 `components`：`a` 组件类型必须是模块级稳定常量，
 * 否则 react-markdown 每帧重建整棵正文（round 73 的分块 memo 会白切）。context 只影响
 * 消费它的角标，不会换掉 markdown 组件身份。
 *
 * 2026-10-18 引用返工补充 `CitationContextsContext`：工具结果没有 title/snippet 时，
 * 用正文里引用所在句子的上下文兜底 hover 卡（由 TextPart 按 markdown 原文算好传下来）。
 */
import { createContext } from 'react'
import { EMPTY_KNOWN_SOURCES, type CitationHint } from './citations'

export const EMPTY_CITATION_HINTS: ReadonlyMap<string, CitationHint> = EMPTY_KNOWN_SOURCES

export const CitationHintsContext =
  createContext<ReadonlyMap<string, CitationHint>>(EMPTY_CITATION_HINTS)

/** citationKey → 正文上下文摘句（仅当工具结果缺 title/snippet 时展示，起兜底作用） */
export const EMPTY_CITATION_CONTEXTS: ReadonlyMap<string, string> = new Map()

export const CitationContextsContext =
  createContext<ReadonlyMap<string, string>>(EMPTY_CITATION_CONTEXTS)

/* ── 引用 hover 的模块级单一管理器（2026-10-18 返工） ───────────────────────
 * 为什么跨组件实例：流式期间 markdown 每帧重渲染，chip 可能卸载重挂；open 状态放组件内会丢。
 * key = citationKey，anchor 是当前角标 DOM；同一时刻全局只有 key 对应的一张卡。
 * 关闭走 140ms 宽限（120–160ms 口径 + 卡片外层 8px 安全区），重挂载的 updateAnchor 会取消它。
 */
export interface CitationHoverState {
  key: string | null
  anchor: HTMLElement | null
}

/** 关闭宽限（指针从角标移向卡片 / chip 重挂载的窗口期） */
export const CITATION_CLOSE_GRACE_MS = 140

let hoverState: CitationHoverState = { key: null, anchor: null }
const hoverListeners = new Set<() => void>()
let hideTimer: ReturnType<typeof setTimeout> | null = null
let openTimer: ReturnType<typeof setTimeout> | null = null

function emitHover(): void {
  for (const listener of hoverListeners) listener()
}

function clearHideTimer(): void {
  if (hideTimer === null) return
  clearTimeout(hideTimer)
  hideTimer = null
}

function clearOpenTimer(): void {
  if (openTimer === null) return
  clearTimeout(openTimer)
  openTimer = null
}

export const citationHoverManager = {
  subscribe(listener: () => void): () => void {
    hoverListeners.add(listener)
    return () => {
      hoverListeners.delete(listener)
    }
  },
  getSnapshot(): CitationHoverState {
    return hoverState
  },
  /** 打开/更新锚点；delayMs > 0 时延迟打开（hover），0 = 立即（focus / 重挂载恢复） */
  show(key: string, anchor: HTMLElement, delayMs = 0): void {
    clearHideTimer()
    clearOpenTimer()
    if (delayMs > 0) {
      openTimer = setTimeout(() => {
        openTimer = null
        citationHoverManager.show(key, anchor)
      }, delayMs)
      return
    }
    if (hoverState.key === key && hoverState.anchor === anchor) return
    hoverState = { key, anchor }
    emitHover()
  },
  /** 重挂载后把 anchor 换到新节点（同 key 保持 open；宽限内抵消 unmount 的关闭） */
  updateAnchor(key: string, anchor: HTMLAnchorElement | null): void {
    if (anchor === null || hoverState.key !== key) return
    clearHideTimer()
    if (hoverState.anchor === anchor) return
    hoverState = { key, anchor }
    emitHover()
  },
  /** 关闭宽限：期间 show/updateAnchor 会取消 */
  scheduleHide(key?: string): void {
    clearHideTimer()
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (key === undefined || hoverState.key === key) citationHoverManager.hideNow()
    }, CITATION_CLOSE_GRACE_MS)
  },
  cancelHide(): void {
    clearHideTimer()
  },
  hideNow(): void {
    clearHideTimer()
    clearOpenTimer()
    if (hoverState.key === null) return
    hoverState = { key: null, anchor: null }
    emitHover()
  },
  /** 测试隔离用 */
  reset(): void {
    clearHideTimer()
    clearOpenTimer()
    hoverListeners.clear()
    hoverState = { key: null, anchor: null }
  }
}
