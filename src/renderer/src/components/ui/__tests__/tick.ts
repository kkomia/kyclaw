import { act } from '@testing-library/react'

/**
 * Radix 的几个动作（条目之间的方向键移动、关闭后把焦点还给触发元素）落在下一个宏任务里。
 * jsdom 里没有真实的帧回调，需要显式让事件循环转一圈再断言。已用探针确认：
 * 立即断言只能看到旧状态，tick 之后才是最终状态。
 */
export async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
