/**
 * 密钥存储（唯一一份：userData/secrets.json）——provider 的 API Key 只在这里落盘，且是
 * safeStorage 的密文（base64）。明文只存在于两个短暂窗口：写入的那一刻、解密后交给模型解析的那一刻；
 * 任何回渲染端的数据都不带明文（契约见 shared/ipc.ts，测试在 main/ipc/__tests__/settings.spec.ts）。
 *
 * 解密失败（换机、迁移、系统账户变了）不是"错误"，而是"没有密钥"：
 * `providerKeyState` 回 `{hasKey:false, needsReentry:true}`，UI 引导重录（Review Focus #5）。
 *
 * 路径由调用方给（main/index.ts 传 app.getPath('userData')），与 settings.ts 同一套范式：
 * 纯函数、可单测；写失败会抛（密钥丢失要让人知道，不静默吞）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import { z } from '../shared/zod'
import { NO_KEY, type ProviderKeyState } from '../shared/providers'

/** 落盘文件名（userData 下，与 settings.json / window-state.json 并列） */
export const SECRETS_FILE = 'secrets.json'

/** 落盘结构：按 provider id 存 base64 密文 */
export const secretsFileSchema = z.strictObject({
  version: z.literal(1),
  keys: z.record(z.string(), z.string())
})

export type SecretsFile = z.infer<typeof secretsFileSchema>

export function secretsPath(userDataDir: string): string {
  return join(userDataDir, SECRETS_FILE)
}

/** 读：文件不存在 / 不是 JSON / 结构不对 → 空账本（坏文件当没写过，应用照常起） */
function readSecretsFile(file: string): SecretsFile {
  try {
    const parsed = secretsFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : { version: 1, keys: {} }
  } catch {
    return { version: 1, keys: {} }
  }
}

/** 写：目录不存在就建；同步写——用户点完保存就该落盘。失败会抛。 */
function writeSecretsFile(file: string, secrets: SecretsFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8')
}

/** 系统钥匙串可用性：不可用时宁可不存，也不把明文写进文件 */
function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储（safeStorage）不可用，无法保存 API 密钥')
  }
}

/** 保存/替换一条 provider 的密钥（加密后落盘，明文不写文件） */
export function setProviderKey(file: string, id: string, key: string): void {
  if (id.length === 0) throw new Error('provider id 不能为空')
  if (key.length === 0) throw new Error('API 密钥不能为空')
  assertEncryptionAvailable()

  const secrets = readSecretsFile(file)
  secrets.keys[id] = safeStorage.encryptString(key).toString('base64')
  writeSecretsFile(file, secrets)
}

/** 清除一条 provider 的密钥（没有就是空操作） */
export function clearProviderKey(file: string, id: string): void {
  const secrets = readSecretsFile(file)
  if (!(id in secrets.keys)) return
  delete secrets.keys[id]
  writeSecretsFile(file, secrets)
}

/** 取密钥明文：**仅主进程内部使用**（模型解析 / 连接测试）；解不开或没配过都回 null */
export function getProviderKey(file: string, id: string): string | null {
  const encrypted = readSecretsFile(file).keys[id]
  if (encrypted === undefined) return null
  try {
    const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    return plain.length > 0 ? plain : null
  } catch {
    return null
  }
}

export function hasProviderKey(file: string, id: string): boolean {
  return getProviderKey(file, id) !== null
}

/** 一条 provider 的密钥状态（设置页显示"已配置 / 需要重新录入"用；不含明文） */
export function providerKeyState(file: string, id: string): ProviderKeyState {
  if (!(id in readSecretsFile(file).keys)) return NO_KEY
  return hasProviderKey(file, id)
    ? { hasKey: true, needsReentry: false }
    : { hasKey: false, needsReentry: true }
}
