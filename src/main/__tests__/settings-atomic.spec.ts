// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings'

const faults = vi.hoisted(() => ({ write: false, rename: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (faults.write) {
        fs.writeFileSync(args[0], 'partial')
        throw new Error('simulated disk full')
      }
      return fs.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.rename) throw new Error('simulated rename failure')
      return fs.renameSync(...args)
    }
  }
})

const directories: string[] = []
afterEach(() => {
  faults.write = false
  faults.rename = false
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('settings atomic writes', () => {
  for (const fault of ['write', 'rename'] as const) {
    it(`${fault} failure preserves existing settings and removes temporary files`, async () => {
      vi.resetModules()
      const { initializeDefaultWorkspace, settingsPath, writeSettings } =
        await import('../settings')
      const dir = mkdtempSync(join(tmpdir(), 'kyclaw-atomic-'))
      directories.push(dir)
      const file = settingsPath(dir)
      writeSettings(file, { ...defaultSettings(), theme: 'dark' })
      const original = readFileSync(file, 'utf8')
      faults[fault] = true

      expect(() => writeSettings(file, { ...defaultSettings(), theme: 'light' })).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(original)
      initializeDefaultWorkspace(dir, join(dir, 'home'))
      expect(readFileSync(file, 'utf8')).toBe(original)
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    })
  }
})
