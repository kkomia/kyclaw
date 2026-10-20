import { useEffect, useState } from 'react'
import { ChevronDown, Folder } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { Input } from '@renderer/components/ui/input'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import {
  CreateProjectDialog,
  type CreateProjectMode
} from '@renderer/features/projects/CreateProjectDialog'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import {
  draftProjectChoiceOf,
  rememberDraftProjectChoice,
  takeDraftProjectChoice
} from './draft-project-choices'

/**
 * 对话页输入卡**上方**那一行左端的「选择项目」（round 64 起；round 66 定下宿主与时机）。
 *
 * 宿主与形态（round 66 用户口径："放到对话框上面，不要嵌入到里面"）：挂在对话页页脚、输入卡
 * **上面**单独一行（与卡片同列宽、左缘对齐）——**不是**卡内嵌件，也不再是卡片下方那一行。
 * 它是卡片外的独立控件：**无描边、无常态底色**（hover / 展开才铺一层浅灰），圆角走 chip 族
 * 的 `rounded-control`，高度与卡片下方那枚 PPT 胶囊同档（h-8）。
 * **只在初始页（空会话）渲染**（用户口径："进入到对话之后就不要显示这个「选择项目」了"）：
 * 与 PPT 胶囊同一个生命周期，进对话两行一起消失。
 *
 * 口径：
 *   - 没归属项目时写「选择项目」，有归属时写项目名并转成强调色；
 *   - 菜单上半截是已有项目（选中项带选中底；项目多到一屏放不下时给搜索框 + 滚动），
 *     下半截三条：**新建空白项目 / 使用现有文件夹**（复用侧栏那份 `CreateProjectDialog`，不另写创建逻辑）
 *     / **不使用文件夹**（= 服务端按 `<默认工作区>/tasks/<会话 id 前 8 位>` 分配，见 shared/session-dir.ts）；
 *   - **草稿（服务端还不认识这个会话 id）与已有会话分两条路**：
 *       已有会话 → 立刻走 projects-store 的 assignSession（PUT /api/projects/mappings）；
 *       草稿     → 只往 draft-project-choices 记一笔 + 本地补一份映射（胶囊文案、权限 chip、
 *                  附件根当场跟上；pending 一起标上，工作台按 round 49 的口径先不动手），
 *                  等服务端真有了这条会话（`threads` 里出现，即物化完成，见 sessions-store.materialize）
 *                  再补写那一笔 —— 归属是"给服务端认识的东西记账"，草稿 id 记上去是悬空的。
 *   - 动效：菜单进出场由 Menu 的配方给（overlay-in / overlay-out）；胶囊 hover / 展开态走
 *     --motion-fast 过渡，不硬切（雷点 5）。
 *   - 雷点：零 emoji；菜单里不加解释性小字（2.1/2.2）；自己不带描边/底色，圆角容器里不出现直角框（6/7）。
 */
export interface ProjectChipProps {
  /** 当前会话（null = 还没有会话，不渲染这枚胶囊） */
  threadId: string | null
}

/** 项目多到这个数以上才给搜索框：少的时候列表一眼看全，不加多余的控件（雷点 3） */
const SEARCH_MIN_PROJECTS = 6

/** 本地补一条映射（与服务端那份的形状一致；PUT 那一刻由 projects-store 自己再写一遍） */
function withMapping(
  mappings: Record<string, string>,
  threadId: string,
  projectId: string | null
): Record<string, string> {
  const next = { ...mappings }
  if (projectId === null) delete next[threadId]
  else next[threadId] = projectId
  return next
}

export function ProjectChip({ threadId }: ProjectChipProps): React.JSX.Element | null {
  const projects = useSettingsStore((state) => state.settings.projects)
  // **响应式订阅 mappings**（不要只拿 store 上的 projectOf 函数：引用恒定，映射变了不重渲染）
  const mappings = useProjectsStore((state) => state.mappings)
  /**
   * 0.2.1（PB-053）：映射通道本版下架（501）→ 这枚胶囊不出现。
   * 旧项目数据不做兼容/迁移：没有映射，"选项目"就是一个点了也不生效的入口，不给。
   */
  const unavailable = useProjectsStore((state) => state.unavailable)
  /** 这条会话服务端已经认识了（物化完成）—— 草稿与真线程的写法在这一处分岔 */
  const materialized = useSessionsStore((state) =>
    threadId === null ? false : state.threads.some((thread) => thread.id === threadId)
  )
  const [dialog, setDialog] = useState<{ mode: CreateProjectMode; key: number } | null>(null)
  const [query, setQuery] = useState('')

  /**
   * 草稿 → 真线程：物化完成那一刻把用户挑的项目补写进映射（等价于 `startNew(projectId)` 的效果）。
   * 依赖 `materialized` 这一个信号就够：它由 `threads` 推出来，物化成功与否都在这里收口。
   */
  useEffect(() => {
    if (threadId === null || !materialized) return
    const choice = takeDraftProjectChoice(threadId)
    if (choice === undefined) return
    void useProjectsStore.getState().assignSession(threadId, choice)
  }, [threadId, materialized])

  if (threadId === null || unavailable) return null

  const projectId = mappings[threadId] ?? draftProjectChoiceOf(threadId) ?? null
  const current = projects.find((project) => project.id === projectId) ?? null

  /** 选中一个项目（null = 「不使用文件夹」）：已有会话立即写，草稿只记在本地（见文件头注） */
  const choose = (nextProjectId: string | null): void => {
    if (materialized) {
      void useProjectsStore.getState().assignSession(threadId, nextProjectId)
      return
    }
    rememberDraftProjectChoice(threadId, nextProjectId)
    useProjectsStore.setState((state) => ({
      mappings: withMapping(state.mappings, threadId, nextProjectId),
      // 这份映射**服务端还没回执**：与 assignSession 的乐观补丁同一档，pending 一起标上 ——
      // 工作台三件（文件树 / Git / 终端）据此推迟第一次请求（round 49 的口径）：
      // 主进程此刻还按兜底根解析，先列一次目录就会留下"树是兜底根、标题是项目根"的旧内容，
      // 而且那次结果不会再刷新。物化那一刻 assignSession 会把它清掉，工具随即按正确的根开工。
      pending: { ...state.pending, [threadId]: true }
    }))
  }

  const trimmed = query.trim().toLowerCase()
  const visible =
    trimmed === ''
      ? projects
      : projects.filter((project) => project.name.toLowerCase().includes(trimmed))

  const items: MenuEntry[] = [
    ...(projects.length < SEARCH_MIN_PROJECTS
      ? []
      : [
          {
            id: 'search',
            type: 'custom' as const,
            content: (
              <Input
                data-testid="project-pick-search"
                aria-label="搜索项目"
                placeholder="搜索项目"
                value={query}
                // 底色分层而不是再描一道边（雷点 7）：菜单面板本身没有框线，这里也只铺一层填充；
                // 高度收到 32 与条目同高（默认 40 比菜单条目高一档，会顶乱节奏）
                className="h-8 border-transparent bg-(--fill-active)"
                // 菜单的 typeahead 会抢字符键（把焦点挪到"名字像"的那条上），让人没法连续输入 ——
                // 只把**字符键**拦在这里；Esc / 方向键照常走菜单（关菜单是 document 级的，不拦）。
                onKeyDown={(event) => {
                  if (event.key.length === 1) event.stopPropagation()
                }}
                onChange={(event) => setQuery(event.target.value)}
              />
            )
          }
        ]),
    ...(projects.length === 0
      ? [{ id: 'empty', label: '还没有项目', disabled: true }]
      : visible.length === 0
        ? [{ id: 'no-match', label: '没有匹配的项目', disabled: true }]
        : visible.map((project) => ({
            id: `project:${project.id}`,
            label: project.name,
            testId: `project-pick-${project.id}`,
            selected: projectId === project.id,
            onSelect: () => choose(project.id)
          }))),
    { id: 'sep', type: 'separator' },
    {
      id: 'new-blank',
      label: '新建空白项目',
      testId: 'project-pick-new-blank',
      // 与侧栏「项目」区的 ＋ 同一份实现（名称 + 路径表单、主进程校验/建目录/入清单/进授权列表）
      onSelect: () => setDialog({ mode: 'blank', key: Date.now() })
    },
    {
      id: 'new-folder',
      label: '使用现有文件夹',
      testId: 'project-pick-new-folder',
      onSelect: () => setDialog({ mode: 'folder', key: Date.now() })
    },
    {
      id: 'no-folder',
      label: '不使用文件夹',
      testId: 'project-pick-none',
      selected: projectId === null,
      onSelect: () => choose(null)
    }
  ]

  return (
    <>
      <Menu
        trigger={
          <button
            type="button"
            data-testid="composer-project"
            aria-label="选择项目"
            // round 66（用户口径："放到对话框上面，不要嵌入到里面"）：卡片**外**的独立顶行控件 ——
            // **无描边、无常态底色**（hover 与展开只铺一层浅灰），圆角与 chip 族一致（rounded-control）、
            // 高度与卡片下方那枚 PPT 胶囊同档（h-8），于是卡上卡下两行看着是一对。
            className={cn(
              'inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-control px-2 text-b2 transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
              current === null
                ? 'text-ink-tertiary hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink'
                : 'text-(--accent-text) hover:bg-hover data-[state=open]:bg-hover'
            )}
          >
            <Folder aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{current === null ? '选择项目' : current.name}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          </button>
        }
        items={items}
        side="top"
        align="start"
        // 项目多的时候整块菜单滚动（高度上限由 Radix 按可用空间算出来）
        className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto"
        onOpenChange={(open) => {
          // 每次开都是新的一次挑选：搜索词不留在下一次
          if (!open) setQuery('')
        }}
      />

      {/* 创建项目：与侧栏「项目」区共用同一个对话框（每次打开换 key 重挂，表单态自然归零） */}
      <CreateProjectDialog
        key={dialog?.key ?? 'closed'}
        open={dialog !== null}
        mode={dialog?.mode ?? 'blank'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        onCreated={(createdId) => choose(createdId)}
      />
    </>
  )
}
