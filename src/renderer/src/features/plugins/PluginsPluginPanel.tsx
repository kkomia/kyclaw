import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import type { MarketplaceView } from '@shared/plugins'
import type { InstalledPlugin } from '@shared/settings'

/**
 * 插件页「插件」面板（round 10）：两块——**插件市场**（添加/刷新/移除）与**插件**（跨市场汇总，安装/卸载）。
 * 市场 = git 仓库或本机目录（主进程判来源、克隆、校验清单）；插件行来自各市场的 marketplace.json，
 * 组件摘要（技能 n · MCP n）只有本地已存在的目录扫得出来（远端来源安装时才知道）。
 * 动作都经 props 抛给页面（页面拿总览、落错误）；确认框（移除市场 / 卸载）在这里。
 */
export interface PluginsPluginPanelProps {
  overview: { marketplaces: MarketplaceView[]; installed: InstalledPlugin[] } | null
  /** 动作进行中的 key（`install:<id>` / `uninstall:<id>` / `refresh:<id>` / `remove:<id>`）：按钮 loading 用 */
  busy: string | null
  onRefresh: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onInstall: (marketplaceId: string, name: string) => Promise<void>
  onUninstall: (id: string) => Promise<void>
}

/** 「技能 n · MCP n」的组件摘要（远端来源扫不出来就不写这一行） */
function componentSummary(plugin: MarketplaceView['plugins'][number]): string | null {
  if (plugin.source.kind !== 'relative') return null
  const parts: string[] = []
  if (plugin.skills.length > 0) parts.push(`技能 ${plugin.skills.length}`)
  if (plugin.mcpServers.length > 0) parts.push(`MCP ${plugin.mcpServers.length}`)
  return parts.length === 0 ? '无组件' : parts.join(' · ')
}

const ROW_CLASS =
  'flex flex-wrap items-center gap-3 rounded-control px-3 py-2.5 transition-colors duration-(--motion-fast) ease-main hover:bg-hover'

export function PluginsPluginPanel({
  overview,
  busy,
  onRefresh,
  onRemove,
  onInstall,
  onUninstall
}: PluginsPluginPanelProps): React.JSX.Element {
  /** 等确认的移除目标（市场）与卸载目标（插件记录） */
  const [removing, setRemoving] = useState<MarketplaceView | null>(null)
  const [uninstalling, setUninstalling] = useState<InstalledPlugin | null>(null)

  const marketplaces = overview?.marketplaces ?? []
  const installed = overview?.installed ?? []
  const plugins = marketplaces.flatMap((marketplace) =>
    marketplace.plugins.map((plugin) => ({ marketplace, plugin }))
  )

  return (
    <div data-testid="plugins-plugin-panel" className="flex flex-col gap-5">
      <section className="flex flex-col gap-1">
        <h2 className="px-3 text-b2 font-medium text-ink">插件市场</h2>
        {marketplaces.length === 0 ? (
          <p data-testid="marketplace-empty" className="px-3 text-b2 text-ink-secondary">
            还没有插件市场：点右上角「新增」，填 owner/repo、git 地址或本机文件夹。
          </p>
        ) : (
          marketplaces.map((marketplace) => (
            <div
              key={marketplace.id}
              data-testid={`marketplace-${marketplace.id}`}
              className={ROW_CLASS}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-b1 font-medium text-ink">{marketplace.name}</span>
                <span className="min-w-0 truncate text-c1 text-ink-tertiary">
                  {marketplace.source}
                </span>
                {marketplace.error === undefined ? null : (
                  <span
                    data-testid={`marketplace-${marketplace.id}-error`}
                    className="text-c1 text-danger"
                  >
                    {marketplace.error}
                  </span>
                )}
              </div>
              <span className="shrink-0 text-c1 text-ink-secondary">
                {marketplace.plugins.length} 个插件
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`marketplace-${marketplace.id}-refresh`}
                  loading={busy === `refresh:${marketplace.id}`}
                  disabled={busy !== null}
                  onClick={() => void onRefresh(marketplace.id)}
                >
                  刷新
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`marketplace-${marketplace.id}-remove`}
                  disabled={busy !== null}
                  onClick={() => setRemoving(marketplace)}
                >
                  移除
                </Button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="px-3 text-b2 font-medium text-ink">插件</h2>
        {plugins.length === 0 ? (
          <p data-testid="plugin-empty" className="px-3 text-b2 text-ink-secondary">
            {marketplaces.length === 0
              ? '添加市场后，这里的插件都能装进 kyclaw。'
              : '这个市场还没有插件。'}
          </p>
        ) : (
          plugins.map(({ marketplace, plugin }) => {
            const record = installed.find(
              (item) => item.marketplaceId === marketplace.id && item.name === plugin.name
            )
            const summary = componentSummary(plugin)
            return (
              <div
                key={`${marketplace.id}:${plugin.name}`}
                data-testid={`plugin-${marketplace.id}-${plugin.name}`}
                className={ROW_CLASS}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-b1 font-medium text-ink">{plugin.name}</span>
                  {plugin.description === '' ? null : (
                    <span className="min-w-0 truncate text-c1 text-ink-secondary">
                      {plugin.description}
                    </span>
                  )}
                  <span className="truncate text-c1 text-ink-tertiary">
                    {marketplace.name}
                    {summary === null ? '' : ` · ${summary}`}
                  </span>
                </div>
                {!plugin.supported ? (
                  <span className="shrink-0 text-c1 text-ink-tertiary">这种来源暂不支持</span>
                ) : record === undefined ? (
                  <Button
                    size="sm"
                    data-testid={`plugin-${marketplace.id}-${plugin.name}-install`}
                    loading={busy === `install:${marketplace.id}:${plugin.name}`}
                    disabled={busy !== null}
                    onClick={() => void onInstall(marketplace.id, plugin.name)}
                  >
                    安装
                  </Button>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      data-testid={`plugin-${marketplace.id}-${plugin.name}-state`}
                      className="text-c1 text-ink-secondary"
                    >
                      已安装
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`plugin-${marketplace.id}-${plugin.name}-uninstall`}
                      disabled={busy !== null}
                      onClick={() => setUninstalling(record)}
                    >
                      卸载
                    </Button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </section>

      {/* 移除市场：连带卸载它名下已装的插件（确认后才做） */}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        title="移除这个插件市场？"
        description={
          removing === null ? '' : `${removing.name} 下已安装的插件会一起卸载；本机目录不会被删除。`
        }
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="marketplace-remove-cancel"
              onClick={() => setRemoving(null)}
            >
              取消
            </Button>
            <Button
              data-testid="marketplace-remove-confirm"
              onClick={() => {
                const target = removing
                setRemoving(null)
                if (target !== null) void onRemove(target.id)
              }}
            >
              移除
            </Button>
          </>
        }
      />

      {/* 卸载插件：删记录 + 它带来的 MCP 条目与技能 */}
      <Dialog
        open={uninstalling !== null}
        onOpenChange={(open) => {
          if (!open) setUninstalling(null)
        }}
        title="卸载这个插件？"
        description={
          uninstalling === null ? '' : `${uninstalling.name} 带来的 MCP 服务与技能会一起移除。`
        }
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="plugin-uninstall-cancel"
              onClick={() => setUninstalling(null)}
            >
              取消
            </Button>
            <Button
              data-testid="plugin-uninstall-confirm"
              onClick={() => {
                const target = uninstalling
                setUninstalling(null)
                if (target !== null) void onUninstall(target.id)
              }}
            >
              卸载
            </Button>
          </>
        }
      />
    </div>
  )
}
