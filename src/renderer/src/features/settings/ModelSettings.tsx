import { Plus } from 'lucide-react'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ConnectionTestResult } from '@shared/ipc'
import {
  contextWindowOf,
  overrideKeyOf,
  probedKeyOf,
  type ModelOverride,
  type ProbedModelSpec
} from '@shared/models'
import {
  withDefaultProvider,
  registeredModelsOf,
  type ProviderConfig,
  type ProviderKeyState
} from '@shared/providers'
import { ModelAddDialog } from './ModelAddDialog'
import { ProviderRow, type ProviderDraft } from './ModelProviderRow'
import { SettingsGroup } from './SettingsGroup'

/**
 * 设置页「模型」组（T8；round 48 换成"折叠列表 + 新增弹窗"的形态）。
 *
 * 分工（这几条都是既有口径，本轮不动）：
 *   - provider 配置（id/type/baseUrl/model/isDefault）落 settings.json，经 `saveProviders` 走 settings:update；
 *   - 密钥只在**写**的方向上经过渲染端（用户输入 → settings:set-provider-key），主进程加密后落
 *     safeStorage 密文；读回来的只有"已配置 / 需要重新录入"两个状态，界面永远不回显明文；
 *   - "测试连接"由主进程分项验证（连通 / 流式 / 流式工具，见 main/connection-test.ts；用户反馈 005），
 *     这里把四档结论（通过 / 失败 / 未验证 / 未执行）逐步显示，并如实带上"验证范围"
 *     ——"未验证"不算通过，也不封注册；
 *   - **能力探测没有开关**（round 48）：模型注册/密钥保存/测试连接成功后，主进程自己发探测请求
 *     （元数据 + 一条真带图的 chat，见 main/model-probe.ts）把结论写进 settings.probedModels；
 *     这一页不提供"支持看图"的手动声明，全应用（composer 的收/拒、模型菜单的标记）都按探测结论走。
 *
 * 形态（round 48，用户口径）：一屏只列**最基本信息**（名字 / 模型名 / 上下文 + **来源** / 能力图标 / 默认），
 * 点行才展开编辑；新增不再把渠道铺在页面上（那排 chips 又长又不美观），改成**组标题行右端的「新增」**
 * 开弹窗、渠道进下拉（见 ModelAddDialog）。这一组自己就是 SettingsGroup（action 槽）——按钮在
 * **圆角卡外面**，与插件页的「新增」同一套模式，别塞回卡里。半截配置（缺模型名 / 缺 Base URL；
 * anthropic 另加缺密钥）行内给具体提示——文案与模型解析处是同一句
 * （shared/providers.providerConfigProblems），不静默回落 mock。openai 兼容渠道**没有密钥不算缺项**
 * （本机 / 自建端点常这样），真要认证由服务端在测试连接时报 401。
 *
 * 用户反馈 003/004（本页新增的两件可写的东西，都落在**独立一张表** `settings.modelOverrides`）：
 *   - 上下文长度手填（键 `<providerId>:<model>`）；与探测表分开存是刻意的：探测每趟都整条重写
 *     自己的记录，手动值住在那里会被下一次探测压掉。输入框里**只放手动值**——留空 = 走实测/回退，
 *     下面那行如实写出自动值是多少、来源是"实测"还是"回退"（006 的来源标注）；
 *   - 模型显示名（004）：**只影响展示**（这一行与 composer 的模型菜单），不进任何 key / 请求 / 探测。
 *
 * 用户反馈 001 的闭环（本页补齐"选择 / 移除"这两半）：
 *   - **加**：新增弹窗里"给这条端点加模型"（见 ModelAddDialog）；
 *   - **选 / 摘**：展开行「模型」那一栏下面的注册清单 + 「管理」菜单——点一个就切过去，
 *     也能把多余的（含改错的名字）摘掉。摘完保存才落盘；草稿没动过时**原样保留**落盘的
 *     `models`（老配置没有这个键就继续没有，不会被每次保存塞一个空字段）。
 *
 * 用户反馈 012（保存反馈 + 草稿竞态）：保存成功行内给"已保存"，但**任何一次草稿修改都立刻
 * 把它收掉**（改了内容还挂着"已保存"就是在撒谎——不管改的是名称/模型/显示名/上下文/Base URL/
 * 密钥，还是 001 的「从清单移除」）。保存是异步的，所以每行还带一个"编辑序号"：只有保存期间
 * 用户没再动过，才用落盘值重置草稿并报"已保存"；动过就一个字都不覆盖，改说
 * "刚才那一份已保存；你又改了内容，改动还没保存"。同理，"先存后测"遇到保存期间又改动时
 * **不测**（那一趟测的是旧配置，结论会误导人）。
 */
type Pending = 'saving' | 'testing'

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/** 删掉 record 里的一条（草稿/状态/结果都是按 provider id 存的） */
function withoutKey<T>(record: Record<string, T>, id: string): Record<string, T> {
  const next = { ...record }
  delete next[id]
  return next
}

/** 上下文长度输入 → tokens（空 / 非法回 undefined = "不要手动值"） */
function parseContextTokens(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) return undefined
  return value
}

/** 输入非空又不是正整数 tokens：保存前拦下来报人话（不静默忽略用户写的东西） */
function contextInputInvalid(text: string): boolean {
  return text.trim() !== '' && parseContextTokens(text) === undefined
}

/** 按落盘值取一份编辑草稿（key 永远从空开始：已存的密钥不回显；上下文那一栏只放**手动值**） */
function draftOf(provider: ProviderConfig, override: ModelOverride | undefined): ProviderDraft {
  return {
    name: provider.name ?? '',
    model: provider.model,
    models: registeredModelsOf(provider).filter((model) => model !== ''),
    displayName: override?.displayName ?? '',
    contextWindow: override?.contextWindow === undefined ? '' : String(override.contextWindow),
    baseUrl: provider.baseUrl ?? '',
    key: ''
  }
}

/** 模型名清单归一并去重（空串丢掉）——草稿与落盘两侧共用同一份判据 */
function normalModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()))].filter((model) => model !== '')
}

/** 两份清单是不是同一份（顺序也算；草稿与落盘的对比用） */
function sameModels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((model, index) => model === right[index])
}

/**
 * 保存时按草稿算这条 provider 该有的手动覆盖（null = 这一条整个删掉）。
 * `typed === auto` 也算"不要手动值"：用户把实测值原样填一遍，不该因此把它冻结成手动值。
 */
function overrideAfterSave(input: {
  providerId: string
  model: string
  probed: ProbedModelSpec | undefined
  draft: ProviderDraft
}): { key: string; value: ModelOverride | null } {
  const key = overrideKeyOf(input.providerId, input.model)
  const typed = parseContextTokens(input.draft.contextWindow)
  const auto = contextWindowOf(input.model, input.probed)
  const displayName = input.draft.displayName.trim()

  const entry: ModelOverride = {}
  if (typed !== undefined && typed !== auto) entry.contextWindow = typed
  if (displayName !== '') entry.displayName = displayName
  return { key, value: Object.keys(entry).length === 0 ? null : entry }
}

/** 把一条覆盖结果并进整张表（null = 删键） */
function withOverride(
  overrides: Record<string, ModelOverride>,
  key: string,
  value: ModelOverride | null
): Record<string, ModelOverride> {
  const next = { ...overrides }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

/** 两条覆盖是不是同一份（一样就不必再写一遍落盘） */
function sameOverride(before: ModelOverride | undefined, after: ModelOverride | null): boolean {
  const left = before ?? {}
  const right = after ?? {}
  return left.contextWindow === right.contextWindow && left.displayName === right.displayName
}

export function ModelSettings(): React.JSX.Element {
  const providers = useSettingsStore((state) => state.settings.providers)
  const probedModels = useSettingsStore((state) => state.settings.probedModels)
  const modelOverrides = useSettingsStore((state) => state.settings.modelOverrides)
  const saveProviders = useSettingsStore((state) => state.saveProviders)
  const saveModelOverrides = useSettingsStore((state) => state.saveModelOverrides)
  const removeProvider = useSettingsStore((state) => state.removeProvider)

  const [addOpen, setAddOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({})
  const [keyStates, setKeyStates] = useState<Record<string, ProviderKeyState>>({})
  const [pending, setPending] = useState<Record<string, Pending | undefined>>({})
  const [results, setResults] = useState<Record<string, ConnectionTestResult | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  /** 每一行上一次保存的结果（012：保存按钮点完要有反馈；行内展示，与 error 同一套存法） */
  const [notices, setNotices] = useState<Record<string, string | undefined>>({})
  const [pageError, setPageError] = useState<string | undefined>(undefined)
  /**
   * 每一行草稿的"编辑序号"（012）：每次用户改动 +1。
   * 保存是异步的，拿它判断"这一趟保存期间用户又改过没有"——改过就**不许**用落盘值覆盖
   * 他刚敲的东西，也不许说"已保存"（用户反馈 012 的另一半：反馈不能撒谎）。
   */
  const draftRevisions = useRef<Record<string, number>>({})

  /** 用户改了这一行的草稿：序号 +1，并把上一次的保存反馈收掉（012：改了就不该还挂着"已保存"） */
  const markDraftEdited = useCallback((id: string): void => {
    draftRevisions.current[id] = (draftRevisions.current[id] ?? 0) + 1
    // 值本来就空时不换对象（React 按引用跳过重渲染；每次击键都 setState 会白渲染一轮）
    setNotices((previous) => (previous[id] === undefined ? previous : withoutKey(previous, id)))
  }, [])

  // id 集合变了（增/删 provider）就重新读密钥状态；改配置不影响状态
  const providerIds = providers.map((provider) => provider.id).join(',')

  const refreshKeyStates = useCallback(async (): Promise<void> => {
    try {
      const states = await window.kyclaw?.settings?.providerKeyStates()
      if (states) setKeyStates(states)
    } catch (error) {
      // 读不到状态只影响"已配置"徽章（显示成未配置），不该拦住整个设置页
      console.error('读取密钥状态失败', error)
    }
  }, [])

  useEffect(() => {
    void refreshKeyStates()
  }, [refreshKeyStates, providerIds])

  /** 这条 provider 的实测元数据与手动覆盖（两个键都是 `<providerId>:<model>`） */
  const probedFor = useCallback(
    (provider: ProviderConfig): ProbedModelSpec | undefined =>
      probedModels[probedKeyOf(provider.id, provider.model)],
    [probedModels]
  )
  const overrideFor = useCallback(
    (provider: ProviderConfig): ModelOverride | undefined =>
      modelOverrides[overrideKeyOf(provider.id, provider.model)],
    [modelOverrides]
  )
  const draftFor = useCallback(
    (provider: ProviderConfig): ProviderDraft => draftOf(provider, overrideFor(provider)),
    [overrideFor]
  )

  const patchDraft = useCallback(
    (provider: ProviderConfig, patch: Partial<ProviderDraft>): void => {
      setDrafts((previous) => {
        const current = previous[provider.id] ?? draftFor(provider)
        const next = { ...current, ...patch }
        if (patch.model !== undefined) {
          // 换了模型名：显示名与手动上下文那一栏跟着换到**新模型**的值
          // （覆盖记录按 `<providerId>:<model>` 存；不跟着换会把上一个模型的数字按到新模型头上）
          const override = modelOverrides[overrideKeyOf(provider.id, patch.model)]
          next.displayName = override?.displayName ?? ''
          next.contextWindow =
            override?.contextWindow === undefined ? '' : String(override.contextWindow)
        }
        return { ...previous, [provider.id]: next }
      })
      markDraftEdited(provider.id)
    },
    [draftFor, markDraftEdited, modelOverrides]
  )

  /** 草稿与落盘/生效值有没有差别（测试连接前据此决定要不要先存；口径与 save 一致） */
  const draftDirty = useCallback(
    (provider: ProviderConfig): boolean => {
      const draft = drafts[provider.id] ?? draftFor(provider)
      const override = overrideFor(provider)
      return (
        draft.name.trim() !== (provider.name ?? '') ||
        draft.model.trim() !== provider.model ||
        !sameModels(
          normalModels(draft.models),
          registeredModelsOf(provider).filter((model) => model !== '')
        ) ||
        draft.displayName.trim() !== (override?.displayName ?? '') ||
        draft.contextWindow.trim() !==
          (override?.contextWindow === undefined ? '' : String(override.contextWindow)) ||
        (provider.type === 'openai-compatible' &&
          draft.baseUrl.trim() !== (provider.baseUrl ?? '')) ||
        draft.key.trim().length > 0
      )
    },
    [draftFor, drafts, overrideFor]
  )

  /**
   * 保存一条 provider（配置 + 手动覆盖 + 可选的新密钥）；失败把原因写进行内错误，
   * 调用方能据此决定要不要继续（测试连接先存后测就靠这个返回值）。
   *
   * 012 的并发口径：保存是异步的，期间用户完全可能接着改（本机保存是毫秒级，但落盘慢/主进程
   * 卡住时就撞得上）。所以这里在动手前记两个"这一趟的身份"——**编辑序号**与**提交上去的密钥**——
   * 回来时只有序号没变才用落盘值重置草稿；序号变了就只收起那个已提交的密钥、
   * 并把反馈说成"刚才那一份已保存，你又改了内容"，既有改动一个字都不动、也不假报成功。
   */
  const save = useCallback(
    async (provider: ProviderConfig): Promise<boolean> => {
      const draft = drafts[provider.id] ?? draftFor(provider)
      if (contextInputInvalid(draft.contextWindow)) {
        setNotices((previous) => ({ ...previous, [provider.id]: undefined }))
        setErrors((previous) => ({
          ...previous,
          [provider.id]: '上下文长度要填正整数（tokens），或留空走实测/回退值'
        }))
        return false
      }
      const revisionAtStart = draftRevisions.current[provider.id] ?? 0
      const submittedKey = draft.key.trim()
      const name = draft.name.trim()
      /**
       * 注册清单（001）：草稿里没动过就**原样保留落盘值**（老配置没有这个键就继续没有，
       * 免得每次保存都往文件里塞一个多余字段）；真动过才写，并且写的就是用户动过的那一份。
       */
      const models = normalModels(draft.models)
      const initialModels = registeredModelsOf(provider).filter((model) => model !== '')
      const modelsPatch = sameModels(models, initialModels)
        ? provider.models === undefined
          ? {}
          : { models: provider.models }
        : { models }
      const next: ProviderConfig = {
        ...provider,
        name: name === '' ? undefined : name,
        model: draft.model.trim(),
        baseUrl: provider.type === 'openai-compatible' ? draft.baseUrl.trim() : undefined,
        ...modelsPatch
      }

      setPending((previous) => ({ ...previous, [provider.id]: 'saving' }))
      setErrors((previous) => ({ ...previous, [provider.id]: undefined }))
      setNotices((previous) => ({ ...previous, [provider.id]: undefined }))
      try {
        await saveProviders(
          providers.map((candidate) => (candidate.id === provider.id ? next : candidate))
        )
        // 手动覆盖（003/004）在**另一张表**里：随同一次保存落盘；没变就不多写一趟
        const { key, value } = overrideAfterSave({
          providerId: provider.id,
          model: next.model,
          probed: probedModels[probedKeyOf(provider.id, next.model)],
          draft
        })
        if (!sameOverride(modelOverrides[key], value)) {
          await saveModelOverrides(withOverride(modelOverrides, key, value))
        }
        const apiKey = submittedKey
        if (apiKey.length > 0) {
          const api = window.kyclaw?.settings
          if (!api) throw new Error('密钥通道不可用（window.kyclaw 缺失），密钥没有保存')
          await api.setProviderKey(provider.id, apiKey)
          // 新密钥刚落地：配置那一趟探测（settings:update）当时还没有 key，这里补一发
          // （元数据 + 视觉能力；后台、静默、同 provider 并发去重，见 main/model-probe.ts）
          void useSettingsStore.getState().probeModels(provider.id)
        }
        if ((draftRevisions.current[provider.id] ?? 0) !== revisionAtStart) {
          // 保存期间用户又改了：**绝不**用落盘值覆盖他刚敲的东西，也如实说这一趟存的是旧内容。
          // 只把"这一趟真提交上去的那个密钥"收掉（用户又敲了新的就留着）。
          setDrafts((previous) => {
            const current = previous[provider.id]
            if (current === undefined) return previous
            return {
              ...previous,
              [provider.id]: { ...current, key: current.key.trim() === apiKey ? '' : current.key }
            }
          })
          setNotices((previous) => ({
            ...previous,
            [provider.id]: '刚才那一份已保存；你又改了内容，改动还没保存'
          }))
          await refreshKeyStates()
          return true
        }
        // 保存期间没人动：以落盘值重置草稿（key 清空，不回显），字段回到保存后的真相
        const persisted = useSettingsStore
          .getState()
          .settings.providers.find((candidate) => candidate.id === provider.id)
        setDrafts((previous) => ({
          ...previous,
          [provider.id]: draftOf(
            persisted ?? next,
            useSettingsStore.getState().settings.modelOverrides[
              overrideKeyOf(provider.id, next.model)
            ]
          )
        }))
        setNotices((previous) => ({ ...previous, [provider.id]: '已保存' }))
        await refreshKeyStates()
        return true
      } catch (error) {
        setErrors((previous) => ({ ...previous, [provider.id]: messageOf(error) }))
        return false
      } finally {
        setPending((previous) => ({ ...previous, [provider.id]: undefined }))
      }
    },
    [
      draftFor,
      drafts,
      modelOverrides,
      probedModels,
      providers,
      refreshKeyStates,
      saveModelOverrides,
      saveProviders
    ]
  )

  /** 测试连接：有未保存的改动就先存再测（测的就是"聊天接下来要走的那条路"） */
  const test = useCallback(
    async (provider: ProviderConfig): Promise<void> => {
      setResults((previous) => ({ ...previous, [provider.id]: undefined }))
      setErrors((previous) => ({ ...previous, [provider.id]: undefined }))
      if (draftDirty(provider)) {
        const revisionAtStart = draftRevisions.current[provider.id] ?? 0
        if (!(await save(provider))) return
        // 保存期间用户又改了：这一趟测的会是**旧**配置，测出来的结论会误导人。
        // 不测——行里已经有"改动还没保存"的提示，用户再点一次就是新配置。
        if ((draftRevisions.current[provider.id] ?? 0) !== revisionAtStart) return
      }

      setPending((previous) => ({ ...previous, [provider.id]: 'testing' }))
      try {
        const api = window.kyclaw?.settings
        if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），没法测试连接')
        const result = await api.testProvider(provider.id)
        setResults((previous) => ({ ...previous, [provider.id]: result }))
        // round 22：连通了就把真实模型元数据抓回来（上下文长度/思考挡位；后台、静默）
        if (result.ok) void useSettingsStore.getState().probeModels(provider.id)
      } catch (error) {
        setErrors((previous) => ({ ...previous, [provider.id]: messageOf(error) }))
      } finally {
        setPending((previous) => ({ ...previous, [provider.id]: undefined }))
      }
    },
    [draftDirty, save]
  )

  /** 001：在已注册的模型之间切换（只改草稿的「模型」那一栏，显示名/手动上下文跟着换） */
  const pickRegisteredModel = useCallback(
    (provider: ProviderConfig, model: string): void => {
      patchDraft(provider, { model })
    },
    [patchDraft]
  )

  /** 001：把一个模型从注册清单里摘掉（当前选中的那个在行里不给摘；落盘逻辑只写"动过"的清单） */
  const dropRegisteredModel = useCallback(
    (provider: ProviderConfig, model: string): void => {
      setDrafts((previous) => {
        const current = previous[provider.id] ?? draftFor(provider)
        return {
          ...previous,
          [provider.id]: {
            ...current,
            models: current.models.filter((candidate) => candidate !== model)
          }
        }
      })
      // 这也是"改了这一行的草稿"：同样要收掉上一次的保存反馈、并让在飞的保存不敢覆盖它
      markDraftEdited(provider.id)
    },
    [draftFor, markDraftEdited]
  )

  const setDefault = useCallback(
    async (id: string): Promise<void> => {
      try {
        await saveProviders(withDefaultProvider(providers, id))
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [providers, saveProviders]
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        await removeProvider(id)
        setDrafts((previous) => withoutKey(previous, id))
        setResults((previous) => withoutKey(previous, id))
        setErrors((previous) => withoutKey(previous, id))
        setNotices((previous) => withoutKey(previous, id))
        setExpanded((previous) => withoutKey(previous, id))
        await refreshKeyStates()
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [refreshKeyStates, removeProvider]
  )

  /** 弹窗新建成功：把新行**自动展开**（用户接着就要补 key / 改模型），并刷一次密钥状态 */
  const handleAdded = useCallback(
    async (id: string): Promise<void> => {
      // 读 store 现取：这条刚经 settings:update 落盘，不靠回调闭包里那份可能还没更新的列表
      const added = useSettingsStore
        .getState()
        .settings.providers.find((provider) => provider.id === id)
      if (added) {
        setDrafts((previous) => ({
          ...previous,
          [id]: draftOf(
            added,
            useSettingsStore.getState().settings.modelOverrides[
              overrideKeyOf(added.id, added.model)
            ]
          )
        }))
      }
      setExpanded((previous) => ({ ...previous, [id]: true }))
      await refreshKeyStates()
    },
    [refreshKeyStates]
  )

  const toggle = useCallback((id: string): void => {
    setExpanded((previous) => ({ ...previous, [id]: !previous[id] }))
  }, [])

  return (
    <SettingsGroup
      title="模型"
      testId="settings-group-model"
      // round 48（用户口径）：动作在组标题行、**圆角卡外面**的右端 —— 与插件页「新增」同一套模式
      action={
        <Button size="sm" data-testid="model-add" icon={<Plus />} onClick={() => setAddOpen(true)}>
          新增
        </Button>
      }
    >
      <div data-testid="model-settings" className="flex flex-col gap-4">
        {providers.length === 0 ? (
          <p data-testid="model-empty" className="text-b2 text-ink-secondary">
            还没有模型通道：点右上角「新增」加一个。
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                open={expanded[provider.id] === true}
                onToggle={() => toggle(provider.id)}
                draft={drafts[provider.id] ?? draftFor(provider)}
                onDraftChange={(patch) => patchDraft(provider, patch)}
                keyState={keyStates[provider.id]}
                probed={probedFor(provider)}
                override={overrideFor(provider)}
                pending={pending[provider.id]}
                result={results[provider.id]}
                error={errors[provider.id]}
                notice={notices[provider.id]}
                onSave={() => void save(provider)}
                onTest={() => void test(provider)}
                onSetDefault={() => void setDefault(provider.id)}
                onRemove={() => void remove(provider.id)}
                onResetContext={() => patchDraft(provider, { contextWindow: '' })}
                onUseRegisteredModel={(model) => pickRegisteredModel(provider, model)}
                onDropRegisteredModel={(model) => dropRegisteredModel(provider, model)}
              />
            ))}
          </div>
        )}

        {pageError ? (
          <p data-testid="model-page-error" className="text-c1 text-danger">
            {pageError}
          </p>
        ) : null}

        <ModelAddDialog open={addOpen} onOpenChange={setAddOpen} onAdded={handleAdded} />
      </div>
    </SettingsGroup>
  )
}
