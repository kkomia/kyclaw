// @vitest-environment node
/**
 * working memory 那块系统提示的**成本哨兵**（round 70）。
 *
 * 为什么值得钉：模型每轮系统提示里有一大段英文样板（`WORKING_MEMORY_SYSTEM_INSTRUCTION: …`，
 * 实测 **438 token**，2013 字符 —— 比我们的整个稳定层指令还大），而这段文字**不是我们写的**：
 * 它由 @mastra/memory 的 `getWorkingMemoryToolInstruction` 生成，只把我们自己的
 * `KYCLAW_WORKING_MEMORY_TEMPLATE`（src/mastra/index.ts）填进 `<working_memory_template>`。
 * 也就是说仓库里**没有任何地方**拥有它 —— 库升级、配置改动、模板变大，都不会有人报错，
 * 只会每轮悄悄多花 token。这份 spec 就是那个"有人报错"的地方。
 *
 * 判据（走**真装配**的 Memory 实例，不自己拼字符串）：拿它这一轮的 `getSystemMessage`，
 * 钉长度上界与关键字段都在。上界不是"目标值"而是"哨兵值"：真要调低，请连同这份 spec 一起改，
 * 并在报告里给出改前改后的真分词数字（本轮的口径见 .superpowers/.../_r70-probe/）。
 *
 * 已知的一次实测（round 70，真分词器）：稳定档 438 token；库的 vnext 档 421 token —— 但 vnext
 * 会把 `updateWorkingMemory` 换成 search-and-replace 形状（newMemory/updateReason），是**降能力**，
 * 所以没切（理由与数字写在 _r70-summary.json 的 workingMemory 一节）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { KyclawMastra } from '../index'
import { createKyclawMastra } from '../index'
import type { KyclawModel } from '../model'

/** 这段样板的字符上界（实测 2013；留一点余量给库的小改动，翻倍级的增长要人看一眼） */
const WORKING_MEMORY_INSTRUCTION_MAX_CHARS = 2200

const resolveModel = async (): Promise<KyclawModel> => ({}) as unknown as KyclawModel

let dir: string
let built: KyclawMastra

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-wm-cost-'))
  built = await createKyclawMastra({
    dataDir: dir,
    resolveModel,
    workspaces: () => [],
    defaultWorkspace: () => null,
    projects: () => [],
    permissionRules: () => [],
    mcpServers: () => [],
    mcpTools: async () => ({})
  })
}, 30_000)

afterAll(async () => {
  await built?.mastra.shutdown().catch(() => {})
  await built?.storage.close().catch(() => {})
  if (dir !== undefined) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows 上 libsql 句柄偶尔延迟释放；删不掉交给系统清理（与既有用例同口径）
    }
  }
})

describe('working memory 的系统提示：成本哨兵', () => {
  it('是库生成的样板 + 我们的模板，长度不越界', async () => {
    const text = await built.memory.getSystemMessage({ threadId: 'wm-cost', resourceId: 'local-user' })

    expect(text).not.toBeNull()
    const block = String(text)
    expect(block).toContain('WORKING_MEMORY_SYSTEM_INSTRUCTION')
    expect(block).toContain('<working_memory_template>')
    // 模板的字段一个不少（记忆页读就是这些字段；少了它模型就不知道该填什么）
    expect(block).toContain('# 用户信息')
    expect(block).toContain('- 长期偏好：')

    expect(block.length).toBeLessThanOrEqual(WORKING_MEMORY_INSTRUCTION_MAX_CHARS)
  })

  it('走的是库的稳定档（不是 vnext）：换档会同时换掉 updateWorkingMemory 的形状，必须是一次显式决定', async () => {
    const block = String(
      await built.memory.getSystemMessage({ threadId: 'wm-cost', resourceId: 'local-user' })
    )

    // vnext 档独有的两句（其 updateWorkingMemory 是 search-and-replace 形状：newMemory/updateReason）
    expect(block).not.toContain('If your memory has not changed')
    expect(block).not.toContain('Only store information if it')
    // 稳定档独有的三句（vnext 会删掉它们）
    expect(block).toContain('DO NOT pass an object')
    expect(block).toContain('Preserve the Markdown formatting structure')
  })
})
