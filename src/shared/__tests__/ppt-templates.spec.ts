import { describe, expect, it } from 'vitest'
import {
  lookupTemplate,
  motifBoxes,
  PPT_CANVAS,
  PPT_TEMPLATE_CATEGORIES,
  PPT_TEMPLATES,
  PPT_TEMPLATE_NAMES,
  PPT_THEMES,
  PPT_THEME_NAMES,
  coverPlan,
  templatesOf,
  type PptBox
} from '../ppt-templates'

/**
 * PPT 模板注册表（round 63）：十个模板 + 四个分类 + 封面几何。
 *
 * 这里盯三件事：
 *   1. **名字一个都不能改**（它是 create_ppt 的 `theme` 取值，也是会话级模板映射里存的值，
 *      改了老会话的记录就指不到模板）；
 *   2. 每个模板的颜色 token 齐、合法，且两两分得开（不然"选模板"等于没选）；
 *   3. 几何（画布 / 装饰块 / 封面构图）都在画布内，且 band 封面与居中封面真的是两种构图。
 */
describe('模板注册表：十套齐全、名字稳定、分类成体系', () => {
  it('模板名顺序固定，前六个仍是老的基础主题（自动挑选池按它取模）', () => {
    expect(PPT_TEMPLATE_NAMES).toEqual([
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
    ])
    // 老六套一个不少、顺序也没动（老文档的自动配色结果因此不变）
    expect([...PPT_TEMPLATE_NAMES].slice(0, PPT_THEME_NAMES.length)).toEqual([...PPT_THEME_NAMES])
  })

  it('names 与 PPT_THEMES 的键一一对应，PPT_TEMPLATES 也是同一批', () => {
    expect(Object.keys(PPT_THEMES)).toEqual([...PPT_TEMPLATE_NAMES])
    expect(PPT_TEMPLATES.map((template) => template.name)).toEqual([...PPT_TEMPLATE_NAMES])
  })

  it('每个模板：颜色是 6 位大写 hex、name 自洽、motif 在册、分类存在', () => {
    const categories = PPT_TEMPLATE_CATEGORIES.map((category) => category.id)

    for (const name of PPT_TEMPLATE_NAMES) {
      const theme = PPT_THEMES[name]
      expect(theme.name).toBe(name)
      for (const color of [
        theme.bg,
        theme.canvas,
        theme.title,
        theme.body,
        theme.accent,
        theme.muted,
        theme.onAccent
      ]) {
        expect(color, `${name} 的 ${color} 应是 6 位大写 hex`).toMatch(/^[0-9A-F]{6}$/)
      }
      expect(['bar', 'block', 'corner']).toContain(theme.motif)
      expect(['center', 'band', undefined]).toContain(theme.cover)

      const template = lookupTemplate(name)
      expect(template?.name).toBe(name)
      expect(categories).toContain(template?.category)
    }
  })

  it('十个模板的强调色两两不同（选模板 = 真的换了观感）', () => {
    const accents = PPT_TEMPLATE_NAMES.map((name) => PPT_THEMES[name].accent)
    expect(new Set(accents).size).toBe(PPT_TEMPLATE_NAMES.length)
  })

  it('分类是四类，每类都有模板且只落在注册表里的模板上', () => {
    expect(PPT_TEMPLATE_CATEGORIES).toEqual([
      { id: 'report', label: '工作汇报' },
      { id: 'academic', label: '学术研究' },
      { id: 'data', label: '数据报告' },
      { id: 'promo', label: '宣传推广' }
    ])

    for (const category of PPT_TEMPLATE_CATEGORIES) {
      expect(templatesOf(category.id).length).toBeGreaterThan(0)
    }
    expect(templatesOf(null)).toHaveLength(PPT_TEMPLATE_NAMES.length)

    // 四类合起来正好是全集，且不重不漏
    const grouped = PPT_TEMPLATE_CATEGORIES.flatMap((category) =>
      templatesOf(category.id).map((template) => template.name)
    )
    expect(grouped.sort()).toEqual([...PPT_TEMPLATE_NAMES].sort())
  })

  it('查名字只认注册表里的：空串与没见过的名字都给 undefined', () => {
    expect(lookupTemplate('学术紫')?.category).toBe('academic')
    expect(lookupTemplate('')).toBeUndefined()
    expect(lookupTemplate('彩虹色')).toBeUndefined()
  })

  it('分类归属照产品口径（工作汇报 3 / 学术研究 2 / 数据报告 2 / 宣传推广 3）', () => {
    const names = (category: Parameters<typeof templatesOf>[0]): string[] =>
      templatesOf(category).map((template) => template.name)

    // 顺序 = PPT_TEMPLATE_NAMES 里的顺序（画廊「全部」的排布）
    expect(names('report')).toEqual(['极简黑白', '商务蓝', '湖蓝'])
    expect(names('academic')).toEqual(['墨绿', '学术紫'])
    expect(names('data')).toEqual(['科技暗', '酒红'])
    expect(names('promo')).toEqual(['暖橙', '紫罗兰', '奶油'])
  })
})

describe('封面几何：装饰块都在画布内，两种构图分得开', () => {
  const inside = (box: PptBox): boolean =>
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.w <= PPT_CANVAS.w + 1e-9 &&
    box.y + box.h <= PPT_CANVAS.h + 1e-9

  /** 页脚文字盒（左「文档标题」0.6–9.4、右「页码」，y 5.08–5.38）——与生成侧同一个禁区口径 */
  const FOOTER_ZONE = { left: 0.6, right: 9.4, top: 5.08, bottom: 5.38 }
  const overlapsFooter = (box: PptBox): boolean =>
    box.x < FOOTER_ZONE.right &&
    box.x + box.w > FOOTER_ZONE.left &&
    box.y < FOOTER_ZONE.bottom &&
    box.y + box.h > FOOTER_ZONE.top

  it('三种 motif 的形状都在画布内，且避开页脚区（y ≥ 4.9 只留给页脚）', () => {
    for (const motif of ['bar', 'block', 'corner'] as const) {
      const boxes = motifBoxes(motif)
      expect(boxes.length).toBeGreaterThan(0)
      for (const box of boxes) {
        expect(inside(box), `${motif} 的色块 ${JSON.stringify(box)} 出了画布`).toBe(true)
        expect(overlapsFooter(box), `${motif} 的色块 ${JSON.stringify(box)} 压住了页脚`).toBe(false)
      }
    }
  })

  it('居中封面：装饰 = 该模板 motif 的形状，标题居中、40pt', () => {
    const plan = coverPlan(PPT_THEMES['商务蓝'])
    expect(plan.align).toBe('center')
    expect(plan.decor).toEqual(motifBoxes('block'))
    expect(plan.titleSize).toBe(40)
    expect(plan.title.w).toBeGreaterThan(plan.subtitle.w * 0.9)
  })

  it('band 封面（学术紫 / 湖蓝）：左侧通栏色带 + 左对齐标题块，几何各不相同', () => {
    for (const name of ['学术紫', '湖蓝'] as const) {
      const plan = coverPlan(PPT_THEMES[name])
      expect(plan.align, `${name} 应是左对齐封面`).toBe('left')
      expect(plan.decor).toHaveLength(1)
      const band = plan.decor[0]
      expect({ x: band.x, y: band.y, h: band.h }).toEqual({ x: 0, y: 0, h: PPT_CANVAS.h })
      expect(band.w).toBeGreaterThan(0.3)
      // 标题块让开色带（不压在色带上）
      expect(plan.title.x).toBeGreaterThan(band.x + band.w)
      expect(inside(plan.title) && inside(plan.subtitle) && inside(plan.rule)).toBe(true)
    }

    // 两种构图必须真的不一样（否则"新模板只是换了颜色"）
    const center = coverPlan(PPT_THEMES['商务蓝'])
    const band = coverPlan(PPT_THEMES['学术紫'])
    expect(band.align).not.toBe(center.align)
    expect(band.title.x).not.toBe(center.title.x)
    expect(band.rule.x).not.toBe(center.rule.x)
  })
})
