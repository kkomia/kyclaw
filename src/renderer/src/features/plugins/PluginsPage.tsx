import { Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Menu } from '@renderer/components/ui/menu'
import { fetchMcpServers, saveMcpServers } from '@renderer/lib/mcp-api'
import { newMcpServer } from '@shared/mcp'
import { PluginsMcpPanel } from './PluginsMcpPanel'
import { PluginsSkillsPanel } from './PluginsSkillsPanel'

/**
 * 插件页（R2 round 5，路由 /plugins）——左侧栏「插件」入口打开；照 Kimi 插件页版式（用户实拍 #9）：
 * 顶部 tab「技能｜MCP」→ 标题行（插件 + 一句说明 + 右上角「＋新增」）→ 页级容器里的内容。
 *
 * 入口位置：主页左栏「新建会话」按钮下方（PluginsNavItem）；设置左列不再有「工具与 MCP」——
 * MCP 的进入点就这一处。
 *
 * 「＋新增」按 ChatGPT「Add ∨」做成菜单（本地命令 stdio / 远程地址 HTTP），只在 MCP tab 出现；
 * 新加的 server 一律停用落盘（T12 口径：先把配置填对、测通了再启用），面板按 revision 重拉列表。
 * 嵌套口径（Step D）：页级容器（一张 rounded-panel）> 行；行内不再有第二层框。
 */
type PluginsTab = 'skills' | 'mcp'

const TABS: Array<{ id: PluginsTab; label: string; testId: string }> = [
  { id: 'skills', label: '技能', testId: 'plugins-tab-skills' },
  { id: 'mcp', label: 'MCP', testId: 'plugins-tab-mcp' }
]

export function PluginsPage(): React.JSX.Element {
  const [tab, setTab] = useState<PluginsTab>('skills')
  /** +1 通知 MCP 面板重拉（新增逻辑在页面侧，面板只读列表） */
  const [revision, setRevision] = useState(0)
  const [addError, setAddError] = useState<string | undefined>(undefined)

  const addServer = useCallback(async (transport: 'stdio' | 'http'): Promise<void> => {
    setAddError(undefined)
    try {
      const list = await fetchMcpServers()
      await saveMcpServers([...list, newMcpServer(list, transport)])
      setRevision((value) => value + 1)
      setTab('mcp')
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  return (
    <section
      data-testid="plugins-page"
      className="content-column animate-page-in flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
    >
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
                'border-b-2 pb-2 text-b1 transition-colors duration-(--motion-fast) ease-main',
                selected
                  ? 'border-(--text-primary) font-medium text-ink'
                  : 'border-transparent text-ink-secondary hover:text-ink'
              )}
            >
              {entry.label}
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-t1 font-medium text-ink">插件</h1>
          <p className="text-b2 text-ink-secondary">技能随应用提供；MCP 服务按需接入。</p>
        </div>
        {tab === 'mcp' ? (
          <Menu
            align="end"
            items={[
              {
                id: 'stdio',
                label: '本地命令（stdio）',
                testId: 'mcp-add-stdio',
                onSelect: () => void addServer('stdio')
              },
              {
                id: 'http',
                label: '远程地址（HTTP）',
                testId: 'mcp-add-http',
                onSelect: () => void addServer('http')
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

      {/* 页级容器（Step D 的第 1 层；行是第 2 层）——技能与 MCP 同一块面 */}
      <div className="rounded-panel bg-secondary p-4">
        {tab === 'skills' ? <PluginsSkillsPanel /> : <PluginsMcpPanel revision={revision} />}
      </div>

      {addError === undefined ? null : (
        <p data-testid="plugins-add-error" className="text-c1 text-danger">
          {addError}
        </p>
      )}
    </section>
  )
}
