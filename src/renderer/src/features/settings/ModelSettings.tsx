import { Plus } from 'lucide-react'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ConnectionTestResult } from '@shared/ipc'
import { probedKeyOf } from '@shared/models'
import { withDefaultProvider, type ProviderConfig, type ProviderKeyState } from '@shared/providers'
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
 *   - "测试连接"由主进程发一条最小请求（见 main/connection-test.ts），这里只展示延迟或错误文案；
 *   - **能力探测没有开关**（round 48）：模型注册/密钥保存/测试连接成功后，主进程自己发探测请求
 *     （元数据 + 一条真带图的 chat，见 main/model-probe.ts）把结论写进 settings.probedModels；
 *     这一页不提供"支持看图"的手动声明，全应用（composer 的收/拒、模型菜单的标记）都按探测结论走。
 *
 * 形态（round 48，用户口径）：一屏只列**最基本信息**（名字 / 上下文 / 能力图标 / 默认），点行才
 * 展开编辑；新增不再把渠道铺在页面上（那排 chips 又长又不美观），改成**组标题行右端的「新增」**
 * 开弹窗、渠道进下拉（见 ModelAddDialog）。这一组自己就是 SettingsGroup（action 槽）——按钮在
 * **圆角卡外面**，与插件页的「新增」同一套模式，别塞回卡里。半截配置（缺模型名 / 缺 Base URL /
 * 缺密钥）行内给具体提示——文案与模型解析处是同一句（shared/providers.providerConfigProblems），
 * 不静默回落 mock。
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

/** 按落盘值取一份编辑草稿（key 永远从空开始：已存的密钥不回显） */
function draftOf(provider: ProviderConfig): ProviderDraft {
  return { model: provider.model, baseUrl: provider.baseUrl ?? '', key: '' }
}

export function ModelSettings(): React.JSX.Element {
  const providers = useSettingsStore((state) => state.settings.providers)
  const probedModels = useSettingsStore((state) => state.settings.probedModels)
  const saveProviders = useSettingsStore((state) => state.saveProviders)
  const removeProvider = useSettingsStore((state) => state.removeProvider)

  const [addOpen, setAddOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({})
  const [keyStates, setKeyStates] = useState<Record<string, ProviderKeyState>>({})
  const [pending, setPending] = useState<Record<string, Pending | undefined>>({})
  const [results, setResults] = useState<Record<string, ConnectionTestResult | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [pageError, setPageError] = useState<string | undefined>(undefined)

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

  const patchDraft = useCallback(
    (provider: ProviderConfig, patch: Partial<ProviderDraft>): void => {
      setDrafts((previous) => ({
        ...previous,
        [provider.id]: { ...(previous[provider.id] ?? draftOf(provider)), ...patch }
      }))
    },
    []
  )

  /** 保存一条 provider（配置 + 可选的新密钥）；失败把原因写进行内错误，调用方能据此决定要不要继续 */
  const save = useCallback(
    async (provider: ProviderConfig): Promise<boolean> => {
      const draft = drafts[provider.id] ?? draftOf(provider)
      const next: ProviderConfig = {
        ...provider,
        model: draft.model.trim(),
        baseUrl: provider.type === 'openai-compatible' ? draft.baseUrl.trim() : undefined
      }

      setPending((previous) => ({ ...previous, [provider.id]: 'saving' }))
      setErrors((previous) => ({ ...previous, [provider.id]: undefined }))
      try {
        await saveProviders(
          providers.map((candidate) => (candidate.id === provider.id ? next : candidate))
        )
        const key = draft.key.trim()
        if (key.length > 0) {
          const api = window.kyclaw?.settings
          if (!api) throw new Error('密钥通道不可用（window.kyclaw 缺失），密钥没有保存')
          await api.setProviderKey(provider.id, key)
          // 新密钥刚落地：配置那一趟探测（settings:update）当时还没有 key，这里补一发
          // （元数据 + 视觉能力；后台、静默、同 provider 并发去重，见 main/model-probe.ts）
          void useSettingsStore.getState().probeModels(provider.id)
        }
        // 以落盘值重置草稿：key 清空（不回显），字段回到保存后的真相
        setDrafts((previous) => ({ ...previous, [provider.id]: draftOf(next) }))
        await refreshKeyStates()
        return true
      } catch (error) {
        setErrors((previous) => ({ ...previous, [provider.id]: messageOf(error) }))
        return false
      } finally {
        setPending((previous) => ({ ...previous, [provider.id]: undefined }))
      }
    },
    [drafts, providers, refreshKeyStates, saveProviders]
  )

  /** 测试连接：有未保存的改动就先存再测（测的就是"聊天接下来要走的那条路"） */
  const test = useCallback(
    async (provider: ProviderConfig): Promise<void> => {
      const draft = drafts[provider.id] ?? draftOf(provider)
      const dirty =
        draft.model.trim() !== provider.model ||
        (provider.type === 'openai-compatible' &&
          draft.baseUrl.trim() !== (provider.baseUrl ?? '')) ||
        draft.key.trim().length > 0

      setResults((previous) => ({ ...previous, [provider.id]: undefined }))
      setErrors((previous) => ({ ...previous, [provider.id]: undefined }))
      if (dirty && !(await save(provider))) return

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
    [drafts, save]
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
      if (added) setDrafts((previous) => ({ ...previous, [id]: draftOf(added) }))
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
            {providers.map((provider) => {
              const draft = drafts[provider.id] ?? draftOf(provider)
              return (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  open={expanded[provider.id] === true}
                  onToggle={() => toggle(provider.id)}
                  draft={draft}
                  onDraftChange={(patch) => patchDraft(provider, patch)}
                  keyState={keyStates[provider.id]}
                  probed={probedModels[probedKeyOf(provider.id, provider.model)]}
                  pending={pending[provider.id]}
                  result={results[provider.id]}
                  error={errors[provider.id]}
                  onSave={() => void save(provider)}
                  onTest={() => void test(provider)}
                  onSetDefault={() => void setDefault(provider.id)}
                  onRemove={() => void remove(provider.id)}
                />
              )
            })}
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
