// @vitest-environment node
/**
 * 本部署事实的来源（round 68，main 侧）：`skillRuntimeFactsFor` 把"这台机器现在有什么"算成
 * `use_skill` 加载技能时拼在全文末尾的那两个字段。
 *
 * 钉住的五件事：
 *   ① 渲染器走 **render-ppt 的同一条探测**（`detectRenderer`，可注入假件）—— 技能里说"能渲染"
 *      必须就是工具那一刻的实情，两处各写一份探测必然分叉；
 *   ② 读图能力走消费侧同一套口径：`visionOf`（探测结论 > 注册表 > 保守 false），
 *      且 provider 选哪一条与 `resolveModel` 同一个 `selectProviderConfig`；
 *   ③ 拿不到结论**不编造**：一条 provider 都没配 / 模型名是空 → `vision: null`（那一段会写"未知"）；
 *   ④ **现读**：每次调用重算（换模型、改了探测结论，下一次加载技能就是新结论）；
 *   ⑤ **接线**：主进程注入的这份事实，真的落到了技能侧读的那一处（service → mastra/index → 注册表）
 *      —— 只测零件不测接线的话，"注入了但没人用"照样绿。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../../../shared/settings'
import { probedKeyOf } from '../../../shared/models'
import type { ProviderConfig } from '../../../shared/providers'
import type { PptRenderer } from '../../../mastra/tools/render-ppt'
import { currentSkillRuntimeFacts } from '../../../mastra/skills/runtime'
import { skillRuntimeFactsFor, startAgentServer } from '../service'

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'deepseek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    isDefault: true,
    ...overrides
  }
}

/** 只填这个函数用得到的两处（providers / probedModels），其余按"没有"处理 */
function settingsOf(input: {
  providers?: ProviderConfig[]
  probedModels?: AppSettings['probedModels']
}): AppSettings {
  return {
    providers: input.providers ?? [],
    probedModels: input.probedModels ?? {}
  } as unknown as AppSettings
}

describe('skillRuntimeFactsFor', () => {
  it('渲染器结论来自注入的探测（同一个 detectRenderer）', () => {
    for (const renderer of ['powerpoint', 'none'] as PptRenderer[]) {
      const facts = skillRuntimeFactsFor({
        settings: () => settingsOf({}),
        detectRenderer: () => renderer
      })()
      expect(facts?.pptRenderer).toBe(renderer)
    }
  })

  it('读图能力：探测结论说了算（true / false 都照实报）', () => {
    const key = probedKeyOf('deepseek', 'deepseek-flash')

    const probedTrue = skillRuntimeFactsFor({
      settings: () =>
        settingsOf({ providers: [provider()], probedModels: { [key]: { vision: true } } }),
      detectRenderer: () => 'powerpoint'
    })()
    expect(probedTrue?.vision).toBe(true)

    const probedFalse = skillRuntimeFactsFor({
      settings: () =>
        settingsOf({ providers: [provider()], probedModels: { [key]: { vision: false } } }),
      detectRenderer: () => 'powerpoint'
    })()
    expect(probedFalse?.vision).toBe(false)
  })

  it('没有 provider（或模型名为空）：读图能力是 null —— 不编造"不能看图"', () => {
    const none = skillRuntimeFactsFor({
      settings: () => settingsOf({}),
      detectRenderer: () => 'none'
    })()
    expect(none?.vision).toBeNull()

    const blank = skillRuntimeFactsFor({
      settings: () => settingsOf({ providers: [provider({ model: '' })] }),
      detectRenderer: () => 'none'
    })()
    expect(blank?.vision).toBeNull()
  })

  it('现读：改了设置或探测结论，下一次取值就是新结论', () => {
    const key = probedKeyOf('deepseek', 'deepseek-flash')
    let vision = true
    let renderer: PptRenderer = 'powerpoint'
    const facts = skillRuntimeFactsFor({
      settings: () =>
        settingsOf({
          providers: [provider()],
          probedModels: { [key]: { vision } }
        }),
      detectRenderer: () => renderer
    })

    expect(facts()).toEqual({ pptRenderer: 'powerpoint', vision: true })
    renderer = 'none'
    vision = false
    expect(facts()).toEqual({ pptRenderer: 'none', vision: false })
  })
})

describe('接线：注入了就真的落到技能侧读的那一处', () => {
  it('startAgentServer 注入的事实，装配完就能被 use_skill 的取值函数读到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-skill-facts-boot-'))
    const handle = await startAgentServer({
      dataDir: dir,
      skillRuntimeFacts: () => ({ pptRenderer: 'none', vision: false })
    })
    try {
      expect(currentSkillRuntimeFacts()).toEqual({ pptRenderer: 'none', vision: false })
    } finally {
      await handle.stop()
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
      }
    }
  })
})
