import type { KyclawApi } from '../shared/ipc'

declare global {
  interface Window {
    /** preload 白名单（src/preload/index.ts 暴露；契约在 src/shared/ipc.ts） */
    kyclaw: KyclawApi
  }
}

export {}
