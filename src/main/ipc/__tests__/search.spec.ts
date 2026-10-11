import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 联网搜索通道的 handler（round 45）：Exa / Tavily / Jina 三个可选 Key 的写/清/状态。
 * 与 provider / 翻译密钥同一套 mock 方式（假 ipcMain + 反转字符串的假 safeStorage）+ 临时目录。
 * 盯三件事：明文只在写方向出现一次、落盘是密文、入参闸门一个口子都不留。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return { handlers: new Map<string, Handler>() }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8'),
    decryptString: (encrypted: Buffer) => [...encrypted.toString('utf8')].reverse().join('')
  }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { SEARCH_KEY_SECRET_ID } from '../../../shared/search'
import { secretsPath } from '../../secrets'
import { registerSearchIpc } from '../search'

const EVENT = { sender: { id: 1 } }
const EXA_KEY = 'exa-SECRET-1'
const TAVILY_KEY = 'tvly-SECRET-2'

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

let dir: string

beforeEach(() => {
  mocks.handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-search-ipc-'))
  registerSearchIpc(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('search 通道 handler', () => {
  it('三条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'search:clear-key',
      'search:key-states',
      'search:set-key'
    ])
  })

  it('初始状态：三档全是"没配过"', () => {
    expect(handlerOf(IPC_CHANNELS.search.keyStates)(EVENT)).toEqual({
      exa: { hasKey: false, needsReentry: false },
      tavily: { hasKey: false, needsReentry: false },
      jina: { hasKey: false, needsReentry: false }
    })
  })

  it('写 Key：只回 {hasKey:true}；状态只有"有没有"；磁盘是密文；分槽互不串味', () => {
    const written = handlerOf(IPC_CHANNELS.search.setKey)(EVENT, 'exa', EXA_KEY)
    expect(written).toEqual({ hasKey: true })
    expect(JSON.stringify(written)).not.toContain(EXA_KEY)

    const states = handlerOf(IPC_CHANNELS.search.keyStates)(EVENT) as Record<
      string,
      { hasKey: boolean }
    >
    expect(states.exa).toEqual({ hasKey: true, needsReentry: false })
    expect(states.tavily).toEqual({ hasKey: false, needsReentry: false })
    expect(states.jina).toEqual({ hasKey: false, needsReentry: false })
    expect(JSON.stringify(states)).not.toContain(EXA_KEY)

    const raw = readFileSync(secretsPath(dir), 'utf8')
    expect(raw).not.toContain(EXA_KEY)
    const stored = JSON.parse(raw) as { keys: Record<string, string> }
    expect(stored.keys[SEARCH_KEY_SECRET_ID.exa]).toBeDefined()
    expect(stored.keys[SEARCH_KEY_SECRET_ID.tavily]).toBeUndefined()
  })

  it('两档都写：各进各的槽位（换服务商不串味）', () => {
    handlerOf(IPC_CHANNELS.search.setKey)(EVENT, 'exa', EXA_KEY)
    handlerOf(IPC_CHANNELS.search.setKey)(EVENT, 'tavily', TAVILY_KEY)

    const stored = JSON.parse(readFileSync(secretsPath(dir), 'utf8')) as {
      keys: Record<string, string>
    }
    expect(Object.keys(stored.keys).sort()).toEqual(
      [SEARCH_KEY_SECRET_ID.exa, SEARCH_KEY_SECRET_ID.tavily].sort()
    )
  })

  it('清 Key：幂等；只动那一档，返回清除后的三份状态', () => {
    handlerOf(IPC_CHANNELS.search.setKey)(EVENT, 'jina', 'jina-key')

    const cleared = handlerOf(IPC_CHANNELS.search.clearKey)(EVENT, 'jina')
    expect(cleared).toEqual({
      exa: { hasKey: false, needsReentry: false },
      tavily: { hasKey: false, needsReentry: false },
      jina: { hasKey: false, needsReentry: false }
    })
    // 再清一次是空操作，不抛
    expect(() => handlerOf(IPC_CHANNELS.search.clearKey)(EVENT, 'jina')).not.toThrow()
  })

  it('入参闸门：target 只认三选一、key 非空、多余入参一律拒', () => {
    const setKey = handlerOf(IPC_CHANNELS.search.setKey)

    for (const args of [
      [],
      ['exa'],
      ['serpapi', 'k'],
      ['exa', ''],
      ['exa', 'k', 'extra'],
      [1, 'k']
    ]) {
      expect(() => setKey(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }

    expect(() => handlerOf(IPC_CHANNELS.search.keyStates)(EVENT, 'x')).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.search.clearKey)(EVENT)).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.search.clearKey)(EVENT, 'serpapi')).toThrow(IpcInputError)
  })
})
