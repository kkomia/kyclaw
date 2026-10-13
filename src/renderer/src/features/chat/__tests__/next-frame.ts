import { act } from '@testing-library/react'

/**
 * 让出一帧（round 73）。
 *
 * 流式正文按帧上屏：delta 到达后内容不再"同一拍就落屏"，而是在**下一个动画帧**合流上屏
 * （见 features/chat/parts/TextPart.tsx 的 useCadencedText）。所以推完增量、要断言屏幕上
 * 有内容时，先让出一帧 —— 这是行为契约，不是"等一会儿碰运气"。
 *
 * 非流式（`streaming=false`）或流刚结束的那一拍**不需要**它：那时内容与 props 同步渲染。
 */
export async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null))
    })
  })
}
