import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { Popover } from '@renderer/components/ui/popover'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import {
  PPT_CANVAS,
  PPT_TEMPLATE_CATEGORIES,
  PPT_THEMES,
  coverPlan,
  lookupTemplate,
  templatesOf,
  type PptBox,
  type PptTemplate,
  type PptTemplateCategory,
  type PptTheme
} from '@shared/ppt-templates'
import { usePptTemplatesStore } from './ppt-templates-store'

/**
 * 对话页的 **PPT 能力胶囊 + 模板画廊**（round 63）：输入卡正下方那一条。
 *
 * 口径：
 *   - 胶囊：没选模板显示「PPT」（= 自动挑），选了显示「PPT · 模板名」并转成强调态，
 *     右侧多一枚 ×（点它回自动）；点胶囊开/关画廊。**只做 PPT 一个**，其余能力后面按同一条加。
 *   - 画廊：分类标签行（全部 + 四类）+ 四列卡片网格（十套一屏放得下）；每张卡是 **16:9 的封面缩影** ——
 *     形状与颜色照 shared/ppt-templates 的 `coverPlan` / `motifBoxes` 画（与生成侧的 pptx 封面
 *     同一份英寸几何），不是占位色块；卡片下写模板名。
 *   - **选择是会话级的**（round 66）：`threadId` → 模板名（会话↔模板映射，见 ppt-templates-store），
 *     下一轮**这个会话**的 create_ppt 不指定 theme 时就用它；别的会话一条都读不到 ——
 *     新会话（草稿）= 没选，界面上不预选任何模板。
 *   - 动效：浮层进出场由 Popover 的配方给（overlay-in / overlay-out）；标签切换、卡片 hover 抬升、
 *     选中描边都走 --motion-main 过渡（雷点 5：不允许硬切）。
 *   - 雷点：零 emoji；不用小字解释；卡片只在圆角容器内放圆角缩略图（不套直角框线）。
 */

/** 画廊里「全部」那一档（null = 不过滤；分类 id 见 PPT_TEMPLATE_CATEGORIES） */
type GalleryFilter = PptTemplateCategory | null

/** 预览卡的坐标单位：viewBox 直接就是**英寸**（10 × 5.625），于是几何与生成侧一个字都不差 */
const PREVIEW_VIEW_BOX = `0 0 ${PPT_CANVAS.w} ${PPT_CANVAS.h}`

/** 预览里把标题 / 副标题画成色条时的占宽比（照封面上的实际观感：标题长、副标题短） */
const TITLE_BAR_RATIO = { left: 0.62, center: 0.56 } as const
const SUBTITLE_BAR_RATIO = { left: 0.42, center: 0.34 } as const
/** 色条高度（英寸；约等于 40pt / 18pt 字在封面上的字形高度） */
const TITLE_BAR_HEIGHT = 0.5
const SUBTITLE_BAR_HEIGHT = 0.22

/** 把一个排版盒缩成居中/左对齐的色条（缩略图上不放真字：位置与颜色才是构图信息） */
function barOf(
  box: PptBox,
  widthRatio: number,
  height: number,
  align: 'left' | 'center'
): { x: number; y: number; width: number; height: number } {
  const width = box.w * widthRatio
  return {
    x: align === 'center' ? box.x + (box.w - width) / 2 : box.x,
    y: box.y + (box.h - height) / 2,
    width,
    height
  }
}

/**
 * 封面缩影（16:9）：底色 + 装饰 + 标题条 + 强调短线 + 副标题条 —— 五个层次都照 coverPlan 摆，
 * 颜色全部取自该模板的 token。样式与选中的模板一一对应，画廊里扫一眼就能比出差别。
 */
export function PptCoverPreview({ theme }: { theme: PptTheme }): React.JSX.Element {
  const plan = coverPlan(theme)
  const title = barOf(plan.title, TITLE_BAR_RATIO[plan.align], TITLE_BAR_HEIGHT, plan.align)
  const subtitle = barOf(
    plan.subtitle,
    SUBTITLE_BAR_RATIO[plan.align],
    SUBTITLE_BAR_HEIGHT,
    plan.align
  )

  return (
    <svg aria-hidden="true" viewBox={PREVIEW_VIEW_BOX} className="block w-full">
      <rect
        data-part="bg"
        x="0"
        y="0"
        width={PPT_CANVAS.w}
        height={PPT_CANVAS.h}
        fill={`#${theme.bg}`}
      />
      {plan.decor.map((box, index) => (
        <rect
          key={index}
          data-part="decor"
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          fill={`#${theme.accent}`}
        />
      ))}
      <rect
        data-part="title"
        x={title.x}
        y={title.y}
        width={title.width}
        height={title.height}
        rx="0.04"
        fill={`#${theme.title}`}
      />
      <rect
        data-part="rule"
        x={plan.rule.x}
        y={plan.rule.y}
        width={plan.rule.w}
        height={plan.rule.h}
        fill={`#${theme.accent}`}
      />
      <rect
        data-part="subtitle"
        x={subtitle.x}
        y={subtitle.y}
        width={subtitle.width}
        height={subtitle.height}
        rx="0.03"
        fill={`#${theme.muted}`}
      />
    </svg>
  )
}

interface CategoryTabProps {
  /** null = 「全部」 */
  category: GalleryFilter
  label: string
  active: boolean
  onPick: (category: GalleryFilter) => void
}

/** 分类标签（选中态铺底 + 变色；切换有过渡，不硬切） */
function CategoryTab({ category, label, active, onPick }: CategoryTabProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`ppt-category-${category ?? 'all'}`}
      aria-pressed={active}
      onClick={() => onPick(category)}
      className={cn(
        'inline-flex h-7 items-center rounded-pill px-2.5 text-b2 transition-colors duration-(--motion-main) ease-main motion-reduce:transition-none',
        active
          ? 'bg-selected text-(--accent-text)'
          : 'text-ink-secondary hover:bg-hover hover:text-ink'
      )}
    >
      {label}
    </button>
  )
}

interface TemplateCardProps {
  template: PptTemplate
  selected: boolean
  onPick: (name: string) => void
}

/** 模板卡：16:9 封面缩影 + 名字（hover 抬升、选中描边 + 铺底） */
function TemplateCard({ template, selected, onPick }: TemplateCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`ppt-template-${template.name}`}
      aria-pressed={selected}
      onClick={() => onPick(template.name)}
      className={cn(
        'flex flex-col gap-1.5 rounded-control p-1.5 text-left transition-[transform,background-color] duration-(--motion-main) ease-main hover:-translate-y-0.5 hover:bg-hover motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        selected && 'bg-selected hover:bg-selected'
      )}
    >
      <span
        className={cn(
          'block overflow-hidden rounded-button-lg border-(length:--hairline-width) transition-colors duration-(--motion-main) ease-main motion-reduce:transition-none',
          selected ? 'border-(--accent)' : 'border-hairline'
        )}
      >
        <PptCoverPreview theme={PPT_THEMES[template.name]} />
      </span>
      <span
        className={cn(
          'truncate text-b2 transition-colors duration-(--motion-main) ease-main motion-reduce:transition-none',
          selected ? 'text-(--accent-text)' : 'text-ink-secondary'
        )}
      >
        {template.name}
      </span>
    </button>
  )
}

export interface PptTemplateGalleryProps {
  /** 当前选中的模板名（空串 / 不认得 = 没选） */
  selected: string
  onPick: (name: string) => void
}

/**
 * 画廊：分类标签行 + 四列卡片网格（内容全部来自共享注册表，加模板不用改这里）。
 *
 * 尺寸的两条硬口径（都来自实测：默认窗口 1280×800、输入卡居中时的初始页）：
 *   1. 四列 × 三行正好放下十套模板（不用滚动），整块 ≈386px 高 —— 必须能被浮层**完整放进**
 *      窗口一侧，否则 Radix 会把它顶出视口（分类标签行被切在屏幕外，点不到）；
 *   2. 网格给一个**固定最小高**（三行）：切分类时卡片数变了、浮层高度不变，面板不会上下跳。
 */
export function PptTemplateGallery({
  selected,
  onPick
}: PptTemplateGalleryProps): React.JSX.Element {
  const [filter, setFilter] = useState<GalleryFilter>(null)

  return (
    <div data-testid="ppt-template-gallery" className="w-[34rem]">
      <div className="flex flex-wrap items-center gap-1">
        <CategoryTab category={null} label="全部" active={filter === null} onPick={setFilter} />
        {PPT_TEMPLATE_CATEGORIES.map((category) => (
          <CategoryTab
            key={category.id}
            category={category.id}
            label={category.label}
            active={filter === category.id}
            onPick={setFilter}
          />
        ))}
      </div>

      <div className="mt-3 grid min-h-[21rem] grid-cols-4 content-start gap-2">
        {templatesOf(filter).map((template) => (
          <TemplateCard
            key={template.name}
            template={template}
            selected={selected === template.name}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  )
}

export interface PptTemplateChipProps {
  /** 当前会话（胶囊显示与写入都按它走；没有会话就没有可记的地方，故非空） */
  threadId: string
  /**
   * 画廊的展开方向：初始页朝下（输入卡上方是空的）、对话页朝上（下方已经贴窗口底）。
   * Radix 自己还会做碰撞避让（避不开就翻边），所以给错方向也只是"先试这个方向"。
   */
  side?: 'top' | 'bottom'
}

/**
 * PPT 胶囊：开合画廊、显示**本会话**的选择、一键清回自动（round 66：选择是会话级的）。
 *
 * 两条路（与「选择项目」胶囊同一口径）：
 *   - **已有会话**（服务端认识它）→ 选中即写映射（PUT /api/ppt/templates），失败由 store 回滚并记日志；
 *   - **草稿**（还没物化）→ 只记本地（服务端 id 还没有真身，写上去是悬空的），
 *     物化完成那一刻由 sessions-store 补写那一笔（见 ppt-templates-store 头注）。
 * 界面上不另开错误行（雷点 2），失败落 console（排障有落点）。
 */
export function PptTemplateChip({
  threadId,
  side = 'top'
}: PptTemplateChipProps): React.JSX.Element {
  // **响应式订阅**（不要只拿 store 上的 templateOf 函数：引用恒定，映射变了不重渲染）
  const templates = usePptTemplatesStore((state) => state.templates)
  /** 这条会话服务端已经认识了（物化完成）—— 草稿与真线程的写法在这一处分岔 */
  const materialized = useSessionsStore((state) =>
    state.threads.some((thread) => thread.id === threadId)
  )
  const [open, setOpen] = useState(false)
  // 映射里可能留着过期 / 认不出的名字（老模板被删、手工改过库）：只认注册表里有的，其余按"没选"画
  const selected = templates[threadId] ?? ''
  const chosen = lookupTemplate(selected)

  const pick = (name: string): void => {
    setOpen(false)
    if (materialized) {
      void usePptTemplatesStore.getState().assignTemplate(threadId, name)
      return
    }
    usePptTemplatesStore.getState().rememberDraft(threadId, name)
  }

  return (
    <div className="flex items-center gap-1">
      <Popover
        open={open}
        onOpenChange={setOpen}
        side={side}
        align="start"
        sideOffset={6}
        className="p-3"
        trigger={
          <button
            type="button"
            data-testid="composer-ppt-template"
            aria-label="PPT 模板"
            className={cn(
              'inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-pill border-(length:--hairline-width) px-3 text-b2 transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
              chosen === undefined
                ? 'border-hairline text-ink-secondary hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink'
                : 'border-(--accent) text-(--accent-text) hover:bg-hover data-[state=open]:bg-hover'
            )}
          >
            <span className="truncate">
              {chosen === undefined ? 'PPT' : `PPT · ${chosen.name}`}
            </span>
          </button>
        }
      >
        <PptTemplateGallery selected={selected} onPick={pick} />
      </Popover>

      {chosen === undefined ? null : (
        <button
          type="button"
          data-testid="composer-ppt-template-clear"
          aria-label="清除 PPT 模板"
          onClick={() => pick('')}
          className="animate-fade-in inline-flex size-6 shrink-0 items-center justify-center rounded-pill text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  )
}
