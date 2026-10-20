/**
 * PB-022：0.2.0 下架的宿主 API 统一回 501 feature-disabled。
 * renderer 统一显示这一句，不把 `feature-disabled` 这种内部 code 直接给用户看。
 */
export const FEATURE_DISABLED_MESSAGE = '0.2.0 暂不可用（0.2.x 恢复）'

export function isFeatureDisabled(response: Response): boolean {
  return response.status === 501
}

/**
 * 0.2.1（PB-053）：`feature-disabled` 是一个**可识别的状态**，不是普通失败。
 *
 * 为什么要有这个类：0.2.0 把 8 条宿主 API 下架成 501 之后，渲染端有几处仍把它们当
 * "加载失败"（红字 + 重试）。对**本版主动下架**的能力，正确的 UI 是"这个功能本版没有"，
 * 而不是"加载出错了、再试一次"——重试永远不会成功。消费者（如 projects-store）用
 * `isFeatureDisabledError` 分支处理，不靠比对文案。
 */
export class FeatureDisabledError extends Error {
  /** 下架的能力名（服务端回包里的 `feature`；拿不到就是 undefined） */
  readonly feature?: string

  constructor(feature?: string) {
    super(FEATURE_DISABLED_MESSAGE)
    this.name = 'FeatureDisabledError'
    this.feature = feature
  }
}

export function isFeatureDisabledError(error: unknown): error is FeatureDisabledError {
  return error instanceof FeatureDisabledError
}

export function featureDisabledError(feature?: string): FeatureDisabledError {
  return new FeatureDisabledError(feature)
}
