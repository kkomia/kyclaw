import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PptTemplateChip } from '@renderer/features/chat/PptTemplatePicker'
import {
  resetPptTemplatesStore,
  usePptTemplatesStore
} from '@renderer/features/chat/ppt-templates-store'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { fetchSessionPptTemplates, putSessionPptTemplate } from '@renderer/lib/session-ppt-api'
import { tick } from '@renderer/components/ui/__tests__/tick'
import { defaultSettings } from '@shared/settings'
import { PPT_THEMES, PPT_TEMPLATE_NAMES, templatesOf } from '@shared/ppt-templates'

/**
 * 对话页的 **PPT 能力胶囊 + 模板画廊**（round 63 建立；round 66 改成**会话级**）。
 *
 * 钉住的口径：
 *   1. 胶囊文案与状态（没选 = 「PPT」；选了 = 「PPT · 名字」+ 清空按钮）；
 *   2. **选择按会话走**（round 66 用户实报的那条）：新会话（另一个草稿 id）永远是未选 ——
 *      上一个会话挑过的模板不能带过来；两条会话各是各的；
 *   3. 已有会话读服务端那份映射（`session_ppt_templates`）显示；
 *   4. 草稿选中只记本地（服务端一个字节都不写），已有会话选中即写（PUT /api/ppt/templates）；
 *      选择**不再**落全局设置（settings:update 一次都不发）；
 *   5. 画廊的开合、分类过滤；预览卡是**真构图的缩影**（band / 居中两种封面都能数出来）。
 */
vi.mock('@renderer/lib/session-ppt-api', () => ({
  fetchSessionPptTemplates: vi.fn(async () => []),
  putSessionPptTemplate: vi.fn(async () => undefined)
}))

let bridge: KyclawBridgeStubs

interface MountOptions {
  /** 当前会话 */
  threadId: string
  /** true = 服务端已经有这条会话（已有会话）；false / 省略 = 草稿 */
  materialized?: boolean
  /** 服务端那份映射（threadId → 模板名） */
  server?: Record<string, string>
  /**
   * 挂载前是否把映射标记成"已加载"。true（缺省）= 直接喂一份快照（大多数用例要的就是"数据在手"）；
   * false = 停在"还没加载"（给"启动时拉回映射"那条用例）。
   */
  loaded?: boolean
}

function mountChip(input: MountOptions): void {
  // 注意：这里**不重置**设置 store / bridge —— 会话之间来回切换是同一场对话里的连续动作，
  // 每次挂载都把全局设置洗回默认值的话，"上一个会话的选择泄漏到新会话"这条就永远测不出来
  // （round 66 修的就是它）。初始设置由 beforeEach 装一次。
  usePptTemplatesStore.setState({
    templates: input.loaded === false ? {} : { ...(input.server ?? {}) },
    loaded: input.loaded !== false
  })
  useSessionsStore.setState({
    threads:
      input.materialized === true
        ? [{ id: input.threadId, title: null, updatedAt: '2026-10-13T00:00:00.000Z' }]
        : [],
    activeId: input.threadId,
    loaded: true
  })
  render(<PptTemplateChip threadId={input.threadId} />)
}

/** 当前胶囊上写着的字 */
function chipText(): string {
  return screen.getByTestId('composer-ppt-template').textContent ?? ''
}

/** 打开画廊选中一个模板（清空走 clearChip） */
function pick(name: string): void {
  fireEvent.click(screen.getByTestId('composer-ppt-template'))
  fireEvent.click(screen.getByTestId(`ppt-template-${name}`))
}

function clearChip(): void {
  fireEvent.click(screen.getByTestId('composer-ppt-template-clear'))
}

/** 卡片容器里的 16:9 预览 SVG（每张卡一个） */
function previewOf(name: string): SVGSVGElement {
  const card = screen.getByTestId(`ppt-template-${name}`)
  const svg = card.querySelector('svg')
  if (svg === null) throw new Error(`模板 ${name} 的卡片里没有预览`)
  return svg as SVGSVGElement
}

/** 预览里某个层次（bg / decor / title / rule / subtitle）的矩形 */
function partsOf(svg: SVGSVGElement, part: string): SVGRectElement[] {
  return [...svg.querySelectorAll(`rect[data-part="${part}"]`)] as SVGRectElement[]
}

beforeEach(() => {
  resetPptTemplatesStore()
  resetSessionsStore()
  // 全局设置装一次就好（会话级的选择**不该**碰它；这里也就是"用户从来没在设置里动过模板"的现场）
  const initial = defaultSettings()
  bridge = installKyclawBridge(initial)
  useSettingsStore.setState({ settings: initial, loaded: true })
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.clearAllMocks()
})

describe('胶囊：没选 / 选了 / 清空', () => {
  it('新会话（草稿）：写「PPT」（= 自动挑），且没有清空按钮', () => {
    mountChip({ threadId: 'draft-a' })
    expect(chipText()).toBe('PPT')
    expect(screen.queryByTestId('composer-ppt-template-clear')).toBeNull()
  })

  it('已有会话带着服务端的模板：显示「PPT · 模板名」+ 清空按钮', () => {
    mountChip({ threadId: 't1', materialized: true, server: { t1: '学术紫' } })
    expect(chipText()).toBe('PPT · 学术紫')
    expect(screen.getByTestId('composer-ppt-template-clear')).toBeInTheDocument()
  })

  it('映射里是过期 / 空的名字：按没选画（不显示半截状态、也不报错）', () => {
    mountChip({ threadId: 't1', materialized: true, server: { t1: '彩虹色' } })
    expect(chipText()).toBe('PPT')
    expect(screen.queryByTestId('composer-ppt-template-clear')).toBeNull()
  })

  it('清空（已有会话）：PUT 空串回服务端，胶囊回到「PPT」', async () => {
    mountChip({ threadId: 't1', materialized: true, server: { t1: '墨绿' } })
    clearChip()

    expect(chipText()).toBe('PPT')
    expect(screen.queryByTestId('composer-ppt-template-clear')).toBeNull()
    await waitFor(() => expect(putSessionPptTemplate).toHaveBeenCalledWith('t1', ''))
  })
})

describe('会话级：新会话不预选，两条会话互不影响（round 66 用户实报）', () => {
  it('上一个会话选过的模板不带进新会话：新草稿仍是未选', async () => {
    mountChip({ threadId: 'draft-a' })
    pick('墨绿')
    await waitFor(() => expect(chipText()).toBe('PPT · 墨绿'))

    // 开一个新会话（另一个草稿 id）：必须回到初始态
    cleanup()
    mountChip({ threadId: 'draft-b' })
    expect(chipText()).toBe('PPT')
    expect(screen.queryByTestId('composer-ppt-template-clear')).toBeNull()
  })

  it('已发过消息的会话（已有会话）也照旧：另一个会话的模板不影响它的显示', () => {
    mountChip({ threadId: 't1', materialized: true, server: { t1: '酒红', t2: '奶油' } })
    expect(chipText()).toBe('PPT · 酒红')

    cleanup()
    mountChip({ threadId: 't2', materialized: true, server: { t1: '酒红', t2: '奶油' } })
    expect(chipText()).toBe('PPT · 奶油')
  })

  it('一个会话在草稿里选的模板，只写本地那一格；另一条会话读不到', () => {
    mountChip({ threadId: 'draft-a' })
    pick('湖蓝')

    const templates = usePptTemplatesStore.getState().templates
    expect(templates['draft-a']).toBe('湖蓝')
    expect(templates['draft-b']).toBeUndefined()
    expect(usePptTemplatesStore.getState().templateOf('draft-b')).toBe('')
  })
})

describe('落点：草稿只记本地、已有会话即写服务端；全局设置一次都不写', () => {
  it('草稿里选中：PUT 一个字节都不写（服务端还不认识这个会话 id）', async () => {
    mountChip({ threadId: 'draft-a' })
    pick('学术紫')

    await tick()
    expect(putSessionPptTemplate).not.toHaveBeenCalled()
    expect(chipText()).toBe('PPT · 学术紫')
  })

  it('已有会话里选中：立刻 PUT 一条（服务端是单写者）', async () => {
    mountChip({ threadId: 't1', materialized: true })
    pick('酒红')

    expect(chipText()).toBe('PPT · 酒红')
    await waitFor(() => expect(putSessionPptTemplate).toHaveBeenCalledWith('t1', '酒红'))
  })

  it('换一个模板：再选一次直接覆盖（不用先清空）', async () => {
    mountChip({ threadId: 't1', materialized: true, server: { t1: '学术紫' } })
    pick('奶油')

    expect(chipText()).toBe('PPT · 奶油')
    await waitFor(() => expect(putSessionPptTemplate).toHaveBeenCalledWith('t1', '奶油'))
  })

  it('选择不落全局设置：settings:update 一次都不发（round 66 前它落的是 settings.pptTemplate）', async () => {
    mountChip({ threadId: 't1', materialized: true })
    pick('墨绿')
    await tick()
    clearChip()
    await tick()

    expect(bridge.update).not.toHaveBeenCalled()
  })
})

describe('画廊：开合、分类过滤', () => {
  it('点胶囊开画廊（十张卡 + 五个分类标签），再点收起', async () => {
    mountChip({ threadId: 'draft-a' })
    expect(screen.queryByTestId('ppt-template-gallery')).toBeNull()

    fireEvent.click(screen.getByTestId('composer-ppt-template'))
    expect(screen.getByTestId('ppt-template-gallery')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ppt-template')).toHaveAttribute('aria-expanded', 'true')

    for (const name of PPT_TEMPLATE_NAMES) {
      expect(screen.getByTestId(`ppt-template-${name}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('ppt-category-all')).toBeInTheDocument()
    for (const category of ['report', 'academic', 'data', 'promo']) {
      expect(screen.getByTestId(`ppt-category-${category}`)).toBeInTheDocument()
    }

    fireEvent.click(screen.getByTestId('composer-ppt-template'))
    await tick()
    expect(screen.queryByTestId('ppt-template-gallery')).toBeNull()
  })

  it('分类标签过滤卡片（「全部」= 十张，其它类各自只留自己的）', () => {
    mountChip({ threadId: 'draft-a' })
    fireEvent.click(screen.getByTestId('composer-ppt-template'))

    fireEvent.click(screen.getByTestId('ppt-category-academic'))
    expect(screen.getByTestId('ppt-category-academic')).toHaveAttribute('aria-pressed', 'true')
    expect(templatesOf('academic').map((template) => template.name)).toEqual(['墨绿', '学术紫'])
    expect(screen.getByTestId('ppt-template-学术紫')).toBeInTheDocument()
    expect(screen.queryByTestId('ppt-template-商务蓝')).toBeNull()

    fireEvent.click(screen.getByTestId('ppt-category-all'))
    expect(screen.getByTestId('ppt-category-all')).toHaveAttribute('aria-pressed', 'true')
    for (const name of PPT_TEMPLATE_NAMES) {
      expect(screen.getByTestId(`ppt-template-${name}`)).toBeInTheDocument()
    }
  })

  it('选中一个模板：胶囊改名 + 画廊收起', async () => {
    mountChip({ threadId: 't1', materialized: true })
    pick('学术紫')

    await waitFor(() => {
      expect(chipText()).toBe('PPT · 学术紫')
    })
    await tick()
    expect(screen.queryByTestId('ppt-template-gallery')).toBeNull()
    expect(screen.getByTestId('composer-ppt-template-clear')).toBeInTheDocument()
  })
})

describe('预览卡：真实构图的缩影（不是色块占位）', () => {
  it('居中封面：底色 + motif 装饰块 + 标题条 + 强调短线 + 副标题条，颜色走模板 token', () => {
    mountChip({ threadId: 'draft-a' })
    fireEvent.click(screen.getByTestId('composer-ppt-template'))

    const theme = PPT_THEMES['商务蓝']
    const svg = previewOf('商务蓝')
    expect(partsOf(svg, 'bg')[0].getAttribute('fill')).toBe(`#${theme.bg}`)
    // block motif 的两块装饰
    const decor = partsOf(svg, 'decor')
    expect(decor).toHaveLength(2)
    expect(decor[0].getAttribute('fill')).toBe(`#${theme.accent}`)
    expect(Number(decor[0].getAttribute('width'))).toBeCloseTo(10, 5)
    // 标题 / 副标题 / 短线（副标题在标题下面）
    const title = partsOf(svg, 'title')[0]
    const subtitle = partsOf(svg, 'subtitle')[0]
    expect(title.getAttribute('fill')).toBe(`#${theme.title}`)
    expect(subtitle.getAttribute('fill')).toBe(`#${theme.muted}`)
    expect(Number(subtitle.getAttribute('y'))).toBeGreaterThan(Number(title.getAttribute('y')))
    expect(partsOf(svg, 'rule')[0].getAttribute('fill')).toBe(`#${theme.accent}`)
  })

  it('band 封面（学术紫 / 湖蓝）：左侧通栏色带 + 标题条靠左 —— 与居中封面明显不同', () => {
    mountChip({ threadId: 'draft-a' })
    fireEvent.click(screen.getByTestId('composer-ppt-template'))

    for (const name of ['学术紫', '湖蓝'] as const) {
      const theme = PPT_THEMES[name]
      const svg = previewOf(name)
      const decor = partsOf(svg, 'decor')
      expect(decor).toHaveLength(1)
      expect(decor[0].getAttribute('fill')).toBe(`#${theme.accent}`)
      // 通栏色带：从 x=0 起、高度铺满画布
      expect(Number(decor[0].getAttribute('x'))).toBe(0)
      expect(Number(decor[0].getAttribute('height'))).toBeCloseTo(5.625, 5)
      // 标题条让开色带（靠左，而不是居中的那一段）
      const title = partsOf(svg, 'title')[0]
      expect(Number(title.getAttribute('x'))).toBeGreaterThanOrEqual(1.5)
    }

    // 两种构图必须在预览里也分得开（同一个模板名只画一种）
    const center = Number(partsOf(previewOf('商务蓝'), 'title')[0].getAttribute('x'))
    const band = Number(partsOf(previewOf('学术紫'), 'title')[0].getAttribute('x'))
    expect(band).not.toBe(center)
  })
})

describe('启动读取：映射拉回来之前不假装认识任何会话', () => {
  it('ensureLoaded 拉回服务端那份：胶囊显示本会话的模板（重启后仍记得）', async () => {
    vi.mocked(fetchSessionPptTemplates).mockResolvedValueOnce([
      { threadId: 't1', template: '墨绿' }
    ])
    mountChip({ threadId: 't1', materialized: true, loaded: false })

    await act(async () => {
      await usePptTemplatesStore.getState().ensureLoaded()
    })
    await waitFor(() => expect(chipText()).toBe('PPT · 墨绿'))
    // 同一份快照里没有的会话照旧未选
    expect(usePptTemplatesStore.getState().templateOf('t2')).toBe('')
  })
})
