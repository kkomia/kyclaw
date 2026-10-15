// @vitest-environment node
/**
 * Langfuse 的设置与密钥（T17）：地址在 settings.json、公私钥在 secrets.json（safeStorage 密文）。
 * 这里盯三件事：
 *   1. "配齐"的判定只有一条路（**开关开着** + 地址 + 两把密钥都在）——缺一就不导出；
 *   2. 明文只进不出：写完之后磁盘上是密文、settings.json 里没有密钥；
 *   3. active 是"本次运行"的事实，状态原样带出去（界面靠它说"重启应用后开启"）。
 *
 * round 86（用户口径 010）：开关（`enabled`）是显式的，**关着 = 一律不发**（下面的负向守卫）；
 * 界面上说"已关闭"的那一句在渲染端的 status-text.ts。
 *
 * electron 的 safeStorage 用假密码本（反转字符串），所以"磁盘是密文"这类断言在 node 里也真成立。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ decryptFails: false }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8'),
    decryptString: (encrypted: Buffer) => {
      if (mocks.decryptFails) throw new Error('decrypt 失败（换机/迁移）')
      return [...encrypted.toString('utf8')].reverse().join('')
    }
  }
}))

import { secretsPath } from '../secrets'
import { readSettings, settingsPath, writeSettings } from '../settings'
import {
  clearLangfuseSecrets,
  LANGFUSE_PUBLIC_KEY_ID,
  LANGFUSE_SECRET_KEY_ID,
  readLangfuseConfig,
  readLangfuseState,
  writeLangfuseKeys
} from '../telemetry'
import { DEFAULT_SETTINGS } from '../../shared/settings'

/** 测试密钥：不像密文，方便断言"磁盘/设置里都不含它" */
const PUBLIC_KEY = 'pk-lf-111122223333'
const SECRET_KEY = 'sk-lf-444455556666-SECRET'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-telemetry-'))
  mocks.decryptFails = false
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 摆一份"用户在设置页填好地址"的落盘设置（round 86：开关默认开着） */
function setEndpoint(endpoint: string, proxyUrl = '', enabled = true): void {
  writeSettings(settingsPath(dir), {
    ...DEFAULT_SETTINGS,
    langfuse: { enabled, endpoint, proxyUrl }
  })
}

describe('readLangfuseConfig：开关开着 + 三项齐才导出', () => {
  it('什么都没配 → null（默认关，也就是"内容不出机器"）', () => {
    // 默认设置里地址是预置那台（LANGFUSE_PRESET），但没密钥 → 依然不导出
    expect(readLangfuseConfig(dir)).toBeNull()
  })

  it('只填地址 → null（缺密钥）', () => {
    setEndpoint('https://cloud.langfuse.com')

    expect(readLangfuseConfig(dir)).toBeNull()
  })

  it('只写密钥、没填地址 → null（地址空 = 没配）', () => {
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)
    setEndpoint('')

    expect(readLangfuseConfig(dir)).toBeNull()
  })

  /**
   * round 86（用户口径 010）的**负向守卫**：显式关掉就是一律不发 —— 三项齐全也一样。
   * 这是"关闭时不再向 Langfuse 发数据"这条口径在数据面上的唯一判据（exporter 装配读的就是它）。
   */
  it('round 86：显式关掉（enabled:false）→ 三项齐全也是 null（不再发任何数据）', () => {
    setEndpoint('https://cloud.langfuse.com', '', false)
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)

    expect(readLangfuseConfig(dir)).toBeNull()

    // 与"关掉"对照：同一份地址与密钥，开关一开就给出配置（守卫拦的是开关，不是别的）
    setEndpoint('https://cloud.langfuse.com', '', true)
    expect(readLangfuseConfig(dir)?.endpoint).toBe('https://cloud.langfuse.com')
  })

  it('三项齐 → 给出配置，地址两端空白与结尾斜杠被归一', () => {
    setEndpoint('  https://self.hosted.langfuse///  ')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)

    expect(readLangfuseConfig(dir)).toEqual({
      endpoint: 'https://self.hosted.langfuse',
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY
    })
  })

  it('填了代理 → 配置里带 proxyUrl（没写协议补 http://；只影响这一路）', () => {
    setEndpoint('http://100.66.1.1:3000', ' 127.0.0.1:7890 ')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)

    expect(readLangfuseConfig(dir)).toEqual({
      endpoint: 'http://100.66.1.1:3000',
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      proxyUrl: 'http://127.0.0.1:7890'
    })
  })

  it('设置里没填代理 → 回落环境变量（HTTPS_PROXY / HTTP_PROXY 都认）', () => {
    setEndpoint('http://100.66.1.1:3000')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)
    const before = { ...process.env }
    try {
      delete process.env.LANGFUSE_PROXY_URL
      delete process.env.HTTPS_PROXY
      delete process.env.https_proxy
      delete process.env.ALL_PROXY
      delete process.env.all_proxy
      process.env.HTTP_PROXY = 'http://10.0.0.9:3128'

      expect(readLangfuseConfig(dir)?.proxyUrl).toBe('http://10.0.0.9:3128')
    } finally {
      process.env = before
    }
  })
})

describe('密钥纪律：明文只进不出', () => {
  it('写完之后：磁盘上是密文、settings.json 里没有密钥、设置里只有地址', () => {
    setEndpoint('https://cloud.langfuse.com')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)

    const secrets = readFileSync(secretsPath(dir), 'utf8')
    expect(secrets).not.toContain(PUBLIC_KEY)
    expect(secrets).not.toContain(SECRET_KEY)
    expect(secrets).toContain(Buffer.from([...PUBLIC_KEY].reverse().join('')).toString('base64'))

    const settings = readFileSync(settingsPath(dir), 'utf8')
    expect(settings).not.toContain(PUBLIC_KEY)
    expect(settings).not.toContain(SECRET_KEY)
    expect(readSettings(settingsPath(dir)).langfuse).toEqual({
      enabled: true,
      endpoint: 'https://cloud.langfuse.com',
      proxyUrl: ''
    })
  })

  it('状态里只有"有没有 / 要不要重录"，没有密钥本身', () => {
    setEndpoint('https://cloud.langfuse.com')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)

    const state = readLangfuseState(dir, false)
    expect(state).toEqual({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: true, needsReentry: false },
      secretKey: { hasKey: true, needsReentry: false },
      active: false
    })
    expect(JSON.stringify(state)).not.toContain(PUBLIC_KEY)
  })

  it('密钥解不开（换机/迁移）：状态是"要重录"，配置判定为不导出', () => {
    setEndpoint('https://cloud.langfuse.com')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)
    mocks.decryptFails = true

    expect(readLangfuseState(dir, false)).toEqual({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: false, needsReentry: true },
      secretKey: { hasKey: false, needsReentry: true },
      active: false
    })
    expect(readLangfuseConfig(dir)).toBeNull()
  })

  it('清除密钥：两把一起没了（没有时是空操作），地址不动', () => {
    setEndpoint('https://cloud.langfuse.com')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)

    clearLangfuseSecrets(secretsPath(dir))
    expect(readLangfuseState(dir, false)).toMatchObject({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: false },
      secretKey: { hasKey: false }
    })
    expect(readLangfuseConfig(dir)).toBeNull()

    expect(() => clearLangfuseSecrets(secretsPath(dir))).not.toThrow()
  })

  it('active 原样带出（本次运行有没有真的挂上导出，由调用方给）', () => {
    setEndpoint('https://cloud.langfuse.com')
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)

    expect(readLangfuseState(dir, true).active).toBe(true)
  })

  it('两个 key id 与 provider 的密钥共用一个文件、互不覆盖', () => {
    writeLangfuseKeys(secretsPath(dir), PUBLIC_KEY, SECRET_KEY)
    const keys = JSON.parse(readFileSync(secretsPath(dir), 'utf8')).keys as Record<string, string>

    expect(Object.keys(keys).sort()).toEqual([LANGFUSE_PUBLIC_KEY_ID, LANGFUSE_SECRET_KEY_ID])
  })
})
