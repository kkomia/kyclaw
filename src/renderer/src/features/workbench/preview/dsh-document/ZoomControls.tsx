/**
 * 浮动缩放控件：适应宽度 + 百分比菜单 + 加减两档。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomControls.tsx`，
 * 把它的设计系统原语（Button / Menu / Tooltip / IconChevronOutline）换成 kyclaw 自己的
 * `components/ui`（Button / Menu / Tooltip + lucide 图标/文字），视觉与文案跟本仓一致。
 *
 * 一个结构性的口径照抄：百分比走**独立的 imperative 句柄**。滚轮/捏合过程中改的是 CSS 变量
 * （不重挂文档树，页面不会闪），数字要跟着动就得绕开整树重渲染 —— 这是 DSH 把两者拆开的原因。
 */
import { ChevronDown, Minus, Plus } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { DEFAULT_ZOOM_BOUNDS, stepZoom, type ZoomBounds, type ZoomLabels } from './zoom'

/** 手势过程中的实时数字刷新口（不走 React state，见文件头注）。 */
export interface ZoomControlsHandle {
  /** @param zoom 当前手势倍率。 */
  showZoom(zoom: number): void
}

export interface ZoomControlsProps {
  /** 当前解析出来的倍率（适应宽度模式下是现算的那个值）。 */
  readonly zoom: number
  /** 当前是否处于适应宽度模式（菜单里据此标中）。 */
  readonly fitWidth: boolean
  readonly labels: ZoomLabels
  /** 露头 / 收起（触屏上由 CSS 常驻）。 */
  readonly visible: boolean
  readonly onZoom: (zoom: number) => void
  readonly onFitWidth: () => void
  /** 鼠标/键盘是否停在控件上：调用方据此不要把手感收走。 */
  readonly onActiveChange: (active: boolean) => void
  /** 缩放边界（缺省 = 文档阅读器那套 25%–400%；图片那侧传它自己的边界，见 `IMAGE_ZOOM_BOUNDS`）。 */
  readonly bounds?: ZoomBounds
}

export const ZoomControls = forwardRef<ZoomControlsHandle, ZoomControlsProps>(function ZoomControls(
  { zoom, fitWidth, labels, visible, onZoom, onFitWidth, onActiveChange, bounds },
  ref
): React.JSX.Element {
  const limits = bounds ?? DEFAULT_ZOOM_BOUNDS
  const [displayZoom, setDisplayZoom] = useState(zoom)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  useImperativeHandle(ref, () => ({ showZoom: setDisplayZoom }), [])

  useEffect(() => {
    onActiveChange(open || hovered || focused)
  }, [focused, hovered, onActiveChange, open])

  const items: MenuEntry[] = [
    { id: 'fit-width', label: labels.fitWidth, selected: fitWidth, onSelect: onFitWidth },
    { id: 'fit-scale', type: 'separator' },
    ...limits.options.map((value) => ({
      id: String(value),
      label: labels.value(value * 100),
      selected: !fitWidth && displayZoom === value,
      onSelect: (): void => onZoom(value)
    }))
  ]

  return (
    <div
      role="toolbar"
      aria-label={labels.controls}
      data-testid="dsh-zoom-controls"
      data-dsh-zoom-controls
      data-dsh-zoom-visible={visible || undefined}
      className="dsh-zoom-controls"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
    >
      <Tooltip label={labels.out}>
        <IconButton
          label={labels.out}
          className="border-transparent hover:bg-hover"
          icon={<Minus />}
          data-testid="dsh-zoom-out"
          disabled={displayZoom <= limits.min}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onZoom(stepZoom(displayZoom, -1, limits))}
        />
      </Tooltip>
      <Menu
        side="top"
        align="center"
        onOpenChange={setOpen}
        items={items}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            className="dsh-zoom-percent"
            aria-label={labels.menu}
            data-testid="dsh-zoom-percent"
            onMouseDown={(event) => event.preventDefault()}
          >
            <span data-testid="dsh-zoom-value">{labels.value(Math.round(displayZoom * 100))}</span>
            <ChevronDown aria-hidden="true" className="size-3" />
          </Button>
        }
      />
      <Tooltip label={labels.into}>
        <IconButton
          label={labels.into}
          className="border-transparent hover:bg-hover"
          icon={<Plus />}
          data-testid="dsh-zoom-in"
          disabled={displayZoom >= limits.max}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onZoom(stepZoom(displayZoom, 1, limits))}
        />
      </Tooltip>
    </div>
  )
})
