/**
 * create_ppt 的**主题解析层**（round 62 建立；round 63 数据下沉到 src/shared/ppt-templates.ts）。
 *
 * 为什么拆两层：主题的**数据与几何**（十套模板的配色、分类、封面构图）主进程与渲染端都要用
 * （对话页的画廊要画真实构图的预览卡），所以那份纯数据放在共享层；这里只留**解析口径**——
 * "这次到底用哪一套"，因为自动挑选要用 FNV 哈希，而且只有生成侧关心它。
 *
 * 口径：
 *   - 十套模板（中文名即 `theme` 的取值）与分类见 shared/ppt-templates.ts；字体统一「微软雅黑」。
 *   - 取值优先级（round 63）：显式 `theme` > **用户固定的模板**（对话页「PPT」胶囊选的，现读设置）
 *     > 自动挑。前一档认不出来（脏输入）就往下一档走，不抛错、不落成"没有主题"。
 *   - 自动挑只用**基础主题**那六套（PPT_THEME_NAMES，顺序稳定）：对（文档标题 + 副标题 + 各页标题）
 *     做 FNV-1a 取模 —— 同一输入两次生成同一套主题（无随机、不随时间变），且新模板不改老文档的结果。
 */

import { PPT_THEMES, PPT_THEME_NAMES, type PptTheme } from '../../shared/ppt-templates'

export {
  PPT_FONT,
  PPT_TEMPLATES,
  PPT_THEMES,
  PPT_THEME_NAMES,
  PPT_TEMPLATE_NAMES
} from '../../shared/ppt-templates'
export type {
  PptBaseThemeName,
  PptCoverStyle,
  PptMotif,
  PptTemplate,
  PptTemplateCategory,
  PptTheme,
  PptThemeName
} from '../../shared/ppt-templates'

/** 自动挑选要看的输入面（只需标题，不必是完整 schema 形状） */
export interface PptThemeInput {
  theme?: string
  title?: string
  subtitle?: string
  slides: readonly { title?: string }[]
}

/**
 * 解析这次用哪套主题：显式 `theme` > `fallback`（用户固定的模板）> 按输入内容确定性自动挑。
 * 两处名字都认不出来时（脏输入 / 用户没固定 / 固定的模板后来被删了）一律退到自动挑。
 */
export function resolveTheme(input: PptThemeInput, fallback?: string): PptTheme {
  const named = input.theme === undefined ? undefined : lookupTheme(input.theme)
  const fixed = named ?? (fallback === undefined ? undefined : lookupTheme(fallback))
  return fixed ?? PPT_THEMES[PPT_THEME_NAMES[fnv1a(themeSeed(input)) % PPT_THEME_NAMES.length]]
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
