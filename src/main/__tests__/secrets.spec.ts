/**
 * 密钥存储（main/secrets.ts）：safeStorage 加密往返 + 解密失败的降级口径（Review Focus #5）。
 *
 * safeStorage 在 vitest（node 环境）里不存在，这里 mock 掉 electron：
 * 加密用的是"反转字符串"这个可逆但**不含明文**的假密码本——真加密由系统钥匙串提供，
 * 用例只验证"密文不落明文、解密失败不当密钥用"这两条我们能控制的行为。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  encryptionAvailable: true,
  decryptFails: false
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    // 假密码本：反转 + UTF-8（可逆；不含原文）
    encryptString: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8'),
    decryptString: (encrypted: Buffer) => {
      if (mocks.decryptFails) throw new Error('decrypt 失败：另一台机器/另一个系统账户加密的密文')
      return [...encrypted.toString('utf8')].reverse().join('')
    }
  }
}))

import {
  clearProviderKey,
  getProviderKey,
  hasProviderKey,
  providerKeyState,
  secretsPath,
  setProviderKey
} from '../secrets'

const KEY = 'sk-test-9f3a7c1e-VERY-secret'
const OTHER_KEY = 'sk-test-other-2b8d4f6a'

let dir: string

beforeEach(() => {
  mocks.encryptionAvailable = true
  mocks.decryptFails = false
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-secrets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function store(): string {
  return secretsPath(dir)
}

function raw(): string {
  return readFileSync(store(), 'utf8')
}

describe('密钥存储（userData 下的 secrets.json）', () => {
  it('往返：写进去的 key 能取回来；hasProviderKey 为 true', () => {
    setProviderKey(store(), 'deepseek', KEY)

    expect(getProviderKey(store(), 'deepseek')).toBe(KEY)
    expect(hasProviderKey(store(), 'deepseek')).toBe(true)
    expect(providerKeyState(store(), 'deepseek')).toEqual({ hasKey: true, needsReentry: false })
  })

  it('落盘的是 base64 密文：文件里没有明文 key', () => {
    setProviderKey(store(), 'deepseek', KEY)

    const file = raw()
    expect(file).not.toContain(KEY)
    expect(file).not.toContain('secret')
    expect(file).not.toContain('sk-test')

    const parsed = JSON.parse(file) as { version: number; keys: Record<string, string> }
    expect(parsed.version).toBe(1)
    expect(Buffer.from(parsed.keys.deepseek, 'base64').toString('utf8')).not.toBe(KEY)
  })

  it('没配过的 id：没有 key、不需要重录（不是"解密失败"）', () => {
    setProviderKey(store(), 'deepseek', KEY)

    expect(hasProviderKey(store(), 'openai')).toBe(false)
    expect(getProviderKey(store(), 'openai')).toBeNull()
    expect(providerKeyState(store(), 'openai')).toEqual({ hasKey: false, needsReentry: false })
  })

  it('解密失败（换机/迁移）→ 降级为无密钥 + needsReentry（Review Focus #5），不抛', () => {
    setProviderKey(store(), 'deepseek', KEY)
    mocks.decryptFails = true

    expect(hasProviderKey(store(), 'deepseek')).toBe(false)
    expect(getProviderKey(store(), 'deepseek')).toBeNull()
    expect(providerKeyState(store(), 'deepseek')).toEqual({ hasKey: false, needsReentry: true })
  })

  it('同一个 id 重复写：以最后一次为准（旧的密文不残留）', () => {
    setProviderKey(store(), 'deepseek', KEY)
    setProviderKey(store(), 'deepseek', OTHER_KEY)

    expect(getProviderKey(store(), 'deepseek')).toBe(OTHER_KEY)
    expect(raw()).not.toContain(KEY)
    const parsed = JSON.parse(raw()) as { keys: Record<string, string> }
    expect(Object.keys(parsed.keys)).toEqual(['deepseek'])
  })

  it('多个 provider 各存各的；清掉一个不动另一个', () => {
    setProviderKey(store(), 'deepseek', KEY)
    setProviderKey(store(), 'openai', OTHER_KEY)

    clearProviderKey(store(), 'deepseek')

    expect(hasProviderKey(store(), 'deepseek')).toBe(false)
    expect(providerKeyState(store(), 'deepseek')).toEqual({ hasKey: false, needsReentry: false })
    expect(getProviderKey(store(), 'openai')).toBe(OTHER_KEY)
  })

  it('清一个本来就没有的 id 是空操作（不抛、不建文件）', () => {
    clearProviderKey(store(), 'nobody')

    expect(hasProviderKey(store(), 'nobody')).toBe(false)
  })

  it('系统安全存储不可用 → 拒绝保存（抛错），文件不动', () => {
    mocks.encryptionAvailable = false

    expect(() => setProviderKey(store(), 'deepseek', KEY)).toThrow(/安全存储/)
    expect(hasProviderKey(store(), 'deepseek')).toBe(false)
  })

  it('空 key / 空 id 直接拒绝（不给"看似保存成功"的错觉）', () => {
    expect(() => setProviderKey(store(), 'deepseek', '')).toThrow()
    expect(() => setProviderKey(store(), '', KEY)).toThrow()
    expect(hasProviderKey(store(), 'deepseek')).toBe(false)
  })

  it('文件坏（不是 JSON / 结构不对）→ 当没配过，之后还能正常写入', () => {
    for (const bad of ['{不是 json', '{"version":1,"keys":[]}', '{"version":2,"keys":{}}', '[]']) {
      writeFileSync(store(), bad, 'utf8')

      expect(providerKeyState(store(), 'deepseek'), bad).toEqual({
        hasKey: false,
        needsReentry: false
      })
      setProviderKey(store(), 'deepseek', KEY)
      expect(getProviderKey(store(), 'deepseek'), bad).toBe(KEY)
    }
  })

  it('目录不存在时写入自己建（userData 首次创建）', () => {
    const nested = secretsPath(join(dir, 'nested', 'deeper'))

    setProviderKey(nested, 'deepseek', KEY)

    expect(getProviderKey(nested, 'deepseek')).toBe(KEY)
  })

  it('写不进去就抛（磁盘满/路径被占），不静默吞掉用户的密钥', () => {
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x', 'utf8')

    expect(() => setProviderKey(secretsPath(blocked), 'deepseek', KEY)).toThrow()
  })
})
