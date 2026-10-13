// @vitest-environment node
/**
 * deliver_file 工具：把工作区里已有的文件交付给用户看。
 *
 * 钉住的五件事：
 *   1. **结构化输出**（卡片要的字段：相对路径 / 文件名 / 字节数 / MIME / note）；
 *   2. **根约束与 read 同口径**（相对路径按会话根解析；越界 / 目录 / 不存在都给人话错误）；
 *   3. **读档免审批**（分类表 + 工具自己的 requireApproval 两个入口都放行，不入工具自己的白名单）；
 *   4. 只 stat：不读内容、不写盘（执行前后工作区内容一字不变）；
 *   5. round 70：**单次上界一件**（多件给的是人话回执，不是异常；逗号不当分隔符），
 *      以及**描述层**确实写着那三条交付语义（中间产物不交 / 不复制字节 / 一次一件）。
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyToolCall } from '../../../main/permission/classify'
import { createDeliverFileTool, mimeTypeOf } from '../deliver'
import { callTool, createBed, writeText, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

interface DeliveryShape {
  path?: unknown
  name?: unknown
  size?: unknown
  mimeType?: unknown
  note?: unknown
  message?: unknown
}

/** 审批 gate 的形状与 write 一致：工具定义上的 requireApproval，收工具入参 */
function gateOf(tool: unknown): (input: unknown) => boolean {
  return (tool as { requireApproval: (input: unknown) => boolean }).requireApproval
}

describe('deliver_file：结构化交付结果', () => {
  it('交付工作区里的文件：回相对路径 / 文件名 / 字节数 / MIME / 人话回执', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    mkdirSync(join(bed.root, 'docs'))
    writeText(join(bed.root, 'docs', '项目交接文档.md'), '# 交接\n共两份材料。')

    const out = (await callTool(tool, { path: 'docs/项目交接文档.md' })) as DeliveryShape

    expect(out.path).toBe('docs/项目交接文档.md')
    expect(out.name).toBe('项目交接文档.md')
    expect(out.size).toBe(statSync(join(bed.root, 'docs', '项目交接文档.md')).size)
    expect(out.mimeType).toBe('text/markdown')
    // 回执是给模型看的人话（不是可解析的机器串）
    expect(String(out.message)).toContain('docs/项目交接文档.md')
    expect(String(out.message)).toContain('交付卡')
  })

  it('相对路径按工作区根解析：同一个相对串在别的工作区里落不到同一个文件', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'x')

    await expect(callTool(tool, { path: 'a.txt' }, 'thread-1')).resolves.toMatchObject({
      path: 'a.txt'
    })

    const other = createBed()
    try {
      const otherTool = await createDeliverFileTool(other.ctx)
      await expect(callTool(otherTool, { path: 'a.txt' }, 'thread-2')).rejects.toThrow(/不存在/)
    } finally {
      other.dispose()
    }
  })

  it('note 原样带回；没给 / 只有空白就不带这个字段', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'x')

    const withNote = (await callTool(tool, { path: 'a.txt', note: '本次交接的全部材料' })) as
      DeliveryShape | undefined
    expect(withNote?.note).toBe('本次交接的全部材料')

    const blank = (await callTool(tool, { path: 'a.txt', note: '   ' })) as DeliveryShape
    expect('note' in blank).toBe(false)
  })

  it('认得出的扩展名给 MIME，认不出的（无扩展名 / 点文件）不给这个字段', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.root, 'README'), 'x')
    writeText(join(bed.root, '.gitignore'), 'node_modules')

    const noExt = (await callTool(tool, { path: 'README' })) as DeliveryShape
    expect('mimeType' in noExt).toBe(false)
    const dotFile = (await callTool(tool, { path: '.gitignore' })) as DeliveryShape
    expect('mimeType' in dotFile).toBe(false)

    expect(mimeTypeOf('报告.pdf')).toBe('application/pdf')
    expect(mimeTypeOf('表.XLSX')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    // 复合扩展名不猜：只看最后一段，认不出就不给
    expect(mimeTypeOf('包.tar.gz')).toBeUndefined()
  })

  it('只 stat：交付前后工作区内容与目录项都不变（不读内容、不写盘）', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), '原文')
    const before = readdirSync(bed.root).sort()

    await callTool(tool, { path: 'a.txt' })

    expect(readdirSync(bed.root).sort()).toEqual(before)
    expect(statSync(join(bed.root, 'a.txt')).size).toBe(Buffer.byteLength('原文', 'utf8'))
  })
})

describe('deliver_file：工作区边界与失败（与 read 同口径）', () => {
  it('工作区外（绝对路径或 ../）：fail closed，原因指向工作区', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.outside, 'secret.txt'), 'secret')

    await expect(callTool(tool, { path: join(bed.outside, 'secret.txt') })).rejects.toThrow(
      /授权工作区/
    )
    await expect(callTool(tool, { path: '../outside/secret.txt' })).rejects.toThrow(/授权工作区/)
  })

  it('目录：明确报"交付的是文件"并给下一步（用 glob 列目录）', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    mkdirSync(join(bed.root, 'sub'))

    await expect(callTool(tool, { path: 'sub' })).rejects.toThrow(/目录/)
    await expect(callTool(tool, { path: 'sub' })).rejects.toThrow(/glob/)
  })

  it('不存在：报错并提示用 glob 找（不是静默成功）', async () => {
    const tool = await createDeliverFileTool(bed.ctx)

    await expect(callTool(tool, { path: 'nope.md' })).rejects.toThrow(/不存在/)
    await expect(callTool(tool, { path: 'nope.md' })).rejects.toThrow(/glob/)
  })

  it('一个工作区都没有：拒绝原因指向设置里的工作区', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    bed.roots.length = 0

    await expect(callTool(tool, { path: 'a.txt' })).rejects.toThrow(/授权工作区/)
  })
})

describe('deliver_file：单次上界（round 70，一件/次）', () => {
  it('一次给多个路径：回一句人话回执（不抛错、也不交付任何一件）', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.root, 'a.md'), '甲')
    writeText(join(bed.root, 'b.md'), '乙')

    const out = await callTool(tool, { path: 'a.md\nb.md' })

    // 不是交付卡（没有卡片字段），而是给模型看的字符串回执
    expect(typeof out).toBe('string')
    const message = String(out)
    expect(message).toContain('一次只交付一件')
    expect(message).toContain('a.md')
    expect(message).toContain('b.md')
    // 可执行的下一步：拆成几次调用
    expect(message).toContain('2 次调用')
    // 一件都没交付：两张卡都不该出现（这里是"没有结构化结果"这个事实本身）
    expect(message).toContain('一件都没交付')
  })

  it('逗号不是分隔符：文件名里带逗号照旧是一件（只按换行判多件）', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.root, '报告,终稿.md'), 'x')

    const out = (await callTool(tool, { path: '报告,终稿.md' })) as DeliveryShape

    expect(out.name).toBe('报告,终稿.md')
    expect(out.path).toBe('报告,终稿.md')
  })

  it('路径两端多一个换行不算多件：照常交付（模型常这么写）', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    writeText(join(bed.root, 'a.md'), 'x')

    const out = (await callTool(tool, { path: '\n a.md \n' })) as DeliveryShape

    expect(out.path).toBe('a.md')
  })
})

describe('deliver_file：描述层的三条交付语义（round 70）', () => {
  it('描述里写清了"不复制字节 / 中间产物不交 / 一次一件"', async () => {
    const tool = await createDeliverFileTool(bed.ctx)
    const description = String((tool as unknown as { description?: unknown }).description ?? '')

    // ① 交付的是原文件本身（不复制、不移动、不清理源文件）
    expect(description).toContain('the original file in place')
    expect(description).toContain('cleans up nothing')
    // ② 中间产物不进交付（技能层同一口径，这里是防"绕过技能时乱交"的那一道）
    expect(description).toContain('page-image directories')
    expect(description).toContain('check records')
    // ③ 单次上界
    expect(description).toContain('One file per call')
  })
})

describe('deliver_file：读档（免审批）', () => {
  it('分类表里是 read 档：ask 工作区上也不弹审批', async () => {
    expect(classifyToolCall('deliver_file', { path: 'a.txt' })).toBe('read')

    const tool = await createDeliverFileTool(bed.ctx)
    const gate = gateOf(tool)
    expect(gate({ path: 'a.txt' })).toBe(false)
    // 越界目标同样不问：执行层会 fail closed（批了也不执行的卡是噪音）
    expect(gate({ path: '../outside/secret.txt' })).toBe(false)
  })

  it('工作区设 full 也照旧免审（不是"靠 full 才放行"）', async () => {
    bed.roots[0] = { ...bed.roots[0], mode: 'full' }
    const tool = await createDeliverFileTool(bed.ctx)

    expect(gateOf(tool)({ path: 'a.txt' })).toBe(false)
  })
})
