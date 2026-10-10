import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TOKENS_CSS = '../tokens/kimi-tokens.css'
const SEMANTIC_CSS = '../tokens/semantic.css'
const TAILWIND_CSS = '../tailwind.css'
const MAIN_TSX = '../../main.tsx'

function readSource(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

const tokensCss = readSource(TOKENS_CSS)
const semanticCss = readSource(SEMANTIC_CSS)
const tailwindCss = readSource(TAILWIND_CSS)

type Decls = Map<string, string>

/** 选择器只做空白/引号归一，`[data-theme="dark"]` 与 `[data-theme='dark']` 视作同一个。 */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, '').replace(/"/g, "'")
}

/** 把平铺样式表拆成「选择器 → 自定义属性表」；无嵌套规则的文件专用（tokens/semantic 都是平铺的）。 */
function collectBlocks(css: string): Map<string, Decls> {
  const blocks = new Map<string, Decls>()
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g
  let match = blockPattern.exec(stripped)
  while (match !== null) {
    const selector = normalizeSelector(match[1])
    const decls = blocks.get(selector) ?? new Map<string, string>()
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':')
      if (colon === -1) continue
      const name = declaration.slice(0, colon).trim()
      if (!name.startsWith('--')) continue
      decls.set(name, declaration.slice(colon + 1).trim())
    }
    blocks.set(selector, decls)
    match = blockPattern.exec(stripped)
  }
  return blocks
}

/** `.3s` 与 `0.3s` 是同一个值（prettier 会把前者写成后者），比较前归一。 */
function canonical(value: string): string {
  return value.replace(/(^|[\s,(])\.(\d)/g, '$10.$2')
}

const tokens = collectBlocks(tokensCss)
const semantic = collectBlocks(semanticCss)
const light: Decls = tokens.get(':root') ?? new Map<string, string>()
const dark: Decls = tokens.get(":root[data-theme='dark']") ?? new Map<string, string>()
const small: Decls = tokens.get(":root[data-font-size='small']") ?? new Map<string, string>()
const large: Decls = tokens.get(":root[data-font-size='large']") ?? new Map<string, string>()

function expectDecl(decls: Decls, name: string, value: string, scope: string): void {
  const actual = decls.get(name)
  expect(actual, `${scope} 缺少 ${name}`).toBeDefined()
  expect(canonical(actual as string), `${scope} 的 ${name}`).toBe(canonical(value))
}

describe('原样层 · 颜色（UI 参考 §2）', () => {
  const COLOR_CASES: Array<[string, string, string]> = [
    // [token, 浅色, 深色]
    ['--Bg-GroundPC', '#fbfaf9', '#181817'],
    ['--Bg-GroundPC-hover', '#f3f3f2', '#242423'],
    ['--Bg-GroundPC-active', '#eeeeed', '#2f2f2e'],
    ['--Bg-Primary', '#fff', '#121212'],
    ['--Bg-Primary70', '#ffffffb3', '#121212b3'],
    ['--Bg-Primary90-hover', '#f7f7f7e6', '#1f1f1fe7'],
    ['--Bg-Secondary', '#f5f5f5', '#1f1f1f'],
    ['--Bg-Tertiary', '#fff', '#292929'],
    ['--Bg-Tertiary90-active', '#f1f1f1e7', '#414141e8'],
    ['--Bg-Quaternary', '#fff', '#4d4d4d'],
    ['--BgGp-Primary', '#f5f5f5', '#121212'],
    ['--BgGp-Secondary', '#fff', '#1f1f1f'],
    ['--BgGp-Secondary90', '#ffffffe6', '#1f1f1fe6'],
    ['--BgGp-Tertiary', '#f5f5f5', '#292929'],
    ['--Labels-Primary', '#000000e6', '#ffffffd6'],
    ['--Labels-Primary-active', '#000000e7', '#ffffffda'],
    ['--Labels-Secondary', '#0009', '#ffffff8f'],
    ['--Labels-Tertiary', '#00000073', '#ffffff6b'],
    ['--Labels-Quaternary', '#0000004d', '#ffffff42'],
    ['--Fills-F1', '#00000008', '#ffffff0d'],
    ['--Fills-F2', '#0000000d', '#ffffff1a'],
    ['--Fills-F2-hover', '#00000014', '#ffffff25'],
    ['--Fills-F3', '#00000026', '#ffffff2e'],
    ['--Fills-F4', '#00000040', '#ffffff40'],
    ['--Separators-S1', '#00000021', '#ffffff1f'],
    ['--Separators-S1-active', '#0000002c', '#ffffff35'],
    ['--Colors-Green', '#32ff7d', '#32ff7d'],
    ['--Colors-KMBlue', '#1783ff', '#1a88ff'],
    ['--Colors-KMBlue-active', '#167cf2', '#3194ff'],
    ['--Colors-Orange', '#ff9500', '#ff9f0a'],
    ['--Colors-PositiveGreen', '#16c456', '#16c456'],
    ['--Colors-PositiveGreen25', '#16c45640', '#16c45640'],
    ['--Colors-Purple', '#985ffb', '#a16bff'],
    ['--Colors-Red', '#ff3849', '#ff4756'],
    ['--Colors-Red25', '#ff384940', '#ff475640'],
    ['--Colors-Yellow', '#ffd230', '#ffd230'],
    ['--MaskBg-Base', '#0006', '#0009'],
    ['--MaskBg-Icon', '#00000040', '#454545b3'],
    ['--MaskBg-ToastPC', '#2b2b2b', '#404040'],
    ['--Always-Black', '#000', '#000'],
    ['--Always-White', '#fff', '#fff'],
    ['--Always-WhiteSecondary', '#ffffffd6', '#ffffffd6'],
    ['--Others-BubbleBlue', '#1783ff', '#292929'],
    ['--Others-KMBlue10', '#1783ff1a', '#1a88ff1a'],
    ['--Others-KMBlueDisabled', '#1783ff66', '#1a88ff66'],
    ['--Others-LightBlueBg', '#e8f3ff', '#1e2a38'],
    ['--Others-LightGreenBg', '#16c4561a', '#16c4561a'],
    ['--Others-LightOrangeBg', '#ff95001a', '#ff9f0a1a'],
    ['--Others-LightRedBg', '#ff4d4d1a', '#ff52521a'],
    ['--Others-LightYellowBg', '#ffc80033', '#ffd23033'],
    ['--Others-SubLayerBg', '#00000014', '#ffffff0f'],
    ['--Others-TextSelected', '#1783ff33', '#1a88ff33'],
    ['--Others-WhiteOnDarkDisabled', '#fff', '#fff6'],
    ['--Syntax-Comment', '#a1a1a1', '#5c6370'],
    ['--Syntax-Keyword', '#a626a4', '#d55fde'],
    ['--Syntax-Literal', '#986801', '#d19a66'],
    ['--Syntax-Mark', '#526fff', '#2bbac5'],
    ['--Syntax-Metadata', '#c18401', '#e5c07b'],
    ['--Syntax-MultilineComment', '#a1a1a1', '#5c6370'],
    ['--Syntax-Punctuation', '#e45649', '#ef596f'],
    ['--Syntax-String', '#50a14f', '#89ca78'],
    // §2.12 / §2.13 本地桌面端补的族
    ['--Shadows-S1', 'rgba(0, 0, 0, .1)', 'rgba(0, 0, 0, .4)'],
    ['--Shadows-S1-hover', 'rgba(0, 0, 0, .127)', 'rgba(30, 30, 30, .43)'],
    ['--Shadows-S1-active', 'rgba(0, 0, 0, .145)', 'rgba(55, 55, 55, .46)'],
    ['--glass-view-shadow', '0 2px 10px 0 #00000003', '0 2px 10px 2px #0000001a'],
    ['--Colors-DiffAdd', '#2da44e', '#3fb950'],
    ['--Colors-DiffAdd-hover', 'rgba(44, 159, 76, 1)', 'rgba(73, 189, 89, 1)'],
    ['--Colors-DiffAdd-active', 'rgba(43, 156, 74, 1)', 'rgba(82, 192, 98, 1)'],
    ['--Colors-DiffDelete', '#d1242f', '#f85149'],
    ['--Colors-DiffDelete-hover', 'rgba(203, 35, 46, 1)', 'rgba(248, 90, 82, 1)'],
    ['--Colors-DiffDelete-active', 'rgba(199, 34, 45, 1)', 'rgba(249, 98, 91, 1)']
  ]

  it.each(COLOR_CASES)('浅色 %s = %s', (name, lightValue) => {
    expectDecl(light, name, lightValue, ':root')
  })

  it.each(COLOR_CASES)('深色 %s = %s', (name, _lightValue, darkValue) => {
    expectDecl(dark, name, darkValue, ":root[data-theme='dark']")
  })

  const FAMILY_COUNTS: Array<[string, number]> = [
    // 族内条数 = 基名 × 3 档（默认 / hover / active），口径同 UI 参考 §2 各行
    ['--Bg-', 27],
    ['--BgGp-', 15],
    ['--Labels-', 12],
    ['--Fills-', 12],
    ['--Separators-', 3],
    ['--Colors-', 33],
    ['--MaskBg-', 24],
    ['--Always-', 24],
    ['--Others-', 36],
    ['--Syntax-', 24]
  ]

  it.each(FAMILY_COUNTS)('浅色族 %s 共 %i 条', (prefix, count) => {
    expect([...light.keys()].filter((key) => key.startsWith(prefix))).toHaveLength(count)
  })

  it.each(FAMILY_COUNTS)('深色族 %s 共 %i 条', (prefix, count) => {
    expect([...dark.keys()].filter((key) => key.startsWith(prefix))).toHaveLength(count)
  })

  const COLOR_PREFIXES = [
    ...FAMILY_COUNTS.map(([prefix]) => prefix),
    '--Shadows-S1',
    '--glass-view-shadow'
  ]
  const colorKeys = (decls: Decls): string[] =>
    [...decls.keys()]
      .filter((key) => COLOR_PREFIXES.some((prefix) => key.startsWith(prefix)))
      .sort()

  it('浅色色 token 共 214 条，深色一一对应（深色无独有 token）', () => {
    const lightKeys = colorKeys(light)

    expect(lightKeys).toHaveLength(214)
    expect(colorKeys(dark)).toEqual(lightKeys)
  })

  it('深色不覆写字阶（§3.1：ui-* / markdown-* 深色沿用同值）', () => {
    const fontKeys = [...dark.keys()].filter(
      (key) => key.startsWith('--ui-') || key.startsWith('--markdown-')
    )

    expect(fontKeys).toEqual([])
  })
})

describe('原样层 · 字阶（UI 参考 §3）', () => {
  // [token, 默认「字号/行高」, small, large]
  const TYPE_TIERS: Array<[string, [number, number], [number, number], [number, number]]> = [
    ['ui-T1', [18, 26], [16, 24], [20, 26]],
    ['ui-T2', [16, 24], [14, 20], [18, 27]],
    ['ui-B1', [15, 22], [14, 20], [17, 25]],
    ['ui-B2', [14, 20], [14, 20], [16, 22]],
    ['ui-C1', [12, 18], [12, 18], [14, 21]],
    ['ui-C2', [10, 14], [10, 14], [12, 17]],
    ['markdown-H1_Content', [22, 36], [20, 32], [24, 39]],
    ['markdown-H2_Content', [20, 32], [18, 28], [22, 36]],
    ['markdown-H3_Content', [18, 28], [16, 26], [20, 31]],
    ['markdown-B1_Content', [16, 26], [14, 22], [18, 29]],
    ['markdown-B2_Content', [15, 24], [14, 22], [17, 27]],
    ['markdown-B3_Content', [14, 22], [14, 22], [16, 25]],
    ['markdown-InlineCode', [16, 26], [14, 22], [18, 29]],
    ['markdown-Codeblocks', [14, 22], [14, 22], [16, 25]]
  ]

  it.each(TYPE_TIERS)('默认档 %s = %ipx / %ipx', (tier, [size, lineHeight]) => {
    expectDecl(light, `--${tier}-font-size`, `${size}px`, ':root')
    expectDecl(light, `--${tier}-line-height`, `${lineHeight}px`, ':root')
  })

  it.each(TYPE_TIERS)('small 档 %s = %ipx / %ipx', (tier, _d, [size, lineHeight]) => {
    expectDecl(small, `--${tier}-font-size`, `${size}px`, ':root[data-font-size=small]')
    expectDecl(small, `--${tier}-line-height`, `${lineHeight}px`, ':root[data-font-size=small]')
  })

  it.each(TYPE_TIERS)('large 档 %s = %ipx / %ipx', (tier, _d, _s, [size, lineHeight]) => {
    expectDecl(large, `--${tier}-font-size`, `${size}px`, ':root[data-font-size=large]')
    expectDecl(large, `--${tier}-line-height`, `${lineHeight}px`, ':root[data-font-size=large]')
  })

  it('整组换值：三档各自覆盖全部 14 阶（28 条声明），不是乘法缩放', () => {
    const expected = TYPE_TIERS.length * 2

    expect(
      [...small.keys()].filter((key) => key.includes('-font-size') || key.includes('-line-height'))
    ).toHaveLength(expected)
    expect(
      [...large.keys()].filter((key) => key.includes('-font-size') || key.includes('-line-height'))
    ).toHaveLength(expected)
  })

  it('无字体度量 token 之外的字阶残留：ui-* 恰好六档（§3.1）', () => {
    const tiers = new Set(
      [...light.keys()]
        .filter((key) => key.startsWith('--ui-') && key.endsWith('-font-size'))
        .map((key) => key)
    )

    expect([...tiers].sort()).toEqual([
      '--ui-B1-font-size',
      '--ui-B2-font-size',
      '--ui-C1-font-size',
      '--ui-C2-font-size',
      '--ui-T1-font-size',
      '--ui-T2-font-size'
    ])
  })
})

describe('原样层 · 圆角 / 描边 / 阴影（UI 参考 §5）', () => {
  const RADIUS_CASES: Array<[string, string]> = [
    ['--chat-input-radius', '24px'],
    ['--flip-digit-border-radius', '4px'],
    ['--kimi-select-radius', '12px'],
    ['--km-modal-radius', '20px'],
    ['--linear-icon-button-radius', '20px'],
    ['--picker-color-radius', '2px'],
    ['--report-radius', '12px'],
    ['--settings-card-radius', '16px'],
    ['--slide-carousel-radius', '16px'],
    ['--table-border-radius', '12px']
  ]

  it.each(RADIUS_CASES)('组件圆角原样 token %s = %s', (name, value) => {
    expectDecl(light, name, value, ':root')
  })

  it('描边两档：.5px 是基准（§5.3）', () => {
    expectDecl(light, '--border-width-hairline', '.5px', ':root')
    expectDecl(light, '--border-width-base', '1px', ':root')
  })

  it('阴影：文档点名的两条字面量收成 token（§5.4）', () => {
    expectDecl(light, '--shadow-popover', '0 4px 16.4px #0000001a', ':root')
    expectDecl(light, '--shadow-input', '0 5px 16px -4px #00000012', ':root')
  })
})

describe('原样层 · 动效（UI 参考 §6）', () => {
  const DURATIONS: Array<[string, string]> = [
    ['--duration-micro', '60ms'],
    ['--duration-micro-slow', '80ms'],
    ['--duration-quick', '.15s'],
    ['--duration-base', '.2s'],
    ['--duration-main', '.3s'],
    ['--duration-shift', '.38s'],
    ['--duration-shift-lg', '.4s'],
    ['--duration-loop', '1s'],
    ['--duration-loop-slow', '1.4s'],
    ['--clp-d', '.48s']
  ]

  const EASINGS: Array<[string, string]> = [
    ['--clp-ease-out', 'cubic-bezier(.23, 1, .32, 1)'],
    ['--clp-ease-open', 'cubic-bezier(.25, 1, .3, 1)'],
    ['--clp-ease-close', 'cubic-bezier(.55, 0, .18, 1)'],
    ['--clp-ease-drawer', 'cubic-bezier(.32, .72, 0, 1)']
  ]

  it.each(DURATIONS)('时长档 %s = %s', (name, value) => {
    expectDecl(light, name, value, ':root')
  })

  it.each(EASINGS)('曲线 token %s = %s', (name, value) => {
    expectDecl(light, name, value, ':root')
  })

  it('动效主档是 .3s + ease-in-out（语义层），不是 .2s ease', () => {
    expectDecl(semantic.get(':root') ?? new Map(), '--motion-ease-inout', 'ease-in-out', ':root')
    expectDecl(semantic.get(':root') ?? new Map(), '--motion-main', 'var(--duration-main)', ':root')
    expectDecl(
      semantic.get(':root') ?? new Map(),
      '--motion-fast',
      'var(--duration-quick)',
      ':root'
    )
    expect(canonical(light.get('--duration-main') ?? '')).toBe(canonical('.3s'))
  })
})

describe('工程阶梯 · 间距（UI 参考 §4.3 的推断阶梯）', () => {
  const SPACE_STEPS: Array<[string, number]> = [
    ['--space-0-5', 2],
    ['--space-1', 4],
    ['--space-1-5', 6],
    ['--space-2', 8],
    ['--space-2-5', 10],
    ['--space-3', 12],
    ['--space-3-5', 14],
    ['--space-4', 16],
    ['--space-5', 20],
    ['--space-6', 24],
    ['--space-7', 28],
    ['--space-7-5', 30],
    ['--space-8', 32],
    ['--space-10', 40],
    ['--space-12', 48],
    ['--space-14', 56],
    ['--space-16', 64]
  ]

  it.each(SPACE_STEPS)('%s = %ipx', (name, value) => {
    expectDecl(light, name, `${value}px`, ':root')
  })

  it('阶梯覆盖 2–64 的 17 档', () => {
    expect([...light.keys()].filter((key) => key.startsWith('--space-'))).toHaveLength(
      SPACE_STEPS.length
    )
  })

  it('命名与 Tailwind 间距刻度同源：--space-N 是 4px 网格的第 N 格', () => {
    expect(canonical(light.get('--space-2') ?? '')).toBe('8px')
    expect(canonical(light.get('--space-4') ?? '')).toBe('16px')
    expect(canonical(light.get('--space-6') ?? '')).toBe('24px')
  })

  it('工程圆角阶梯只收 Kimi 写死为字面值的档', () => {
    expectDecl(light, '--radius-badge', '4px', ':root')
    expectDecl(light, '--radius-button-sm', '8px', ':root')
    expectDecl(light, '--radius-control', '10px', ':root')
    expectDecl(light, '--radius-button-lg', '12px', ':root')
    expectDecl(light, '--radius-pill', '999px', ':root')
  })
})

describe('语义层（semantic.css）', () => {
  const root = semantic.get(':root') ?? new Map<string, string>()
  const darkSemantic = semantic.get(":root[data-theme='dark']") ?? new Map<string, string>()

  const ALIASES: Array<[string, string]> = [
    ['--bg-canvas', 'var(--Bg-GroundPC)'],
    ['--bg-primary', 'var(--Bg-Primary)'],
    ['--bg-secondary', 'var(--Bg-Secondary)'],
    ['--bg-menu', 'var(--Bg-Tertiary)'],
    ['--text-primary', 'var(--Labels-Primary)'],
    ['--text-secondary', 'var(--Labels-Secondary)'],
    ['--border-hairline', 'var(--Separators-S1)'],
    ['--fill-hover', 'var(--Fills-F1)'],
    ['--fill-selected', 'var(--Fills-F2)'],
    ['--fill-active', 'var(--Fills-F3)'],
    ['--accent', 'var(--Colors-KMBlue)'],
    ['--positive', 'var(--Colors-PositiveGreen)'],
    ['--positive-bg', 'var(--Others-LightGreenBg)'],
    ['--warning', 'var(--Colors-Orange)'],
    ['--warning-bg', 'var(--Others-LightOrangeBg)'],
    ['--danger', 'var(--Colors-Red)'],
    ['--danger-bg', 'var(--Others-LightRedBg)'],
    ['--diff-add', 'var(--Colors-DiffAdd)'],
    ['--diff-delete', 'var(--Colors-DiffDelete)'],
    ['--motion-fast', 'var(--duration-quick)'],
    ['--motion-main', 'var(--duration-main)'],
    ['--motion-ease-inout', 'ease-in-out'],
    ['--motion-ease-out', 'var(--clp-ease-out)'],
    ['--radius-field', 'var(--kimi-select-radius)'],
    ['--radius-panel', 'var(--settings-card-radius)'],
    ['--radius-overlay', 'var(--km-modal-radius)'],
    ['--radius-icon-button', 'var(--linear-icon-button-radius)'],
    ['--radius-input', 'var(--chat-input-radius)'],
    ['--focus-ring', 'inset 0 0 0 1px var(--Labels-Primary)'],
    ['--selection', 'var(--Others-TextSelected)'],
    ['--mask', 'var(--MaskBg-Base)'],
    ['--blur-glass', '15px'],
    ['--hairline-width', 'var(--border-width-hairline)'],
    ['--scrollbar-size', '6px'],
    ['--scrollbar-thumb', 'var(--Fills-F2)'],
    ['--scrollbar-thumb-hover', 'var(--Fills-F3)']
  ]

  it.each(ALIASES)('语义 token %s = %s', (name, value) => {
    expectDecl(root, name, value, 'semantic :root')
  })

  it('新增 token --accent-text：浅 #0065dd / 深 #3194ff（Kimi 没有蓝字档）', () => {
    expectDecl(root, '--accent-text', '#0065dd', 'semantic :root')
    expectDecl(darkSemantic, '--accent-text', '#3194ff', "semantic :root[data-theme='dark']")
  })

  it('语义层的每个 var() 引用都能在原样层找到定义', () => {
    const declared = new Set([...tokens.values()].flatMap((decls) => [...decls.keys()]))
    const referenced = [
      ...new Set([...semanticCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))
    ].sort()

    expect(referenced.length).toBeGreaterThan(20)
    for (const name of referenced) {
      expect(declared.has(name), `原样层没有定义 ${name}`).toBe(true)
    }
  })
})

describe('T3 控件尺寸与组件级 token（UI 验收表数值）', () => {
  const t3root = semantic.get(':root') ?? new Map<string, string>()
  const t3dark = semantic.get(":root[data-theme='dark']") ?? new Map<string, string>()

  it('三级/四级灰用达标档（spec §6.5 刻意偏离；台账 R6）', () => {
    expectDecl(t3root, '--text-tertiary', '#0000008c', 'semantic :root')
    expectDecl(t3root, '--text-quaternary', '#00000070', 'semantic :root')
    expectDecl(t3dark, '--text-tertiary', '#ffffff85', "semantic :root[data-theme='dark']")
    expectDecl(t3dark, '--text-quaternary', '#ffffff5c', "semantic :root[data-theme='dark']")
  })

  const CONTROL_TOKENS: Array<[string, string]> = [
    // 控件高度阶梯（§4.7）
    ['--control-height-sm', '26px'],
    ['--control-height-md', '32px'],
    ['--control-height-lg', '44px'],
    ['--control-min-width-sm', '52px'],
    ['--control-min-width-md', '62px'],
    ['--control-min-width-lg', '72px'],
    ['--icon-button-size', '36px'],
    ['--field-height', '40px'],
    ['--chip-height', '36px'],
    // 图标与 spinner（§4.7 spinner 16/18/20、§4.8 图标 18 与不透明度三档）
    ['--icon-size-sm', '16px'],
    ['--icon-size-md', '18px'],
    ['--icon-size-lg', '20px'],
    ['--icon-opacity', '0.56'],
    ['--icon-opacity-hover', '0.84'],
    ['--icon-opacity-disabled', '0.26'],
    ['--spinner-stroke', '1.5px'],
    // 按钮（§7）
    ['--button-primary-bg', 'var(--Labels-Primary)'],
    ['--button-primary-bg-hover', 'var(--Labels-Primary-hover)'],
    ['--button-primary-bg-active', 'var(--Labels-Primary-active)'],
    ['--button-primary-fg', 'var(--Bg-Primary)'],
    ['--button-danger-bg', 'var(--Colors-Red)'],
    ['--button-danger-bg-hover', 'var(--Colors-Red-hover)'],
    ['--button-danger-bg-active', 'var(--Colors-Red-active)'],
    ['--button-danger-fg', 'var(--Always-White)'],
    ['--text-disabled', 'var(--Labels-Quaternary)'],
    ['--fill-disabled', 'var(--Fills-F3)'],
    // 输入框（§4.7 .kimi-select）、菜单（§7）、弹层（§4.5）
    ['--border-field', 'var(--Fills-F1)'],
    ['--field-bg', 'var(--Bg-Primary)'],
    ['--menu-item-height', '36px'],
    ['--menu-pad', 'var(--space-2)'],
    ['--menu-item-radius', 'var(--radius-control)'],
    ['--overlay-width-sm', '360px'],
    ['--overlay-width-md', '560px'],
    ['--overlay-max-width', 'calc(100vw - var(--space-8))'],
    ['--shadow-overlay', '0 4px 16.4px var(--Shadows-S1)'],
    ['--bg-overlay', 'var(--Bg-Tertiary)'],
    // 提示与骨架屏
    ['--tooltip-bg', 'var(--Always-TransparencyDarkFill)'],
    ['--tooltip-fg', 'var(--Always-WhiteSecondary)'],
    ['--skeleton-base', 'var(--Fills-F2)'],
    ['--skeleton-highlight', 'var(--Bg-Primary)']
  ]

  it.each(CONTROL_TOKENS)('T3 token %s = %s', (name, value) => {
    expectDecl(t3root, name, value, 'semantic :root')
  })

  it('深色档只重写必须分档的，别名不重复声明（翻档交给原样层）', () => {
    expectDecl(t3dark, '--field-bg', 'var(--Bg-Secondary)', "semantic :root[data-theme='dark']")
    expectDecl(
      t3dark,
      '--skeleton-highlight',
      'var(--Always-TransparencyWhite15)',
      "semantic :root[data-theme='dark']"
    )
    for (const name of ['--button-primary-bg', '--bg-overlay', '--menu-pad', '--icon-opacity']) {
      expect(t3dark.has(name), `深色档不该重写别名 ${name}`).toBe(false)
    }
  })
})

describe('tailwind.css 接线', () => {
  it('Tailwind 入口 + 两层 token 的导入顺序', () => {
    expect(tailwindCss).toContain("@import 'tailwindcss'")
    expect(tailwindCss).toContain("@import './tokens/kimi-tokens.css'")
    expect(tailwindCss).toContain("@import './tokens/semantic.css'")
    expect(tailwindCss.indexOf("@import 'tailwindcss'")).toBeLessThan(
      tailwindCss.indexOf("@import './tokens/kimi-tokens.css'")
    )
  })

  it('dark 变体对齐 html[data-theme=dark]，不是 .dark 或 media query', () => {
    expect(tailwindCss).toContain('@custom-variant dark')
    expect(tailwindCss).toContain("[data-theme='dark']")
  })

  it('@theme inline 把语义层映射成 Tailwind 主题', () => {
    expect(tailwindCss).toContain('@theme inline')
    expect(tailwindCss).toContain('--color-canvas: var(--bg-canvas)')
    expect(tailwindCss).toContain('--color-ink: var(--text-primary)')
    expect(tailwindCss).toContain('--color-menu: var(--bg-menu)')
    expect(tailwindCss).toContain('--color-hover: var(--fill-hover)')
    expect(tailwindCss).toContain('--color-selected: var(--fill-selected)')
    expect(tailwindCss).toContain('--color-hairline: var(--border-hairline)')
    expect(tailwindCss).toContain('--text-b1: var(--ui-B1-font-size)')
    expect(tailwindCss).toContain('--text-b1--line-height: var(--ui-B1-line-height)')
    expect(tailwindCss).toContain('--radius-overlay: var(--km-modal-radius)')
    expect(tailwindCss).toContain('--font-sans:')
  })

  it('@theme inline 引用的 token 都能找到定义（Tailwind 自带的 --font-* 除外）', () => {
    const declared = new Set([
      ...tokens.values().flatMap((decls) => [...decls.keys()]),
      ...semantic.values().flatMap((decls) => [...decls.keys()])
    ])
    const referenced = [
      ...new Set([...tailwindCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))
    ].sort()

    for (const name of referenced) {
      if (name === '--font-sans' || name === '--font-mono') continue // Tailwind 主题命名空间
      if (name.startsWith('--radix-')) continue // Radix 运行时注入（浮层变形原点），不是我们的 token
      expect(declared.has(name), `两层 token 都没有定义 ${name}`).toBe(true)
    }
  })

  const themeDecls = new Map(
    [...tailwindCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(
      (match) => [match[1], match[2].trim()]
    )
  )
  const semanticRoot = semantic.get(':root') ?? new Map<string, string>()

  const COLOR_MAPPING: Array<[string, string]> = [
    ['--color-canvas', '--bg-canvas'],
    ['--color-surface', '--bg-primary'],
    ['--color-secondary', '--bg-secondary'],
    ['--color-menu', '--bg-menu'],
    ['--color-ink', '--text-primary'],
    ['--color-ink-secondary', '--text-secondary'],
    ['--color-ink-tertiary', '--text-tertiary'],
    ['--color-hairline', '--border-hairline'],
    ['--color-hover', '--fill-hover'],
    ['--color-selected', '--fill-selected'],
    ['--color-active', '--fill-active'],
    ['--color-accent', '--accent'],
    ['--color-accent-text', '--accent-text'],
    ['--color-positive', '--positive'],
    ['--color-positive-bg', '--positive-bg'],
    ['--color-warning', '--warning'],
    ['--color-warning-bg', '--warning-bg'],
    ['--color-danger', '--danger'],
    ['--color-danger-bg', '--danger-bg'],
    ['--color-diff-add', '--diff-add'],
    ['--color-diff-delete', '--diff-delete'],
    ['--color-selection', '--selection'],
    ['--color-mask', '--mask']
  ]

  it.each(COLOR_MAPPING)('颜色映射 %s ← %s 指向语义层', (tailwindName, semanticName) => {
    expectDecl(themeDecls, tailwindName, `var(${semanticName})`, '@theme')
  })

  const RADIUS_MAPPING: Array<[string, string]> = [
    ['--radius-badge', '--radius-badge'],
    ['--radius-button-sm', '--radius-button-sm'],
    ['--radius-control', '--radius-control'],
    ['--radius-button-lg', '--radius-button-lg'],
    ['--radius-pill', '--radius-pill'],
    ['--radius-field', '--radius-field'],
    ['--radius-panel', '--radius-panel'],
    ['--radius-overlay', '--radius-overlay'],
    ['--radius-icon-button', '--radius-icon-button'],
    ['--radius-input', '--radius-input']
  ]

  it.each(RADIUS_MAPPING)('圆角映射 %s ↔ %s 两层取值一致（防漂移）', (tailwindName, sourceName) => {
    const source = semanticRoot.get(sourceName) ?? light.get(sourceName) ?? '<缺失>'

    expectDecl(themeDecls, tailwindName, source, '@theme')
  })

  it('字号映射：ui-* 六档的字号与行高都进主题', () => {
    const tiers = ['t1', 't2', 'b1', 'b2', 'c1', 'c2']

    for (const tier of tiers) {
      expectDecl(
        themeDecls,
        `--text-${tier}`,
        `var(--ui-${tier.toUpperCase()}-font-size)`,
        '@theme'
      )
      expectDecl(
        themeDecls,
        `--text-${tier}--line-height`,
        `var(--ui-${tier.toUpperCase()}-line-height)`,
        '@theme'
      )
    }
  })

  it('缓动映射与语义层一致', () => {
    expectDecl(themeDecls, '--ease-main', 'var(--motion-ease-inout)', '@theme')
  })

  it('全局基础：body 底色/正文色、墨色焦点环、5–7px 滚动条、color-scheme', () => {
    expect(tailwindCss).toContain('background-color: var(--bg-canvas)')
    expect(tailwindCss).toContain('color: var(--text-primary)')
    expect(tailwindCss).toContain('box-shadow: var(--focus-ring)')
    expect(tailwindCss).toContain('width: var(--scrollbar-size)')
    expect(tailwindCss).toContain('background-color: var(--scrollbar-thumb)')
    expect(tailwindCss).toContain('color-scheme: light')
    expect(tailwindCss).toContain('color-scheme: dark')
  })

  it('全局尊重 prefers-reduced-motion', () => {
    expect(tailwindCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(tailwindCss).toMatch(/animation-duration:\s*0?\.01ms\s*!important/)
    expect(tailwindCss).toMatch(/transition-duration:\s*0?\.01ms\s*!important/)
  })
})

describe('样式入口接线', () => {
  const mainSource = readSource(MAIN_TSX)

  it('main.tsx 引 tailwind.css 入口，不再引模板 main.css', () => {
    expect(mainSource).toContain("import './styles/tailwind.css'")
    expect(mainSource).not.toContain('assets/main.css')
  })

  it('模板样式文件已删除（不留双重来源）', () => {
    expect(existsSync(new URL('../../assets/main.css', import.meta.url))).toBe(false)
  })

  it('main.tsx 启动时初始化主题机制', () => {
    expect(mainSource).toContain('initTheme')
  })
})

describe('T4 壳布局尺寸（spec §6.2 三栏骨架 / 附录 A）', () => {
  const shellRoot = semantic.get(':root') ?? new Map<string, string>()

  it('顶栏 42 / 侧栏 240 / 工作台 400 都在语义层有 token（壳不写裸数值）', () => {
    expectDecl(shellRoot, '--titlebar-height', '42px', 'semantic :root')
    expectDecl(shellRoot, '--sidebar-width', '240px', 'semantic :root')
    expectDecl(shellRoot, '--work-panel-width', '400px', 'semantic :root')
  })

  it('壳 token 不随主题分档（几何在明暗下一致）', () => {
    const darkShell = semantic.get(":root[data-theme='dark']") ?? new Map<string, string>()
    for (const name of ['--titlebar-height', '--sidebar-width', '--work-panel-width']) {
      expect(darkShell.has(name), `深色档不该重写几何 ${name}`).toBe(false)
    }
  })
})

describe('T5 导航项与新建会话尺寸（附录 A 实测值）', () => {
  const t5root = semantic.get(':root') ?? new Map<string, string>()

  it('导航项高 36（实测 35.9）/ 新建会话按钮高 41（实测 41.3）进语义层', () => {
    expectDecl(t5root, '--nav-item-height', '36px', 'semantic :root')
    expectDecl(t5root, '--new-session-height', '41px', 'semantic :root')
  })

  it('这两条也是几何，深色档不重写', () => {
    const t5dark = semantic.get(":root[data-theme='dark']") ?? new Map<string, string>()
    for (const name of ['--nav-item-height', '--new-session-height']) {
      expect(t5dark.has(name), `深色档不该重写几何 ${name}`).toBe(false)
    }
  })

  it('图标尺度复用 §4.8 的 18 档（导航项图标不另起一个尺寸 token）', () => {
    expectDecl(t5root, '--icon-size-md', '18px', 'semantic :root')
    expect(t5root.has('--nav-icon-size'), '不该另起 nav 专用图标尺寸').toBe(false)
  })

  it('内容层限宽 800（spec §6.2 消息列）：侧栏是覆盖层，贴左缘的内容会被盖住', () => {
    expectDecl(t5root, '--content-max-width', '800px', 'semantic :root')
  })
})
