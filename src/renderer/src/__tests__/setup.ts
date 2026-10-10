import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// RTL 的自动清理只在全局注入 afterEach 时才挂上（本项目的 vitest 没开 globals），
// 这里显式接上：不接的话同文件里第二次 render 会留下上一棵 DOM。
afterEach(() => {
  cleanup()
})
