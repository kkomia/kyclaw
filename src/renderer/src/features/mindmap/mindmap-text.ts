/**
 * PB-024 导图模块：Mermaid mindmap 文本的默认模板与本地持久化。
 *
 * 最小可用形态：左文本、右 Pele 渲染。存储只做单文档（`kyclaw:mindmap:v1`），
 * 页面级 debounce 自动保存；纯函数便于单测（不依赖 React）。
 */

export const MINDMAP_STORAGE_KEY = 'kyclaw:mindmap:v1'

export const DEFAULT_MINDMAP_TEXT = `mindmap
  root((kyclaw))
    对话
      会话
      轨迹
    Office
      docx
      xlsx
      pptx
    笔记与知识库
      笔记
      知识库`

export const NEW_MINDMAP_TEXT = `mindmap
  root((新导图))
    分支一
    分支二`

/** 读本地单文档；不可用/空→默认示例（保证页面非空态） */
export function loadMindmapText(): string {
  try {
    const saved = window.localStorage.getItem(MINDMAP_STORAGE_KEY)
    if (saved !== null && saved.trim() !== '') return saved
  } catch {
    // 存储不可用：退回示例
  }
  return DEFAULT_MINDMAP_TEXT
}

export function saveMindmapText(text: string): void {
  try {
    window.localStorage.setItem(MINDMAP_STORAGE_KEY, text)
  } catch {
    // 存储不可用：静默降级（编辑与渲染不受影响）
  }
}

/** 字符数（状态栏只报事实，不估算节点数） */
export function charCountOf(text: string): number {
  return Array.from(text).length
}
