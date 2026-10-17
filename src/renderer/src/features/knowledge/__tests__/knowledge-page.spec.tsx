import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import type { KnowledgeDoc } from '@shared/knowledge'
import { KnowledgePage } from '../KnowledgePage'
import { resetKnowledgeStore } from '../knowledge-store'

/**
 * 知识库页（M5-B）：数据全走 `window.kyclaw.knowledge`（这里用测试桩），页面只负责
 * 列表/选中/搜索/重命名/删除确认/错误/窄窗。磁盘与导入规则在主进程测试里钉（knowledge-store.spec）。
 */
let bridge: KyclawBridgeStubs

function docFixture(patch: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: '00000000-0000-4000-8000-00000000000a',
    title: '会议纪要.md',
    originalPath: 'C:\\资料\\会议纪要.md',
    size: 2048,
    ext: 'txt',
    addedAt: '2026-10-18T01:00:00.000Z',
    updatedAt: '2026-10-18T01:00:00.000Z',
    charCount: 12,
    excerpt: '会议纪要摘要',
    ...patch
  }
}

beforeEach(() => {
  resetKnowledgeStore()
  bridge = installKyclawBridge()
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true })
})

afterEach(() => {
  clearKyclawBridge()
  resetKnowledgeStore()
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
})

describe('知识库：空态与导入', () => {
  it('空库：右区给衬线一句话 + 说明 + 实物动作「导入资料」，左列有列表空话', async () => {
    render(<KnowledgePage />)

    expect(await screen.findByTestId('knowledge-empty')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-page-title')).toHaveTextContent('知识库')
    expect(screen.getByTestId('knowledge-empty')).toHaveTextContent('把读过的资料收进一个地方')
    expect(screen.getByTestId('knowledge-empty-import')).toHaveTextContent('导入资料')
    expect(screen.getByTestId('knowledge-list-empty')).toHaveTextContent('还没有资料')
    expect(bridge.knowledge.list).toHaveBeenCalled()
  })

  it('导入：成功后列表出现、自动选中并读正文；跳过项如实展示原因', async () => {
    const imported = docFixture()
    bridge.knowledge.import.mockResolvedValue({
      documents: [imported],
      skipped: [{ name: 'blob.exe', reason: '不支持的格式（v1 只收文本类）' }]
    })
    bridge.knowledge.list
      .mockResolvedValueOnce({ documents: [] })
      .mockResolvedValue({ documents: [imported] })
    bridge.knowledge.readText.mockResolvedValue({ text: '会议正文', truncated: false })

    render(<KnowledgePage />)
    await screen.findByTestId('knowledge-empty')
    fireEvent.click(screen.getByTestId('knowledge-import'))

    expect(await screen.findByTestId('knowledge-item')).toHaveTextContent('会议纪要.md')
    expect(bridge.knowledge.import).toHaveBeenCalledTimes(1)
    expect(bridge.knowledge.readText).toHaveBeenCalledWith(imported.id)
    expect(await screen.findByTestId('knowledge-detail-title')).toHaveTextContent('会议纪要.md')
    expect(await screen.findByTestId('knowledge-text')).toHaveTextContent('会议正文')
    // 导入结果里被跳过的文件有原因（不静默吞）
    expect(screen.getByTestId('knowledge-skipped')).toHaveTextContent('blob.exe')
    expect(screen.getByTestId('knowledge-skipped')).toHaveTextContent('不支持的格式')
    // 关掉提示
    fireEvent.click(screen.getByTestId('knowledge-skipped-dismiss'))
    expect(screen.queryByTestId('knowledge-skipped')).not.toBeInTheDocument()
  })
})

describe('知识库：列表 / 选中 / 搜索', () => {
  it('点列表项切换详情：读对应 id 的正文，元信息显示来源路径与大小', async () => {
    const first = docFixture({ id: '00000000-0000-4000-8000-000000000001', title: '第一篇.txt' })
    const second = docFixture({
      id: '00000000-0000-4000-8000-000000000002',
      title: '第二篇.md',
      originalPath: 'C:\\资料\\第二篇.md',
      ext: 'md'
    })
    bridge.knowledge.list.mockResolvedValue({ documents: [first, second] })
    bridge.knowledge.readText.mockImplementation(async (id) => ({
      text: `正文-${id}`,
      truncated: false
    }))

    render(<KnowledgePage />)
    const items = await screen.findAllByTestId('knowledge-item')
    expect(items).toHaveLength(2)
    // 默认选中第一篇
    await waitFor(() => expect(bridge.knowledge.readText).toHaveBeenCalledWith(first.id))
    fireEvent.click(items[1])
    await waitFor(() => expect(bridge.knowledge.readText).toHaveBeenCalledWith(second.id))
    expect(await screen.findByTestId('knowledge-detail-title')).toHaveTextContent('第二篇.md')
    expect(screen.getByTestId('knowledge-source-path')).toHaveTextContent('C:\\资料\\第二篇.md')
    expect(screen.getByTestId('knowledge-detail')).toHaveAttribute('data-document-id', second.id)
  })

  it('搜索：输入 200ms 防抖后走主进程 search，命中列表点进去即选中', async () => {
    const doc = docFixture({ id: '00000000-0000-4000-8000-000000000003' })
    bridge.knowledge.list.mockResolvedValue({ documents: [doc] })
    bridge.knowledge.readText.mockResolvedValue({ text: '会议正文', truncated: false })
    bridge.knowledge.search.mockResolvedValue({
      hits: [{ id: doc.id, title: doc.title, snippet: '…关键词上下文…' }]
    })

    render(<KnowledgePage />)
    await screen.findByTestId('knowledge-item')

    fireEvent.change(screen.getByTestId('knowledge-search'), { target: { value: '关键词' } })
    await waitFor(() => expect(bridge.knowledge.search).toHaveBeenCalledWith('关键词'), {
      timeout: 2_000
    })
    const hit = await screen.findByTestId('knowledge-hit')
    expect(hit).toHaveTextContent('会议纪要.md')
    expect(hit).toHaveTextContent('关键词上下文')
    fireEvent.click(hit)
    await waitFor(() => expect(bridge.knowledge.readText).toHaveBeenCalledWith(doc.id))

    // 清空搜索回到全量列表
    fireEvent.change(screen.getByTestId('knowledge-search'), { target: { value: '' } })
    expect(await screen.findByTestId('knowledge-list')).toBeInTheDocument()
  })
})

describe('知识库：重命名 / 删除 / 错误', () => {
  it('重命名：点笔图标 → 输入新标题提交 → 调 rename 并更新标题', async () => {
    const doc = docFixture({ id: '00000000-0000-4000-8000-000000000004' })
    bridge.knowledge.list.mockResolvedValue({ documents: [doc] })
    bridge.knowledge.readText.mockResolvedValue({ text: '正文', truncated: false })
    bridge.knowledge.rename.mockResolvedValue({ document: { ...doc, title: '新标题' } })

    render(<KnowledgePage />)
    await screen.findByTestId('knowledge-detail-title')
    fireEvent.click(screen.getByTestId('knowledge-rename-button'))
    const input = screen.getByTestId('knowledge-rename-input')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(bridge.knowledge.rename).toHaveBeenCalledWith(doc.id, '新标题'))
    expect(await screen.findByTestId('knowledge-detail-title')).toHaveTextContent('新标题')
    expect(screen.getByTestId('knowledge-item')).toHaveTextContent('新标题')
  })

  it('删除：先确认弹窗，确认后调 remove、列表移除并回到空态', async () => {
    const doc = docFixture({ id: '00000000-0000-4000-8000-000000000005' })
    bridge.knowledge.list.mockResolvedValue({ documents: [doc] })
    bridge.knowledge.readText.mockResolvedValue({ text: '正文', truncated: false })
    bridge.knowledge.remove.mockResolvedValue({ ok: true })

    render(<KnowledgePage />)
    await screen.findByTestId('knowledge-detail-title')
    fireEvent.click(screen.getByTestId('knowledge-delete'))

    // 破坏性文案按章程：确认弹窗里说清"原文件不受影响"
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('删除这份资料？')
    expect(dialog).toHaveTextContent('原文件不受影响')
    fireEvent.click(within(dialog).getByTestId('knowledge-delete-confirm'))

    await waitFor(() => expect(bridge.knowledge.remove).toHaveBeenCalledWith(doc.id))
    expect(await screen.findByTestId('knowledge-empty')).toBeInTheDocument()
  })

  it('读列表失败：给错误条（人话）并可关闭', async () => {
    bridge.knowledge.list.mockRejectedValue(new Error('知识库目录读不了'))
    render(<KnowledgePage />)

    const error = await screen.findByTestId('knowledge-error')
    expect(error).toHaveTextContent('知识库目录读不了')
    fireEvent.click(screen.getByTestId('knowledge-error-dismiss'))
    expect(screen.queryByTestId('knowledge-error')).not.toBeInTheDocument()
  })

  it('「打开数据文件夹」走主进程（渲染端传不了路径）', async () => {
    render(<KnowledgePage />)
    await screen.findByTestId('knowledge-empty')
    fireEvent.click(screen.getByTestId('knowledge-open-folder'))
    await waitFor(() => expect(bridge.knowledge.openFolder).toHaveBeenCalledTimes(1))
  })
})

describe('知识库：窄窗（<900）列表替换式', () => {
  it('窄窗下选中后显示详情、列表隐藏；「返回列表」回到列表', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 720, configurable: true })
    const doc = docFixture({ id: '00000000-0000-4000-8000-000000000006' })
    bridge.knowledge.list.mockResolvedValue({ documents: [doc] })
    bridge.knowledge.readText.mockResolvedValue({ text: '正文', truncated: false })

    render(<KnowledgePage />)
    // 默认选中第一篇 → 窄窗直接进详情
    expect(await screen.findByTestId('knowledge-detail-title')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-list-aside')).not.toBeVisible()

    fireEvent.click(screen.getByTestId('knowledge-back'))
    expect(screen.getByTestId('knowledge-list-aside')).toBeVisible()
    expect(screen.getByTestId('knowledge-detail-area')).not.toBeVisible()
  })

  it('窄窗空库：列表空话可见、详情区（空态）隐藏', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 720, configurable: true })
    render(<KnowledgePage />)
    expect(await screen.findByTestId('knowledge-list-empty')).toBeVisible()
    expect(screen.getByTestId('knowledge-detail-area')).not.toBeVisible()
  })
})
