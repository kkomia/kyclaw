/**
 * Office ribbon 的**纯数据模型**（A2-prep，M3-S4/A2）。
 *
 * 只描述"有哪些 tab / 分组 / 命令项、长什么样、什么时候应该可用"：
 * 不 import 任何 React / 图标运行时 / BetterOffice 运行时，只用 `import type` 拿命令 id 与参数类型，
 * 这样 spec 可以在 jsdom 里零代价单测，也可以在 A2 组件层被任意消费。
 *
 * 硬口径（与 `.superpowers/handover/office-ui-redesign-spec.md` §6.1 一致）：
 *   - 5 个 tab：开始 / 插入 / 布局 / 审阅 / 视图；**不设空的绘图/设计 tab**；
 *   - 命令 id 必须是 `@betteroffice/docx-react@0.4.3` 真实命令（d.mts `DocxCommandArgs`，48 个），
 *     **不给假入口**：剪贴板（粘贴/剪切/复制）、绘图/墨迹、字数统计、AI 配图等内核没有的能力一律不出现；
 *   - `enabledWhen` 只是**描述**（A2 负责按真实 command state 决定 disabled），不是逻辑；
 *   - 同一命令可带不同参数出现（对齐 4 个按钮 = `alignment` × {left|center|right|both}），
 *     所以唯一性口径是「id + args」而不是裸 id；
 *   - **选中态用墨色，不用品牌蓝**（本仓 nav-item 口径）；颜色/间距/字号在 A2 组件层映射 token。
 *
 * 与 Phase 1 规格的偏差（见 a2-prep-report.md）：
 *   - 规格 §6.1 里「+ / − 字号步进」没有对应命令 → 不做；
 *   - 「打印」命令存在，但当前隔离面没有 `onPrint` 回调 → 先不放进 v1 ribbon；
 *   - `open` / `reportIssue` 属于宿主/开发动作，不进 ribbon。
 */
import type { DocxCommandArgs, DocxCommandId } from '@betteroffice/docx-react'

/** 命令项形态：toggle=有激活态；button=一次性动作；select=内建选择器；split=主按钮 + 下拉 */
export type OfficeRibbonItemType = 'toggle' | 'button' | 'select' | 'split'

/** `enabledWhen` 的粗粒度描述（A2 可据此做分组显隐/置灰，不做逻辑） */
export type OfficeRibbonEnableCondition =
  /** 有文档即可（撤销/重做、保存、视图） */
  | 'document'
  /** 需要非空选区（文字格式类） */
  | 'selection'
  /** 非只读、非 viewing 模式 */
  | 'editable'
  /** 光标在表格内 */
  | 'table'
  /** 选中图片 */
  | 'image'
  /** 文档存在修订记录（上一处/下一处/接受/拒绝） */
  | 'tracked-changes'
  /** 选区落在某条修订上（接受/拒绝） */
  | 'revision'

/**
 * 图标名：直接用 lucide-react 的组件名（A2 里 `icons[name]` 即可）。
 * 这里显式列出用到的集合，避免数据层 import lucide 运行时。
 */
export type OfficeRibbonIcon =
  | 'Save'
  | 'Undo2'
  | 'Redo2'
  | 'Type'
  | 'CaseSensitive'
  | 'ALargeSmall'
  | 'Bold'
  | 'Italic'
  | 'Underline'
  | 'Strikethrough'
  | 'Superscript'
  | 'Subscript'
  | 'Baseline'
  | 'Highlighter'
  | 'RemoveFormatting'
  | 'TextAlignStart'
  | 'TextAlignCenter'
  | 'TextAlignEnd'
  | 'TextAlignJustify'
  | 'List'
  | 'ListOrdered'
  | 'ListIndentIncrease'
  | 'ListIndentDecrease'
  | 'BetweenVerticalStart'
  | 'Image'
  | 'Table'
  | 'Link'
  | 'SquareSplitVertical'
  | 'SeparatorHorizontal'
  | 'BookOpen'
  | 'Droplet'
  | 'FileCog'
  | 'Pilcrow'
  | 'ArrowLeftToLine'
  | 'ArrowRightToLine'
  | 'MessageSquareText'
  | 'ChevronLeft'
  | 'ChevronRight'
  | 'CheckCheck'
  | 'X'
  | 'Search'
  | 'Replace'
  | 'Percent'
  | 'Ruler'
  | 'ListTree'
  | 'Frame'

interface OfficeRibbonCommandItemBase {
  readonly type: OfficeRibbonItemType
  readonly label: string
  readonly icon: OfficeRibbonIcon
  /** 可选的快捷键提示（只用于展示；实际拦截由内核命令负责） */
  readonly shortcut?: string
  /**
   * 交给内核自带控件渲染（`ToolbarCommand`）而不是"盲执行"：
   * 需要额外参数/自带菜单的命令（插入表格、表格操作、图片旋转翻转）走这个。
   */
  readonly control?: 'default' | 'builtin'
  /** 置灰/显隐条件的描述，A2 用真实 command state 落实 */
  readonly enabledWhen?: OfficeRibbonEnableCondition
  /** E2E/单测稳定选择器 */
  readonly testId?: string
}

/**
 * 一条命令项。`id`/`args` 用映射联合一一配对：
 *   - 无参命令（`bold: null`）不能带 args；
 *   - 带参命令（`alignment: { value }`）必须给对形状；
 * 写错命令名/参数会在 `satisfies` 处编译报错。
 */
export type OfficeRibbonCommandItem = {
  [K in DocxCommandId]: OfficeRibbonCommandItemBase & {
    readonly id: K
    readonly args?: DocxCommandArgs[K]
  }
}[DocxCommandId]

/** 视图 tab 的宿主开关（`DocxEditor` 的 showRuler/showOutline/showMarginGuides props，不是命令） */
export type OfficeHostToggleId = 'ruler' | 'outline' | 'margin-guides'

export interface OfficeRibbonHostToggleItem {
  readonly type: 'toggle'
  /** 明确标记：这是宿主 props，不是内核命令（不给假入口的边界） */
  readonly host: OfficeHostToggleId
  readonly label: string
  readonly icon: OfficeRibbonIcon
  readonly testId?: string
}

export interface OfficeRibbonSeparatorItem {
  readonly type: 'separator'
  readonly id: string
}

export type OfficeRibbonItem =
  OfficeRibbonCommandItem | OfficeRibbonHostToggleItem | OfficeRibbonSeparatorItem

export interface OfficeRibbonGroup {
  readonly id: string
  readonly label: string
  readonly items: readonly OfficeRibbonItem[]
}

export type OfficeRibbonTabId = 'home' | 'insert' | 'layout' | 'review' | 'view'

export interface OfficeRibbonTab {
  readonly id: OfficeRibbonTabId
  readonly label: string
  readonly groups: readonly OfficeRibbonGroup[]
}

/** 快捷键展示口径（与 BetterOffice 命令的 chord 保持一致；A2 也可改从 descriptor 读） */
const SHORTCUT = {
  save: 'Ctrl+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  underline: 'Ctrl+U',
  find: 'Ctrl+F',
  replace: 'Ctrl+H'
} as const

/* ═══════════════════════════════════════════════════════════════════════
 * 5 个 tab
 * ═══════════════════════════════════════════════════════════════════════ */
export const OFFICE_RIBBON_TABS = [
  {
    id: 'home',
    label: '开始',
    groups: [
      {
        id: 'styles',
        label: '样式',
        items: [
          {
            type: 'select',
            id: 'paragraphStyle',
            label: '样式',
            icon: 'Type',
            enabledWhen: 'document',
            testId: 'office-ribbon-style'
          }
        ]
      },
      {
        id: 'font',
        label: '字体',
        items: [
          {
            type: 'select',
            id: 'fontFamily',
            label: '字体',
            icon: 'CaseSensitive',
            enabledWhen: 'document',
            testId: 'office-ribbon-font-family'
          },
          {
            type: 'select',
            id: 'fontSize',
            label: '字号',
            icon: 'ALargeSmall',
            enabledWhen: 'document',
            testId: 'office-ribbon-font-size'
          }
        ]
      },
      {
        id: 'text',
        label: '文本',
        items: [
          {
            type: 'toggle',
            id: 'bold',
            label: '加粗',
            icon: 'Bold',
            shortcut: SHORTCUT.bold,
            enabledWhen: 'editable',
            testId: 'office-ribbon-bold'
          },
          {
            type: 'toggle',
            id: 'italic',
            label: '斜体',
            icon: 'Italic',
            shortcut: SHORTCUT.italic,
            enabledWhen: 'editable',
            testId: 'office-ribbon-italic'
          },
          {
            type: 'toggle',
            id: 'underline',
            label: '下划线',
            icon: 'Underline',
            shortcut: SHORTCUT.underline,
            enabledWhen: 'editable',
            testId: 'office-ribbon-underline'
          },
          {
            type: 'toggle',
            id: 'strikethrough',
            label: '删除线',
            icon: 'Strikethrough',
            enabledWhen: 'editable',
            testId: 'office-ribbon-strikethrough'
          },
          {
            type: 'toggle',
            id: 'superscript',
            label: '上标',
            icon: 'Superscript',
            enabledWhen: 'editable'
          },
          {
            type: 'toggle',
            id: 'subscript',
            label: '下标',
            icon: 'Subscript',
            enabledWhen: 'editable'
          },
          { type: 'separator', id: 'text-color-sep' },
          {
            // 颜色是 split：主按钮应用最近颜色，下拉选色板（A2 用内核 ColorPicker 或自绘色板）
            type: 'split',
            id: 'textColor',
            label: '字体颜色',
            icon: 'Baseline',
            enabledWhen: 'editable',
            testId: 'office-ribbon-text-color'
          },
          {
            type: 'split',
            id: 'highlightColor',
            label: '高亮',
            icon: 'Highlighter',
            enabledWhen: 'editable',
            testId: 'office-ribbon-highlight'
          },
          { type: 'separator', id: 'clear-format-sep' },
          {
            type: 'button',
            id: 'clearFormatting',
            label: '清除格式',
            icon: 'RemoveFormatting',
            enabledWhen: 'selection',
            testId: 'office-ribbon-clear-formatting'
          }
        ]
      },
      {
        id: 'paragraph',
        label: '段落',
        items: [
          {
            type: 'toggle',
            id: 'alignment',
            args: { value: 'left' },
            label: '左对齐',
            icon: 'TextAlignStart',
            enabledWhen: 'editable',
            testId: 'office-ribbon-align-left'
          },
          {
            type: 'toggle',
            id: 'alignment',
            args: { value: 'center' },
            label: '居中',
            icon: 'TextAlignCenter',
            enabledWhen: 'editable',
            testId: 'office-ribbon-align-center'
          },
          {
            type: 'toggle',
            id: 'alignment',
            args: { value: 'right' },
            label: '右对齐',
            icon: 'TextAlignEnd',
            enabledWhen: 'editable',
            testId: 'office-ribbon-align-right'
          },
          {
            type: 'toggle',
            id: 'alignment',
            args: { value: 'both' },
            label: '两端对齐',
            icon: 'TextAlignJustify',
            enabledWhen: 'editable',
            testId: 'office-ribbon-align-justify'
          },
          { type: 'separator', id: 'list-sep' },
          {
            type: 'toggle',
            id: 'bulletList',
            label: '项目符号',
            icon: 'List',
            enabledWhen: 'editable'
          },
          {
            type: 'toggle',
            id: 'numberedList',
            label: '编号',
            icon: 'ListOrdered',
            enabledWhen: 'editable'
          },
          { type: 'separator', id: 'indent-sep' },
          {
            type: 'button',
            id: 'outdent',
            label: '减少缩进',
            icon: 'ListIndentDecrease',
            enabledWhen: 'editable'
          },
          {
            type: 'button',
            id: 'indent',
            label: '增加缩进',
            icon: 'ListIndentIncrease',
            enabledWhen: 'editable'
          },
          { type: 'separator', id: 'line-spacing-sep' },
          {
            type: 'select',
            id: 'lineSpacing',
            label: '行距',
            icon: 'BetweenVerticalStart',
            enabledWhen: 'editable'
          }
        ]
      },
      {
        id: 'direction',
        label: '文字方向',
        items: [
          {
            type: 'button',
            id: 'setLtr',
            label: '从左到右',
            icon: 'ArrowRightToLine',
            enabledWhen: 'editable'
          },
          {
            type: 'button',
            id: 'setRtl',
            label: '从右到左',
            icon: 'ArrowLeftToLine',
            enabledWhen: 'editable'
          }
        ]
      },
      {
        // 上下文组（选中图片才可用；A2 可据此整组显隐）
        id: 'image-context',
        label: '图片',
        items: [
          {
            type: 'select',
            id: 'imageWrap',
            label: '环绕方式',
            icon: 'Image',
            enabledWhen: 'image'
          },
          {
            type: 'button',
            id: 'imageTransform',
            label: '旋转翻转',
            icon: 'Image',
            control: 'builtin',
            enabledWhen: 'image'
          },
          {
            type: 'button',
            id: 'imageProperties',
            label: '图片属性',
            icon: 'Image',
            enabledWhen: 'image'
          }
        ]
      },
      {
        // 上下文组（光标在表格内才可用）
        id: 'table-context',
        label: '表格',
        items: [
          {
            type: 'button',
            id: 'tableAction',
            label: '表格操作',
            icon: 'Table',
            control: 'builtin',
            enabledWhen: 'table'
          }
        ]
      }
    ]
  },
  {
    id: 'insert',
    label: '插入',
    groups: [
      {
        id: 'pages',
        label: '页面',
        items: [
          {
            type: 'button',
            id: 'insertPageBreak',
            label: '分页符',
            icon: 'SquareSplitVertical',
            enabledWhen: 'editable',
            testId: 'office-ribbon-page-break'
          }
        ]
      },
      {
        id: 'objects',
        label: '对象',
        items: [
          {
            type: 'button',
            id: 'insertImage',
            label: '图片',
            icon: 'Image',
            enabledWhen: 'editable'
          },
          {
            type: 'button',
            id: 'insertTable',
            label: '表格',
            icon: 'Table',
            control: 'builtin',
            enabledWhen: 'editable'
          },
          {
            type: 'button',
            id: 'watermark',
            label: '水印',
            icon: 'Droplet',
            enabledWhen: 'editable'
          }
        ]
      },
      {
        id: 'links',
        label: '链接',
        items: [
          {
            type: 'button',
            id: 'insertLink',
            label: '链接',
            icon: 'Link',
            enabledWhen: 'editable'
          }
        ]
      },
      {
        id: 'references',
        label: '引用',
        items: [
          {
            type: 'button',
            id: 'insertTOC',
            label: '目录',
            icon: 'BookOpen',
            enabledWhen: 'editable'
          }
        ]
      }
    ]
  },
  {
    id: 'layout',
    label: '布局',
    groups: [
      {
        id: 'page',
        label: '页面',
        items: [
          {
            type: 'button',
            id: 'pageSetup',
            label: '页面设置',
            icon: 'FileCog',
            enabledWhen: 'document'
          }
        ]
      },
      {
        id: 'sections',
        label: '分节',
        items: [
          {
            type: 'button',
            id: 'insertSectionBreakNextPage',
            label: '下一页分节符',
            icon: 'SeparatorHorizontal',
            enabledWhen: 'editable'
          },
          {
            type: 'button',
            id: 'insertSectionBreakContinuous',
            label: '连续分节符',
            icon: 'SeparatorHorizontal',
            enabledWhen: 'editable'
          }
        ]
      }
    ]
  },
  {
    id: 'review',
    label: '审阅',
    groups: [
      {
        id: 'mode',
        label: '模式',
        items: [
          {
            type: 'select',
            id: 'editingMode',
            label: '编辑模式',
            icon: 'Pilcrow',
            enabledWhen: 'document',
            testId: 'office-ribbon-editing-mode'
          }
        ]
      },
      {
        id: 'comments',
        label: '批注',
        items: [
          {
            type: 'button',
            id: 'commentsSidebar',
            label: '批注',
            icon: 'MessageSquareText',
            enabledWhen: 'document'
          }
        ]
      },
      {
        id: 'changes',
        label: '修订',
        items: [
          {
            type: 'button',
            id: 'reviewPrevious',
            label: '上一处',
            icon: 'ChevronLeft',
            enabledWhen: 'tracked-changes'
          },
          {
            type: 'button',
            id: 'reviewNext',
            label: '下一处',
            icon: 'ChevronRight',
            enabledWhen: 'tracked-changes'
          },
          { type: 'separator', id: 'review-sep' },
          {
            type: 'button',
            id: 'reviewAccept',
            args: null,
            label: '接受修订',
            icon: 'CheckCheck',
            enabledWhen: 'revision'
          },
          {
            type: 'button',
            id: 'reviewReject',
            args: null,
            label: '拒绝修订',
            icon: 'X',
            enabledWhen: 'revision'
          }
        ]
      },
      {
        id: 'find',
        label: '查找',
        items: [
          {
            type: 'button',
            id: 'find',
            label: '查找',
            icon: 'Search',
            shortcut: SHORTCUT.find,
            enabledWhen: 'document'
          },
          {
            type: 'button',
            id: 'replace',
            label: '替换',
            icon: 'Replace',
            shortcut: SHORTCUT.replace,
            enabledWhen: 'editable'
          }
        ]
      }
    ]
  },
  {
    id: 'view',
    label: '视图',
    groups: [
      {
        id: 'zoom',
        label: '缩放',
        items: [
          {
            type: 'select',
            id: 'zoom',
            label: '缩放',
            icon: 'Percent',
            enabledWhen: 'document',
            testId: 'office-ribbon-zoom'
          }
        ]
      },
      {
        // 宿主 props（DocxEditor 的 showRuler/showOutline/showMarginGuides），不是内核命令
        id: 'display',
        label: '显示',
        items: [
          {
            type: 'toggle',
            host: 'ruler',
            label: '标尺',
            icon: 'Ruler',
            testId: 'office-ribbon-ruler'
          },
          {
            type: 'toggle',
            host: 'outline',
            label: '大纲',
            icon: 'ListTree',
            testId: 'office-ribbon-outline'
          },
          {
            type: 'toggle',
            host: 'margin-guides',
            label: '页边距参考线',
            icon: 'Frame',
            testId: 'office-ribbon-margin-guides'
          }
        ]
      }
    ]
  }
] as const satisfies readonly OfficeRibbonTab[]

/* ═══════════════════════════════════════════════════════════════════════
 * QAT（快速访问行，32px）：保存 / 撤销 / 重做 + 自动保存状态占位
 * ═══════════════════════════════════════════════════════════════════════ */
export interface OfficeQatStatusItem {
  readonly type: 'status'
  /** 自动保存状态占位：A2 接真实保存状态（store 的 saving/dirty → 已保存/保存中…） */
  readonly id: 'save-state'
  readonly label: string
}

export type OfficeQatItem = OfficeRibbonCommandItem | OfficeQatStatusItem

export const OFFICE_QAT_ITEMS = [
  {
    type: 'button',
    id: 'save',
    label: '保存',
    icon: 'Save',
    shortcut: SHORTCUT.save,
    enabledWhen: 'document',
    testId: 'office-qat-save'
  },
  {
    type: 'button',
    id: 'undo',
    label: '撤销',
    icon: 'Undo2',
    shortcut: SHORTCUT.undo,
    enabledWhen: 'document',
    testId: 'office-qat-undo'
  },
  {
    type: 'button',
    id: 'redo',
    label: '重做',
    icon: 'Redo2',
    shortcut: SHORTCUT.redo,
    enabledWhen: 'document',
    testId: 'office-qat-redo'
  },
  { type: 'status', id: 'save-state', label: '已保存' }
] as const satisfies readonly OfficeQatItem[]

/* ═══════════════════════════════════════════════════════════════════════
 * 纯函数 helper（给组件层/单测用）
 * ═══════════════════════════════════════════════════════════════════════ */
export function isOfficeRibbonCommand(item: OfficeRibbonItem): item is OfficeRibbonCommandItem {
  return item.type !== 'separator' && !('host' in item)
}

export function isOfficeRibbonHostToggle(
  item: OfficeRibbonItem
): item is OfficeRibbonHostToggleItem {
  return item.type !== 'separator' && 'host' in item
}

export function isOfficeRibbonSeparator(item: OfficeRibbonItem): item is OfficeRibbonSeparatorItem {
  return item.type === 'separator'
}

export function findOfficeRibbonTab(id: OfficeRibbonTabId): OfficeRibbonTab | undefined {
  return OFFICE_RIBBON_TABS.find((tab) => tab.id === id)
}

/** 展平某个 tab 的所有命令项（不含分隔线/宿主开关；上下文组也包含，调用方按 enabledWhen 筛） */
export function ribbonCommandsOfTab(tab: OfficeRibbonTab): readonly OfficeRibbonCommandItem[] {
  return tab.groups.flatMap((group) => group.items.filter(isOfficeRibbonCommand))
}

/**
 * 命令项的身份键：`id` 或 `id:{参数字典序 JSON}`。
 * 对齐 4 个按钮同 id 不同 args 是**有意**的，所以唯一性按这个键算（见头注）。
 */
export function officeRibbonCommandKey(item: OfficeRibbonCommandItem): string {
  return item.args === undefined ? item.id : `${item.id}:${JSON.stringify(item.args)}`
}
