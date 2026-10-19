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
  addSkillFromUrl,
  allowSkillHost,
  fetchPluginsOverview,
  importSkillFromFile,
  importSkillFromFolder,
  installPlugin,
  refreshPluginMarketplace,
  removePluginMarketplace,
  uninstallPlugin
} from '@renderer/lib/plugins-api'
import { fetchMcpServers, saveMcpServers } from '@renderer/lib/mcp-api'
import type { PluginSkillEgressBlock, PluginsOverview } from '@shared/plugins'
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
 * （stdio / HTTP / 从 JSON 导入）；**技能区（round 94）= 从网址 / 本地文件 / 本地文件夹导入单个技能**
 * ——技能不必再随插件或整包安装才进得来（用户反馈 004），导入后落进"我的技能"一组。
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
  skills: { title: '技能', subtitle: '查看内置、我的与插件技能' }
}

/** 导入框里的示例（placeholder 就是口径说明，不写解释性小字） */
const IMPORT_PLACEHOLDER =
  '{"mcpServers": {"perfsight": {"type": "http", "url": "https://api.perfsight.qq.com/mcp", "headers": {"Authorization": "Bearer YOUR_API_KEY"}}}}'

/** 技能网址导入的口径提示（上限与"内网要先放行"都是用户会撞到的边界，写在框下面一行） */
const SKILL_URL_HINT =
  '直链 SKILL.md 或单个技能的 zip，最大 8MB；本机与内网地址默认不允许，被拦下时可以在下面点「允许这台主机」。'

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
  /** 动作成功的一句回执（round 94：导入技能后总览会变，但"新装进来的是哪一份"得说一句） */
  const [actionNotice, setActionNotice] = useState<string | undefined>(undefined)
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

  /** 技能导入（round 94）：网址对话框 + 两条原生选择器入口 */
  const [skillUrlOpen, setSkillUrlOpen] = useState(false)
  const [skillUrl, setSkillUrl] = useState('')
  const [skillUrlError, setSkillUrlError] = useState<string | undefined>(undefined)
  const [importingSkill, setImportingSkill] = useState(false)
  /** 被出站边界拦下的"可以放行"的那一档（本机/内网）：非 null 时框里给"允许访问 <主机>" */
  const [skillBlocked, setSkillBlocked] = useState<PluginSkillEgressBlock | null>(null)

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
      setActionNotice(undefined)
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

  /**
   * 技能导入的两条本地入口（round 94）：路径由主进程的原生选择器给，渲染端只递"挑文件还是挑文件夹"。
   * 取消 = `added: null`（什么都不说）；成功就刷总览并回一句"已导入 xx"。
   */
  const importLocalSkill = useCallback(async (kind: 'file' | 'folder'): Promise<void> => {
    setBusy(`skill-${kind}`)
    setActionError(undefined)
    setActionNotice(undefined)
    try {
      const result = kind === 'file' ? await importSkillFromFile() : await importSkillFromFolder()
      setOverview(result.overview)
      if (result.added !== null) setActionNotice(`已导入技能「${result.added.name}」`)
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }, [])

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

  /**
   * 从网址导入一个技能（round 94）。三条结果：
   *   - 成功 → 关框 + 回执；
   *   - **被出站边界拦下且可以放行**（本机/内网这一档）→ 框里给原因 + 作用域说明 + "允许访问 <主机>"；
   *   - 其它失败 → 行内人话。
   */
  const runSkillUrlImport = useCallback(async (): Promise<void> => {
    const result = await addSkillFromUrl(skillUrl.trim())
    setOverview(result.overview)
    setSkillBlocked(result.blocked)
    if (result.blocked === null) {
      setSkillUrlOpen(false)
      setSkillUrl('')
      if (result.added !== null) setActionNotice(`已导入技能「${result.added.name}」`)
    }
  }, [skillUrl])

  const submitSkillUrl = useCallback(async (): Promise<void> => {
    setImportingSkill(true)
    setSkillUrlError(undefined)
    setSkillBlocked(null)
    try {
      await runSkillUrlImport()
    } catch (error) {
      setSkillUrlError(messageOf(error))
    } finally {
      setImportingSkill(false)
    }
  }, [runSkillUrlImport])

  /**
   * "允许访问 <主机>"：**用户点这一下才写白名单**（没有静默放行、没有默认开）。写完用同一个网址
   * 重试一次导入 —— 用户点按钮的意图就是"导入这个"，不该让他再点一次。
   *
   * 重试若因**别的**原因失败（404 / 超时 / 包坏了），旧的"要你允许"提示必须撤掉：那一台主机已经
   * 写进白名单了，再挂着那条提示会让人以为还得点一次（重复授权），而白名单里是幂等的一条。
   */
  const allowSkillHostAndRetry = useCallback(async (): Promise<void> => {
    if (skillBlocked === null) return
    setImportingSkill(true)
    setSkillUrlError(undefined)
    try {
      await allowSkillHost(skillBlocked.host)
      await runSkillUrlImport()
    } catch (error) {
      setSkillBlocked(null)
      setSkillUrlError(messageOf(error))
    } finally {
      setImportingSkill(false)
    }
  }, [runSkillUrlImport, skillBlocked])

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
                hidden={entry.id === 'mcp'}
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
          ) : (
            // round 94：技能可以单独注册了（用户反馈 004）——网址 / 本地文件 / 本地文件夹三条入口
            <Menu
              align="end"
              items={[
                {
                  id: 'url',
                  label: '从网址导入',
                  testId: 'skill-add-url',
                  onSelect: () => {
                    setSkillUrlError(undefined)
                    setSkillBlocked(null)
                    setSkillUrl('')
                    setSkillUrlOpen(true)
                  }
                },
                {
                  id: 'file',
                  label: '从本地文件导入',
                  testId: 'skill-add-file',
                  onSelect: () => void importLocalSkill('file')
                },
                {
                  id: 'folder',
                  label: '从本地文件夹导入',
                  testId: 'skill-add-folder',
                  onSelect: () => void importLocalSkill('folder')
                }
              ]}
              trigger={
                <Button
                  size="sm"
                  icon={<Plus />}
                  loading={busy === 'skill-file' || busy === 'skill-folder'}
                  data-testid="skills-add"
                >
                  新增
                </Button>
              }
            />
          )}
        </div>

        {/* round 23：动作失败的行内错误**贴着面板顶部**（原来在页面底，被 94 行插件列表淹没，
          "移除没反应"的体感就是错误看不见） */}
        {actionError === undefined ? null : (
          <p data-testid="plugins-error" className="text-c1 text-danger">
            {actionError}
          </p>
        )}
        {actionNotice === undefined ? null : (
          <p data-testid="plugins-notice" className="text-c1 text-ink-secondary">
            {actionNotice}
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

        {/* 技能：从网址导入（round 94）。上限与"内网要先放行"写在输入框下面一行 ——
          用户会撞到这两个边界，所以先讲清，失败提示里再给一次出口 */}
        <Dialog
          open={skillUrlOpen}
          onOpenChange={(open) => {
            if (!open) setSkillUrlOpen(false)
          }}
          title="从网址导入技能"
          size="md"
          footer={
            <>
              <Button
                variant="ghost"
                data-testid="skill-url-cancel"
                onClick={() => setSkillUrlOpen(false)}
              >
                取消
              </Button>
              <Button
                data-testid="skill-url-save"
                loading={importingSkill}
                disabled={skillUrl.trim() === ''}
                onClick={() => void submitSkillUrl()}
              >
                导入
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">网址</span>
              <Input
                data-testid="skill-url-input"
                value={skillUrl}
                placeholder="https://example.com/skills/demo.zip"
                onChange={(event) => {
                  setSkillUrl(event.target.value)
                  // 换了网址，上一次那条"要放行"就作废了（白名单还没写，重新判）
                  setSkillBlocked(null)
                }}
              />
            </label>
            <p className="text-c1 text-ink-tertiary">{SKILL_URL_HINT}</p>
            {skillBlocked === null ? null : (
              <div className="flex flex-col gap-2 rounded-panel bg-secondary p-3">
                <p data-testid="skill-url-blocked" className="text-c1 text-danger">
                  {skillBlocked.message}
                </p>
                {/* 作用域如实说清：这一下写的是共用白名单，不是"只对这次导入生效"；取消不改任何东西 */}
                <p data-testid="skill-url-blocked-scope" className="text-c1 text-ink-tertiary">
                  允许访问 {skillBlocked.host} 会把这一台主机写进「本机 /
                  内网白名单」，联网抓取等工具共用同一份设置；取消不做任何改动。
                </p>
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="skill-url-allow"
                    loading={importingSkill}
                    onClick={() => void allowSkillHostAndRetry()}
                  >
                    允许访问 {skillBlocked.host}
                  </Button>
                </div>
              </div>
            )}
            {skillUrlError === undefined ? null : (
              <p data-testid="skill-url-error" className="text-c1 text-danger">
                {skillUrlError}
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
