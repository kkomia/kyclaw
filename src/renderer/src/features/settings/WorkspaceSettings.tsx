import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { workspaceModeSchema, type WorkspaceMode } from '@shared/settings'

/**
 * 设置页「工作区」组（T10 起；T13 收紧 full 入口；T18 加"默认工作区"）。
 *
 * 分工：
 *   - 第一行是 **默认工作区**（T18，地位对齐 Kimi「其他 → 通用 → 存储位置」）：未指定项目的会话
 *     （侧栏直接点「新建会话」的那些）在它里面读写文件；「更改位置」走原生选择器，选中目录会以
 *     ask 并进授权列表并记为默认（主进程 `workspace:pick-default`）。
 *   - 下面是授权目录列表：加 / 删 / 切模式都走 workspace:* 通道（主进程校验路径、落盘 settings.json
 *     的 workspaces）；
 *   - 添加一律以「每次询问」落盘（`workspace:add` 不收 mode）—— **完全访问只能显式切换**：
 *     点「完全访问」先弹受控确认框（说明它会放行这个文件夹里的写操作），确认后才走 `setMode`；
 *     点「每次询问」是收紧方向，直接切；
 *   - 模式是**两档单选**，选中态直接读落盘值 —— 不做乐观改，
 *     失败时行内给原因（路径校验在主进程，这里看不到）；
 *   - 列表与模式都来自 store 的那份设置副本，组件自己不存第二份；
 *   - 路径可能很长（列表里截断），完整值走应用内的 Tooltip（不用原生 title，见雷点 4）。
 */
const MODE_LABELS: Record<WorkspaceMode, string> = {
  ask: '每次询问',
  full: '完全访问'
}

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

export function WorkspaceSettings(): React.JSX.Element {
  const workspaces = useSettingsStore((state) => state.settings.workspaces)
  const defaultWorkspace = useSettingsStore((state) => state.settings.defaultWorkspace)
  const pickWorkspace = useSettingsStore((state) => state.pickWorkspace)
  const pickDefaultWorkspace = useSettingsStore((state) => state.pickDefaultWorkspace)
  const setWorkspaceMode = useSettingsStore((state) => state.setWorkspaceMode)
  const removeWorkspace = useSettingsStore((state) => state.removeWorkspace)

  /** 正在进行的动作（'pick' / 'pick-default' 或某条工作区的路径）：期间禁掉其余控件，避免连点打架 */
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 等确认切到「完全访问」的那条工作区（null = 没有确认框） */
  const [fullTarget, setFullTarget] = useState<string | null>(null)

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

  const selectMode = (path: string, mode: WorkspaceMode): void => {
    // 收紧方向（回「每次询问」）直接切；放开方向（「完全访问」）先确认
    if (mode === 'full') {
      setFullTarget(path)
      return
    }
    void run(path, () => setWorkspaceMode(path, mode))
  }

  return (
    <div data-testid="workspace-settings" className="flex flex-col gap-4">
      {/* 默认工作区（T18）：一行「标签 + 说明 + 位置 + 更改位置」，与授权列表分开 —— 它是设置，不是一条授权 */}
      <section
        data-testid="default-workspace"
        className="flex flex-wrap items-center gap-3 rounded-panel border border-hairline p-3"
      >
        <div className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
          <span className="text-b2 text-ink">默认工作区</span>
          <span className="text-c1 text-ink-secondary">
            未指定项目的会话（新建会话）在这里读写文件。
          </span>
        </div>
        {defaultWorkspace === null ? (
          <span data-testid="default-workspace-path" className="text-b2 text-ink-tertiary">
            未指定
          </span>
        ) : (
          <Tooltip label={defaultWorkspace} side="bottom" align="start">
            <span
              data-testid="default-workspace-path"
              tabIndex={0}
              className="min-w-0 max-w-[45%] truncate rounded-button-sm text-b2 text-ink"
            >
              {defaultWorkspace}
            </span>
          </Tooltip>
        )}
        <Button
          size="sm"
          data-testid="default-workspace-change"
          loading={pending === 'pick-default'}
          disabled={pending !== undefined && pending !== 'pick-default'}
          onClick={() => void run('pick-default', pickDefaultWorkspace)}
        >
          更改位置
        </Button>
      </section>

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
                  onClick={() => selectMode(workspace.path, mode)}
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

      {/* 完全访问是放开写权限的动作：受控确认框（R12），确认后才落盘 */}
      <Dialog
        open={fullTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFullTarget(null)
        }}
        title="开启完全访问？"
        description={
          fullTarget === null
            ? ''
            : `「${fullTarget}」里的读写将不再逐次询问；移动与删除仍然会先问你。`
        }
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="workspace-full-cancel"
              onClick={() => setFullTarget(null)}
            >
              取消
            </Button>
            <Button
              data-testid="workspace-full-confirm"
              onClick={() => {
                const target = fullTarget
                setFullTarget(null)
                if (target !== null) void run(target, () => setWorkspaceMode(target, 'full'))
              }}
            >
              开启
            </Button>
          </>
        }
      />
    </div>
  )
}
