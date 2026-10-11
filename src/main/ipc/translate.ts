/**
 * 思考翻译的 handler（round 32）。
 *
 * 只有请求与可选密钥走 IPC：服务地址 / 模型 / 目标语言是普通设置（settings:update 的补丁里就有），
 * 模式与开关由渲染端决定"哪些思考段要翻、什么时候翻"（见 features/chat/parts 的思考块）。
 *
 * 密钥纪律与 provider / Langfuse / 嵌入密钥完全同一套：
 *   - 写方向上明文只活在局部变量里（不打印、不回包）；
 *   - 读方向只回"有没有 / 要不要重录"（ProviderKeyState）；
 *   - 落盘是 safeStorage 密文（secrets.json 的保留槽位，见 shared/translate.ts 的
 *     TRANSLATE_KEY_SECRET_ID）；请求时解出来的明文只进 Authorization 头。
 *
 * 服务地址/模型**按预置兜底**（落盘空串 = 用预置，与设置页表单同一份口径）：这样"设置页里看见的
 * 那三项"就是"真会用的那三项"。目标语言入参缺省时同样按设置兜底。
 */
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  translateKeyArgsSchema,
  translateRunArgsSchema
} from '../../shared/ipc'
import { effectiveReasoningTranslate } from '../../shared/settings'
import { TRANSLATE_KEY_SECRET_ID } from '../../shared/translate'
import {
  clearProviderKey,
  getProviderKey,
  providerKeyState,
  secretsPath,
  setProviderKey
} from '../secrets'
import { readSettings, settingsPath } from '../settings'
import { translateText } from '../translate'
import type { ProviderKeyState } from '../../shared/providers'

export function registerTranslateIpc(userDataDir: string): void {
  const file = settingsPath(userDataDir)
  const secrets = secretsPath(userDataDir)
  const state = (): ProviderKeyState => providerKeyState(secrets, TRANSLATE_KEY_SECRET_ID)

  ipcMain.handle(IPC_CHANNELS.translate.keyState, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.translate.keyState)
    return state()
  })

  // 写密钥：明文只活在这个局部变量里；回包只有 {hasKey:true}
  ipcMain.handle(IPC_CHANNELS.translate.setKey, (_event, ...args) => {
    const [key] = parseIpcArgs(translateKeyArgsSchema, args, IPC_CHANNELS.translate.setKey)
    setProviderKey(secrets, TRANSLATE_KEY_SECRET_ID, key)
    return { hasKey: true }
  })

  ipcMain.handle(IPC_CHANNELS.translate.clearKey, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.translate.clearKey)
    clearProviderKey(secrets, TRANSLATE_KEY_SECRET_ID)
    return state()
  })

  // 翻译：现读设置（改完当场生效，不必重启），密钥解出来只进 Authorization 头
  ipcMain.handle(IPC_CHANNELS.translate.run, async (_event, ...args) => {
    const [{ text, targetLanguage }] = parseIpcArgs(
      translateRunArgsSchema,
      args,
      IPC_CHANNELS.translate.run
    )
    const effective = effectiveReasoningTranslate(readSettings(file).reasoningTranslate)
    const target = targetLanguage?.trim() ?? ''
    return translateText({
      text,
      targetLanguage: target === '' ? effective.targetLanguage : target,
      baseUrl: effective.baseUrl,
      model: effective.model,
      apiKey: getProviderKey(secrets, TRANSLATE_KEY_SECRET_ID)
    })
  })
}
