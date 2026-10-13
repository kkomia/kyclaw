import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Menu } from '@renderer/components/ui/menu'
import { useSettingsStore } from '@renderer/lib/settings-store'
import {
  addPluginMarketplace,
  fetchPluginsOverview,
  installPlugin,
  refreshPluginMarketplace,
  removePluginMarketplace,
  uninstallPlugin
} from '@renderer/lib/plugins-api'
import { fetchMcpServers, saveMcpServers } from '@renderer/lib/mcp-api'
import type { PluginsOverview } from '@shared/plugins'
import { BUILTIN_PLUGINS } from './builtin-plugins'
import {
  mcpServerProblems,
  mcpServersProblems,
  newMcpServer,
  parseMcpServersJson
} from '@shared/mcp'
import { addFormToConfig, blankAddForm, type McpAddForm } from './mcp-form'
import { McpKeyValueEditor } from './McpKeyValueEditor'
import { PluginsMcpPanel } from './PluginsMcpPanel'
import { PluginsPluginPanel } from './PluginsPluginPanel'
import { PluginsSkillsPanel } from './PluginsSkillsPanel'

/**
 * 插件页（round 10 起三分区）：**插件 | MCP | 技能**（默认「插件」，标签带计数）。
 * 三层定位（用户口径）：MCP = 连接层（独立进程暴露 tools）；技能 = 知识层（SKILL.md 给 Agent 的
 * 操作手册）；**插件 = 打包分发层**（一个插件可以捆绑 skills / MCP servers 等，靠插件市场分发）。
 *
 * 「插件」分区的数据来自主进程的 `plugins:overview`（市场清单 + 插件 + 安装记录 + 已装技能）；
 * 「＋新增」菜单按分区给不同入口：插件区 = 添加插件市场（照 Codex 的三字段）；MCP 区 = round 9 的三项
 * （stdio / HTTP / 从 JSON 导入）；技能区没有新增——**技能随应用内置或随插件安装，不能单独装**（用户口径）。
 * 文案照用户口径：不解释后端（雷点 2.1/2.2）。
 */
type PluginsTab = 'plugins' | 'mcp' | 'skills'

const TABS: Array<{ id: PluginsTab; label: string; testId: string }> = [
  { id: 'plugins', label: '插件', testId: 'plugins-tab-plugins' },
  { id: 'mcp', label: 'MCP', testId: 'plugins-tab-mcp' },
  { id: 'skills', label: '技能', testId: 'plugins-tab-skills' }
]

/** 标题区随分区走（round 11，用户实拍：切 tab 时标题区不变）：h1 + 一句短副标题，不解释后端 */
const HEADINGS: Record<PluginsTab, { title: string; subtitle: string }> = {
  plugins: { title: '插件', subtitle: '从插件市场安装与管理插件' },
  mcp: { title: 'MCP', subtitle: '连接外部工具服务' },
  skills: { title: '技能', subtitle: '查看内置与插件技能' }
}

/** 导入框里的示例（placeholder 就是口径说明，不写解释性小字） */
const IMPORT_PLACEHOLDER =
  '{"mcpServers": {"perfsight": {"type": "http", "url": "https://api.perfsight.qq.com/mcp", "headers": {"Authorization": "Bearer YOUR_API_KEY"}}}}'

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

export function PluginsPage(): React.JSX.Element {
  const [tab, setTab] = useState<PluginsTab>('plugins')
  /** +1 通知 MCP 面板重拉（round 9 的 MCP 新增流程用） */
  const [revision, setRevision] = useState(0)

  /** 插件总览（round 10）：市场 + 插件 + 安装记录 + 已装技能 */
  const [overview, setOverview] = useState<PluginsOverview | null>(null)
  /** 插件区动作失败的原因（行内给，人话） */
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  /** 动作进行中的 key（按钮 loading + 禁其余动作） */
  const [busy, setBusy] = useState<string | null>(null)

  /** 添加插件市场对话框（照 Codex 三字段） */
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const [source, setSource] = useState('')
  const [ref, setRef] = useState('')
  const [sparseText, setSparseText] = useState('')
  const [adding, setAdding] = useState(false)
  const [marketplaceError, setMarketplaceError] = useState<string | undefined>(undefined)

  /** MCP 新增/导入（round 9 流程，保持原样） */
  const [addForm, setAddForm] = useState<McpAddForm | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [dialogError, setDialogError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const mcpServers = useSettingsStore((state) => state.settings.mcpServers)

  useEffect(() => {
    let alive = true
    void fetchPluginsOverview().then(
      (data) => {
        if (alive) setOverview(data)
      },
      (error: unknown) => {
        if (alive) setActionError(messageOf(error))
      }
    )
    return () => {
      alive = false
    }
  }, [])

  const run = useCallback(
    async (key: string, action: () => Promise<PluginsOverview>): Promise<void> => {
      setBusy(key)
      setActionError(undefined)
      try {
        setOverview(await action())
        // 装/卸会连带增删 mcpServers：刷新渲染端的设置副本，MCP 标签计数才不是旧的
        void useSettingsStore.getState().load()
      } catch (error) {
        setActionError(messageOf(error))
      } finally {
        setBusy(null)
      }
    },
    []
  )

  const submitMarketplace = useCallback(async (): Promise<void> => {
    setAdding(true)
    setMarketplaceError(undefined)
    try {
      const sparsePaths = sparseText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      setOverview(
        await addPluginMarketplace({
          source,
          ...(ref.trim() === '' ? {} : { ref: ref.trim() }),
          ...(sparsePaths.length === 0 ? {} : { sparsePaths })
        })
      )
      setMarketplaceOpen(false)
      setSource('')
      setRef('')
      setSparseText('')
    } catch (error) {
      setMarketplaceError(messageOf(error))
    } finally {
      setAdding(false)
    }
  }, [ref, source, sparseText])

  const openAddMcp = useCallback((transport: 'stdio' | 'http'): void => {
    setDialogError(undefined)
    setAddForm(blankAddForm(transport))
  }, [])

  const openImport = useCallback((): void => {
    setDialogError(undefined)
    setImportText('')
    setImportOpen(true)
  }, [])

  const addProblems =
    addForm === null
      ? []
      : mcpServerProblems(addFormToConfig(newMcpServer([], addForm.transport), addForm))

  const submitAddMcp = useCallback(async (): Promise<void> => {
    if (addForm === null) return
    setSaving(true)
    setDialogError(undefined)
    try {
      const list = await fetchMcpServers()
      const config = addFormToConfig(newMcpServer(list, addForm.transport), addForm)
      const problems = mcpServerProblems(config)
      if (problems.length > 0) {
        setDialogError(problems.join('；'))
        return
      }
      const tableProblems = mcpServersProblems([...list, config])
      if (tableProblems.length > 0) {
        setDialogError(tableProblems.join('；'))
        return
      }
      await saveMcpServers([...list, config])
      setRevision((value) => value + 1)
      setTab('mcp')
      setAddForm(null)
    } catch (error) {
      setDialogError(messageOf(error))
    } finally {
      setSaving(false)
    }
  }, [addForm])

  const submitImport = useCallback(async (): Promise<void> => {
    setSaving(true)
    setDialogError(undefined)
    try {
      const list = await fetchMcpServers()
      const parsed = parseMcpServersJson(importText, list)
      await saveMcpServers([...list, ...parsed])
      setRevision((value) => value + 1)
      setTab('mcp')
      setImportOpen(false)
      setImportText('')
    } catch (error) {
      setDialogError(messageOf(error))
    } finally {
      setSaving(false)
    }
  }, [importText])

  // 插件计数 = 这一栏列出的插件行数（round 48：内置插件常驻，也算在里面）
  const pluginCount =
    BUILTIN_PLUGINS.length +
    (overview?.marketplaces.reduce((total, m) => total + m.plugins.length, 0) ?? 0)
  // 技能计数 = 技能栏列出的行数（round 64：内置技能也在这一份清单里，跟着一起算）
  const skillCount = overview?.installedSkills.length ?? 0
  const counts: Record<PluginsTab, number> = {
    plugins: pluginCount,
    mcp: mcpServers.length,
    skills: skillCount
  }

  return (
    // round 23：外层全宽滚动容器（滚动条贴窗口右缘）+ 内层限宽内容列（口径不变）
    <section
      data-testid="plugins-page"
      className="animate-page-in flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div data-testid="plugins-page-column" className="content-column flex flex-col gap-6 p-6">
        <div data-testid="plugins-tabs" role="tablist" aria-label="插件分区" className="flex gap-5">
          {TABS.map((entry) => {
            const selected = tab === entry.id
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={entry.testId}
                onClick={() => setTab(entry.id)}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 pb-2 text-b1 transition-colors duration-(--motion-fast) ease-main',
                  selected
                    ? 'border-(--text-primary) font-medium text-ink'
                    : 'border-transparent text-ink-secondary hover:text-ink'
                )}
              >
                {entry.label}
                <span
                  data-testid={`${entry.testId}-count`}
                  className="text-c1 text-ink-tertiary tabular-nums"
                >
                  {counts[entry.id]}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 data-testid="plugins-title" className="text-t1 font-medium text-ink">
              {HEADINGS[tab].title}
            </h1>
            <p data-testid="plugins-subtitle" className="text-b2 text-ink-secondary">
              {HEADINGS[tab].subtitle}
            </p>
          </div>
          {tab === 'plugins' ? (
            <Menu
              align="end"
              items={[
                {
                  id: 'marketplace',
                  label: '添加插件市场',
                  testId: 'marketplace-add',
                  onSelect: () => {
                    setMarketplaceError(undefined)
                    setMarketplaceOpen(true)
                  }
                }
              ]}
              trigger={
                <Button size="sm" icon={<Plus />} data-testid="plugins-add">
                  新增
                </Button>
              }
            />
          ) : tab === 'mcp' ? (
            <Menu
              align="end"
              items={[
                {
                  id: 'stdio',
                  label: '本地命令（stdio）',
                  testId: 'mcp-add-stdio',
                  onSelect: () => openAddMcp('stdio')
                },
                {
                  id: 'http',
                  label: '远程地址（HTTP）',
                  testId: 'mcp-add-http',
                  onSelect: () => openAddMcp('http')
                },
                {
                  id: 'json',
                  label: '从 JSON 导入',
                  testId: 'mcp-add-json',
                  onSelect: openImport
                }
              ]}
              trigger={
                <Button size="sm" icon={<Plus />} data-testid="mcp-add">
                  新增
                </Button>
              }
            />
          ) : null}
        </div>

        {/* round 23：动作失败的行内错误**贴着面板顶部**（原来在页面底，被 94 行插件列表淹没，
          "移除没反应"的体感就是错误看不见） */}
        {actionError === undefined ? null : (
          <p data-testid="plugins-error" className="text-c1 text-danger">
            {actionError}
          </p>
        )}

        {/* 页级容器（Step D 的第 1 层；行是第 2 层）——三个分区同一块面 */}
        <div className="rounded-panel bg-secondary p-4">
          {tab === 'plugins' ? (
            <PluginsPluginPanel
              overview={overview}
              busy={busy}
              onRefresh={(id) => run(`refresh:${id}`, () => refreshPluginMarketplace(id))}
              onRemove={(id) => run(`remove:${id}`, () => removePluginMarketplace(id))}
              onInstall={(marketplaceId, name) =>
                run(`install:${marketplaceId}:${name}`, () => installPlugin(marketplaceId, name))
              }
              onUninstall={(id) => run(`uninstall:${id}`, () => uninstallPlugin(id))}
            />
          ) : tab === 'mcp' ? (
            <PluginsMcpPanel revision={revision} />
          ) : (
            <PluginsSkillsPanel installedSkills={overview?.installedSkills ?? []} />
          )}
        </div>

        {/* 添加插件市场（照 Codex 的 Add a marketplace：来源 / 分支或标签 / 稀疏路径） */}
        <Dialog
          open={marketplaceOpen}
          onOpenChange={(open) => {
            if (!open) setMarketplaceOpen(false)
          }}
          title="添加插件市场"
          size="md"
          footer={
            <>
              <Button
                variant="ghost"
                data-testid="marketplace-cancel"
                onClick={() => setMarketplaceOpen(false)}
              >
                取消
              </Button>
              <Button
                data-testid="marketplace-save"
                loading={adding}
                disabled={source.trim() === ''}
                onClick={() => void submitMarketplace()}
              >
                添加
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">来源</span>
              <Input
                data-testid="marketplace-source"
                value={source}
                placeholder="owner/repo、git URL 或本地文件夹"
                onChange={(event) => setSource(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">Git 分支或标签</span>
              <Input
                data-testid="marketplace-ref"
                value={ref}
                placeholder="留空 = 仓库默认分支"
                onChange={(event) => setRef(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">稀疏路径</span>
              <textarea
                data-testid="marketplace-sparse"
                aria-label="稀疏路径"
                rows={2}
                value={sparseText}
                placeholder={'每行一条，留空 = 全量检出\nplugins/foo'}
                onChange={(event) => setSparseText(event.target.value)}
                className="w-full resize-none rounded-field border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 py-2 font-mono text-c1 text-ink outline-none placeholder:text-(--text-quaternary)"
              />
            </label>
            {marketplaceError === undefined ? null : (
              <p data-testid="marketplace-error" className="text-c1 text-danger">
                {marketplaceError}
              </p>
            )}
          </div>
        </Dialog>

        {/* MCP：新增对话框（round 9 流程，原样保留） */}
        <Dialog
          open={addForm !== null}
          onOpenChange={(open) => {
            if (!open) setAddForm(null)
          }}
          title="新增 MCP 服务"
          size="md"
          footer={
            <>
              <Button variant="ghost" data-testid="mcp-add-cancel" onClick={() => setAddForm(null)}>
                取消
              </Button>
              <Button
                data-testid="mcp-add-save"
                loading={saving}
                disabled={addProblems.length > 0}
                onClick={() => void submitAddMcp()}
              >
                保存
              </Button>
            </>
          }
        >
          {addForm === null ? null : (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-b2 text-ink-secondary">名称</span>
                <Input
                  data-testid="mcp-add-name"
                  value={addForm.name}
                  onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className="text-b2 text-ink-secondary">类型</span>
                <div role="group" aria-label="传输类型" className="flex gap-3">
                  {(['http', 'stdio'] as const).map((transport) => (
                    <Chip
                      key={transport}
                      data-testid={`mcp-add-type-${transport}`}
                      aria-pressed={addForm.transport === transport}
                      className={cn(addForm.transport === transport && 'bg-selected')}
                      onClick={() => setAddForm({ ...addForm, transport })}
                    >
                      {transport === 'http' ? 'HTTP' : 'stdio'}
                    </Chip>
                  ))}
                </div>
              </div>

              {addForm.transport === 'stdio' ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-b2 text-ink-secondary">命令</span>
                    <Input
                      data-testid="mcp-add-command"
                      value={addForm.command}
                      placeholder="如 npx"
                      onChange={(event) => setAddForm({ ...addForm, command: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-b2 text-ink-secondary">参数</span>
                    <Input
                      data-testid="mcp-add-args"
                      value={addForm.argsText}
                      placeholder="如 -y @modelcontextprotocol/server-filesystem D:/notes"
                      onChange={(event) => setAddForm({ ...addForm, argsText: event.target.value })}
                    />
                  </label>
                  <div className="flex flex-col gap-1">
                    <span className="text-b2 text-ink-secondary">环境变量</span>
                    <McpKeyValueEditor
                      rows={addForm.env}
                      onChange={(env) => setAddForm({ ...addForm, env })}
                      testIdPrefix="mcp-add-env"
                      namePlaceholder="环境变量名"
                      valuePlaceholder="环境变量值"
                      addLabel="添加环境变量"
                    />
                  </div>
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-b2 text-ink-secondary">地址</span>
                    <Input
                      data-testid="mcp-add-url"
                      value={addForm.url}
                      placeholder="https://example.com/mcp"
                      onChange={(event) => setAddForm({ ...addForm, url: event.target.value })}
                    />
                  </label>
                  <div className="flex flex-col gap-1">
                    <span className="text-b2 text-ink-secondary">Headers</span>
                    <McpKeyValueEditor
                      rows={addForm.headers}
                      onChange={(headers) => setAddForm({ ...addForm, headers })}
                      testIdPrefix="mcp-add-headers"
                      namePlaceholder="Header 名称"
                      valuePlaceholder="Header 值"
                      addLabel="添加 Header"
                    />
                  </div>
                </>
              )}

              {addProblems.length > 0 ? (
                <p data-testid="mcp-add-problems" className="text-c1 text-danger">
                  {addProblems.join('；')}
                </p>
              ) : null}
              {dialogError === undefined ? null : (
                <p data-testid="mcp-add-error" className="text-c1 text-danger">
                  {dialogError}
                </p>
              )}
            </div>
          )}
        </Dialog>

        {/* MCP：从 JSON 导入（round 9 流程，原样保留） */}
        <Dialog
          open={importOpen}
          onOpenChange={(open) => {
            if (!open) setImportOpen(false)
          }}
          title="从 JSON 导入"
          size="md"
          footer={
            <>
              <Button
                variant="ghost"
                data-testid="mcp-add-json-cancel"
                onClick={() => setImportOpen(false)}
              >
                取消
              </Button>
              <Button
                data-testid="mcp-add-json-import"
                loading={saving}
                disabled={importText.trim() === ''}
                onClick={() => void submitImport()}
              >
                导入
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <textarea
              data-testid="mcp-add-json-text"
              aria-label="MCP 服务 JSON"
              rows={8}
              value={importText}
              placeholder={IMPORT_PLACEHOLDER}
              onChange={(event) => setImportText(event.target.value)}
              className="w-full resize-none rounded-field border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 py-2 font-mono text-c1 text-ink outline-none placeholder:text-(--text-quaternary)"
            />
            {dialogError === undefined ? null : (
              <p data-testid="mcp-add-json-error" className="text-c1 text-danger">
                {dialogError}
              </p>
            )}
          </div>
        </Dialog>
      </div>
    </section>
  )
}
