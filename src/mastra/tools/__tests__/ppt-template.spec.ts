// @vitest-environment node
/**
 * round 63：**用户固定的 PPT 模板**走完整条链路（resolveTheme 优先级 → 渲染 → 落盘回执）。
 *
 * 三件事：
 *   1. `resolveTheme` 的取值优先级：显式 `theme` > 固定模板（fallback）> 自动挑；
 *      两处都不认得（脏输入）时一律退到自动挑 —— 不抛错、不落成"没有模板"。
 *   2. 新模板真的换了观感：`学术紫` / `湖蓝` 走 band 封面（左侧色带 + 左对齐标题），
 *      几何与颜色都落进 slide1.xml（真解包断言，不看库自己说法）。
 *   3. `createPptTool` 的缺省模板：注入的取值函数给了名字就用它、空串 / 不认得就自动；
 *      落盘回执里带上**最终用的模板名**（用户与测试靠它确认）。
 *   4. 系统指令里那一行（用户在对话页固定了模板 → 告诉模型别乱换）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KYCLAW_INSTRUCTIONS, kyclawInstructions } from '../../agents/kyclaw'
import { readZipEntries } from '../artifact-check'
import { createPptTool, renderPptx } from '../ppt'
import { PPT_TEMPLATE_NAMES, PPT_THEMES, PPT_THEME_NAMES, resolveTheme } from '../ppt-themes'
import { callTool, createBed, type TestBed } from './helpers'
import { zipText } from './zip'

/** 一页正文字形：band 封面的标题框（1.5in, 1.75in, 7.6in × 1.35in）→ EMU */
const INCH = 914_400

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('resolveTheme：显式 > 用户固定 > 自动', () => {
  const deck = { title: '季度复盘', slides: [{ title: '结论' }] }

  it('显式 theme 最优先（哪怕用户固定了别的）', () => {
    expect(resolveTheme({ ...deck, theme: '酒红' }, '学术紫').name).toBe('酒红')
  })

  it('没给 theme 时用用户固定的那套（新模板也能固定）', () => {
    expect(resolveTheme(deck, '学术紫').name).toBe('学术紫')
    expect(resolveTheme(deck, '湖蓝').name).toBe('湖蓝')
  })

  it('固定模板是空串 / 不认识的名字 → 退到自动挑（不抛错、不落成"没有模板"）', () => {
    const auto = resolveTheme(deck).name
    expect(resolveTheme(deck, '').name).toBe(auto)
    expect(resolveTheme(deck, '彩虹色').name).toBe(auto)
    // 显式给了脏名字、用户也没固定：同样走自动
    expect(resolveTheme({ ...deck, theme: '彩虹色' }, '').name).toBe(auto)
  })

  it('自动挑只在六套基础主题里挑（新模板要显式选，老文档的配色一点不变）', () => {
    for (const title of ['季度汇报', '产品发布', '教学课件', '商业提案', '个人小结']) {
      expect([...PPT_THEME_NAMES]).toContain(resolveTheme({ title, slides: [] }).name)
    }
  })

  it('十套模板都能被显式选中（schema 与注册表同一份名单）', () => {
    expect([...PPT_TEMPLATE_NAMES]).toHaveLength(10)
    for (const name of PPT_TEMPLATE_NAMES) {
      expect(resolveTheme({ ...deck, theme: name }).name).toBe(name)
    }
  })
})

describe('band 封面（学术紫 / 湖蓝）：左侧色带 + 左对齐标题真的落进 XML', () => {
  it('封面页有那条通栏色带，标题框让开它、副标题也左对齐', async () => {
    const band = PPT_THEMES['学术紫']
    const rendered = await renderPptx({
      title: '毕业论文答辩',
      subtitle: '2026 届 · 计算机学院',
      theme: '学术紫',
      slides: [{ title: '研究背景', bullets: ['问题定义'] }]
    })
    expect(rendered.theme).toBe('学术紫')

    const cover = zipText(readZipEntries(rendered.data), 'ppt/slides/slide1.xml')
    // 色带：0.85in × 5.625in 的 accent 色块（band 封面唯一的装饰）
    expect(cover).toContain(
      `<a:ext cx="${Math.round(0.85 * INCH)}" cy="${Math.round(5.625 * INCH)}"/>`
    )
    expect(cover).toContain(`val="${band.accent}"`)
    // 标题框：x = 1.5in（让开色带），左对齐（algn="l"）
    expect(cover).toContain(`<a:off x="${Math.round(1.5 * INCH)}"`)
    expect(cover).toContain('algn="l"')
    expect(cover).toContain('毕业论文答辩')
    expect(cover).toContain('2026 届 · 计算机学院')
    // 封面不铺模板 motif 的第二块（band 封面只有一条色带）
    expect(cover).not.toContain(
      `<a:ext cx="${Math.round(1.5 * INCH)}" cy="${Math.round(0.22 * INCH)}"/>`
    )
  })

  it('居中封面（老模板）保持原样：装饰块还是 motif 那两块', async () => {
    const blue = PPT_THEMES['商务蓝']
    const rendered = await renderPptx({
      title: '季度业务复盘',
      theme: '商务蓝',
      slides: [{ title: '结论' }]
    })
    const cover = zipText(readZipEntries(rendered.data), 'ppt/slides/slide1.xml')

    // block motif：顶部通栏色带（10 × 0.35）+ 右下角方块（0.6 × 0.6）
    expect(cover).toContain(
      `<a:ext cx="${Math.round(10 * INCH)}" cy="${Math.round(0.35 * INCH)}"/>`
    )
    expect(cover).toContain(
      `<a:ext cx="${Math.round(0.6 * INCH)}" cy="${Math.round(0.6 * INCH)}"/>`
    )
    expect(cover).toContain(`val="${blue.accent}"`)
    expect(cover).toContain('sz="4000"')
  })
})

describe('createPptTool：缺省模板（这个会话在对话页固定的）与落盘回执', () => {
  const input = { title: '季度复盘', slides: [{ title: '结论', bullets: ['稳中向好'] }] }

  /** 从落盘文件里读第 index 页的 XML（1 起） */
  function pageXml(file: string, index: number): string {
    return zipText(readZipEntries(readFileSync(file)), `ppt/slides/slide${index}.xml`)
  }

  it('没注入取值函数 / 函数回空串：照旧自动挑（回执里带自动挑中的那套）', async () => {
    const plain = await createPptTool(bed.ctx)
    const auto = String(await callTool(plain, input))
    const autoName = /模板「(.+?)」/.exec(auto)?.[1] ?? ''
    expect([...PPT_THEME_NAMES]).toContain(autoName)
    expect(existsSync(join(bed.root, '季度复盘.pptx'))).toBe(true)

    const empty = await createPptTool(bed.ctx, { getDefaultTheme: () => '' })
    const emptyOut = String(await callTool(empty, { ...input, path: '空模板.pptx' }, 'session-2'))
    expect(emptyOut).toContain(`模板「${autoName}」`)
  })

  it('注入了固定模板：不指定 theme 就用它（颜色落进文件），回执写明模板名', async () => {
    const tool = await createPptTool(bed.ctx, { getDefaultTheme: () => '酒红' })
    const out = String(await callTool(tool, input))

    expect(out).toContain('模板「酒红」')
    expect(out).toContain('；结构校验通过')
    const file = join(bed.root, '季度复盘.pptx')
    expect(existsSync(file)).toBe(true)
    expect(pageXml(file, 1)).toContain(`val="${PPT_THEMES['酒红'].accent}"`)
  })

  it('固定模板认不出来 → 自动挑（脏设置不拦生成）', async () => {
    const tool = await createPptTool(bed.ctx, { getDefaultTheme: () => '彩虹色' })
    const out = String(await callTool(tool, input))
    const name = /模板「(.+?)」/.exec(out)?.[1] ?? ''
    expect([...PPT_THEME_NAMES]).toContain(name)
  })

  it('模型显式给了 theme：压过用户固定的模板', async () => {
    const tool = await createPptTool(bed.ctx, { getDefaultTheme: () => '学术紫' })
    const out = String(await callTool(tool, { ...input, theme: '暖橙' }))

    expect(out).toContain('模板「暖橙」')
    expect(pageXml(join(bed.root, '季度复盘.pptx'), 1)).toContain(
      `val="${PPT_THEMES['暖橙'].accent}"`
    )
  })

  // round 66：缺省模板按 threadId 取（模板选择是会话级的）——两条会话各用自己那套，
  // 没选的会话照旧自动挑。这条与"显式 theme 最优先"合起来就是完整的优先级：
  // 显式 theme > 这个会话的选择 > 自动挑。
  it('会话级：两条会话各用自己那套（缺省模板按 threadId 取）', async () => {
    const byThread: Record<string, string> = { 'thread-a': '酒红', 'thread-b': '奶油' }
    const tool = await createPptTool(bed.ctx, {
      getDefaultTheme: (threadId) => byThread[threadId] ?? ''
    })

    const a = String(await callTool(tool, { ...input, path: 'a.pptx' }, 'thread-a'))
    const b = String(await callTool(tool, { ...input, path: 'b.pptx' }, 'thread-b'))

    expect(a).toContain('模板「酒红」')
    expect(b).toContain('模板「奶油」')
    // 颜色也真的各自落进文件（不是只有回执换了名字）
    expect(pageXml(join(bed.root, 'a.pptx'), 1)).toContain(`val="${PPT_THEMES['酒红'].accent}"`)
    expect(pageXml(join(bed.root, 'b.pptx'), 1)).toContain(`val="${PPT_THEMES['奶油'].accent}"`)
  })

  it('会话级：没选模板的会话照旧自动挑（不继承别的会话选的）', async () => {
    const tool = await createPptTool(bed.ctx, {
      getDefaultTheme: (threadId) => (threadId === 'picked' ? '酒红' : '')
    })

    const out = String(await callTool(tool, input, 'plain'))
    const name = /模板「(.+?)」/.exec(out)?.[1] ?? ''
    // 自动池只有六套基础主题（酒红 / 奶油 这类要显式选）——"别的会话的选择"漏过来就会红
    expect([...PPT_THEME_NAMES]).toContain(name)
    expect(name).not.toBe('酒红')
  })
})

// round 66：模板名**不再进系统指令**——PPT 模板从"全局设置"改成"会话级"后，指令那一层拿不到会话 id
// （instructions 回调里的 requestContext 是空的），缺省模板的解析挪进了 create_ppt 的工具执行里
// （上面 `createPptTool：缺省模板` 那组就在钉这一层）。这里只钉"指令里没有它"这条边界，免得又被加回来。
describe('系统指令：不再补"用户固定了 PPT 模板"那一行（round 66）', () => {
  it('第二个参数是技能清单（原样接在末尾），不再生成模板行', () => {
    const text = kyclawInstructions(null, '\n- Skills (work manuals): 示例清单')

    expect(text).toContain(KYCLAW_INSTRUCTIONS)
    expect(text).toContain('Skills (work manuals): 示例清单')
    expect(text).not.toContain('固定了 PPT 模板')
  })

  it('没有技能：末尾不留空话，也没有任何模板名', () => {
    const text = kyclawInstructions(null, '')
    expect(text).toContain(KYCLAW_INSTRUCTIONS)
    for (const name of [...PPT_THEME_NAMES]) {
      expect(text).not.toContain(`固定的 PPT 模板「${name}」`)
    }
  })
})
