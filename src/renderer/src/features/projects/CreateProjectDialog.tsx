import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useState } from 'react'
import { Folder, FolderPlus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { joinProjectPath } from '@shared/projects'

/**
 * 创建项目对话框（T18；形态参考 Kimi 的「创建项目」）：项目名称* + 选择项目路径* + 取消/保存。
 *
 * 两条入口（侧栏「项目」区的 ＋ 菜单）共用这一个对话框，差别只在**路径的默认值**：
 *   - `blank`（新建空白项目）：路径 = 默认基底（settings.defaultWorkspace，没指认时是应用的
 *     workspaces 目录）下的同名子目录，随名称实时更新；保存时目录不存在就自动建；
 *   - `folder`（使用现有文件夹）：路径先空着，点路径行开原生选择器挑一个已存在的目录。
 * 两种模式下路径行都可点（挑中的目录会"钉住"路径，名称就不再改它）——与参考里那行可点的路径一致。
 *
 * 提交（名称 + 路径）交给 settings-store 的 createProject（主进程校验/建目录/入清单/进授权列表）；
 * 失败的行内原因在这里显示（比如"这个文件夹已经是一个项目"）。
 * 保存成功后回调 onCreated 让调用方选中它（开一个属于这个项目的会话）。
 */
export type CreateProjectMode = 'blank' | 'folder'

export interface CreateProjectDialogProps {
  open: boolean
  mode: CreateProjectMode
  onOpenChange: (open: boolean) => void
  /** 创建成功（已落盘）后回调：调用方在项目里开一个新会话 */
  onCreated?: (projectId: string) => void
}

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

export function CreateProjectDialog({
  open,
  mode,
  onOpenChange,
  onCreated
}: CreateProjectDialogProps): React.JSX.Element {
  const createProject = useSettingsStore((state) => state.createProject)
  const pickProjectFolder = useSettingsStore((state) => state.pickProjectFolder)
  const projectBase = useSettingsStore((state) => state.projectBase)

  const [name, setName] = useState('')
  /** 用户用选择器钉住的路径（null = 跟着名称走/还没挑） */
  const [pickedPath, setPickedPath] = useState<string | null>(null)
  const [base, setBase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 每次打开由调用方换 `key` 重挂（表单态自然归零）——所以这里只做一件事：
   * 现取基底（默认工作区可能刚被改过，不能缓存）。异步回填，挂载后开的效果。
   */
  useEffect(() => {
    let alive = true
    projectBase().then(
      (value) => {
        if (alive) setBase(value)
      },
      (cause: unknown) => {
        if (alive) setError(messageOf(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [projectBase])

  const trimmedName = name.trim()
  const path =
    pickedPath ?? (mode === 'blank' && base !== '' ? joinProjectPath(base, trimmedName) : '')
  const canSave = name.trim() !== '' && path !== '' && !busy
  const chooseFolder = useCallback(() => {
    setError(null)
    pickProjectFolder().then(
      (chosen) => {
        if (chosen !== null) setPickedPath(chosen)
      },
      (cause: unknown) => setError(messageOf(cause))
    )
  }, [pickProjectFolder])

  const submit = useCallback(() => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    createProject(name.trim(), path).then(
      (created) => {
        setBusy(false)
        onOpenChange(false)
        if (created !== null) onCreated?.(created.id)
      },
      (cause: unknown) => {
        setBusy(false)
        setError(messageOf(cause))
      }
    )
  }, [canSave, createProject, name, path, onCreated, onOpenChange])

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="创建项目"
      footer={
        <>
          <Button
            variant="ghost"
            data-testid="project-create-cancel"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button data-testid="project-create-save" disabled={!canSave} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <DialogClose />
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-b2 text-ink">
            项目名称<span className="text-danger">*</span>
          </span>
          <Input
            data-testid="project-name-input"
            aria-label="项目名称"
            placeholder="请输入文件夹名称"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              submit()
            }}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-b2 text-ink">
            选择项目路径<span className="text-danger">*</span>
          </span>
          <button
            type="button"
            data-testid="project-path-field"
            aria-label="选择项目路径"
            className={cn(
              'flex h-(--field-height) w-full items-center gap-2 rounded-field border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover'
            )}
            onClick={chooseFolder}
          >
            {pickedPath === null ? (
              <FolderPlus aria-hidden="true" />
            ) : (
              <Folder aria-hidden="true" />
            )}
            <span
              data-testid="project-path-value"
              className={cn('min-w-0 truncate', path === '' ? 'text-ink-tertiary' : 'text-ink')}
            >
              {path === '' ? '选择文件夹' : path}
            </span>
          </button>
        </div>

        {error === null ? null : (
          <p data-testid="project-create-error" className="text-c1 text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
