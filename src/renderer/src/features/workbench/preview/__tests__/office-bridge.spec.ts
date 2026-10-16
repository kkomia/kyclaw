import { describe, expect, it, vi } from 'vitest'
import { isAbortError } from '../dsh-document/errors'
import {
  describeOfficeFailure,
  officeLoadFor,
  OfficePreviewFailure,
  type OfficeBridge
} from '../dsh-document/office-bridge'

/** 一份"转好了"的回包（字节内容是 PDF 头，够证明是原样递下来的）。 */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])

/** 只造转换真正用到的那两个方法（真签名来自 `shared/ipc.ts` 的 Pick）。 */
function bridge(overrides: Partial<OfficeBridge> = {}): OfficeBridge {
  return {
    officePdf: vi.fn(async (_threadId, relative) => ({
      kind: 'pdf' as const,
      path: relative,
      version: 'v1',
      pdf: PDF_BYTES,
      size: PDF_BYTES.byteLength,
      missingFonts: [],
      generation: 'g1'
    })),
    cancelOfficePdf: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('officeLoadFor：转换口', () => {
  it('发起时带上会话、相对路径、调度意图与一个新的 requestId', async () => {
    const workbench = bridge()
    const handle = officeLoadFor(workbench, 'thread-1', '方案.docx')

    const result = await handle.load(new AbortController().signal)

    expect(workbench.officePdf).toHaveBeenCalledTimes(1)
    const [threadId, relative, priority, requestId] = vi.mocked(workbench.officePdf).mock
      .calls[0] as [string, string, string, string]
    expect([threadId, relative, priority]).toEqual(['thread-1', '方案.docx', 'foreground'])
    expect(requestId).toBeTypeOf('string')
    expect(requestId.length).toBeGreaterThan(0)
    expect(result).toEqual({ bytes: PDF_BYTES, missingFonts: [] })
    // 没取消：一条 cancel 都不该发
    expect(workbench.cancelOfficePdf).not.toHaveBeenCalled()
  })

  it('每次发起一个新的 requestId；代次一次一换（宿主重读即重转）', async () => {
    const workbench = bridge()
    const first = officeLoadFor(workbench, 'thread-1', '方案.docx')
    const second = officeLoadFor(workbench, 'thread-1', '方案.docx')

    expect(second.revision).toBeGreaterThan(first.revision)

    await first.load(new AbortController().signal)
    await second.load(new AbortController().signal)

    const calls = vi.mocked(workbench.officePdf).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[3]).not.toBe(calls[1]?.[3])
  })

  it('缺字体原样递下来（doc/ppt 的空数组也照原样，不替引擎补话）', async () => {
    const workbench = bridge({
      officePdf: vi.fn(async (_threadId, relative) => ({
        kind: 'pdf' as const,
        path: relative,
        version: 'v2',
        pdf: PDF_BYTES,
        size: PDF_BYTES.byteLength,
        missingFonts: ['方正兰亭黑', '思源宋体'],
        generation: 'g1'
      }))
    })

    const result = await officeLoadFor(workbench, 't', 'a.docx').load(new AbortController().signal)

    expect(result).toEqual({ bytes: PDF_BYTES, missingFonts: ['方正兰亭黑', '思源宋体'] })
  })

  it('失败带分类：OfficePreviewFailure 带 code，人话就是主进程给的那句', async () => {
    const workbench = bridge({
      officePdf: vi.fn(async (_threadId, relative) => ({
        kind: 'failed' as const,
        path: relative,
        code: 'busy' as const,
        message: '转换队列满'
      }))
    })

    const error = await officeLoadFor(workbench, 't', 'a.pptx')
      .load(new AbortController().signal)
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(OfficePreviewFailure)
    expect((error as OfficePreviewFailure).code).toBe('busy')
    expect(describeOfficeFailure(error)).toBe('转换队列满（稍等一会儿再试一次）')
  })

  it('取消（主进程回 cancelled）**不当错误**：翻成 AbortError，界面直接丢弃', async () => {
    const workbench = bridge({
      officePdf: vi.fn(async (_threadId, relative) => ({
        kind: 'failed' as const,
        path: relative,
        code: 'cancelled' as const,
        message: '这次转换被取消了'
      }))
    })

    const error = await officeLoadFor(workbench, 't', 'a.doc')
      .load(new AbortController().signal)
      .catch((reason: unknown) => reason)

    expect(isAbortError(error)).toBe(true)
    expect(error).not.toBeInstanceOf(OfficePreviewFailure)
  })

  it('中途取消：真的发 cancelOfficePdf，且用的是这次请求的那个 id', async () => {
    const workbench = bridge({
      // 永不落地的转换：停在"在途"，等我们取消
      officePdf: vi.fn(() => new Promise<never>(() => undefined))
    })
    const controller = new AbortController()
    const handle = officeLoadFor(workbench, 't', '大文档.pptx')

    void handle.load(controller.signal).catch(() => undefined)
    const requestId = vi.mocked(workbench.officePdf).mock.calls[0]?.[3]
    controller.abort()

    expect(workbench.cancelOfficePdf).toHaveBeenCalledTimes(1)
    expect(workbench.cancelOfficePdf).toHaveBeenCalledWith(requestId)
  })

  it('进来就已经取消（面板关了）：不发起转换，只发一条取消，抛 AbortError', async () => {
    const workbench = bridge()
    const controller = new AbortController()
    controller.abort()

    const error = await officeLoadFor(workbench, 't', 'a.docx')
      .load(controller.signal)
      .catch((reason: unknown) => reason)

    expect(workbench.officePdf).not.toHaveBeenCalled()
    expect(workbench.cancelOfficePdf).toHaveBeenCalledTimes(1)
    expect(isAbortError(error)).toBe(true)
  })

  it('取消失败不改结论：cancelOfficePdf 抛错（通道断了）也不会把取消变成崩溃', async () => {
    const workbench = bridge({
      cancelOfficePdf: vi.fn(() => {
        throw new Error('channel gone')
      })
    })
    const controller = new AbortController()
    controller.abort()

    const error = await officeLoadFor(workbench, 't', 'a.docx')
      .load(controller.signal)
      .catch((reason: unknown) => reason)

    expect(isAbortError(error)).toBe(true)
  })
})

describe('describeOfficeFailure：失败人话', () => {
  it('普通失败直接用主进程那句；拿不到信息时给通用句（不吐栈）', () => {
    expect(describeOfficeFailure(new Error('引擎读不出这份文件'))).toBe('引擎读不出这份文件')
    expect(describeOfficeFailure(new Error(''))).toBe('这份文档转不出预览')
    expect(describeOfficeFailure('boom')).toBe('这份文档转不出预览')
  })

  it('"刷新一下"那两类补一句下一步（源变了 / 文件没了）', () => {
    expect(describeOfficeFailure(new OfficePreviewFailure('source-changed', '源文件被改过'))).toBe(
      '源文件被改过（刷新一下文件树再看）'
    )
    expect(describeOfficeFailure(new OfficePreviewFailure('missing', '文件不在了'))).toBe(
      '文件不在了（刷新一下文件树再看）'
    )
  })
})
