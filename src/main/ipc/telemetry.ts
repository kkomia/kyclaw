/**
 * 可观测通道的 handler（T17）：Langfuse 的配置状态 + 写/清公私钥。
 *
 * 与 provider 密钥同一套纪律（T8）：
 *   - 写方向上明文只活在局部变量里（不打印、不回包）；
 *   - 读方向只回"有没有 / 要不要重录"（LangfuseState，契约在 shared/ipc.ts）；
 *   - 服务地址是普通设置，走 settings:update（补丁 schema 里开着），不在这里开第二条路。
 *
 * 状态里的 `active` 是**本次运行**的事实（agent 服务启动时挂没挂上导出），由调用方注入的取值函数给。
 */
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  langfuseKeysArgsSchema,
  noArgsSchema,
  parseIpcArgs,
  type LangfuseState
} from '../../shared/ipc'
import { clearLangfuseSecrets, readLangfuseState, writeLangfuseKeys } from '../telemetry'

export function registerTelemetryIpc(options: {
  /** userData 目录（地址读的是 settings.json，与 settings:update 写的是同一份） */
  dataDir: string
  /** userData 下的 secrets.json */
  secretsFile: string
  /** 本次运行的 agent 服务有没有真的挂上导出（服务没起来 = false） */
  langfuseActive: () => boolean
}): void {
  const readState = (): LangfuseState =>
    readLangfuseState(options.dataDir, options.langfuseActive(), options.secretsFile)

  ipcMain.handle(IPC_CHANNELS.telemetry.langfuseState, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.telemetry.langfuseState)
    return readState()
  })

  // 写密钥：明文只活在这个局部变量里；回包只有 {hasKeys:true}
  ipcMain.handle(IPC_CHANNELS.telemetry.setLangfuseKeys, (_event, ...args) => {
    const [publicKey, secretKey] = parseIpcArgs(
      langfuseKeysArgsSchema,
      args,
      IPC_CHANNELS.telemetry.setLangfuseKeys
    )
    writeLangfuseKeys(options.secretsFile, publicKey, secretKey)
    return { hasKeys: true }
  })

  ipcMain.handle(IPC_CHANNELS.telemetry.clearLangfuseKeys, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.telemetry.clearLangfuseKeys)
    clearLangfuseSecrets(options.secretsFile)
    return readState()
  })
}
