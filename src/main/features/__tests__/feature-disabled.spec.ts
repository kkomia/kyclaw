// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createFeatureDisabledRouter, type DisabledFeature } from '../feature-disabled'

const FEATURES: DisabledFeature[] = [
  'tasks',
  'goal',
  'projects',
  'ppt',
  'mcp',
  'memory',
  'usage',
  'trajectory'
]

describe('PB-022 feature-disabled 501', () => {
  for (const feature of FEATURES) {
    it(`${feature} 的任意方法/路径都回统一 501 形状`, async () => {
      const app = createFeatureDisabledRouter(feature)
      const get = await app.request('/anything')
      expect(get.status).toBe(501)
      await expect(get.json()).resolves.toEqual({
        error: 'feature-disabled',
        feature,
        availableIn: '0.2.x'
      })

      const post = await app.request('/anything', { method: 'POST', body: '{}' })
      expect(post.status).toBe(501)
    })
  }
})
