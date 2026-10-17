import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { withoutAllowedRule } from '@shared/permissions'
import { workspaceModeSchema, type WorkspaceMode } from '@shared/settings'

/**
 * 设置页「工作区」组（T10 起；T13 收紧 full 入口；T18 加"默认工作区"；round 75 加"工作区之外"档）。
 *
 * 分工：
 *   - 第一行是 **默认工作区**（T18，地位对齐 Kimi「其他 → 通用 → 存储位置」）：未指定项目的会话
 *     （侧栏直接点「新建会话」的那些）在它里面读写文件；「更改位置」走原生选择器，选中目录会以
 *     ask 并进授权列表并记为默认（主进程 `workspace:pick-default`）。
 *   - 下面是授权目录列表：加 / 删 / 切模式都走 workspace:* 通道（主进程校验路径、落盘 settings.json
 *     的 workspaces）。**这一栏是「工作区内」那一档**（每个文件夹一条）；
 *   - **「工作区之外」那一档**（round 75）是另一条：碰授权文件夹以外的东西（删除、移动、bash 命令里
 *     的区外路径）怎么办。默认「每次询问」；用户显式切「完全访问」= 区外也免审（他设了就照办）。
 *     这一条走 `settings:update` 的补丁（`outsideWorkspaceMode` 是顶层字段，不参与规则表的整对象替换）。
 *     两档分开摆，是为了让用户看得出"为什么这个删了没问、那个问了"；
 *   - 添加一律以「每次询问」落盘（`workspace:add` 不收 mode）—— **完全访问只能显式切换**：
 *     点「完全访问」先弹受控确认框（说明它会放行哪个范围），确认后才落盘；点「每次询问」是收紧方向，
 *     直接切（两条档位同一口径）；
 *   - 模式是**两档单选**，选中态直接读落盘值 —— 不做乐观改，
 *     失败时行内给原因（路径校验在主进程，这里看不到）；
 *   - 列表与模式都来自 store 的那份设置副本，组件自己不存第二份；
 *   - 路径可能很长（列表里截断），完整值走应用内的 Tooltip（不用原生 title，见雷点 4）；
 *   - round 71 起把「已记住的允许」（`settings.permissions.rules`）也列在这里（工具 + 文件夹，
 *     逐条撤销）：在那之前这张表只增不减、没有任何界面读它，用户点过「永久允许」后既看不见
 *     也收不回。撤销走 settings 通道整表替换，失败由行内错误条承接。
 */
const MODE_LABELS: Record<WorkspaceMode, string> = {
  ask: '每次询问',
  full: '完全访问'
}

/** 等确认才切「完全访问」的那一条：某个文件夹的档位 / 「工作区之外」那一档（round 75） */
type FullRequest = { kind: 'workspace'; path: string } | { kind: 'outside' }

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

export function WorkspaceSettings(): React.JSX.Element {
  const workspaces = useSettingsStore((state) => state.settings.workspaces)
  const defaultWorkspace = useSettingsStore((state) => state.settings.defaultWorkspace)
  const outsideMode = useSettingsStore((state) => state.settings.outsideWorkspaceMode)
  const permissionRules = useSettingsStore((state) => state.settings.permissions.rules)
  const pickWorkspace = useSettingsStore((state) => state.pickWorkspace)
  const pickDefaultWorkspace = useSettingsStore((state) => state.pickDefaultWorkspace)
  const setWorkspaceMode = useSettingsStore((state) => state.setWorkspaceMode)
  const removeWorkspace = useSettingsStore((state) => state.removeWorkspace)

  /** 正在进行的动作（'pick' / 'pick-default' / 'outside' 或某条工作区的路径）：期间禁掉其余控件 */
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 等确认切到「完全访问」的那一条（null = 没有确认框） */
  const [fullRequest, setFullRequest] = useState<FullRequest | null>(null)

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
      setFullRequest({ kind: 'workspace', path })
      return
    }
    void run(path, () => setWorkspaceMode(path, mode))
  }

  /**
   * 「工作区之外」那一档（round 75）：走 settings:update 的补丁（顶层字段 `outsideWorkspaceMode`），
   * 落盘回吐为准、失败行内报错 —— 与本文件其它动作同口径。
   * `requestOutsideMode` 是**入口**（放开方向先过确认框），`applyOutsideMode` 是真正落盘的那个 ——
   * 确认框里调后面那个，免得确认完又走一遍确认。
   */
  const applyOutsideMode = (mode: WorkspaceMode): void =>
    void run('outside', async () => {
      const api = window.kyclaw?.settings
      if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），改动没有保存')
      useSettingsStore.setState({ settings: await api.update({ outsideWorkspaceMode: mode }) })
    })

  const requestOutsideMode = (mode: WorkspaceMode): void => {
    if (mode === 'full') {
      setFullRequest({ kind: 'outside' })
      return
    }
    applyOutsideMode(mode)
  }

  /**
   * 撤销一条「永久允许」（round 71）：在这之前规则只增不减 —— 审批卡写进去之后既看不见也收不回。
   * 走 settings 通道整表替换（与本文件其它动作同口径：**以落盘回吐为准**，写不进去要看得见），
   * 失败由 run 的行内错误条承接。
   */
  const revokeRule = (tool: string, workspace: string): void =>
    void run(`rule:${tool}:${workspace}`, async () => {
      const api = window.kyclaw?.settings
      if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），改动没有保存')
      const rules = withoutAllowedRule(permissionRules, tool, workspace)
      useSettingsStore.setState({ settings: await api.update({ permissions: { rules } }) })
    })

  return (
    <div data-testid="workspace-settings" className="flex flex-col gap-4">
      {/* 默认工作区（T18）：一行「标签 + 说明 + 位置 + 更改位置」，与授权列表分开 —— 它是设置，不是一条授权 */}
      <section
        data-testid="default-workspace"
        className="flex flex-wrap items-center gap-3 border-t border-hairline p-3"
      >
        <div className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
          <span className="text-b2 text-ink">默认工作区</span>
          <span className="text-c1 text-ink-secondary">
            未指定项目的会话（新建会话）在这里读写文件，每个会话一个子目录；更改位置不会自动移动已有文件。
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

      {/* round 75：**工作区之外**那一档。与下面每个文件夹自己的档位**分开摆** —— 用户要能看出
          "为什么这个删了没问、那个问了"：一条管文件夹里面，一条管文件夹以外。 */}
      <section
        data-testid="outside-mode"
        className="flex flex-wrap items-center gap-3 border-t border-hairline p-3"
      >
        <div className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
          <span className="text-b2 text-ink">工作区之外</span>
          <span className="text-c1 text-ink-secondary">
            碰授权文件夹以外的东西（删除、移动、命令里的区外路径）怎么办。默认每次询问。
          </span>
        </div>
        <div role="group" aria-label="工作区之外的访问档" className="flex shrink-0 gap-3">
          {workspaceModeSchema.options.map((mode) => (
            <Chip
              key={mode}
              data-testid={`outside-mode-${mode}`}
              aria-pressed={outsideMode === mode}
              className={cn(outsideMode === mode && 'bg-selected')}
              disabled={pending !== undefined}
              onClick={() => requestOutsideMode(mode)}
            >
              {MODE_LABELS[mode]}
            </Chip>
          ))}
        </div>
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
            className="flex flex-wrap items-center gap-3 border-t border-hairline p-3"
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

            <div role="group" aria-label="访问模式" className="flex shrink-0 items-center gap-3">
              <span className="text-c1 text-ink-tertiary">工作区内</span>
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

      {/* round 71：已记住的「永久允许」（settings.permissions.rules）—— 在这之前这张表只增不减、
          全仓没有任何界面读它：用户在审批卡上点过「永久允许」之后，既看不见它、也收不回它，
          只能手改 settings.json。这里把它列出来（工具 + 文件夹）并逐条撤销。
          工具名按**整名**显示（与服务端规则匹配同一把尺），MCP 工具就是 `mcp__<id>__<tool>` 原样。 */}
      <section data-testid="permission-rules" className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-b2 text-ink">已记住的允许</span>
          <span className="text-c1 text-ink-secondary">
            在审批卡上点过「永久允许」的工具，在这些文件夹里不再逐次询问。撤销后下次会重新询问。
          </span>
        </div>
        {permissionRules.length === 0 ? (
          <p data-testid="permission-rules-empty" className="text-b2 text-ink-tertiary">
            还没有记住任何允许
          </p>
        ) : (
          permissionRules.map((rule, index) => (
            <div
              key={`${rule.tool}\u0000${rule.workspace}\u0000${index}`}
              data-testid={`permission-rule-${index}`}
              className="flex flex-wrap items-center gap-3 border-t border-hairline p-3"
            >
              <span
                data-testid={`permission-rule-${index}-tool`}
                className="shrink-0 text-b2 text-ink"
              >
                {rule.tool}
              </span>
              <Tooltip label={rule.workspace} side="bottom" align="start">
                <span
                  data-testid={`permission-rule-${index}-workspace`}
                  tabIndex={0}
                  className="min-w-0 flex-1 truncate rounded-button-sm font-mono text-c1 text-ink-secondary"
                >
                  {rule.workspace}
                </span>
              </Tooltip>
              <Button
                size="sm"
                variant="ghost"
                data-testid={`permission-rule-${index}-revoke`}
                disabled={pending !== undefined}
                onClick={() => revokeRule(rule.tool, rule.workspace)}
              >
                撤销
              </Button>
            </div>
          ))
        )}
      </section>

      {error === undefined ? null : (
        <p data-testid="workspace-error" className="text-c1 text-danger">
          {error}
        </p>
      )}

      {/* 完全访问是放开权限的动作：受控确认框（R12），确认后才落盘。两条档位共用这一个框 ——
          文案说清"放开的到底是哪一块"（文件夹里面 / 文件夹以外）。 */}
      <Dialog
        open={fullRequest !== null}
        onOpenChange={(open) => {
          if (!open) setFullRequest(null)
        }}
        title="开启完全访问？"
        description={
          fullRequest === null
            ? ''
            : fullRequest.kind === 'outside'
              ? '授权文件夹以外的操作也不再逐次询问：删除、移动、命令里的区外路径都照办。'
              : `「${fullRequest.path}」里的读写、删除、移动都不再逐次询问；文件夹以外的东西仍按「工作区之外」那一档判。`
        }
        footer={
          <>
            <Button
              variant="ghost"
              data-testid={
                fullRequest?.kind === 'outside' ? 'outside-full-cancel' : 'workspace-full-cancel'
              }
              onClick={() => setFullRequest(null)}
            >
              取消
            </Button>
            <Button
              data-testid={
                fullRequest?.kind === 'outside' ? 'outside-full-confirm' : 'workspace-full-confirm'
              }
              onClick={() => {
                const request = fullRequest
                setFullRequest(null)
                if (request === null) return
                if (request.kind === 'outside') applyOutsideMode('full')
                else void run(request.path, () => setWorkspaceMode(request.path, 'full'))
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
