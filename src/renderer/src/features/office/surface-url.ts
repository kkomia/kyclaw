/**
 * Office 隔离面的 URL 决策（M3-S1）——纯函数，单测直接打。
 *
 * 三态的约定见 `.superpowers/handover/office-docx-plan.md` §3.5：
 *   · dev（主窗口是 Vite 的 http 页面，`ELECTRON_RENDERER_URL`）：
 *     iframe 直接加载 Vite 出的 `/office.html`，**同源，隔离不成立**，只影响开发期；
 *   · preview / 打包（主窗口是 `file://`）：
 *     iframe 加载 `kyclaw-office://surface/`，与父页跨源，协议 handler 由主进程提供；
 *   · 其它协议（理论兜底）同样走自定义协议。
 *
 * 不新增 preload/IPC：surface URL 完全由渲染端自己算（主进程只负责把资源供出来）。
 */
import { OFFICE_DEV_SURFACE_PATH, OFFICE_SURFACE_ORIGIN } from '@shared/office-editor'

/** 与 `src/main/office-protocol.ts` 的 OFFICE_SCHEME 一致（跨进程不能共享常量，靠单测钉） */
export const OFFICE_SURFACE_SCHEME = 'kyclaw-office'

/** 面的 origin（`kyclaw-office://surface`）；与主进程 `office:config` 共用 shared 常量 */
export { OFFICE_SURFACE_ORIGIN } from '@shared/office-editor'

/** dev 下 Vite 出的第二个 HTML 入口（与 electron.vite.config.ts 的 input.office 一致） */
const DEV_SURFACE_PATH = OFFICE_DEV_SURFACE_PATH

/** 只依赖 `protocol` / `origin` 两个字段，便于单测传假 Location */
export type SurfaceLocation = Pick<Location, 'protocol' | 'origin'>

/**
 * 纯函数：给定主窗口的 location，返回 iframe 应加载的 surface URL。
 *
 * - `file:`（preview / 打包）→ `kyclaw-office://surface/`（根路径由协议映射到 office.html）；
 * - http(s)（dev）→ `<origin>/office.html`（同源，方便 HMR；隔离只在 preview/packaged 成立）；
 * - 其它 → 自定义协议（兜底，不猜别的开发形态）。
 */
export function resolveSurfaceUrl(location: SurfaceLocation): string {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return new URL(DEV_SURFACE_PATH, location.origin).href
  }
  return `${OFFICE_SURFACE_ORIGIN}/`
}

/** 壳组件用的现算入口（读当前窗口的 location） */
export function currentSurfaceUrl(): string {
  return resolveSurfaceUrl(window.location)
}
