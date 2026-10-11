/**
 * 联网搜索的 handler（round 45）：三个可选 Key（Exa / Tavily / Jina）的写/清/状态。
 *
 * 与 provider / Langfuse / 嵌入 / 翻译密钥完全同一套纪律：
 *   - 写方向上明文只活在局部变量里（不打印、不回包）；
 *   - 读方向只回"有没有 / 要不要重录"（ProviderKeyState）；
 *   - 落盘是 safeStorage 密文（secrets.json 的保留槽位，见 shared/search.ts 的 SEARCH_KEY_SECRET_ID）。
 *
 * **搜索请求本身不走 IPC**：它在 agent 进程里发（tools/web-search.ts），
 * 主进程只负责把 Key 从安全存储里取出来交给那一侧（见 main/index.ts 注入的 webSearch 取值函数）。
 */
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  searchClearKeyArgsSchema,
  searchSetKeyArgsSchema
} from '../../shared/ipc'
import { SEARCH_KEY_SECRET_ID, type SearchKeyTarget } from '../../shared/search'
import { clearProviderKey, providerKeyState, secretsPath, setProviderKey } from '../secrets'
import type { ProviderKeyState } from '../../shared/providers'
import type { SearchKeyStates } from '../../shared/ipc'

export function registerSearchIpc(userDataDir: string): void {
  const secrets = secretsPath(userDataDir)

  const stateOf = (target: SearchKeyTarget): ProviderKeyState =>
    providerKeyState(secrets, SEARCH_KEY_SECRET_ID[target])

  const states = (): SearchKeyStates => ({
    exa: stateOf('exa'),
    tavily: stateOf('tavily'),
    jina: stateOf('jina')
  })

  ipcMain.handle(IPC_CHANNELS.search.keyStates, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.search.keyStates)
    return states()
  })

  // 写密钥：明文只活在这个局部变量里；回包只有 {hasKey:true}
  ipcMain.handle(IPC_CHANNELS.search.setKey, (_event, ...args) => {
    const [target, key] = parseIpcArgs(searchSetKeyArgsSchema, args, IPC_CHANNELS.search.setKey)
    setProviderKey(secrets, SEARCH_KEY_SECRET_ID[target], key)
    return { hasKey: true }
  })

  ipcMain.handle(IPC_CHANNELS.search.clearKey, (_event, ...args) => {
    const [target] = parseIpcArgs(searchClearKeyArgsSchema, args, IPC_CHANNELS.search.clearKey)
    clearProviderKey(secrets, SEARCH_KEY_SECRET_ID[target])
    return states()
  })
}
