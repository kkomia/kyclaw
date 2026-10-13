// @vitest-environment node
/**
 * render_ppt 的聚焦用例（round 68）。
 *
 * 要钉住的是**退化口径**与**给模型的形状**，两件都不该被重构悄悄改掉：
 *   1. 没有渲染器时**不抛异常、不假装成功**：回人话 + 逐页文字结构（结构自检），并且**不落任何页图**；
 *   2. 有渲染器时：页图按页码落盘（PowerPoint 的文件名前缀随语言变，不能按名字比大小）、
 *      上一次多出来的页不留到这一次、附给模型的图**有上限**（省 token）；
 *   3. `toModelOutput` 给的是 AI SDK 认的 `file` 形状（**不是废弃的 `image-url`**——那个会抛 Invalid URL），
 *      并且只附 `attached` 里那几页；
 *   4. 非 .pptx、文件不存在都给**人话**错误。
 *
 * 渲染器与渲染过程都是注入的（真 PowerPoint COM 不在单测里跑，见真链路探针
 * `src/main/agent/__tests__/_r68-real.spec.ts`）。
 */
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderPptx } from '../ppt'
import { MAX_ATTACHED_PAGES, createRenderPptTool, pageNumberOf, sortPageFiles } from '../render-ppt'
import { createBed, callTool, type TestBed } from './helpers'

/** 一份真 pptx（用产出物自己的渲染器造，抽取结构那一段因此也是真链路） */
async function writeDeck(path: string): Promise<number> {
  const deck = await renderPptx({
    title: '今日新闻日报',
    slides: [
      { title: '国内要闻', bullets: ['PSL 利率下调 0.25 个百分点'] },
      { title: '关键指标', stats: [{ value: '182.3 万辆', label: '9 月新能源车销量' }] }
    ]
  })
  writeFileSync(path, deck.data)
  return deck.slides
}

/** 假渲染器：写 count 张 PNG（模拟 PowerPoint 的中文文件名），内容无所谓 */
function fakeRenderer(
  count: number
): (deck: string, outDir: string) => Promise<{ ok: boolean; detail: string }> {
  return async (_deck, outDir) => {
    // 1x1 PNG 的真字节（不是占位串）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    for (let index = 1; index <= count; index += 1) {
      writeFileSync(join(outDir, `幻灯片${index}.PNG`), png)
    }
    return { ok: true, detail: '' }
  }
}

describe('render_ppt', () => {
  let bed: TestBed

  beforeEach(() => {
    bed = createBed({ mode: 'full' })
  })

  afterEach(() => {
    bed.dispose()
  })

  it('没有渲染器时不抛异常，回人话 + 逐页文字，且不落页图', async () => {
    const deckPath = join(bed.root, '日报.pptx')
    const slides = await writeDeck(deckPath)

    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'none',
      render: fakeRenderer(3)
    })
    const result = (await callTool(tool, { path: '日报.pptx' })) as {
      renderer: string
      pages: unknown[]
      attached: unknown[]
      outline: Array<{ index: number; title?: string; lines: string[] }>
      message: string
    }

    expect(result.renderer).toBe('none')
    expect(result.pages).toEqual([])
    expect(result.attached).toEqual([])
    // 结构自检是真从 pptx 里抽出来的
    expect(result.outline).toHaveLength(slides)
    // 我们自己生成的 deck 用的是文本框（没有 <p:ph> 占位符），所以抽出来的正文行里带标题文字、
    // 但 title 字段是空的 —— 这正是 extractPptx「认不出就不猜」的口径，断言按它写
    expect(JSON.stringify(result.outline)).toContain('国内要闻')
    expect(result.message).toContain('没能渲染页图')
    expect(result.message).toContain('国内要闻')
    // 退化路径**没有**落任何派生文件
    expect(readdirSync(bed.root)).toEqual(['日报.pptx'])
  })

  it('渲染成功时按页码排页图、附给模型的图有上限、上一次多余的页不会留下', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))

    const many = MAX_ATTACHED_PAGES + 3
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: fakeRenderer(many)
    })
    const result = (await callTool(tool, { path: '日报.pptx' })) as {
      renderer: string
      dir: string
      pages: Array<{ index: number; path: string }>
      attached: number[]
      message: string
    }

    expect(result.renderer).toBe('powerpoint')
    expect(result.dir).toBe('日报_页图')
    expect(result.pages).toHaveLength(many)
    // 页码 1..15 按数字排（不是 "幻灯片1, 幻灯片10, 幻灯片11…" 那种字典序）
    expect(result.pages.map((page) => page.index)).toEqual(
      Array.from({ length: many }, (_unused, index) => index + 1)
    )
    expect(result.attached).toEqual(
      Array.from({ length: MAX_ATTACHED_PAGES }, (_unused, index) => index + 1)
    )
    expect(result.message).toContain(`一次最多 ${MAX_ATTACHED_PAGES} 页`)

    // 第二次用更少的页渲染：上一次多出来的页必须被清掉（否则会冒充这一次的产出）
    const smaller = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: fakeRenderer(2)
    })
    const second = (await callTool(smaller, { path: '日报.pptx' })) as {
      pages: Array<{ index: number }>
      attached: number[]
    }
    expect(second.pages.map((page) => page.index)).toEqual([1, 2])
    expect(second.attached).toEqual([1, 2])
  })

  it('pages 只附点名的那几页（渲染仍然全量落盘）', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: fakeRenderer(6)
    })
    const result = (await callTool(tool, { path: '日报.pptx', pages: [2, 5] })) as {
      pages: unknown[]
      attached: number[]
    }
    expect(result.pages).toHaveLength(6)
    expect(result.attached).toEqual([2, 5])
  })

  it('toModelOutput 给 AI SDK 的 file 形状（不是废弃的 image-url），且只附点名的页', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: fakeRenderer(3)
    })
    const result = await callTool(tool, { path: '日报.pptx', pages: [2, 3] })

    const toModelOutput = (tool as { toModelOutput?: (output: unknown) => Promise<unknown> })
      .toModelOutput
    expect(toModelOutput).toBeTypeOf('function')
    const mapped = (await toModelOutput?.(result)) as {
      type: string
      value: Array<Record<string, unknown>>
    }

    expect(mapped.type).toBe('content')
    const files = mapped.value.filter((part) => part.type === 'file')
    expect(files).toHaveLength(2)
    for (const part of files) {
      expect(part.mediaType).toBe('image/png')
      // 内联字节（base64 字符串），**不是** data URL —— 后者会被 DeepSeek 的 8192 字符上限拒掉
      expect(part.data).toMatchObject({ type: 'data' })
      expect(typeof (part.data as { data: unknown }).data).toBe('string')
    }
    // 废弃形状一个都不能有
    expect(mapped.value.some((part) => part.type === 'image-url')).toBe(false)
    expect(mapped.value[0]).toMatchObject({ type: 'text' })
  })

  it('非 .pptx 与不存在的文件都给人话错误', async () => {
    const tool = await createRenderPptTool(bed.ctx, { detect: () => 'none' })
    await expect(callTool(tool, { path: '报告.html' })).rejects.toThrow(/只渲染 \.pptx/)
    await expect(callTool(tool, { path: '没有这个.pptx' })).rejects.toThrow(/不存在/)
  })

  it('页图排序按名字里的页码走，不按字典序', () => {
    expect(sortPageFiles(['幻灯片10.PNG', '幻灯片2.PNG', '幻灯片1.PNG'])).toEqual([
      '幻灯片1.PNG',
      '幻灯片2.PNG',
      '幻灯片10.PNG'
    ])
    expect(pageNumberOf('幻灯片7.PNG')).toBe(7)
    expect(pageNumberOf('Slide12.png')).toBe(12)
    expect(pageNumberOf('封面.PNG')).toBe(0)
  })

  it('渲染失败（不是"没有渲染器"）时同样退化成结构自检，并把原因原样带出来', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: async () => ({ ok: false, detail: '演示文稿被占用' })
    })
    const result = (await callTool(tool, { path: '日报.pptx' })) as {
      renderer: string
      pages: unknown[]
      message: string
    }
    expect(result.renderer).toBe('powerpoint')
    expect(result.pages).toEqual([])
    expect(result.message).toContain('演示文稿被占用')
  })

  it('随包 LibreOffice 渲染成功：回执报**渲染器实测**的尺寸，缺字单独提出来说', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'libreoffice',
      // 实测形状：page-0001.png + manifest 里 width/height 与 missingFonts
      render: async (_deck, outDir) => {
        await fakeRenderer(2)(_deck, outDir)
        return {
          ok: true,
          detail: '',
          size: { width: 1441, height: 811 },
          missingFonts: ['微软雅黑']
        }
      }
    })
    const result = (await callTool(tool, { path: '日报.pptx' })) as {
      renderer: string
      dir: string
      pages: Array<{ index: number; path: string }>
      message: string
    }

    expect(result.renderer).toBe('libreoffice')
    expect(result.pages.map((page) => page.index)).toEqual([1, 2])
    // 尺寸来自渲染器自报，不是常量 1600×900（kit 只能按 dpi 缩放，不能点定死宽高）
    expect(result.message).toContain('已渲染 2 页（1441×811）')
    expect(result.message).not.toContain('1600×900')
    expect(result.message).toContain('缺这些字体')
    expect(result.message).toContain('微软雅黑')
  })

  it('缺字为空数组时不啰嗦（"查过且没缺"不该占篇幅）', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'libreoffice',
      render: async (_deck, outDir) => {
        await fakeRenderer(1)(_deck, outDir)
        return { ok: true, detail: '', size: { width: 1441, height: 811 }, missingFonts: [] }
      }
    })
    const result = (await callTool(tool, { path: '日报.pptx' })) as { message: string }
    expect(result.message).toContain('已渲染 1 页（1441×811）')
    expect(result.message).not.toContain('缺这些字体')
  })

  it('探测说是 libreoffice 但找不到随包 CLI（人为硬指）时如实退化，**不悄悄改用 PowerPoint**', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'libreoffice',
      kitCli: null
    })
    const result = (await callTool(tool, { path: '日报.pptx' })) as {
      renderer: string
      pages: unknown[]
      message: string
    }
    // 渲染器名照实说是 libreoffice（不是假装走了 PowerPoint），并说清为什么没渲
    expect(result.renderer).toBe('libreoffice')
    expect(result.pages).toEqual([])
    expect(result.message).toContain('没能渲染页图')
    expect(result.message).toContain('没找到它')
    expect(result.message).toContain('结构自检')
  })

  /**
   * 免审的**前提**（见 `main/permission/classify.ts` 的 render_ppt 表项）：写入只落在派生目录里。
   * 下面两条钉的就是这个前提 —— 不是"它不写盘"（它确实要新建/覆盖 `<deck 名>_页图/`）。
   */
  it('页图只落在 deck 旁边的派生目录里：别处不动、被检查的那份 deck 一个字节都不变', async () => {
    mkdirSync(join(bed.root, '演示'))
    const deckPath = join(bed.root, '演示', '日报.pptx')
    await writeDeck(deckPath)
    const before = readFileSync(deckPath)

    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: fakeRenderer(2)
    })
    const result = (await callTool(tool, { path: '演示/日报.pptx' })) as { dir: string }

    expect(result.dir).toBe('演示/日报_页图')
    expect(readdirSync(join(bed.root, '演示')).sort()).toEqual(['日报.pptx', '日报_页图'])
    // 渲染只读 deck（PowerPoint 那条路以只读方式打开），产物全在派生目录里
    expect(readFileSync(deckPath).equals(before)).toBe(true)
  })

  it('派生目录若解析到工作区外（有人把它做成链接）：拒绝，工作区外一个文件都不写', async (context) => {
    await writeDeck(join(bed.root, '日报.pptx'))
    try {
      symlinkSync(bed.outside, join(bed.root, '日报_页图'), 'junction')
    } catch {
      // 造不出链接的机器（Windows 无开发者模式等）跳过：这条要证明的不是"这台机器能不能建链接"
      context.skip()
      return
    }

    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: fakeRenderer(2)
    })

    await expect(callTool(tool, { path: '日报.pptx' })).rejects.toThrow(/派生目录不在工作区内/)
    expect(readdirSync(bed.outside)).toEqual([])
  })

  it('免审不等于免封：跨越工作区边界的路径照样被引擎拒，不写任何文件', async () => {
    await writeDeck(join(bed.root, '日报.pptx'))
    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: fakeRenderer(2)
    })

    await expect(callTool(tool, { path: '../outside/日报.pptx' })).rejects.toThrow(/工作区/)
    expect(readdirSync(bed.outside)).toEqual([])
  })
})

describe('render_ppt 的渲染器探测', () => {
  it('没有随包渲染器时，非 Windows 一律回 none（那时第二条路只剩 PowerPoint COM）', async () => {
    const { detectRenderer, resetRendererCache } = await import('../render-ppt')
    resetRendererCache()
    expect(detectRenderer({ platform: 'darwin', kitCli: null })).toBe('none')
    expect(detectRenderer({ platform: 'linux', kitCli: null })).toBe('none')
  })

  it('随包 kit 在位时**优先**回 libreoffice，且任何平台都一样（这正是"没有 PowerPoint 也能渲染"）', async () => {
    const { detectRenderer, resetRendererCache } = await import('../render-ppt')
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      resetRendererCache()
      expect(detectRenderer({ platform, kitCli: 'C:/kit/cli.js' })).toBe('libreoffice')
    }
  })

  it('环境变量可以强制指定（排障与测试的逃生门）', async () => {
    const { detectRenderer, resetRendererCache } = await import('../render-ppt')
    const forced: Array<[string, string]> = [
      ['none', 'none'],
      ['off', 'none'],
      ['libreoffice', 'libreoffice'],
      ['kit', 'libreoffice'],
      ['powerpoint', 'powerpoint']
    ]
    for (const [value, expected] of forced) {
      process.env.KYCLAW_PPT_RENDERER = value
      try {
        resetRendererCache()
        // kitCli 给 null：证明结论来自环境变量，不是来自"这台机器刚好装了 kit"
        expect(detectRenderer({ platform: 'win32', kitCli: null })).toBe(expected)
      } finally {
        delete process.env.KYCLAW_PPT_RENDERER
        resetRendererCache()
      }
    }
  })

  it('探测结果会被缓存（COM 探测要起 PowerShell，不能每轮都来），resetRendererCache 能清掉', async () => {
    const { detectRenderer, resetRendererCache } = await import('../render-ppt')
    resetRendererCache()
    expect(detectRenderer({ platform: 'darwin', kitCli: 'C:/kit/cli.js' })).toBe('libreoffice')
    // 缓存住之后，这次给 null 也还是上一次的结论
    expect(detectRenderer({ platform: 'darwin', kitCli: null })).toBe('libreoffice')
    resetRendererCache()
    expect(detectRenderer({ platform: 'darwin', kitCli: null })).toBe('none')
  })
})
