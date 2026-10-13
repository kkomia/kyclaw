/**
 * Langfuse 的设置与密钥（T17；round 67 加代理）：
 *   - 服务地址与代理落 settings.json（shared/settings.ts 的 `langfuse.endpoint` / `proxyUrl`）；
 *   - 公私钥与 provider 密钥同待遇 —— safeStorage 密文落 secrets.json（复用 main/secrets.ts 那套
 *     通用读写，用两个固定的 key id 占位）。明文只在写入的那一刻与"建 exporter 的那一刻"存在，
 *     回渲染端的数据永远只有"有没有"。
 *
 * 这里也是"配齐没配齐"的唯一判定入口：agent 服务（建 exporter）与设置页（显示状态）读同一份，
 * 不会两处各判一次、判出两个结果。
 *
 * 代理的兜底口径（round 67）：设置项非空就用它；空则看 `LANGFUSE_PROXY_URL` /
 * `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量（归一逻辑在 mastra/telemetry.ts）。
 */
import { langfuseConfigOf, resolveProxyUrl, type LangfuseExportConfig } from '../mastra/telemetry'
import type { LangfuseState } from '../shared/ipc'
import {
  clearProviderKey,
  getProviderKey,
  providerKeyState,
  secretsPath,
  setProviderKey
} from './secrets'
import { readSettings, settingsPath } from './settings'

/**
 * secrets.json 里的两个固定 key id：与 provider 的密钥共用同一份存储。
 * 带冒号前缀是为了不可能与 provider id 撞（provider id 的形状在 shared/providers.ts 里另有约束）。
 */
export const LANGFUSE_PUBLIC_KEY_ID = 'langfuse:public'
export const LANGFUSE_SECRET_KEY_ID = 'langfuse:secret'

/** 从落盘设置 + 密钥算出导出配置（三项缺一 = null，即"不导出"） */
export function readLangfuseConfig(
  dataDir: string,
  secretsFile = secretsPath(dataDir)
): LangfuseExportConfig | null {
  const { langfuse } = readSettings(settingsPath(dataDir))
  return langfuseConfigOf({
    endpoint: langfuse.endpoint,
    proxyUrl: resolveProxyUrl(langfuse.proxyUrl, process.env),
    publicKey: getProviderKey(secretsFile, LANGFUSE_PUBLIC_KEY_ID),
    secretKey: getProviderKey(secretsFile, LANGFUSE_SECRET_KEY_ID)
  })
}

/**
 * 设置页要的状态：地址原文 + 两个密钥的"有没有 / 要不要重录" + 本次运行有没有真的挂上导出。
 * `active` 由调用方给（agent 服务启动时定下的事实），所以配置改完到重启前，界面能说实话。
 */
export function readLangfuseState(
  dataDir: string,
  active: boolean,
  secretsFile = secretsPath(dataDir)
): LangfuseState {
  return {
    endpoint: readSettings(settingsPath(dataDir)).langfuse.endpoint,
    publicKey: providerKeyState(secretsFile, LANGFUSE_PUBLIC_KEY_ID),
    secretKey: providerKeyState(secretsFile, LANGFUSE_SECRET_KEY_ID),
    active
  }
}

/**
 * 写公私钥。两次写盘之间出问题会留下"只有公钥"的半截状态——那种状态下判定仍是不导出
 * （缺一即关），所以无害；不要为它加回滚（回滚本身又是一次可能失败的写）。
 */
export function writeLangfuseKeys(secretsFile: string, publicKey: string, secretKey: string): void {
  setProviderKey(secretsFile, LANGFUSE_PUBLIC_KEY_ID, publicKey)
  setProviderKey(secretsFile, LANGFUSE_SECRET_KEY_ID, secretKey)
}

/** 清除公私钥（没有就是空操作）；地址不动——想彻底关就把地址清空保存 */
export function clearLangfuseSecrets(secretsFile: string): void {
  clearProviderKey(secretsFile, LANGFUSE_PUBLIC_KEY_ID)
  clearProviderKey(secretsFile, LANGFUSE_SECRET_KEY_ID)
}
