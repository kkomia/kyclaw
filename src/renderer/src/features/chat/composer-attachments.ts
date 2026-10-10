/**
 * composer 附件与引用的**最小可用**口径（round 7）。
 *
 * 为什么是"文本内联"而不是协议里的 file part：实测过 AI SDK 的 `file` part 走真服务——
 * 服务端接受（HTTP 200、不报错），但当前 provider（openai-compatible）**看不到内容**
 * （问它附件里的暗号，它回"看不到"；见 smoke-ui-r2/_r7_attach_probe.py 的原始记录）。
 * 与其做一个"上传成功但模型瞎"的假链路，不如把文本内容随消息文本发出去（任何模型都能读到），
 * 非文本/过大就明确拒收（不假装附加成功）。二进制文件的服务端协议留后续。
 */
export interface PendingAttachment {
  id: string
  name: string
  size: number
  /** 已读出的文本内容（发送时内联进消息） */
  text: string
}

export interface PendingReference {
  id: string
  kind: '技能' | '插件' | '上下文'
  label: string
}

/** 附件大小上限（保守档）：文本内容会内联进消息与气泡，避免一条消息膨胀成几 MB */
export const ATTACHMENT_MAX_BYTES = 16 * 1024

/** 认不出的 MIME（空 type）时按扩展名兜底的白名单 */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'csv',
  'tsv',
  'log',
  'ini',
  'conf',
  'env',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'swift',
  'css',
  'scss',
  'html',
  'htm',
  'xml',
  'vue',
  'svelte',
  'sh',
  'bash',
  'zsh',
  'bat',
  'ps1',
  'sql',
  'graphql'
])

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 能不能收（不能收给出简短原因，调用方原样展示）：只收文本类、且不超过上限 */
export function attachmentProblem(file: File): string | null {
  if (file.size > ATTACHMENT_MAX_BYTES) return `超过 ${ATTACHMENT_MAX_BYTES / 1024}KB`
  const type = file.type
  const name = file.name.toLowerCase()
  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot + 1)
  const textish =
    type.startsWith('text/') ||
    /(json|xml|yaml|javascript)/.test(type) ||
    TEXT_EXTENSIONS.has(extension)
  if (!textish) return '不是文本文件'
  return null
}

export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsText(file)
  })
}

/**
 * 围栏长度（T16 小修批）：内容里最长的一段连续反引号 + 1，下限 3。
 * 固定三反引号的围栏会被内容自带的 ``` 提前收尾——后面的原文就漏成正文了。
 */
function fenceFor(text: string): string {
  let longest = 0
  let run = 0
  for (const char of text) {
    run = char === '`' ? run + 1 : 0
    if (run > longest) longest = run
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/** 发送时的组装：正文 → 【引用】行 → 附件块（附件内容包在围栏里，模型按原文读） */
export function composeOutgoingText(input: {
  text: string
  references: readonly PendingReference[]
  attachments: readonly PendingAttachment[]
}): string {
  const { text, references, attachments } = input
  const blocks: string[] = []
  const trimmed = text.trim()
  if (trimmed !== '') blocks.push(trimmed)
  if (references.length > 0) {
    blocks.push(`【引用】${references.map((item) => `${item.kind}：${item.label}`).join('；')}`)
  }
  for (const attachment of attachments) {
    const content = attachment.text.replace(/\n+$/, '')
    const fence = fenceFor(content)
    blocks.push(`【附件】${attachment.name}\n${fence}\n${content}\n${fence}`)
  }
  return blocks.join('\n\n')
}
