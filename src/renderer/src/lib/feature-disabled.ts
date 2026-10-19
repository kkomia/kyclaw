/**
 * PB-022：0.2.0 下架的宿主 API 统一回 501 feature-disabled。
 * renderer 统一显示这一句，不把 `feature-disabled` 这种内部 code 直接给用户看。
 */
export const FEATURE_DISABLED_MESSAGE = '0.2.0 暂不可用（0.2.x 恢复）'

export function isFeatureDisabled(response: Response): boolean {
  return response.status === 501
}

export function featureDisabledError(): Error {
  return new Error(FEATURE_DISABLED_MESSAGE)
}
