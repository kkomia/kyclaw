/**
 * 本轮的已知来源 allowlist（provenance）通过 context 往下传。
 *
 * 为什么叫 hints：它同时携带 web_search / fetch 工具结果里的 title/snippet，供 hover 卡补全；
 * 但更重要的是**键存在即授权** —— TextPart 只把命中 allowlist 的数字链接渲染成角标。
 *
 * 为什么不把 map 塞进 `TextPartProps` 的 `components`：`a` 组件类型必须是模块级稳定常量，
 * 否则 react-markdown 每帧重建整棵正文（round 73 的分块 memo 会白切）。context 只影响
 * 消费它的角标，不会换掉 markdown 组件身份。
 */
import { createContext } from 'react'
import { EMPTY_KNOWN_SOURCES, type CitationHint } from './citations'

export const EMPTY_CITATION_HINTS: ReadonlyMap<string, CitationHint> = EMPTY_KNOWN_SOURCES

export const CitationHintsContext =
  createContext<ReadonlyMap<string, CitationHint>>(EMPTY_CITATION_HINTS)
