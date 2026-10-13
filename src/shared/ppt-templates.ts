/**
 * PPT 模板注册表（round 63）：**纯数据 + 纯几何**，生成侧（create_ppt 渲染）与渲染端
 * （对话页「PPT」胶囊的模板画廊）共用同一份 —— 画廊里那张 16:9 预览就是按这里的几何与颜色画出来的，
 * 于是"看到的封面"与"生成出来的封面"不会各画一套慢慢漂移。
 *
 * 口径：
 *   - 一套**模板** = 名字 + 分类 + 全套颜色 token + 封面构图（cover）+ 强调形状风格（motif）。
 *     名字是 create_ppt 的 `theme` 取值，也是**会话级**模板映射（`session_ppt_templates` 表的
 *     `template` 列，见 shared/session-ppt-templates.ts）里存的值 —— **一个都不能改**。
 *   - 十个模板分四类（工作汇报 / 学术研究 / 数据报告 / 宣传推广），见 PPT_TEMPLATES。
 *   - 前六个（PPT_THEME_NAMES）是基础主题，兼**自动挑选池**：既没给 `theme`、这个会话也没固定模板时，
 *     按（文档标题 + 副标题 + 各页标题）做 FNV-1a 取模挑一套（见 mastra/tools/ppt-themes.ts）。
 *     后四个模板要显式选（画廊里点 / `theme` 参数给），**不进自动池** —— 老文档的既有结果一点不变。
 *   - 字体统一「微软雅黑」（Windows 自带、CJK 不缺字）。
 *   - 几何一律**英寸**（画布 10 × 5.625 = 16:9）：生成侧直接落进 pptx，渲染端按同一份比例缩到预览卡上。
 *
 * 许可证：模板配色与几何全部是本项目自己的 token 与算式（形状只有矩形/短线这类基本图形），
 * 不含任何第三方模板仓库的文件或像素级图形。
 */

/** 全演示文稿统一字体（Windows 自带；pptx 的 a:latin/a:ea/a:cs 都写它） */
export const PPT_FONT = '微软雅黑'

/** 强调形状风格：封面 / 章节页 / 结尾页的装饰色块怎么摆（同一套模板在三种页上一致） */
export type PptMotif = 'bar' | 'block' | 'corner'

/** 封面构图：'center' = 居中大标题（默认）；'band' = 白底 + 左侧色带 + 左对齐标题块 */
export type PptCoverStyle = 'center' | 'band'

/** 一套模板的配色与形状风格（渲染层只读这张表的字段，不写死任何颜色） */
export interface PptTheme {
  /** 模板名（`theme` 的取值；也是报告里引用的名字） */
  name: string
  /** 页底色（每页铺满） */
  bg: string
  /** 卡片 / 浅底（KPI 卡、分栏卡、表格隔行、表头描边） */
  canvas: string
  /** 标题字色 */
  title: string
  /** 正文字色 */
  body: string
  /** 强调色（标题短线、要点圆点、装饰色块、KPI 数字、表头底色） */
  accent: string
  /** 次要字色（页脚、出处、副标题） */
  muted: string
  /** 压在强调色上的字色（表格表头） */
  onAccent: string
  /** 强调形状风格 */
  motif: PptMotif
  /** 封面构图（缺省 'center'） */
  cover?: PptCoverStyle
}

/** 基础主题名清单（顺序稳定：自动挑选按它取模 —— 顺序变了同一输入会换主题） */
export const PPT_THEME_NAMES = ['极简黑白', '商务蓝', '科技暗', '暖橙', '墨绿', '紫罗兰'] as const

export type PptBaseThemeName = (typeof PPT_THEME_NAMES)[number]

/** 模板名清单（十套；顺序 = 画廊「全部」里的排布顺序，前六个必须是基础主题那六个） */
export const PPT_TEMPLATE_NAMES = [
  '极简黑白',
  '商务蓝',
  '科技暗',
  '暖橙',
  '墨绿',
  '紫罗兰',
  '学术紫',
  '酒红',
  '湖蓝',
  '奶油'
] as const

export type PptThemeName = (typeof PPT_TEMPLATE_NAMES)[number]

/** 十套模板（键名即 `theme` 取值；全部颜色都是 6 位大写 hex） */
export const PPT_THEMES: Record<PptThemeName, PptTheme> = {
  极简黑白: {
    name: '极简黑白',
    bg: 'FFFFFF',
    canvas: 'F4F4F4',
    title: '141414',
    body: '3A3A38',
    accent: '141414',
    muted: '8C8C8A',
    onAccent: 'FFFFFF',
    motif: 'bar'
  },
  商务蓝: {
    name: '商务蓝',
    bg: 'FFFFFF',
    canvas: 'EEF4FB',
    title: '11243C',
    body: '3C4A5C',
    accent: '1F5FA9',
    muted: '8A94A6',
    onAccent: 'FFFFFF',
    motif: 'block'
  },
  科技暗: {
    name: '科技暗',
    bg: '0E1524',
    canvas: '18233B',
    title: 'EAF0FF',
    body: 'B7C4DC',
    accent: '35C8F0',
    muted: '7E8CA6',
    onAccent: '0E1524',
    motif: 'corner'
  },
  暖橙: {
    name: '暖橙',
    bg: 'FFF9F3',
    canvas: 'FFF0E1',
    title: '3A2418',
    body: '5C4232',
    accent: 'E8722C',
    muted: 'A08876',
    onAccent: 'FFFFFF',
    motif: 'block'
  },
  墨绿: {
    name: '墨绿',
    bg: 'F4F8F5',
    canvas: 'E4EFE8',
    title: '14301F',
    body: '37503F',
    accent: '2F7D53',
    muted: '7E9487',
    onAccent: 'FFFFFF',
    motif: 'bar'
  },
  紫罗兰: {
    name: '紫罗兰',
    bg: 'F8F6FF',
    canvas: 'EDE9FF',
    title: '2A1F4A',
    body: '4A3E70',
    accent: '6C4FD8',
    muted: '9A90B8',
    onAccent: 'FFFFFF',
    motif: 'corner'
  },
  // 以下四套（round 63 新增）不在自动池里：要显式选，避免改变老文档的既有配色
  学术紫: {
    name: '学术紫',
    bg: 'FFFFFF',
    canvas: 'F3F0FA',
    title: '241945',
    body: '413764',
    accent: '5B3FA8',
    muted: '8B84A3',
    onAccent: 'FFFFFF',
    motif: 'bar',
    // 答辩/论文那种克制气质：白底 + 左侧一条深紫色带 + 左对齐标题块
    cover: 'band'
  },
  酒红: {
    name: '酒红',
    bg: 'FDF8F6',
    canvas: 'F6E7E2',
    title: '3A1418',
    body: '5C3A38',
    accent: '9B2C3F',
    muted: 'A88C88',
    onAccent: 'FFFFFF',
    motif: 'block'
  },
  湖蓝: {
    name: '湖蓝',
    bg: 'F6FAFB',
    canvas: 'E3EFF3',
    title: '0F2C36',
    body: '35606C',
    accent: '1E7F96',
    muted: '7E9AA3',
    onAccent: 'FFFFFF',
    motif: 'corner',
    cover: 'band'
  },
  奶油: {
    name: '奶油',
    bg: 'FFFBEE',
    canvas: 'F7EDD5',
    title: '33291A',
    body: '574934',
    accent: 'C08A2E',
    muted: 'A0926F',
    onAccent: 'FFFFFF',
    motif: 'block'
  }
}

/** 模板分类 id（画廊标签行用它过滤；顺序 = 画廊里的展示顺序） */
export type PptTemplateCategory = 'report' | 'academic' | 'data' | 'promo'

export interface PptTemplateCategoryInfo {
  id: PptTemplateCategory
  label: string
}

/** 四个分类（画廊标签行 = 「全部」+ 这四个） */
export const PPT_TEMPLATE_CATEGORIES: readonly PptTemplateCategoryInfo[] = [
  { id: 'report', label: '工作汇报' },
  { id: 'academic', label: '学术研究' },
  { id: 'data', label: '数据报告' },
  { id: 'promo', label: '宣传推广' }
]

/** 每个模板归哪一类（Record 全量 → 少一个编译期就报错） */
const TEMPLATE_CATEGORY: Record<PptThemeName, PptTemplateCategory> = {
  极简黑白: 'report',
  商务蓝: 'report',
  湖蓝: 'report',
  学术紫: 'academic',
  墨绿: 'academic',
  酒红: 'data',
  科技暗: 'data',
  暖橙: 'promo',
  奶油: 'promo',
  紫罗兰: 'promo'
}

export interface PptTemplate {
  name: PptThemeName
  category: PptTemplateCategory
}

/** 模板清单（顺序 = PPT_TEMPLATE_NAMES） */
export const PPT_TEMPLATES: readonly PptTemplate[] = PPT_TEMPLATE_NAMES.map((name) => ({
  name,
  category: TEMPLATE_CATEGORY[name]
}))

/** 一个分类下的模板（category 传 null = 全部）；未知分类给空表 */
export function templatesOf(category: PptTemplateCategory | null): readonly PptTemplate[] {
  if (category === null) return PPT_TEMPLATES
  return PPT_TEMPLATES.filter((template) => template.category === category)
}

/**
 * 按名字查模板（不认得给 undefined）。空串 / 落盘里过期的名字都走这条 —— 调用方按"没有选择"处理，
 * 不抛错、不落成半截状态。
 */
export function lookupTemplate(name: string): PptTemplate | undefined {
  return PPT_TEMPLATES.find((template) => template.name === name)
}

/** 画布（英寸）：16:9 —— pptx 的 LAYOUT_16x9 = 10 × 5.625 */
export const PPT_CANVAS = { w: 10, h: 5.625 } as const

/** 一个矩形（英寸） */
export interface PptBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 封面 / 章节页 / 结尾页的装饰色块（形状风格跟模板走，同一模板三处一致）。
 * 三套形状都**避开页脚区**（y ≥ 4.9 的横带只留给页脚细线与页码）：章节页/结尾页也带页脚，
 * 装饰压在页脚上会让 muted 字色贴在强调色底上（对比度不够）。
 */
export function motifBoxes(motif: PptMotif): PptBox[] {
  if (motif === 'bar') {
    // 左侧通栏竖条 + 左上横块（L 形）
    return [
      { x: 0, y: 0, w: 0.22, h: PPT_CANVAS.h },
      { x: 0.22, y: 0, w: 1.5, h: 0.22 }
    ]
  }
  if (motif === 'block') {
    // 顶部通栏色带 + 右下角方块
    return [
      { x: 0, y: 0, w: PPT_CANVAS.w, h: 0.35 },
      { x: PPT_CANVAS.w - 1, y: 4.35, w: 0.6, h: 0.6 }
    ]
  }
  // corner：右上横块 + 右下横块
  return [
    { x: PPT_CANVAS.w - 2.6, y: 0, w: 2.6, h: 0.3 },
    { x: PPT_CANVAS.w - 1.6, y: PPT_CANVAS.h - 0.225, w: 1.6, h: 0.225 }
  ]
}

/** 封面构图（英寸 + 字号）：生成侧照着画，渲染端的预览卡按同一份缩到 16:9 缩略图上 */
export interface PptCoverPlan {
  /** 标题/副标题的对齐方式（'band' 左对齐，'center' 居中） */
  align: 'left' | 'center'
  /** 装饰色块：'band' 封面 = 左侧色带；其余 = 该模板 motif 的形状 */
  decor: PptBox[]
  title: PptBox
  titleSize: number
  /** 标题下那条 accent 短线 */
  rule: PptBox
  subtitle: PptBox
  subtitleSize: number
}

/** 封面的两种构图（'band' 是 round 63 新增的克制型封面，其余模板保持原来的居中封面） */
export function coverPlan(theme: PptTheme): PptCoverPlan {
  if (theme.cover === 'band') {
    return {
      align: 'left',
      decor: [{ x: 0, y: 0, w: 0.85, h: PPT_CANVAS.h }],
      title: { x: 1.5, y: 1.75, w: 7.6, h: 1.35 },
      titleSize: 40,
      rule: { x: 1.5, y: 3.3, w: 1.0, h: 0.06 },
      subtitle: { x: 1.5, y: 3.5, w: 7.6, h: 0.6 },
      subtitleSize: 18
    }
  }
  return {
    align: 'center',
    decor: motifBoxes(theme.motif),
    title: { x: 0.8, y: 1.8, w: 8.4, h: 1.35 },
    titleSize: 40,
    rule: { x: 4.5, y: 3.32, w: 1.0, h: 0.06 },
    subtitle: { x: 0.8, y: 3.55, w: 8.4, h: 0.6 },
    subtitleSize: 18
  }
}
