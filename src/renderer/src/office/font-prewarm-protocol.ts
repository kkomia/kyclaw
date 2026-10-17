/**
 * 面 → 壳的「字体已就绪」通知（task-76 字体启动预注册）。
 *
 * 为什么单独一个文件：`office/**` 是隔离面代码，`features/office/**` 是壳侧；两边都要认这条消息，
 * 但不该把壳侧依赖带进面 bundle，也不该把面侧依赖带进壳。所以协议形状放这里（renderer 内部，
 * 不走 `src/shared/**` 的 main↔renderer IPC 契约，不新增 preload/IPC）。
 *
 * 字段口径：
 *   - `prewarm`：这条消息是否来自启动期的 hidden 预热面（壳据此释放预热 iframe）；
 *   - `stats`：与 `SurfaceFontStats` 同形（22 面 / 46 注册 / 27MB / 毫秒）；
 *   - `elapsedMs`：面从加载到字体就绪的墙钟时间（面自己 `performance.now()` 起点）。
 */
export interface SurfaceFontsReadyStats {
  faces: number
  registrations: number
  fetchedBytes: number
  fontSetSize: number
  ms: number
  cjk: boolean
}

export interface SurfaceFontsReadyMessage {
  type: 'surface:fonts-ready'
  prewarm: boolean
  elapsedMs: number
  stats: SurfaceFontsReadyStats
}

/** 运行时守卫（父页 message 监听里用；也方便单测钉形状） */
export function isSurfaceFontsReady(value: unknown): value is SurfaceFontsReadyMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (message.type !== 'surface:fonts-ready' || typeof message.prewarm !== 'boolean') return false
  if (typeof message.elapsedMs !== 'number') return false
  const stats = message.stats
  if (typeof stats !== 'object' || stats === null) return false
  const record = stats as Record<string, unknown>
  return (
    typeof record.faces === 'number' &&
    typeof record.registrations === 'number' &&
    typeof record.fetchedBytes === 'number' &&
    typeof record.ms === 'number'
  )
}
