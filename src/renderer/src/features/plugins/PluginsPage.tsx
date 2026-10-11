import { Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Menu } from '@renderer/components/ui/menu'
import { fetchMcpServers, saveMcpServers } from '@renderer/lib/mcp-api'
import {
  mcpServerProblems,
  mcpServersProblems,
  newMcpServer,
  parseMcpServersJson
} from '@shared/mcp'
import { addFormToConfig, blankAddForm, type McpAddForm } from './mcp-form'
import { McpKeyValueEditor } from './McpKeyValueEditor'
import { PluginsMcpPanel } from './PluginsMcpPanel'
import { PluginsSkillsPanel } from './PluginsSkillsPanel'

/**
 * 插件页（R2 round 5，路由 /plugins）——左侧栏「插件」入口打开；照 Kimi 插件页版式（用户实拍 #9）：
 * 顶部 tab「技能｜MCP」→ 标题行（插件 + 一句说明 + 右上角「＋新增」）→ 页级容器里的内容。
 *
 * 「＋新增」菜单（round 9 重做）：本地命令（stdio）/ 远程地址（HTTP）/ **从 JSON 导入** ——
 * 点菜单项**直接开对话框填配置**（不再先往列表落一条空草稿、再点齿轮去改；用户实拍）。
 * 打开后才校验：`mcpServerProblems` 实时行内提示，保存 = 通过校验 → 追加（**一律停用**落盘）
 * → 整表 PUT → 关对话框、面板按 revision 重拉。取消 = 什么都不发生。
 *
 * 「从 JSON 导入」吃整段 `{"mcpServers": {...}}`（可多个）或单个 server 对象，
 * 解析器在 shared/mcp.ts 的 parseMcpServersJson（纯函数）；失败保持输入、行内给人话。
 *
 * 嵌套口径（Step D）：页级容器（一张 rounded-panel）> 行；行内不再有第二层框。
 */
type PluginsTab = 'skills' | 'mcp'

const TABS: Array<{ id: PluginsTab; label: string; testId: string }> = [
  { id: 'skills', label: '技能', testId: 'plugins-tab-skills' },
  { id: 'mcp', label: 'MCP', testId: 'plugins-tab-mcp' }
]

/** 导入框里的示例（placeholder 就是口径说明，不写解释性小字） */
const IMPORT_PLACEHOLDER =
  '{"mcpServers": {"perfsight": {"type": "http", "url": "https://api.perfsight.qq.com/mcp", "headers": {"Authorization": "Bearer YOUR_API_KEY"}}}}'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PluginsPage(): React.JSX.Element {
  const [tab, setTab] = useState<PluginsTab>('skills')
  /** +1 通知 MCP 面板重拉（新增/导入在页面侧，面板只读列表） */
  const [revision, setRevision] = useState(0)
  /** 新增对话框的表单（null = 关着）；打开时按类型给空白表单 */
  const [addForm, setAddForm] = useState<McpAddForm | null>(null)
  /** 导入对话框 */
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  /** 两个对话框共用的错误位（不会同时开） */
  const [dialogError, setDialogError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const openAdd = useCallback((transport: 'stdio' | 'http'): void => {
    setDialogError(undefined)
    setAddForm(blankAddForm(transport))
  }, [])

  const openImport = useCallback((): void => {
    setDialogError(undefined)
    setImportText('')
    setImportOpen(true)
  }, [])

  /** 新增表单的实时校验（用真 schema/规则，不是另写一份）：不通过时保存钮禁用 + 行内说明 */
  const addProblems =
    addForm === null
      ? []
      : mcpServerProblems(addFormToConfig(newMcpServer([], addForm.transport), addForm))

  const submitAdd = useCallback(async (): Promise<void> => {
    if (addForm === null) return
    setSaving(true)
    setDialogError(undefined)
    try {
      // 现读列表：id 分配要避开已有项；整表保存以服务端回吐为准
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
      // 失败保持输入（不清空），错误行内给人话
      setDialogError(messageOf(error))
    } finally {
      setSaving(false)
    }
  }, [importText])

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
                onSelect: () => openAdd('stdio')
              },
              {
                id: 'http',
                label: '远程地址（HTTP）',
                testId: 'mcp-add-http',
                onSelect: () => openAdd('http')
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

      {/* 页级容器（Step D 的第 1 层；行是第 2 层）——技能与 MCP 同一块面 */}
      <div className="rounded-panel bg-secondary p-4">
        {tab === 'skills' ? <PluginsSkillsPanel /> : <PluginsMcpPanel revision={revision} />}
      </div>

      {/* 新增对话框（round 9：点菜单项直接开这里填，不再先落草稿行） */}
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
              onClick={() => void submitAdd()}
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

      {/* 从 JSON 导入（用户实拍：整段 {"mcpServers": {...}} 直接贴） */}
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
    </section>
  )
}
