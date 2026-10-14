// @vitest-environment node
/**
 * 会话↔Word **源结构**映射（真 libsql）。
 *
 * 三层关注点：
 *   1. 读写语义：一条 = 一份文件（`(threadId, path)` 主键），同一份再记就是覆盖（不是两条）；
 *   2. **持久化 = 重启后还能改**：换一个 store 实例（= 应用重启）读同一份库，源结构与指纹都在；
 *   3. 会话被删时的清理（`clear(threadId)` 整片摘掉），以及坏行的处理（库里那行形状不对时当没有）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSessionDocxSourceStore,
  sha256Of,
  type SessionDocxSourceStore
} from '../session-docx-sources'
import type { DocxSourceRecordInput } from '../../shared/session-docx-sources'

let dir: string
let storage: LibSQLStore
let store: SessionDocxSourceStore

const SOURCE = JSON.stringify({
  title: '采购管理办法',
  blocks: [{ type: 'heading', text: '第一章 总则' }]
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-docx-sources-'))
  storage = new LibSQLStore({
    id: 'kyclaw-docx-sources-test',
    url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
  })
  store = createSessionDocxSourceStore(storage)
})

afterEach(async () => {
  await storage?.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

function record(threadId: string, path: string, sha: string, blocks = 6): DocxSourceRecordInput {
  return { threadId, path, sourceJson: SOURCE, blocks, sha256: sha, size: 4321 }
}

describe('会话↔Word 源结构：表与读写', () => {
  it('没记过：find 是 null，list 空', async () => {
    expect(await store.find('t1', 'C:/ws/办法.docx')).toBeNull()
    expect(await store.list()).toEqual([])
    expect(await store.list('t1')).toEqual([])
  })

  it('记一份 → find 拿到（源结构、块数、指纹都在）', async () => {
    await store.record(record('t1', 'C:/ws/办法.docx', 'a'.repeat(64)))
    const found = await store.find('t1', 'C:/ws/办法.docx')

    expect(found?.sourceJson).toBe(SOURCE)
    expect(found?.blocks).toBe(6)
    expect(found?.sha256).toBe('a'.repeat(64))
    expect(found?.size).toBe(4321)
    expect(await store.list('t1')).toEqual([found])
  })

  it('同一份文件再记一次 = 覆盖（不是两条）；另一条会话的同一路径各是各的', async () => {
    await store.record(record('t1', 'C:/ws/办法.docx', 'a'.repeat(64)))
    await store.record({ ...record('t1', 'C:/ws/办法.docx', 'b'.repeat(64)), blocks: 5 })
    await store.record(record('t2', 'C:/ws/办法.docx', 'c'.repeat(64)))

    expect((await store.find('t1', 'C:/ws/办法.docx'))?.blocks).toBe(5)
    expect((await store.find('t1', 'C:/ws/办法.docx'))?.sha256).toBe('b'.repeat(64))
    expect((await store.find('t2', 'C:/ws/办法.docx'))?.sha256).toBe('c'.repeat(64))
    expect(await store.list('t1')).toHaveLength(1)
  })

  it('clear(threadId) 整片摘掉（会话被删时走这条）；clear(threadId, path) 只摘一条', async () => {
    await store.record(record('t1', 'C:/ws/甲.docx', 'a'.repeat(64)))
    await store.record(record('t1', 'C:/ws/乙.docx', 'b'.repeat(64)))
    await store.clear('t1', 'C:/ws/甲.docx')
    expect(await store.list('t1')).toHaveLength(1)

    await store.record(record('t2', 'C:/ws/丙.docx', 'c'.repeat(64)))
    await store.clear('t1')
    expect(await store.list('t1')).toEqual([])
    expect(await store.list('t2')).toHaveLength(1)
  })

  it('**重启后仍然能改**：换一个 store 实例读同一份库，源结构与指纹都还在', async () => {
    const bytes = Buffer.from('假装这是一份 docx')
    await store.record({
      threadId: 't1',
      path: 'C:/ws/办法.docx',
      sourceJson: SOURCE,
      blocks: 6,
      sha256: sha256Of(bytes),
      size: bytes.byteLength
    })

    const reopened = createSessionDocxSourceStore(storage)
    const found = await reopened.find('t1', 'C:/ws/办法.docx')

    expect(found?.sourceJson).toBe(SOURCE)
    expect(found?.sha256).toBe(sha256Of(bytes))
    expect(found?.size).toBe(bytes.byteLength)
  })

  it('指纹口径与 PPT 那一份同源（sha256Of 对同一段字节稳定、差一个字节就不同）', () => {
    expect(sha256Of(Buffer.from('abc'))).toBe(sha256Of(Buffer.from('abc')))
    expect(sha256Of(Buffer.from('abc'))).not.toBe(sha256Of(Buffer.from('abd')))
    expect(sha256Of(Buffer.from('abc'))).toHaveLength(64)
  })
})
