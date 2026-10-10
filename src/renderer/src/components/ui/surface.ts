/**
 * "菜单类弹层"的表面配方（spec §6.3 的一条）：底 Bg-Tertiary、圆角 ≈20、玻璃 blur(15px) 裸写法；
 * 阴影取 §5.4 的弹层特征值 0 4px 16.4px（配 §2.12 的阴影基色，深色档自动加重）。
 * Menu 与 Popover 共用一份，免得两处各写一遍慢慢漂移。
 */
export const OVERLAY_SURFACE_CLASS =
  'z-50 rounded-overlay bg-menu shadow-(--shadow-overlay) backdrop-blur-(--blur-glass)'
