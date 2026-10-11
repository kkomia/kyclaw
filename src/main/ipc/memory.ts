/**
 * 记忆通道的 handler（round 28 模块 3）：语义召回里**远程嵌入**的 API Key。
 *
 * 只有密钥走 IPC —— 开关与嵌入服务（enabled / source / baseUrl / model）是普通设置，
 * 走 settings:update 的补丁；状态行（本次运行开没开）走 agent 服务的 `GET /api/memory/recall`。
 *
 * 密钥纪律与 provider / Langfuse 完全同一套（T8 / T17）：
 *   - 写方向上明文只活在局部变量里（不打印、不回包）；
 *   - 读方向只回"有没有 / 要不要重录"（ProviderKeyState，契约在 shared/ipc.ts）；
 *   - 落盘是 safeStorage 密文（secrets.json 里一个保留槽位，见 shared/memory.ts 的
 *     EMBEDDING_KEY_SECRET_ID）。
 */
import { ipcMain } from 'electron'
import { embeddingKeyArgsSchema, IPC_CHANNELS, noArgsSchema, parseIpcArgs } from '../../shared/ipc'
import { EMBEDDING_KEY_SECRET_ID } from '../../shared/memory'
import { clearProviderKey, providerKeyState, setProviderKey } from '../secrets'
import type { ProviderKeyState } from '../../shared/providers'

export function registerMemoryIpc(options: { secretsFile: string }): void {
  const state = (): ProviderKeyState =>
    providerKeyState(options.secretsFile, EMBEDDING_KEY_SECRET_ID)

  ipcMain.handle(IPC_CHANNELS.memory.embeddingKeyState, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.memory.embeddingKeyState)
    return state()
  })

  // 写密钥：明文只活在这个局部变量里；回包只有 {hasKey:true}
  ipcMain.handle(IPC_CHANNELS.memory.setEmbeddingKey, (_event, ...args) => {
    const [key] = parseIpcArgs(embeddingKeyArgsSchema, args, IPC_CHANNELS.memory.setEmbeddingKey)
    setProviderKey(options.secretsFile, EMBEDDING_KEY_SECRET_ID, key)
    return { hasKey: true }
  })

  ipcMain.handle(IPC_CHANNELS.memory.clearEmbeddingKey, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.memory.clearEmbeddingKey)
    clearProviderKey(options.secretsFile, EMBEDDING_KEY_SECRET_ID)
    return state()
  })
}
