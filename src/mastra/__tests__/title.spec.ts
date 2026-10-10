// @vitest-environment node
/**
 * 标题生成器（T9 Step 4 单测）：
 *   1. 正常路径：模型被调（resolveModel → generate），输出清理后落库；
 *   2. 降级路径：模型失败 / 配置半截（resolveModel 抛错）→ 截断首句，照常落库；
 *   3. 没有可用素材（首句为空）→ 兜底"新会话"。
 * 这里不打真网：模型与 generate 都是注入的假件；线程/落库用假的 memory 记录调用。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_TITLE,
  TITLE_MAX_LENGTH,
  fallbackTitle,
  generateThreadTitle,
  sanitizeTitle
} from '../title'
import type { KyclawModel } from '../model'

const THREAD_ID = 'thread-1'
const FIRST_TEXT = '帮我把电源管理的调研资料整理成一份对比表，周五之前要'

function fakeMemory(): {
  updateThread: ReturnType<typeof vi.fn>
} {
  return {
    updateThread: vi.fn(async ({ id, title }: { id: string; title?: string }) => ({ id, title }))
  }
}

describe('sanitizeTitle / fallbackTitle（纯函数）', () => {
  it('清理模型输出：去掉思考块、引号、换行与多余空白', () => {
    expect(sanitizeTitle('<think>先分类</think>「周报 与下周计划」。\n额外解释')).toBe(
      '周报 与下周计划'
    )
    expect(sanitizeTitle('  "项目预算看板"  ')).toBe('项目预算看板')
  })

  it('超长标题截到上限', () => {
    const long = '一'.repeat(80)
    expect(sanitizeTitle(long)).toHaveLength(TITLE_MAX_LENGTH)
  })

  it('清理后为空返回 null（不算生成成功）', () => {
    expect(sanitizeTitle('   ')).toBeNull()
    expect(sanitizeTitle('""')).toBeNull()
  })

  it('降级标题取首句并截断', () => {
    expect(fallbackTitle('帮我把资料整理成对比表。另外再做一个图表')).toBe('帮我把资料整理成对比表')
    expect(fallbackTitle('很长'.repeat(40))).toHaveLength(TITLE_MAX_LENGTH)
    expect(fallbackTitle(FIRST_TEXT)).toBe(FIRST_TEXT)
    expect(fallbackTitle('   ')).toBe(FALLBACK_TITLE)
  })
})

describe('generateThreadTitle', () => {
  it('正常路径：模型被调一次，清理后的标题写入线程', async () => {
    const memory = fakeMemory()
    const resolveModel = vi.fn(async () => ({}) as KyclawModel)
    const generate = vi.fn(async () => ({ text: '「电源管理对比表」' }))

    const result = await generateThreadTitle({
      memory: memory as never,
      threadId: THREAD_ID,
      firstUserText: FIRST_TEXT,
      resolveModel,
      generate
    })

    expect(result).toEqual({ title: '电源管理对比表', source: 'model' })
    expect(resolveModel).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
    // 模型请求带着首句与"只输出标题"的指令
    const call = generate.mock.calls[0] as unknown as [unknown, { prompt: string; system: string }]
    expect(call[1].prompt).toContain('电源管理')
    expect(call[1].system).toContain('标题')

    expect(memory.updateThread).toHaveBeenCalledWith({ id: THREAD_ID, title: '电源管理对比表' })
  })

  it('模型失败 → 截断首句降级，仍然落库', async () => {
    const memory = fakeMemory()
    const generate = vi.fn(async () => {
      throw new Error('模型挂了')
    })

    const result = await generateThreadTitle({
      memory: memory as never,
      threadId: THREAD_ID,
      firstUserText: FIRST_TEXT,
      resolveModel: async () => ({}) as never,
      generate
    })

    expect(result.source).toBe('fallback')
    expect(result.title).toBe(fallbackTitle(FIRST_TEXT))
    expect(memory.updateThread).toHaveBeenCalledWith({ id: THREAD_ID, title: result.title })
  })

  it('模型解析都失败（provider 半截）→ 降级，不抛错', async () => {
    const memory = fakeMemory()
    const resolveModel = vi.fn(async () => {
      throw new Error('配置不完整：缺 API 密钥')
    })
    const generate = vi.fn()

    const result = await generateThreadTitle({
      memory: memory as never,
      threadId: THREAD_ID,
      firstUserText: FIRST_TEXT,
      resolveModel,
      generate
    })

    expect(result.source).toBe('fallback')
    expect(generate).not.toHaveBeenCalled()
    expect(memory.updateThread).toHaveBeenCalledTimes(1)
  })

  it('模型回空/废话不够当标题 → 也走降级', async () => {
    const memory = fakeMemory()

    const result = await generateThreadTitle({
      memory: memory as never,
      threadId: THREAD_ID,
      firstUserText: FIRST_TEXT,
      resolveModel: async () => ({}) as never,
      generate: async () => ({ text: '   ' })
    })

    expect(result.source).toBe('fallback')
  })

  it('落库失败要往上抛（调用方决定怎么呈现），不吞', async () => {
    const memory = { updateThread: vi.fn(async () => Promise.reject(new Error('db 挂了'))) }

    await expect(
      generateThreadTitle({
        memory: memory as never,
        threadId: THREAD_ID,
        firstUserText: FIRST_TEXT,
        resolveModel: async () => ({}) as never,
        generate: async () => ({ text: '标题' })
      })
    ).rejects.toThrow('db 挂了')
  })
})
