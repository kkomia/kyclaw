/**
 * PB-022：0.2.0 下架的八条宿主 API 统一返回 501。
 *
 * mount 仍在，旧实现文件仍在（PB-020 再删）；这里只替换挂载的 handler，保证 renderer
 * 能拿到稳定的 `feature-disabled` 形状并显示「0.2.0 暂不可用（0.2.x 恢复）」。
 */
import { Hono } from 'hono'

export type DisabledFeature =
  'tasks' | 'goal' | 'projects' | 'ppt' | 'mcp' | 'memory' | 'usage' | 'trajectory'

export function createFeatureDisabledRouter(feature: DisabledFeature): Hono {
  const app = new Hono()
  app.all('*', (context) =>
    context.json(
      {
        error: 'feature-disabled',
        feature,
        availableIn: '0.2.x'
      },
      501
    )
  )
  return app
}
