// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

/**
 * 附件通道的 handler（模块 2）：入参先过闸门（真 Uint8Array），再交给主进程的 PDF 抽取。
 * 与其它 ipc spec 同一套 mock 方式（假 ipcMain）；抽取本体是**真的**（走真 pdfjs + 自造 fixture），
 * 所以这里验的是"过桥那一层没把字节弄丢、回包形状对、坏入参真的被挡"。
 * 用 node 环境：jsdom 的 Realm 与 Node 不是同一个 Uint8Array 构造器，`instanceof` 会假阴性
 * （真应用里主进程收到的是结构化克隆出来的**本 realm** 的 Uint8Array，没有这个问题）。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return { handlers: new Map<string, Handler>() }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { buildPdf } from '../../__tests__/pdf-fixture'
import { registerAttachmentsIpc } from '../attachments'

const EVENT = { sender: { id: 1 } }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

registerAttachmentsIpc()

describe('attachments:extract-pdf', () => {
  it('真字节过桥 → 抽到带页码标记的文本与页数', async () => {
    const handler = handlerOf(IPC_CHANNELS.attachments.extractPdf)
    const result = (await handler(EVENT, buildPdf([['Hello from IPC']]))) as {
      ok: boolean
      text?: string
      pages?: number
    }

    expect(result.ok).toBe(true)
    expect(result.pages).toBe(1)
    expect(result.text).toContain('【第 1 页】')
    expect(result.text).toContain('Hello from IPC')
  })

  it('扫描件（没有文字层）→ ok:false + 人话（不抛）', async () => {
    const handler = handlerOf(IPC_CHANNELS.attachments.extractPdf)
    const result = (await handler(EVENT, buildPdf([[]]))) as { ok: boolean; message?: string }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有文字层')
  })

  it('坏入参（不是 Uint8Array）→ 被闸门挡下（IpcInputError，不静默）', () => {
    const handler = handlerOf(IPC_CHANNELS.attachments.extractPdf)
    expect(() => handler(EVENT, 'not-bytes')).toThrow(IpcInputError)
    expect(() => handler(EVENT)).toThrow(IpcInputError)
  })
})
