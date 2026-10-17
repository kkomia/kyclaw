/**
 * 过程块（round 6 → task-52 收进「本轮过程」统一容器）。
 *
 * 旧实现是「一行摘要 + 普通高度内容」；task-52 起改成**固定上限高度的内部滚动容器**
 * （实现见 `TurnProcess.tsx`：头部摘要「执行 N 次思考 · 调用 M 次工具」+ 状态 + 用时、
 * 正文 `--turn-process-max-height` 内滚、流式自动跟随、完成后自动收起）。
 *
 * 这里保留同名 re-export，仅为「过程块」这个概念的旧引用点/测试契约不破；新代码请直接用
 * `TurnProcess`。
 */
export {
  TurnProcess as TraceBlock,
  type TurnProcessEntry as TraceBlockEntry,
  type TurnProcessProps as TraceBlockProps
} from './TurnProcess'
