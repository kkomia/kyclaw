/**
 * 「本地模型」API 客户端（渲染端，模块 3B）：薄薄一层，把 `window.kyclaw.localModels` 包成
 * 好用的函数（与其它 ipc 客户端一致：结构校验在 preload 做完了，这里只负责调与订阅）。
 */
import type { LocalModelsOverview } from '@shared/local-models'

function api(): NonNullable<Window['kyclaw']>['localModels'] {
  const localModels = window.kyclaw?.localModels
  if (!localModels) throw new Error('本地模型通道不可用（window.kyclaw 缺失）')
  return localModels
}

export function fetchLocalModels(): Promise<LocalModelsOverview> {
  return api().overview()
}

export function downloadLocalModel(id: string): Promise<LocalModelsOverview> {
  return api().download(id)
}

export function cancelLocalModelDownload(): Promise<LocalModelsOverview> {
  return api().cancel()
}

export function selectLocalModel(id: string): Promise<LocalModelsOverview> {
  return api().select(id)
}

/** 打开原生选择器挑一个本机 GGUF 并设为生效（取消 = 不改动，也回总览） */
export function pickCustomLocalModel(): Promise<LocalModelsOverview> {
  return api().pickCustom()
}

export function removeLocalModel(id: string): Promise<LocalModelsOverview> {
  return api().remove(id)
}

/** 订阅总览变化（下载进度、引擎相位）；返回退订函数 */
export function onLocalModelsChanged(
  listener: (overview: LocalModelsOverview) => void
): () => void {
  return api().onChanged(listener)
}
