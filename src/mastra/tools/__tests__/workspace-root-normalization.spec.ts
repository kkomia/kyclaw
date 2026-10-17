// @vitest-environment node
/**
 * 工作区根归一化（round 97 真实探针暴露的缺陷）：
 *
 * `TEMP=C:\LMSTUD~1` 这类 Windows 8.3 短名下，工具解析出的 `abs` 是 realpath 后的长名，
 * 而设置里存的 `workspace.path` 仍是短名。任何拿 `workspace.path` 去对 `abs` 算 `relative`
 * 的地方都会得到 `..\..\lmstudio-temp\...` 这种伪相对路径（探针里 deliver 卡的
 * `data-path` 就是这样坏掉的）。
 *
 * 这些用例把工作区根换成**真实短名**（拿不到就 skip，不当通过），再让目标走长名绝对路径，
 * 钉住四件事：
 *   1. `toolTarget` 的 `root` 与 `abs` 是同一 realpath 口径；
 *   2. deliver 的 `path` 是 `delivered.md`，不是 `../..`；
 *   3. delete / move 的“工作区根”保护没有被短名绕过；
 *   4. read / render_ppt 的工作区相对路径不含 `..`。
 *
 * 另有一条 junction 根用例：不依赖 8.3 也能证明“根必须按真实路径算”，
 * 同时覆盖 symlink / junction 根这一同类。
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeleteTool } from '../delete'
import { createDeliverFileTool } from '../deliver'
import { toolTarget } from '../guard'
import { createMoveTool } from '../move'
import { renderPptx } from '../ppt'
import { createReadTool } from '../read'
import { createRenderPptTool } from '../render-ppt'
import { callTool, createBed, type TestBed } from './helpers'

/** 真 1×1 PNG（read / render_ppt 的图片档都只验格式与尺寸） */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const NO_SHORT_PATH = '本机拿不到 8.3 短名（非 Windows 或卷上未生成短名），跳过'

let bed: TestBed
let shortRoot: string | null = null

/** Windows 8.3 短名（系统 API 口径）；非 Windows / 卷上没生成短名 → null */
function shortPathOf(path: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execSync(`for %I in ("${path}") do @echo %~sI`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
      .trim()
      .replace(/^"|"$/g, '')
    return out !== '' && out.toLowerCase() !== path.toLowerCase() ? out : null
  } catch {
    return null
  }
}

beforeEach(() => {
  bed = createBed()
  shortRoot = shortPathOf(bed.root)
  // 根换成短名；文件仍从长名路径造/读，复现探针里的“短名根 vs 长名 abs”
  if (shortRoot !== null) bed.roots[0] = { ...bed.roots[0], path: shortRoot }
})

afterEach(() => {
  bed.dispose()
})

describe('工作区根归一化：短名根 vs 长名 abs', () => {
  it('toolTarget：root 与 abs 出自同一次 realpath 判定', (context) => {
    if (shortRoot === null) {
      context.skip(NO_SHORT_PATH)
      return
    }

    const resolved = toolTarget(bed.ctx, join(bed.root, 'a.txt'))

    expect(resolved.workspace.path).toBe(shortRoot)
    expect(resolved.root).toBe(bed.root)
    expect(resolved.abs).toBe(join(bed.root, 'a.txt'))
  })

  it('deliver_file：卡片 path 是 delivered.md，不是 ../..', async (context) => {
    if (shortRoot === null) {
      context.skip(NO_SHORT_PATH)
      return
    }
    writeFileSync(join(bed.root, 'delivered.md'), '# 交付\n')

    const tool = await createDeliverFileTool(bed.ctx)
    // 探针里的模型给的是相对路径；再用绝对长名走一遍，两条都必须是同一张卡的相对路径
    for (const target of ['delivered.md', join(bed.root, 'delivered.md')]) {
      const out = (await callTool(tool, { path: target })) as {
        path: string
        message: string
      }
      expect(out.path, target).toBe('delivered.md')
      expect(out.message, target).not.toContain('..')
    }
    // 不存在的文件仍按原来的"不存在"报错（根归一只改相对路径口径，不改这条分支）
    await expect(callTool(tool, { path: 'missing.md' })).rejects.toThrow(/不存在/)
  })

  it('delete：短名根 + 长名 abs 仍识别为工作区根，拒绝删除', async (context) => {
    if (shortRoot === null) {
      context.skip(NO_SHORT_PATH)
      return
    }
    writeFileSync(join(bed.root, 'keep.txt'), 'keep')

    const tool = await createDeleteTool(bed.ctx)
    // 用绝对短名根进引擎：归一后的 abs 是长名根，旧的词法比较会漏判
    await expect(callTool(tool, { path: shortRoot })).rejects.toThrow(/工作区根目录/)
    expect(existsSync(join(bed.root, 'keep.txt'))).toBe(true)
  })

  it('move：短名根 + 长名 abs 仍识别为工作区根，拒绝移动', async (context) => {
    if (shortRoot === null) {
      context.skip(NO_SHORT_PATH)
      return
    }

    const tool = await createMoveTool(bed.ctx)
    await expect(callTool(tool, { path: shortRoot, to: 'renamed' })).rejects.toThrow(/工作区根目录/)
  })

  it('read：图片档 path 是工作区相对路径（不含 ..）', async (context) => {
    if (shortRoot === null) {
      context.skip(NO_SHORT_PATH)
      return
    }
    writeFileSync(join(bed.root, 'shot.png'), Buffer.from(PNG_1x1, 'base64'))

    const tool = await createReadTool(bed.ctx)
    const out = (await callTool(tool, { path: join(bed.root, 'shot.png') })) as { path: string }

    expect(out.path).toBe('shot.png')
    expect(out.path).not.toContain('..')
  })

  it('render_ppt：页图目录与页图 path 都是工作区相对路径（不含 ..）', async (context) => {
    if (shortRoot === null) {
      context.skip(NO_SHORT_PATH)
      return
    }
    const deck = await renderPptx({
      title: '日报',
      slides: [{ title: '一', bullets: ['只有一页'] }]
    })
    mkdirSync(join(bed.root, '演示'))
    writeFileSync(join(bed.root, '演示', '日报.pptx'), deck.data)

    const tool = await createRenderPptTool(bed.ctx, {
      detect: () => 'powerpoint',
      render: async (_deck, outDir) => {
        writeFileSync(join(outDir, '幻灯片1.PNG'), Buffer.from(PNG_1x1, 'base64'))
        return { ok: true, detail: '' }
      }
    })
    const out = (await callTool(tool, { path: join(bed.root, '演示', '日报.pptx') })) as {
      dir?: string
      pages: Array<{ path: string }>
    }

    expect(out.dir).toBe('演示/日报_页图')
    expect(out.pages.map((page) => page.path)).toEqual(['演示/日报_页图/幻灯片1.PNG'])
    expect(out.dir).not.toContain('..')
  })
})

describe('工作区根归一化：junction / symlink 根（不依赖 8.3）', () => {
  it('deliver_file：根是链接时，相对路径仍按真实根算', async (context) => {
    const real = join(bed.tmp, 'real-ws')
    const link = join(bed.tmp, 'link-ws')
    mkdirSync(real)
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      context.skip('本机建不出目录 junction / symlink，跳过')
      return
    }
    writeFileSync(join(real, 'delivered.md'), 'x')
    bed.roots[0] = { ...bed.roots[0], path: link }

    const tool = await createDeliverFileTool(bed.ctx)
    const out = (await callTool(tool, { path: join(real, 'delivered.md') })) as { path: string }

    expect(out.path).toBe('delivered.md')
  })
})
