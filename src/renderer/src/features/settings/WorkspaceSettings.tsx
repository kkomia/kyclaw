import { useCallback, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { workspaceModeSchema, type WorkspaceMode } from '@shared/settings'

/**
 * 设置页「工作区」组（T10）：授权目录列表 + 原生选择器添加 + 移除 + 访问模式切换。
 *
 * 分工：
 *   - 加 / 删 / 切模式都走 workspace:* 通道（主进程校验路径、落盘 settings.json 的 workspaces）；
 *   - 模式是**两档单选**（ask=每次询问 / full=完全访问），选中态直接读落盘值 —— 不做乐观改，
 *     失败时行内给原因（路径校验在主进程，这里看不到）；
 *   - 列表与模式都来自 store 的那份设置副本，组件自己不存第二份；
 *   - 路径可能很长（列表里截断），完整值走应用内的 Tooltip（不用原生 title，见雷点 4）。
 */
const MODE_LABELS: Record<WorkspaceMode, string> = {
  ask: '每次询问',
  full: '完全访问'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WorkspaceSettings(): React.JSX.Element {
  const workspaces = useSettingsStore((state) => state.settings.workspaces)
  const pickWorkspace = useSettingsStore((state) => state.pickWorkspace)
  const addWorkspace = useSettingsStore((state) => state.addWorkspace)
  const removeWorkspace = useSettingsStore((state) => state.removeWorkspace)

  /** 正在进行的动作（'pick' 或某条工作区的路径）：期间禁掉其余控件，避免连点打架 */
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const run = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setPending(key)
    setError(undefined)
    try {
      await action()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [])

  return (
    <div data-testid="workspace-settings" className="flex flex-col gap-4">
      {workspaces.length === 0 ? (
        <p data-testid="workspace-empty" className="text-b2 text-ink-secondary">
          还没有授权的工作区：添加一个文件夹，助手只能读写它里面的文件。
        </p>
      ) : (
        workspaces.map((workspace, index) => (
          <section
            key={workspace.path}
            data-testid={`workspace-${index}`}
            className="flex flex-wrap items-center gap-3 rounded-panel border border-hairline p-3"
          >
            <Tooltip label={workspace.path} side="bottom" align="start">
              <span
                data-testid={`workspace-${index}-path`}
                tabIndex={0}
                className="min-w-0 flex-1 truncate rounded-button-sm text-b2 text-ink"
              >
                {workspace.path}
              </span>
            </Tooltip>

            <div role="group" aria-label="访问模式" className="flex shrink-0 gap-3">
              {workspaceModeSchema.options.map((mode) => (
                <Chip
                  key={mode}
                  data-testid={`workspace-${index}-mode-${mode}`}
                  aria-pressed={workspace.mode === mode}
                  className={cn(workspace.mode === mode && 'bg-selected')}
                  disabled={pending !== undefined}
                  onClick={() => void run(workspace.path, () => addWorkspace(workspace.path, mode))}
                >
                  {MODE_LABELS[mode]}
                </Chip>
              ))}
            </div>

            <Button
              size="sm"
              variant="ghost"
              data-testid={`workspace-${index}-remove`}
              disabled={pending !== undefined}
              onClick={() => void run(workspace.path, () => removeWorkspace(workspace.path))}
            >
              移除
            </Button>
          </section>
        ))
      )}

      <div>
        <Button
          size="sm"
          data-testid="workspace-add"
          loading={pending === 'pick'}
          disabled={pending !== undefined && pending !== 'pick'}
          onClick={() => void run('pick', pickWorkspace)}
        >
          添加文件夹
        </Button>
      </div>

      {error === undefined ? null : (
        <p data-testid="workspace-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
