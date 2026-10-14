// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (faults.rename) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      return fs.rename(...args)
    }
  }
})
import { saveProjectRules } from '../project-rules'

describe('原子替换错误回执', () => {
  it('rename 失败返回 save-failed，旧文件不变，不留临时文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rules-atomic-'))
    try {
      const project = { id: 'p', name: 'P', path: root, createdAt: '' }
      expect(await saveProjectRules(project, '原文')).toEqual({ ok: true })
      faults.rename = true
      expect(await saveProjectRules(project, '新版')).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'save-failed' }]
      })
      expect(await readFile(join(root, '.kyclaw', 'rules.md'), 'utf8')).toBe('原文')
      expect(await readdir(join(root, '.kyclaw'))).toEqual(['rules.md'])
    } finally {
      faults.rename = false
      await rm(root, { recursive: true, force: true })
    }
  })
})
