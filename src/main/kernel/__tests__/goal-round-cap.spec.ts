// @vitest-environment node
/**
 * B3.3b：profile patch 注入 `defaultMaxGoalRounds`（不改内核包）。
 * - 首次写：生成 `profiles/web/cordis.patch.yml`，内容是 `- id: goal / config / defaultMaxGoalRounds: 16`；
 * - 幂等：已有 16 不重复追加；
 * - 已有 `- id: goal`（无 config）：在条目里插入 config，不新增重复 id。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureGoalRoundCap } from '../kernel-adapter'

describe('B3.3b goal 轮次安全阀配置注入', () => {
  it('首次生成 patch：defaultMaxGoalRounds: 16；重复调用幂等', () => {
    const home = mkdtempSync(join(tmpdir(), 'kyclaw-cap-patch-'))
    try {
      const patch = ensureGoalRoundCap(home, 16)
      const first = readFileSync(patch, 'utf8')
      expect(first).toContain('- id: goal')
      expect(first).toContain('defaultMaxGoalRounds: 16')
      ensureGoalRoundCap(home, 16)
      const second = readFileSync(patch, 'utf8')
      expect(second).toBe(first)
      expect((second.match(/defaultMaxGoalRounds/g) ?? []).length).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('已有 `- id: goal` 无 config：插入 config，不产生重复 id', () => {
    const home = mkdtempSync(join(tmpdir(), 'kyclaw-cap-patch2-'))
    try {
      ensureGoalRoundCap(home, 16)
      const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
      writeFileSync(
        patchPath,
        ['# existing profile patch', '- id: goal', '  name: "@deepseek-ai/dsh-goal"', ''].join(
          '\n'
        ),
        'utf8'
      )
      ensureGoalRoundCap(home, 16)
      const patched = readFileSync(patchPath, 'utf8')
      expect((patched.match(/^- id: goal$/gm) ?? []).length).toBe(1)
      expect(patched).toContain('defaultMaxGoalRounds: 16')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
