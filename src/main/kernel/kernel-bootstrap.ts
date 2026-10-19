/**
 * B3.1a：main 侧入口（flag 开才实例化真内核）。
 *
 * 现状：**没有接到 chat 路由**——那需要改现有 `src/main/agent/service.ts`，超出本批边界
 * （Lead 要求"要动现有代码才能接通的话先报我"）。C 阶段接线时调用本函数即可：
 *   const adapter = await maybeStartKernelAdapter({...})
 *   if (adapter !== null) … // renderer 仍走现有本地 HTTP/SSE，帧由 adapter 产生
 */
import { isKernelPortEnabled } from './feature-flag'
import { startKernelAdapter, type KernelAdapter, type KernelAdapterOptions } from './kernel-adapter'

export interface KernelBootstrapOptions extends KernelAdapterOptions {
  env?: Readonly<Record<string, string | undefined>>
}

/** flag 关：返回 null（不 spawn、不连网、行为与现在完全一致）；flag 开：起真内核 */
export async function maybeStartKernelAdapter(
  options: KernelBootstrapOptions
): Promise<KernelAdapter | null> {
  const env = options.env ?? process.env
  if (!isKernelPortEnabled(env)) return null
  const { env: _ignored, ...adapterOptions } = options
  void _ignored
  return startKernelAdapter(adapterOptions)
}
