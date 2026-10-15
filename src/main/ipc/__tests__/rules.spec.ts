import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
)
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))
import { registerRulesIpc } from '../rules'
import { RULES_IPC_CHANNELS } from '../../../shared/rules-ipc'
import { updateSettings, settingsPath } from '../../settings'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  handlers.clear()
})
const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(null, ...args)

describe('项目约束 IPC', () => {
  it('status 无参数且每次现取实际注册状态，未注入默认 false', () => {
    registerRulesIpc('unused')
    expect(call(RULES_IPC_CHANNELS.status)).toEqual({ processorRegistered: false })
    expect(() => call(RULES_IPC_CHANNELS.status, 'path')).toThrow()
    let registered = false
    registerRulesIpc('unused', { processorRegistered: () => registered })
    expect(call(RULES_IPC_CHANNELS.status)).toEqual({ processorRegistered: false })
    registered = true
    expect(call(RULES_IPC_CHANNELS.status)).toEqual({ processorRegistered: true })
  })
  it('只接受已存在 projectId，拒绝任意路径，诊断返回 UI，默认未接线', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rules-ipc-')))
    roots.push(root)
    updateSettings(settingsPath(root), {
      projects: [{ id: 'p', name: 'P', path: root, createdAt: '' }],
      globalRules: 'g'.repeat(16384)
    })
    registerRulesIpc(root)
    await expect(
      call(RULES_IPC_CHANNELS.save, { projectId: 'p', path: root, text: '' })
    ).rejects.toThrow()
    await expect(call(RULES_IPC_CHANNELS.read, 'unknown')).rejects.toThrow()
    expect(
      await call(RULES_IPC_CHANNELS.save, { projectId: 'p', text: 'p'.repeat(16384) })
    ).toMatchObject({
      ok: true,
      view: {
        processorRegistered: false,
        projectIncluded: false,
        diagnostics: [{ code: 'combined-too-large' }]
      }
    })
    expect(await call(RULES_IPC_CHANNELS.save, { projectId: 'p', text: '' })).toMatchObject({
      ok: true,
      view: { text: '', projectIncluded: true }
    })
  })
})
