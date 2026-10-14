/**
 * 文件指纹的口径**只有这一处**：内容 sha256 十六进制（大小声明的 size 由调用方另存）。
 *
 * 谁在用：会话↔PPT 源结构（session-ppt-sources.ts，round 76）与会话↔Word 源结构
 * （session-docx-sources.ts）的"落盘那一刻的指纹"——编辑前比对它，对不上就说明盘上那份
 * 已经不是我们渲染的那一份（用户手改/删过），绝不静默覆盖。
 *
 * 抽成独立模块的理由：两个源结构 store 是**平级**的（谁也不该 import 谁），
 * 而指纹算法必须**只有一份实现**（两处各写一遍迟早会在"大小写/编码"上漂）。
 * `session-ppt-sources.ts` 仍照旧导出 `sha256Of`（既有调用方与 spec 的 import 路径不变）。
 */
import { createHash } from 'node:crypto'

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
