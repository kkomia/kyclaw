import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// RTL 的自动清理只在全局注入 afterEach 时才挂上（本项目的 vitest 没开 globals），
// 这里显式接上：不接的话同文件里第二次 render 会留下上一棵 DOM。
afterEach(() => {
  cleanup()
})

/**
 * 测试环境的已知噪声过滤（**只压两条固定前缀**，其余 console.error 原样透出）。
 *
 * jsdom 里没有主进程：渲染壳时"会话列表"必然拉不到（IPC 桥缺 agent 字段 / 没有服务端）。
 * 失败路径按产品口径会 `console.error` 留底（生产排障落点，见 sessions-store.ts），
 * 于是一批与错误无关的用例也会打这几行。这里按前缀压掉，保证测试输出干净；
 * 需要断言日志本身的用例（sessions-store.spec）仍用 vi.spyOn 自己接管。
 */
const NOISE_PREFIXES = ['[kyclaw] 会话列表加载失败', '[kyclaw] 刷新会话列表失败']
const realError = console.error.bind(console)
console.error = (...args: unknown[]): void => {
  const first = typeof args[0] === 'string' ? args[0] : ''
  if (NOISE_PREFIXES.some((prefix) => first.startsWith(prefix))) return
  realError(...args)
}
