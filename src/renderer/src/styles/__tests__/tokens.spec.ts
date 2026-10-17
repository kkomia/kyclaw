import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TOKENS_CSS = '../tokens/kimi-tokens.css'
const IDENTITY_CSS = '../tokens/identity.css'
const MOTION_CSS = '../tokens/motion.css'
const SEMANTIC_CSS = '../tokens/semantic.css'
const TAILWIND_CSS = '../tailwind.css'
const MAIN_TSX = '../../main.tsx'
const OFFICE_SURFACE_CSS = '../../office/surface.css'
const OFFICE_CHROME_CSS = '../../office/office-chrome.css'
const OFFICE_MAIN_TSX = '../../office/main.tsx'
const OFFICE_AI_PANEL_TSX = '../../features/office/OfficeAiPanel.tsx'

function readSource(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

const tokensCss = readSource(TOKENS_CSS)
const identityCss = readSource(IDENTITY_CSS)
const motionCss = readSource(MOTION_CSS)
const semanticCss = readSource(SEMANTIC_CSS)
const tailwindCss = readSource(TAILWIND_CSS)
const officeSurfaceCss = readSource(OFFICE_SURFACE_CSS)
const officeChromeCss = readSource(OFFICE_CHROME_CSS)
const officeMainTsx = readSource(OFFICE_MAIN_TSX)
const officeAiPanelTsx = readSource(OFFICE_AI_PANEL_TSX)

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
const identity = collectBlocks(identityCss)
/** motion.css 的 reduced-motion 媒体块里也有一个 :root（覆盖角色时长）——平铺解析器会把它与
 *  基础 :root 合并、后写覆盖。这里只取「媒体块之外」的基础令牌，媒体块单独用正则断言。 */
const motion = collectBlocks(motionCss.replace(/@media[^{]*\{[\s\S]*?\n\}\n/, ''))
const semantic = collectBlocks(semanticCss)
const light: Decls = tokens.get(':root') ?? new Map<string, string>()
const dark: Decls = tokens.get(":root[data-theme='dark']") ?? new Map<string, string>()
const identityLight: Decls = identity.get(':root') ?? new Map<string, string>()
const identityDark: Decls = identity.get(":root[data-theme='dark']") ?? new Map<string, string>()
const motionRoot: Decls = motion.get(':root') ?? new Map<string, string>()
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

/**
 * 身份层（identity.css，P0 2026-10-18）：Claude palette.claude 的 `--k-*` 原样值，浅/深两段。
 * 值来源见章程 §3.8；这里钉「浅深两段齐全 + 关键角色逐值」，防止后续迁移把色板改回 Kimi 或自造色。
 */
describe('身份层（identity.css）· Claude 保底色板', () => {
  const IDENTITY_CASES: Array<[string, string, string]> = [
    // [token, 浅色, 深色]（逐条对应 tokens.json palette.claude）
    ['--k-canvas', '#fcfcfb', '#141413'],
    ['--k-card', '#ffffff', '#1e1e1d'],
    ['--k-sidebar', '#fbfbf9', '#141413'],
    ['--k-inset', '#f0f0ef', '#1c1b1a'],
    ['--k-menu', '#ffffff', '#242320'],
    ['--k-chip', '#f6f6f4', '#242320'],
    ['--k-bubble', '#f0f0ef', 'rgba(255, 255, 255, 0.06)'],
    ['--k-ink', '#141413', '#faf9f5'],
    ['--k-ink-2', '#6e6a60', '#b0aea5'],
    ['--k-ink-3', '#8f8a7e', '#8f8d84'],
    // D-29：12px 承载信息的同色相压深档（浅 #776f62 ≈4.86:1）
    ['--k-ink-3-readable', '#776f62', '#8f8d84'],
    ['--k-ink-4', '#a6a094', '#6b6a65'],
    ['--k-accent', '#d97757', '#d97757'],
    ['--k-accent-hover', '#c6613f', '#e08a6d'],
    ['--k-on-accent', '#faf9f5', '#faf9f5'],
    ['--k-link', '#c6613f', '#e08a6d'],
    ['--k-border-l1', '#e8e6dc', 'rgba(255, 255, 255, 0.09)'],
    ['--k-border-l2', '#dedcd2', 'rgba(255, 255, 255, 0.18)'],
    ['--k-border-l3', '#d0cdc1', 'rgba(255, 255, 255, 0.3)'],
    ['--k-hover', 'rgba(0, 0, 0, 0.08)', 'rgba(255, 255, 255, 0.08)'],
    ['--k-hover-solid', '#f0efe9', '#2e2c29'],
    ['--k-active', 'rgba(217, 119, 87, 0.3)', 'rgba(217, 119, 87, 0.3)'],
    ['--k-code-ink', '#943333', '#e8a08a'],
    ['--k-positive', '#3d7550', '#8cbf96'],
    ['--k-warning', '#a4621d', '#e2a45f'],
    ['--k-danger', '#943333', '#e8a08a'],
    ['--k-selection', 'rgba(217, 119, 87, 0.3)', 'rgba(217, 119, 87, 0.3)'],
    // Office 纸面不来自 tokens.json（Word-faithful 硬决定）：浅白纸 / 深灰纸
    ['--k-paper', '#ffffff', '#cfd1cb']
  ]

  it.each(IDENTITY_CASES)('浅色 %s = %s', (name, lightValue) => {
    expectDecl(identityLight, name, lightValue, 'identity :root')
  })

  it.each(IDENTITY_CASES)('深色 %s = %s', (name, _lightValue, darkValue) => {
    expectDecl(identityDark, name, darkValue, "identity :root[data-theme='dark']")
  })

  it('阴影三级：paper/overlay 同源 lv2，composer 是拆出的轻档（暗色加深，不开彩色阴影）', () => {
    expectDecl(identityLight, '--k-shadow-paper', 'var(--k-shadow-lv2)', 'identity :root')
    expect(identityLight.get('--k-shadow-lv2')).toContain('rgba(20, 20, 19, 0.1)')
    expect(identityLight.get('--k-shadow-composer')).toContain('rgba(20, 20, 19, 0.06)')
    expect(identityDark.get('--k-shadow-lv2')).toContain('rgba(0, 0, 0, 0.3)')
    // 暗色顶边高光（边 = 光，不是轮廓；章程 §3.4）
    expect(identityDark.get('--k-edge-highlight')).toContain('rgba(255, 255, 255, 0.06)')
  })

  it('kimi 原样层冻结：身份层不写 Kimi 名，Kimi 层不出现 --k-*', () => {
    for (const name of identityLight.keys()) {
      expect(name.startsWith('--k-'), `身份层混入了非 --k- token：${name}`).toBe(true)
    }
    expect(tokensCss).not.toContain('--k-canvas')
    // Kimi 品牌蓝仍在原样层（只作回滚/对照，不进语义层）
    expect(light.get('--Colors-KMBlue')).toBe('#1783ff')
  })
})

/**
 * 语义层（semantic.css）：工程名只引用身份层 `--k-*`（+ 技术性原样值）。
 * 深色切换全部交给 identity.css 的 `--k-*` 重写 —— 语义层**不再有自己的深色块**。
 */
describe('语义层（semantic.css）· 重映射到身份层', () => {
  const root = semantic.get(':root') ?? new Map<string, string>()

  const ALIASES: Array<[string, string]> = [
    ['--bg-canvas', 'var(--k-canvas)'],
    ['--bg-primary', 'var(--k-card)'],
    ['--bg-secondary', 'var(--k-inset)'],
    ['--bg-menu', 'var(--k-menu)'],
    ['--bg-overlay', 'var(--k-menu)'],
    ['--bg-sidebar', 'var(--k-sidebar)'],
    ['--bg-bubble', 'var(--k-bubble)'],
    ['--surface-3', 'var(--k-hover-solid)'],
    ['--text-primary', 'var(--k-ink)'],
    ['--text-secondary', 'var(--k-ink-2)'],
    ['--text-tertiary', 'var(--k-ink-3)'],
    ['--text-tertiary-readable', 'var(--k-ink-3-readable)'],
    ['--text-quaternary', 'var(--k-ink-4)'],
    ['--text-disabled', 'var(--k-ink-4)'],
    ['--border-hairline', 'var(--k-border-l2)'],
    ['--border-surface', 'var(--k-border-l3)'],
    ['--border-field', 'var(--k-border-l1)'],
    ['--hairline-soft', 'var(--k-border-l1)'],
    ['--fill-hover', 'var(--k-hover)'],
    ['--fill-selected', 'var(--k-hover-solid)'],
    ['--fill-active', 'var(--k-active)'],
    ['--accent', 'var(--k-accent)'],
    ['--accent-hover', 'var(--k-accent-hover)'],
    ['--on-accent', 'var(--k-on-accent)'],
    ['--accent-text', 'var(--k-link)'],
    ['--link', 'var(--k-link)'],
    ['--link-hover', 'var(--k-link-hover)'],
    ['--positive', 'var(--k-positive)'],
    ['--positive-bg', 'var(--k-positive-soft)'],
    ['--warning', 'var(--k-warning)'],
    ['--warning-bg', 'var(--k-warning-soft)'],
    ['--danger', 'var(--k-danger)'],
    ['--danger-bg', 'var(--k-danger-soft)'],
    ['--diff-add', 'var(--k-positive)'],
    ['--diff-delete', 'var(--k-danger)'],
    ['--code-ink', 'var(--k-code-ink)'],
    ['--code-bg', 'var(--k-code-bg)'],
    ['--inline-code-bg', 'var(--k-inline-code-bg)'],
    ['--selection', 'var(--k-active)'],
    ['--focus-ring', 'inset 0 0 0 1px var(--k-ink-3)'],
    ['--mask', 'var(--MaskBg-Base)'],
    ['--blur-glass', '15px'],
    ['--hairline-width', 'var(--border-width-base)'],
    ['--scrollbar-size', '6px'],
    ['--scrollbar-thumb', 'var(--k-scrollbar)'],
    ['--scrollbar-thumb-hover', 'var(--k-scrollbar-hover)'],
    ['--shadow-overlay', 'var(--k-shadow-lv2)'],
    ['--shadow-paper', 'var(--k-shadow-paper)'],
    ['--shadow-composer', 'var(--k-shadow-composer)'],
    ['--motion-fast', 'var(--duration-quick)'],
    ['--motion-main', 'var(--duration-main)'],
    ['--motion-ease-inout', 'ease-in-out'],
    ['--motion-ease-out', 'var(--clp-ease-out)'],
    ['--radius-field', 'var(--kimi-select-radius)'],
    ['--radius-panel', 'var(--settings-card-radius)'],
    ['--radius-overlay', 'var(--km-modal-radius)'],
    ['--radius-icon-button', 'var(--linear-icon-button-radius)'],
    ['--radius-input', '16px'],
    ['--field-bg', 'var(--k-input)'],
    ['--tooltip-bg', 'var(--k-ink)'],
    ['--tooltip-fg', 'var(--k-canvas)'],
    ['--skeleton-base', 'var(--k-inset)'],
    ['--skeleton-highlight', 'var(--k-card)']
  ]

  it.each(ALIASES)('语义 token %s = %s', (name, value) => {
    expectDecl(root, name, value, 'semantic :root')
  })

  it('主按钮 = 陶土橙实心 + on-accent 字（全产品唯一实心按钮，章程 D-07）', () => {
    expectDecl(root, '--button-primary-bg', 'var(--k-accent)', 'semantic :root')
    expectDecl(root, '--button-primary-bg-hover', 'var(--k-accent-hover)', 'semantic :root')
    expectDecl(root, '--button-primary-bg-active', 'var(--k-accent-hover)', 'semantic :root')
    expectDecl(root, '--button-primary-fg', 'var(--k-on-accent)', 'semantic :root')
    // 危险按钮保留 danger 档（不做霓虹红）
    expectDecl(root, '--button-danger-bg', 'var(--k-danger)', 'semantic :root')
    expectDecl(root, '--button-danger-fg', 'var(--k-on-accent)', 'semantic :root')
  })

  it('语义层不再有深色块：暗色由 identity.css 的 --k-* 整段重写承担', () => {
    expect(semantic.get(":root[data-theme='dark']")).toBeUndefined()
    // 暗色差异确实在身份层（同名 token 两段值不同）
    expect(identityLight.get('--k-canvas')).not.toBe(identityDark.get('--k-canvas'))
  })

  it('语义层的每个 var() 引用都能在身份层 / Kimi 原样层 / 语义层自身找到定义', () => {
    const declared = new Set([
      ...[...tokens.values()].flatMap((decls) => [...decls.keys()]),
      ...[...identity.values()].flatMap((decls) => [...decls.keys()]),
      ...[...semantic.values()].flatMap((decls) => [...decls.keys()])
    ])
    const referenced = [
      ...new Set([...semanticCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))
    ].sort()

    expect(referenced.length).toBeGreaterThan(20)
    for (const name of referenced) {
      expect(declared.has(name), `三层 token 都没有定义 ${name}`).toBe(true)
    }
  })
})

describe('T3 控件尺寸与组件级 token（UI 验收表数值）', () => {
  const t3root = semantic.get(':root') ?? new Map<string, string>()

  it('文字层级用 Claude 三级 + caption + 可读偏离档（D-29）；旧「达标档」literal 退休', () => {
    expectDecl(t3root, '--text-tertiary', 'var(--k-ink-3)', 'semantic :root')
    expectDecl(t3root, '--text-quaternary', 'var(--k-ink-4)', 'semantic :root')
    expectDecl(t3root, '--text-tertiary-readable', 'var(--k-ink-3-readable)', 'semantic :root')
    expect(t3root.has('--text-tertiary-readable'), '缺少 12px 可读档').toBe(true)
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
    // 按钮（章程 §3.5/§3.7：主按钮 = 陶土橙实心 + on-accent 字）
    ['--button-primary-bg', 'var(--k-accent)'],
    ['--button-primary-bg-hover', 'var(--k-accent-hover)'],
    ['--button-primary-bg-active', 'var(--k-accent-hover)'],
    ['--button-primary-fg', 'var(--k-on-accent)'],
    ['--button-danger-bg', 'var(--k-danger)'],
    ['--button-danger-fg', 'var(--k-on-accent)'],
    ['--text-disabled', 'var(--k-ink-4)'],
    ['--fill-disabled', 'var(--k-hover)'],
    // 输入框（§4.7 .kimi-select）、菜单（§7）、弹层（§4.5）
    ['--border-field', 'var(--k-border-l1)'],
    ['--field-bg', 'var(--k-input)'],
    ['--menu-item-height', '36px'],
    ['--menu-pad', 'var(--space-2)'],
    ['--menu-item-radius', 'var(--radius-control)'],
    ['--overlay-width-sm', '360px'],
    ['--overlay-width-md', '560px'],
    ['--overlay-max-width', 'calc(100vw - var(--space-8))'],
    ['--shadow-overlay', 'var(--k-shadow-lv2)'],
    ['--bg-overlay', 'var(--k-menu)'],
    // 提示与骨架屏（tooltip = 深墨底/纸字，暗色自动反相）
    ['--tooltip-bg', 'var(--k-ink)'],
    ['--tooltip-fg', 'var(--k-canvas)'],
    ['--skeleton-base', 'var(--k-inset)'],
    ['--skeleton-highlight', 'var(--k-card)']
  ]

  it.each(CONTROL_TOKENS)('T3 token %s = %s', (name, value) => {
    expectDecl(t3root, name, value, 'semantic :root')
  })
})

/**
 * P0 字体系统（章程 §2）：三声部 + 中文链逐字 = DSH typeface 组；
 * 六档不增不减，只新增一个 text-hero；叙事行宽 --prose-measure；输入卡圆角 16。
 */
describe('P0 字体三声部与字号（章程 §2）', () => {
  const root = semantic.get(':root') ?? new Map<string, string>()
  /** DSH 现用中文链（tokens.json typeface 组，顺序一字不改；本机实际命中 Noto Sans SC） */
  const DSH_CJK_CHAIN =
    /'Noto Sans SC',\s*'Source Han Sans SC',\s*'PingFang SC',\s*'Hiragino Sans GB',\s*'Microsoft YaHei',\s*sans-serif/

  it('三条声部的字体栈都在语义层，且中文段逐字 = DSH 链', () => {
    for (const name of ['--font-ui', '--font-reading', '--font-prose', '--font-code']) {
      const value = root.get(name)
      expect(value, `缺少字体声部 ${name}`).toBeDefined()
      expect(value as string, `${name} 的中文段不是 DSH 链`).toMatch(DSH_CJK_CHAIN)
    }
  })

  it('拉丁声部各就各位：UI Segoe / 标题 Sitka·Georgia / 正文随包 Noto Serif / 技术 Cascadia·Consolas', () => {
    expect(root.get('--font-ui')).toContain("'Segoe UI Variable Text'")
    expect(root.get('--font-reading')).toContain("'Sitka Text'")
    expect(root.get('--font-reading')).toContain('Georgia')
    // task-51：正文/思考的拉丁是随包 Noto Serif（OFL），不是系统 Sitka；中文段仍 DSH 链
    expect(root.get('--font-prose')).toContain("'kyclaw-serif-latin'")
    expect(root.get('--font-prose')).not.toContain('Sitka')
    expect(root.get('--font-code')).toContain("'Cascadia Mono'")
    expect(root.get('--font-code')).toContain('Consolas')
    // D-16 边界：不许出现 Anthropic 商业字体名
    for (const name of ['--font-ui', '--font-reading', '--font-prose', '--font-code']) {
      expect(root.get(name) ?? '').not.toContain('Anthropic')
    }
  })

  it('文档字（Word-faithful）另起三条，不混进三声部', () => {
    expect(root.get('--font-doc')).toContain("'SimSun'")
    expect(root.get('--font-doc-head')).toContain("'SimHei'")
    expect(root.get('--font-doc-num')).toContain("'Times New Roman'")
  })

  it('text-hero 30/1.2 只给欢迎字标；行宽 --prose-measure = 44em', () => {
    expectDecl(root, '--text-hero-size', '30px', 'semantic :root')
    expectDecl(root, '--text-hero-line', '1.2', 'semantic :root')
    expectDecl(root, '--prose-measure', '44em', 'semantic :root')
  })

  it('输入卡圆角从 Kimi 的 24 收到 16（D-13）；Tailwind 三声部映射同步', () => {
    expectDecl(root, '--radius-input', '16px', 'semantic :root')
    expect(tailwindCss).toContain('--font-sans: var(--font-ui);')
    expect(tailwindCss).toContain('--font-serif: var(--font-reading);')
    expect(tailwindCss).toContain('--font-mono: var(--font-code);')
    expect(tailwindCss).toContain('--text-hero: var(--text-hero-size);')
    expect(tailwindCss).toContain('--text-hero--line-height: var(--text-hero-line);')
    expect(tailwindCss).toContain('--radius-input: 16px;')
  })

  it('欢迎字标不写死 px：字号/行高/字距都走 token 与声部（900 窄窗 0.85×）', () => {
    const welcome = /@layer components \{[\s\S]*?\.welcome-title \{([\s\S]*?)\n\s{2}\}/.exec(
      tailwindCss
    )?.[1]
    expect(welcome).toContain('font-family: var(--font-reading)')
    expect(welcome).toContain('font-size: var(--text-hero-size)')
    expect(welcome).toContain('letter-spacing: -0.02em')
    expect(tailwindCss).toMatch(
      /@media \(max-width: 900px\) \{[\s\S]*?calc\(var\(--text-hero-size\) \* 0\.85\)/
    )
  })
})

/**
 * P0 动效角色层（章程 §5.1）：12 条角色时长 + 4 条曲线 + 配套位移/模糊/缩放；
 * 一种效果只有一档，新组件读角色名而不是挑数值。
 */
describe('P0 动效角色层（motion.css）', () => {
  const ROLES: Array<[string, string]> = [
    ['--motion-feedback', '120ms'],
    ['--motion-reveal', '150ms'],
    ['--motion-exit', '120ms'],
    ['--motion-open', '250ms'],
    ['--motion-enter', '320ms'],
    ['--motion-flight', '400ms'],
    ['--motion-spring', '500ms'],
    ['--motion-stagger', '70ms'],
    ['--motion-dot', '500ms'],
    ['--motion-sweep', '1500ms'],
    ['--motion-reduced', '0.01ms']
  ]

  it.each(ROLES)('角色时长 %s = %s', (name, value) => {
    expectDecl(motionRoot, name, value, 'motion :root')
  })

  it('四条曲线与 tokens.json 一致（enter/glide/settle/spring）', () => {
    expectDecl(
      motionRoot,
      '--motion-ease-enter',
      'cubic-bezier(0.34, 1.3, 0.64, 1)',
      'motion :root'
    )
    expectDecl(
      motionRoot,
      '--motion-ease-glide',
      'cubic-bezier(0.22, 0.61, 0.36, 1)',
      'motion :root'
    )
    expectDecl(motionRoot, '--motion-ease-settle', 'cubic-bezier(0.22, 1, 0.36, 1)', 'motion :root')
    expectDecl(
      motionRoot,
      '--motion-ease-spring',
      'cubic-bezier(0.34, 1.45, 0.64, 1)',
      'motion :root'
    )
  })

  it('配套位移/模糊/缩放来自 tokens.json，供配方 1/2/4 直接用', () => {
    expectDecl(motionRoot, '--motion-distance-nudge', '4px', 'motion :root')
    expectDecl(motionRoot, '--motion-distance-travel', '8px', 'motion :root')
    expectDecl(motionRoot, '--motion-distance-rise', '12px', 'motion :root')
    expectDecl(motionRoot, '--motion-blur-soft', '2px', 'motion :root')
    expectDecl(motionRoot, '--motion-blur-enter', '3px', 'motion :root')
    expectDecl(motionRoot, '--motion-scale-surface', '0.98', 'motion :root')
    expectDecl(motionRoot, '--motion-scale-dialog', '0.96', 'motion :root')
    expectDecl(motionRoot, '--motion-swap', '150ms', 'motion :root')
    expectDecl(motionRoot, '--motion-swap-gap', '50ms', 'motion :root')
  })

  it('reduced-motion：角色时长整组压到 0.01ms（不是 0：transitionend 仍触发）', () => {
    expect(motionCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?:root \{/)
    for (const name of [
      '--motion-feedback',
      '--motion-enter',
      '--motion-open',
      '--motion-exit',
      '--motion-sweep'
    ]) {
      expect(motionCss, `${name} 没有 reduced 压档`).toMatch(
        new RegExp(`${name}: var\\(--motion-reduced\\)`)
      )
    }
    // 既有工程阶梯未受影响（--duration-* / --clp-* 仍在 Kimi 原样层）
    expect(canonical(light.get('--duration-main') ?? '')).toBe(canonical('.3s'))
    expect(canonical(light.get('--clp-ease-out') ?? '')).toBe(
      canonical('cubic-bezier(.23, 1, .32, 1)')
    )
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
    // P0：三声部映射（sans/serif/mono）+ 唯一新增字阶 text-hero + 输入卡圆角 16
    expect(tailwindCss).toContain('--font-sans: var(--font-ui);')
    expect(tailwindCss).toContain('--font-serif: var(--font-reading);')
    expect(tailwindCss).toContain('--font-mono: var(--font-code);')
    expect(tailwindCss).toContain('--text-hero: var(--text-hero-size);')
    expect(tailwindCss).toContain('--radius-input: 16px;')
  })

  it('@theme inline 引用的 token 都能找到定义（Tailwind 自带的 --font-* 除外）', () => {
    const declared = new Set([
      ...tokens.values().flatMap((decls) => [...decls.keys()]),
      ...identity.values().flatMap((decls) => [...decls.keys()]),
      ...motion.values().flatMap((decls) => [...decls.keys()]),
      ...semantic.values().flatMap((decls) => [...decls.keys()])
    ])
    const referenced = [
      ...new Set([...tailwindCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))
    ].sort()

    for (const name of referenced) {
      if (name === '--font-sans' || name === '--font-mono') continue // Tailwind 主题命名空间
      if (name === '--font-serif') continue // 同上（@theme 里的 font-serif）
      if (name.startsWith('--radix-')) continue // Radix 运行时注入（浮层变形原点），不是我们的 token
      expect(declared.has(name), `三层 token 都没有定义 ${name}`).toBe(true)
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
    ['--color-ink-tertiary', '--text-tertiary-readable'],
    ['--color-ink-tertiary-readable', '--text-tertiary-readable'],
    ['--color-hairline', '--border-hairline'],
    ['--color-surface-border', '--border-surface'],
    ['--color-hover', '--fill-hover'],
    ['--color-selected', '--fill-selected'],
    ['--color-active', '--fill-active'],
    ['--color-accent', '--accent'],
    ['--color-accent-text', '--accent-text'],
    ['--color-on-accent', '--on-accent'],
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

  it('工具类 text-ink-tertiary 走 D-29 可读档（兼容既有 12px 承载信息小字）；装饰原值仍可达', () => {
    expectDecl(themeDecls, '--color-ink-tertiary', 'var(--text-tertiary-readable)', '@theme')
    expect(semanticRoot.get('--text-tertiary')).toBe('var(--k-ink-3)')
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

  it('字号映射：ui-* 六档的字号与行高都进主题；P0 只多一个 text-hero', () => {
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
    expectDecl(themeDecls, '--text-hero', 'var(--text-hero-size)', '@theme')
    expectDecl(themeDecls, '--text-hero--line-height', 'var(--text-hero-line)', '@theme')
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

describe('样式入口接线（P0 三层 token：identity → motion → kimi/semantic）', () => {
  const mainSource = readSource(MAIN_TSX)

  it('main.tsx：identity 与 motion 先于 tailwind.css（semantic 在 tailwind 里 ⇒ identity 必早于 semantic）', () => {
    expect(mainSource).toContain("import './styles/tokens/identity.css'")
    expect(mainSource).toContain("import './styles/tokens/motion.css'")
    expect(mainSource).toContain("import './styles/tailwind.css'")
    expect(mainSource.indexOf('tokens/identity.css')).toBeLessThan(
      mainSource.indexOf('styles/tailwind.css')
    )
    expect(mainSource.indexOf('tokens/motion.css')).toBeLessThan(
      mainSource.indexOf('styles/tailwind.css')
    )
    expect(mainSource).not.toContain('assets/main.css')
  })

  it('身份层不在 tailwind.css 里重复 import（单一入口，防双份级联）', () => {
    expect(tailwindCss).not.toContain("import './tokens/identity.css'")
    expect(tailwindCss).not.toContain("import './tokens/motion.css'")
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

  it('一级导航（2026-10-17 起只有图标栏）：只有 56 一档，旧的 200 展开档退休；会话二级栏仍是 240', () => {
    expectDecl(shellRoot, '--primary-nav-rail-width', '56px', 'semantic :root')
    // 用户拍板参考 Codex 布局：一级导航永远是图标栏，不再有展开态，所以不该再留 200 的宽度 token
    expect(shellRoot.has('--primary-nav-width'), '不该再留 --primary-nav-width').toBe(false)
    expectDecl(shellRoot, '--sidebar-width', '240px', 'semantic :root')
  })

  it('壳 token 不随主题分档（几何在明暗下一致）', () => {
    const darkShell = semantic.get(":root[data-theme='dark']") ?? new Map<string, string>()
    for (const name of [
      '--titlebar-height',
      '--primary-nav-rail-width',
      '--sidebar-width',
      '--work-panel-width'
    ]) {
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

  it('内容层限宽 800（spec §6.2 消息列）：侧栏进卡后主列天然不含那 240，内容列只在自己的可用宽里居中', () => {
    expectDecl(t5root, '--content-max-width', '800px', 'semantic :root')
  })
})

describe('壳 · 中列最小可读宽（round 77 取代窄窗固定阈值）', () => {
  const root = semantic.get(':root') ?? new Map<string, string>()
  const appShell = readSource('../../components/shell/AppShell.tsx')

  it('--chat-min-readable-width = 480px；旧的固定阈值 token 已退休', () => {
    expectDecl(root, '--chat-min-readable-width', '480px', 'semantic :root')
    // R2 D4 的 --work-panel-collapse-width = 1120 把"工作台 400 + 侧栏必开"写死了：
    // 拖宽面板 / 收起侧栏都判不准（round 77 改成按实测宽算），所以不该再留这条。
    expect(root.has('--work-panel-collapse-width'), '不该再留固定阈值 token').toBe(false)
  })

  it('token 与 AppShell 的 TS 兜底同值：只改一处不会两边漂开', () => {
    const fallbackOf = (name: string): number =>
      Number.parseFloat(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(appShell)?.[1] ?? '')

    const fromToken = Number.parseFloat(root.get('--chat-min-readable-width') ?? '')
    expect(fromToken, 'token 值解析失败').toBeGreaterThan(0)
    expect(
      fallbackOf('CHAT_MIN_READABLE_FALLBACK'),
      'AppShell.tsx 里没找到 CHAT_MIN_READABLE_FALLBACK'
    ).toBe(fromToken)

    // 判据里另外两个实测折算也用 token：侧栏遮挡与内容卡右缘留缝
    expect(fallbackOf('SIDEBAR_WIDTH_FALLBACK')).toBe(
      Number.parseFloat(root.get('--sidebar-width') ?? '')
    )
    expect(fallbackOf('SHELL_EDGE_GAP_FALLBACK')).toBe(
      Number.parseFloat(light.get('--space-1-5') ?? '')
    )
  })
})

describe('壳 · 内容卡留缝（R2 修复轮 round 3；2026-10-17 侧栏进卡）', () => {
  const root = semantic.get(':root') ?? new Map<string, string>()
  const contentRegion = readSource('../../components/shell/ContentRegion.tsx')
  const appShell = readSource('../../components/shell/AppShell.tsx')

  it('--shell-edge-gap = 6px（Kimi 桌面实测 12 设备像素 @2x）：右/底留缝与圆角卡同源', () => {
    expectDecl(root, '--shell-edge-gap', 'var(--space-1-5)', 'semantic :root')
    // 工程阶梯里 6px 已有断言（'--space-1-5', 6），这里钉的是"留缝取的就是这一格"
  })

  it('内容卡吃四角圆角与右/底留缝；覆盖层时代的 notch 补角随侧栏进卡一并删除', () => {
    expect(contentRegion).toContain('rounded-overlay')
    expect(contentRegion).not.toContain('rounded-t-overlay')
    expect(contentRegion).toContain('mr-(--shell-edge-gap)')
    expect(contentRegion).toContain('mb-(--shell-edge-gap)')
    // 2026-10-17：会话侧栏成了卡内 flex 子列，内容卡左缘不再被覆盖层盖住，缺口角机制退休
    expect(appShell).not.toContain('data-testid="shell-notch"')
    expect(appShell).not.toContain('left-(--content-safe-left)')
  })
})

/**
 * Office 文档画布 token（A1；P0 映射到身份层）。
 *
 * 契约：画布 = 语义凹槽（--bg-secondary，Claude inset）；纸 = 身份层 --k-paper
 * （浅白纸 / 深灰纸 #cfd1cb，Office 硬决定）；页影 = shadow-paper（lv2）。
 * 隔离面也 import 同一套 identity + motion + kimi + semantic（office/main.tsx），
 * 画布底由 surface.css 把内核 `--doc-bg` 映射过去。A2/A3 在用的 token 名与尺寸一律不动。
 */
describe('Office 文档画布 token（A1；P0 映射到身份层）', () => {
  const docRoot = semantic.get(':root') ?? new Map<string, string>()

  it('三条 token 映射到语义凹槽 / 身份纸面 / 阴影三级（名字不变，值随语义映射）', () => {
    expectDecl(docRoot, '--doc-canvas-bg', 'var(--bg-secondary)', 'semantic :root')
    expectDecl(docRoot, '--doc-page-bg', 'var(--k-paper)', 'semantic :root')
    expectDecl(docRoot, '--doc-page-shadow', 'var(--k-shadow-paper)', 'semantic :root')
  })

  it('深色纸 = 灰纸 #cfd1cb（Office 硬决定；不是把白纸调暗、不是反相滤镜）', () => {
    expectDecl(identityDark, '--k-paper', '#cfd1cb', "identity :root[data-theme='dark']")
    expectDecl(identityDark, '--k-paper-ink', '#1b1b1b', "identity :root[data-theme='dark']")
    expectDecl(identityLight, '--k-paper', '#ffffff', 'identity :root')
  })

  it('隔离面复用同一套 token：office/main.tsx 前置 identity + motion，且都早于 semantic', () => {
    expect(officeMainTsx).toContain("import '../styles/tokens/identity.css'")
    expect(officeMainTsx).toContain("import '../styles/tokens/motion.css'")
    expect(officeMainTsx).toContain("import '../styles/tokens/kimi-tokens.css'")
    expect(officeMainTsx).toContain("import '../styles/tokens/semantic.css'")
    const semanticAt = officeMainTsx.indexOf('tokens/semantic.css')
    expect(officeMainTsx.indexOf('tokens/identity.css')).toBeLessThan(semanticAt)
    expect(officeMainTsx.indexOf('tokens/motion.css')).toBeLessThan(semanticAt)
  })

  it('surface.css：内核画布底 --doc-bg 映射到 --doc-canvas-bg；调试条默认隐藏', () => {
    expect(officeSurfaceCss).toContain('--doc-bg: var(--doc-canvas-bg')
    // .oox-root / .oox-root.dark 两档都覆盖（后者特异性相同、后写胜出）
    expect(officeSurfaceCss).toMatch(/\.oox-root,\s*\.oox-root\.dark\s*\{/)
    expect(officeSurfaceCss).toContain("[data-debug='false']")
  })
})

/**
 * Office ribbon 布局/动效 token（A2）。
 * 纯布局/时长值：浅深同值，只进 :root，不进深色块；面内 office-chrome.css 消费。
 * 动效节奏按设计研究 §三.2（反馈 120ms / 入场 150–320ms / 离场 120ms）令牌化。
 */
describe('Office ribbon 布局与动效 token（A2）', () => {
  const ribbonRoot: Decls = semantic.get(':root') ?? new Map<string, string>()
  const ribbonDark: Decls = semantic.get(":root[data-theme='dark']") ?? new Map<string, string>()

  it('布局 token：QAT/tab 行 32 / 工具带 80 / 状态栏 26（A4）/ AI 面板 320（A3）', () => {
    expectDecl(ribbonRoot, '--office-ribbon-tabs-height', '32px', 'semantic :root')
    expectDecl(ribbonRoot, '--office-ribbon-body-height', '80px', 'semantic :root')
    expectDecl(ribbonRoot, '--office-status-height', '26px', 'semantic :root')
    expectDecl(ribbonRoot, '--office-ai-panel-width', '320px', 'semantic :root')
  })

  it('A3：AI 面板组件消费 --office-ai-panel-width；开合只动 width/opacity + reduced-motion 0.01ms', () => {
    expect(officeAiPanelTsx).toContain('var(--office-ai-panel-width)')
    expect(officeAiPanelTsx).toContain('transition-[width,opacity]')
    expect(officeAiPanelTsx).toContain('motion-reduce:[transition-duration:0.01ms]')
    // 面板 320 由 token 给，不在组件里写死 px
    expect(officeAiPanelTsx).not.toContain("width: '320px'")
  })

  it('动效 token：反馈 120ms / 入场取基准档 / 离场 120ms', () => {
    expectDecl(ribbonRoot, '--office-motion-feedback', '120ms', 'semantic :root')
    expectDecl(ribbonRoot, '--office-motion-enter', 'var(--duration-base)', 'semantic :root')
    expectDecl(ribbonRoot, '--office-motion-exit', '120ms', 'semantic :root')
  })

  it('这七条深浅同值：深色块不重写', () => {
    for (const name of [
      '--office-ribbon-tabs-height',
      '--office-ribbon-body-height',
      '--office-status-height',
      '--office-motion-feedback',
      '--office-motion-enter',
      '--office-motion-exit',
      '--office-ai-panel-width'
    ] as const) {
      expect(ribbonDark.get(name), `深色块不该重写 ${name}`).toBeUndefined()
    }
  })

  it('面内入口 import office-chrome.css；该文件消费布局/动效 token 与语义色', () => {
    expect(officeMainTsx).toContain("import './office-chrome.css'")
    expect(officeChromeCss).toContain('var(--office-ribbon-tabs-height)')
    expect(officeChromeCss).toContain('var(--office-ribbon-body-height)')
    expect(officeChromeCss).toContain('var(--office-motion-feedback)')
    expect(officeChromeCss).toContain('var(--text-primary)')
    expect(officeChromeCss).toContain('var(--border-hairline)')
    expect(officeChromeCss).toContain('prefers-reduced-motion')
  })
})
