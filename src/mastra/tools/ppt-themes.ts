/**
 * create_ppt 的**设计系统底座**（round 62）：内置主题表 + 确定性挑选。
 *
 * 为什么单独一份：主题是**纯数据 + 纯函数**（配色 / 字体 / 强调形状风格），渲染与 schema 都在 ./ppt.ts。
 * 这样"加一套主题"只改这张表，不碰渲染代码；测试也能只针对主题解析钉口径。
 *
 * 口径：
 *   - 六套内置主题（中文名即 `theme` 的取值）：极简黑白 / 商务蓝 / 科技暗 / 暖橙 / 墨绿 / 紫罗兰。
 *   - 字体统一「微软雅黑」（Windows 自带、CJK 不缺字；写进 a:latin/a:ea/a:cs）。
 *   - 不给 `theme` 时**确定性自动挑**：对（文档标题 + 副标题 + 各页标题）做 FNV-1a 取模 ——
 *     同一输入两次生成同一套主题（无随机、不随时间变）。
 */

/** 全演示文稿统一字体（Windows 自带；pptx 的 a:latin/a:ea/a:cs 都写它） */
export const PPT_FONT = '微软雅黑'

/** 强调形状风格：封面 / 章节页 / 结尾页的装饰色块怎么摆（同一套主题在三种页上一致） */
export type PptMotif = 'bar' | 'block' | 'corner'

/** 一套主题 = 全部配色 + 强调形状风格（渲染层只读这张表的字段，不写死任何颜色） */
export interface PptTheme {
  /** 主题名（`theme` 的取值；也是报告里引用的名字） */
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
}

/** 主题名清单（顺序稳定：自动挑选按它取模 —— 顺序变了同一输入会换主题） */
export const PPT_THEME_NAMES = ['极简黑白', '商务蓝', '科技暗', '暖橙', '墨绿', '紫罗兰'] as const

export type PptThemeName = (typeof PPT_THEME_NAMES)[number]

/** 六套内置主题（键名即 `theme` 取值） */
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
  }
}

/** 自动挑选要看的输入面（只需标题，不必是完整 schema 形状） */
export interface PptThemeInput {
  theme?: string
  title?: string
  subtitle?: string
  slides: readonly { title?: string }[]
}

/**
 * 解析这次用哪套主题：给了 `theme` 且认得就用它；否则按输入内容确定性自动挑。
 * 给的名字不认识（直接调渲染入口时的脏输入）也退到自动挑 —— 不抛错、不落成"没有主题"。
 */
export function resolveTheme(input: PptThemeInput): PptTheme {
  const named = input.theme === undefined ? undefined : lookupTheme(input.theme)
  return named ?? PPT_THEMES[PPT_THEME_NAMES[fnv1a(themeSeed(input)) % PPT_THEME_NAMES.length]]
}

/** 按名字查主题（不认得给 undefined） */
export function lookupTheme(name: string): PptTheme | undefined {
  return (PPT_THEMES as Record<string, PptTheme | undefined>)[name]
}

/** 自动挑选的种子：文档标题 + 副标题 + 各页标题（顺序参与，故同一输入恒定） */
function themeSeed(input: PptThemeInput): string {
  const parts = [input.title ?? '', input.subtitle ?? '']
  for (const slide of input.slides) parts.push(slide.title ?? '')
  return parts.join('\u0000')
}

/** FNV-1a 32 位：纯函数、跨平台稳定（不依赖 String.hashCode 之类的引擎实现） */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}
