import { describe, expect, it } from 'vitest'
import {
  CUSTOM_MODEL_ID,
  LOCAL_EMBEDDING_MODELS,
  LOCAL_MODEL_SOURCES,
  downloadPlanOf,
  emptyOverview,
  formatBytes,
  localModelById,
  localModelsOverviewSchema
} from '../local-models'

/**
 * 模块 3B：本地模型清单的"事实层"测试。
 *
 * 清单里每个数字都是**拉各源 API 实测**得来的（2026-10-11），所以这里钉的是
 * "清单本身自洽"：哈希是 64 位十六进制、URL 是 https、**备选来源与首选必须同一份哈希**
 * （同一尺寸但内容不同的照抄进来会装上一个对不上号的文件——Qwen3-Embedding 的第三方镜像
 * 就与官方仓库不同哈希），以及体积/维度的口径统一。
 */
describe('本地模型清单', () => {
  it('每个档位：id 唯一、体积为正、维度为正、哈希是 64 位十六进制、URL 是 https', () => {
    const ids = new Set<string>()
    for (const model of LOCAL_EMBEDDING_MODELS) {
      expect(ids.has(model.id)).toBe(false)
      ids.add(model.id)
      expect(model.name.length).toBeGreaterThan(0)
      expect(model.file.bytes).toBeGreaterThan(0)
      expect(model.dim).toBeGreaterThan(0)
      expect(model.file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(model.file.urls.length).toBeGreaterThan(0)
      for (const url of model.file.urls) expect(url).toMatch(/^https:\/\//)
      expect(LOCAL_MODEL_SOURCES).toContain(model.file.source)
    }
  })

  it('Qwen3-Embedding 只有 Q8_0 与 f16 两档（610MB / 1142MB），没有 Q4/Q5', () => {
    const qwen = LOCAL_EMBEDDING_MODELS.filter((model) => model.id.startsWith('qwen3-embedding'))
    expect(qwen.map((model) => model.file.bytes).sort((left, right) => left - right)).toEqual([
      639150592, 1197629632
    ])
    expect(qwen.every((model) => !/q[45]/i.test(model.file.file))).toBe(true)
  })

  it('备选来源与首选是同一份内容（同 sha256）——否则宁可不写', () => {
    for (const model of LOCAL_EMBEDDING_MODELS) {
      const plan = downloadPlanOf(model)
      expect(plan.length).toBeGreaterThanOrEqual(1)
      for (const file of plan) expect(file.sha256).toBe(model.file.sha256)
      for (const file of plan) expect(file.bytes).toBe(model.file.bytes)
    }
  })

  it('下载路线：首选来源排在前面，备选来源不重复', () => {
    for (const model of LOCAL_EMBEDDING_MODELS) {
      const plan = downloadPlanOf(model)
      expect(plan[0]?.source).toBe(model.file.source)
      const sources = new Set(plan.map((file) => file.source))
      expect(sources.size).toBe(plan.length)
    }
  })

  it('localModelById / CUSTOM_MODEL_ID / formatBytes 的取值口径', () => {
    expect(localModelById('bge-small-zh-v1.5-q8')?.dim).toBe(512)
    expect(localModelById('没有这个')).toBeNull()
    expect(CUSTOM_MODEL_ID).toBe('custom')
    expect(formatBytes(639150592)).toBe('610 MB')
    expect(formatBytes(1197629632)).toBe('1142 MB')
    expect(formatBytes(26472640)).toBe('25.2 MB')
  })

  it('空总览也是一份合法回包（preload / 界面初值都吃它）', () => {
    const overview = emptyOverview('C:\\userData\\models')
    expect(localModelsOverviewSchema.safeParse(overview).success).toBe(true)
    expect(overview.items).toHaveLength(LOCAL_EMBEDDING_MODELS.length)
    expect(overview.download).toBeNull()
    expect(overview.engine).toEqual({ phase: 'stopped', modelId: null, detail: null })
  })
})
