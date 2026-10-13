/**
 * 设置通道的 handler（IPC 契约的"服务端"）。
 * 与窗口通道同一套范式：先过 `parseIpcArgs` 入参闸门，再动作；
 * 区别是设置不作用在"发来消息的那个窗口"上，而是读写这个应用自己的 userData 目录
 * （目录在注册时传进来，测试用临时目录即可，不必 mock electron 的 app）。
 *
 * 密钥纪律（T8）：
 *   - `settings:set-provider-key` 只在**写**的方向上见到明文，回包只有 `{hasKey:true}`；
 *   - 读密钥只发生在主进程内部（模型解析 / 测试连接），密钥不出主进程；
 *   - 测试连接的失败文案会先抹掉密钥再回给渲染端（供应商可能回显）。
 */
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  providerIdArgsSchema,
  providerKeyArgsSchema,
  settingsUpdateArgsSchema
} from '../../shared/ipc'
import { providerConfigProblems, type ProviderKeyState } from '../../shared/providers'
import { testConnection } from '../connection-test'
import { probeProviderModelsQuietly } from '../model-probe'
import {
  clearProviderKey,
  getProviderKey,
  providerKeyState,
  secretsPath,
  setProviderKey
} from '../secrets'
import { readSettings, settingsPath, updateSettings } from '../settings'

export interface SettingsIpcHooks {
  /**
   * 这次落盘写了 `updateUrl` 之后的通知（round 63）：更新源是"改了就该当场生效"的一项，
   * 主进程拿它重配更新器（不必重启）。写得进去才调（写失败会抛，通知不会到）；
   * 值没真变也照调——要不要动由监听方自己比（见 main/updater.ts 的 reconfigure）。
   */
  onUpdateUrlSaved?: () => void
}

export function registerSettingsIpc(userDataDir: string, hooks: SettingsIpcHooks = {}): void {
  const file = settingsPath(userDataDir)
  const secrets = secretsPath(userDataDir)
  /** 密钥读取器（主进程内唯一的口子：safeStorage 解出来只进内存，不回渲染端、不进日志） */
  const readKey = (providerId: string): string | null => getProviderKey(secrets, providerId)

  ipcMain.handle(IPC_CHANNELS.settings.get, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.settings.get)
    return readSettings(file)
  })

  ipcMain.handle(IPC_CHANNELS.settings.update, (_event, ...args) => {
    const [patch] = parseIpcArgs(settingsUpdateArgsSchema, args, IPC_CHANNELS.settings.update)
    // 落盘失败会把错误抛回渲染端（updateSettings 不吞写失败）
    const next = updateSettings(file, patch)
    // round 63：更新源改完当场生效（不用重启）——落盘成功才通知
    if (patch.updateUrl !== undefined) hooks.onUpdateUrlSaved?.()
    // round 22：provider 保存后**后台**探一轮（元数据 + round 48 的视觉能力；不 await、不挡保存；失败静默）
    if (patch.providers !== undefined) {
      for (const provider of next.providers) {
        void probeProviderModelsQuietly({ file, readKey, providerId: provider.id })
      }
    }
    return next
  })

  // 写密钥：明文只活在这个局部变量里（不打印、不回包、不落明文）
  ipcMain.handle(IPC_CHANNELS.settings.setProviderKey, (_event, ...args) => {
    const [id, key] = parseIpcArgs(
      providerKeyArgsSchema,
      args,
      IPC_CHANNELS.settings.setProviderKey
    )
    setProviderKey(secrets, id, key)
    return { hasKey: true }
  })

  // 各 provider 的密钥状态（渲染端拿它显示"已配置 / 需要重新录入"，永远拿不到明文）
  ipcMain.handle(IPC_CHANNELS.settings.providerKeyStates, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.settings.providerKeyStates)
    const states: Record<string, ProviderKeyState> = {}
    for (const provider of readSettings(file).providers) {
      states[provider.id] = providerKeyState(secrets, provider.id)
    }
    return states
  })

  // 测试连接：配置来自落盘设置、密钥来自 secrets——测的就是聊天接下来要走的那条路
  ipcMain.handle(IPC_CHANNELS.settings.testProvider, (_event, ...args) => {
    const [id] = parseIpcArgs(providerIdArgsSchema, args, IPC_CHANNELS.settings.testProvider)
    const provider = readSettings(file).providers.find((candidate) => candidate.id === id)
    if (!provider) return { ok: false, message: `找不到 provider：${id}` }

    const apiKey = readKey(id)
    const problems = providerConfigProblems(provider, apiKey !== null)
    if (apiKey === null || problems.length > 0) {
      return { ok: false, message: problems.join('；') }
    }
    return testConnection(provider, apiKey)
  })

  // round 22 / 48：探这个 provider 的模型能力（GET /models 的元数据 + 一条真带图的 chat 定视觉）。
  // 连接测试成功 / 模型菜单打开且过期 / 写完密钥时由渲染端触发；静默失败（回当前设置）
  // ——探测是"尽力拿真实值"，不该挡用户在看的东西
  ipcMain.handle(IPC_CHANNELS.settings.probeModels, (_event, ...args) => {
    const [id] = parseIpcArgs(providerIdArgsSchema, args, IPC_CHANNELS.settings.probeModels)
    return probeProviderModelsQuietly({ file, readKey, providerId: id })
  })

  // 删配置连带清密钥：先落盘配置（写失败要抛给用户），再清密钥（事后写失败只留无害孤儿密文）
  ipcMain.handle(IPC_CHANNELS.settings.removeProvider, (_event, ...args) => {
    const [id] = parseIpcArgs(providerIdArgsSchema, args, IPC_CHANNELS.settings.removeProvider)
    const current = readSettings(file)
    if (!current.providers.some((provider) => provider.id === id)) return current

    const next = updateSettings(file, {
      providers: current.providers.filter((provider) => provider.id !== id)
    })
    clearProviderKeyQuietly(secrets, id)
    return next
  })
}

/** 清密钥的写失败不该把"配置已经删掉"的事实翻回去（孤儿密文解出来也没人认领） */
function clearProviderKeyQuietly(secrets: string, id: string): void {
  try {
    clearProviderKey(secrets, id)
  } catch (error) {
    console.warn('[kyclaw] 清理已删除 provider 的密钥失败（孤儿密文，不影响使用）', error)
  }
}
