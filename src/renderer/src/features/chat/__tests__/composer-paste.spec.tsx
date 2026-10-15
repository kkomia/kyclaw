import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'

/**
 * 粘贴入口与图片磁贴（round 50，用户口径 + Kimi 实拍）：
 *   - 粘贴 = 第三条件附件入口，与拖拽 / ＋ 上传共用**同一条 pickFiles**（限额、vision=false 人话
 *     拒收、PDF 抽取同一套）；没有文件 = 纯文本粘贴，不拦截；
 *   - 图片在附件条上画成 64px 磁贴：多张时右下角数字徽章、hover 出「删除 / @ 提及」、点空白放大预览；
 *   - @ 提及只往输入里插一段可 chip 化的引用文字（`【引用】图片：图N`），图片本体仍在附件里真发。
 *
 * 合成粘贴：jsdom 没有 ClipboardEvent / DataTransfer，但 @testing-library 的 createEvent
 * 会把 init 里的 clipboardData 原样挂到事件上（React 读的正是 nativeEvent.clipboardData），
 * 派发到 textarea 就是真 handler 路径。
 */
function settingsWithVision(vision: boolean): AppSettings {
  return {
    ...defaultSettings(),
    providers: [
      {
        id: 'p1',
        type: 'openai-compatible',
        model: 'my-vision-model',
        isDefault: true,
        baseUrl: 'http://x/v1'
      }
    ],
    // round 48：视觉能力由探测结论说了算（`<providerId>:<model>`），没有手动开关
    probedModels: vision ? { 'p1:my-vision-model': { vision: true } } : {}
  }
}

function mount(vision = true): {
  onSend: ReturnType<typeof vi.fn>
  bridge: KyclawBridgeStubs
} {
  const initial = settingsWithVision(vision)
  const bridge = installKyclawBridge(initial)
  useSettingsStore.setState({ settings: initial, loaded: true })
  const onSend = vi.fn()
  render(<Composer onSend={onSend} onStop={vi.fn()} />)
  return { onSend, bridge }
}

afterEach(() => {
  cleanup()
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

function png(name: string, bytes = 'png-bytes', lastModified = 1_700_000_000_000): File {
  return new File([bytes], name, { type: 'image/png', lastModified })
}

/** 剪贴板形状（真实 DataTransfer 的最小子集 / 平台各填一处的两种情况都要能喂） */
interface FakeClipboard {
  files?: File[]
  items?: Array<{ kind: string; getAsFile: () => File | null }>
  text?: string
}

/**
 * 在输入框上合成一次粘贴。返回值 `canceled = true` = 处理器 preventDefault 了（文件被收下走
 * 附件管线）；`false` = 没拦截（纯文本保持默认行为）。
 */
function paste(data: FakeClipboard): { canceled: boolean } {
  const input = screen.getByTestId('composer-input')
  const files = data.files ?? []
  const dispatched = fireEvent.paste(input, {
    clipboardData: {
      files,
      items: data.items ?? files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      getData: () => data.text ?? ''
    }
  })
  return { canceled: dispatched === false }
}

/** 发送载荷（模块 2 起 onSend 收 `{ text, files }`） */
function sentPayload(
  onSend: ReturnType<typeof vi.fn>,
  call = 0
): { text: string; files: Array<{ mediaType: string; url: string; filename?: string }> } {
  const payload = onSend.mock.calls[call]?.[0] as
    | { text?: string; files?: Array<{ mediaType: string; url: string; filename?: string }> }
    | undefined
  return { text: payload?.text ?? '', files: payload?.files ?? [] }
}

describe('round 50 · 粘贴入口（截图贴图 / 资源管理器贴文件 → 同一条 pickFiles）', () => {
  it('粘贴图片：进附件条、渲染磁贴；事件被拦下（不让默认行为再插一遍）', async () => {
    mount()

    const { canceled } = paste({ files: [png('shot.png')] })

    expect(canceled).toBe(true)
    const tile = await screen.findByTestId('composer-attachment-shot.png')
    expect(tile).toHaveAttribute('data-image-tile', 'true')
    expect(screen.getByTestId('composer-attachment-thumb-shot.png')).toBeInTheDocument()
  })

  it('vision=false：粘贴图片照样人话拒收（与 pickFiles 同款），不假装收下', async () => {
    mount(false)

    paste({ files: [png('shot.png')] })

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '未附加：shot.png（已自动检测：当前模型不支持看图）'
      )
    )
    expect(screen.queryByTestId('composer-attachment-shot.png')).not.toBeInTheDocument()
  })

  it('纯文本粘贴：不拦截（保持默认行为），也不产生附件', async () => {
    mount()

    const { canceled } = paste({ files: [], items: [], text: '只是一段文字' })

    expect(canceled).toBe(false)
    expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-notice')).not.toBeInTheDocument()
  })

  it('一次多个文件：全部进（按现有上限各自处置），拒收的给一句人话', async () => {
    mount()

    paste({
      files: [
        png('a.png'),
        new File(['文本内容'], 'note.txt', { type: 'text/plain' }),
        new File(['x'], 'archive.zip', { type: 'application/zip' })
      ]
    })

    // 两张图（一张走磁贴、一张文本走 chip）+ 一个拒收
    expect(await screen.findByTestId('composer-attachment-a.png')).toBeInTheDocument()
    expect(screen.getByTestId('composer-attachment-note.txt')).toBeInTheDocument()
    expect(screen.getAllByTestId('composer-image-preview-open')).toHaveLength(1)
    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '未附加：archive.zip（不是文本文件）'
      )
    )
  })

  it('文件只挂在 items 上（某些平台/来源如此）：kind === file 的照样取到', async () => {
    mount()

    paste({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => png('item.png') }
      ]
    })

    expect(await screen.findByTestId('composer-attachment-item.png')).toBeInTheDocument()
  })

  it('同一个文件同时出现在 files 与 items：只收一份（不重复）', async () => {
    mount()
    const file = png('once.png')

    paste({ files: [file], items: [{ kind: 'file', getAsFile: () => file }] })

    await screen.findByTestId('composer-attachment-once.png')
    expect(screen.getAllByTestId('composer-image-preview-open')).toHaveLength(1)
  })

  /**
   * round 85（用户实报 011「同一张图片被粘贴两次，得手动删掉多一份」）：**两条路给的不是同一个
   * File 对象**时也要只收一份。
   *
   * 上面那条用例里 `files[0]` 与 `items[0].getAsFile()` 返回的是同一个对象，靠"名字+大小+类型+
   * lastModified"当指纹去重就够。真机上不成立：`clipboardData.files` 与 `items[i].getAsFile()`
   * 各自构造一份 File，元数据不保证逐字相等（截图工具贴图时 lastModified 就对不上），指纹一碰
   * 就漏 —— 同一次粘贴于是入队两张。
   */
  it('同一份内容在 files 与 items 上是两个 File（元数据不同）：仍只收一份', async () => {
    mount()
    const fromFiles = png('once.png', 'png-bytes', 1_700_000_000_000)
    const fromItems = png('once.png', 'png-bytes', 1_700_000_000_999)

    paste({ files: [fromFiles], items: [{ kind: 'file', getAsFile: () => fromItems }] })

    await screen.findByTestId('composer-attachment-once.png')
    expect(screen.getAllByTestId('composer-image-preview-open')).toHaveLength(1)
  })

  it('真的粘了两张不同的图（两条 items，没有 files）：两张都收，不去重过头', async () => {
    mount()

    paste({
      files: [],
      items: [
        { kind: 'file', getAsFile: () => png('first.png', 'first-bytes') },
        { kind: 'file', getAsFile: () => png('second.png', 'second-bytes') }
      ]
    })

    expect(await screen.findByTestId('composer-attachment-first.png')).toBeInTheDocument()
    expect(screen.getByTestId('composer-attachment-second.png')).toBeInTheDocument()
    expect(screen.getAllByTestId('composer-image-preview-open')).toHaveLength(2)
  })

  /**
   * 011：去重**只活在一次粘贴之内**（防的是同一次粘贴里 `files` 与 `items` 各给一份）。
   * 隔了次数的两次独立粘贴是两次不同的用户意图 —— 同一张再贴一次就该有两份，
   * 不能被"内容相同"吞掉第二份。
   */
  it('隔次独立粘贴同一张图：两份都在（去重不跨次，序号 1 / 2）', async () => {
    mount()

    paste({ files: [png('same.png')] })
    await screen.findByTestId('composer-attachment-same.png')
    paste({ files: [png('same.png')] })

    await waitFor(() =>
      expect(screen.getAllByTestId('composer-attachment-same.png')).toHaveLength(2)
    )
    expect(screen.getAllByTestId('composer-image-preview-open')).toHaveLength(2)
    const badges = screen.getAllByTestId('composer-image-badge')
    expect(badges.map((badge) => badge.textContent)).toEqual(['1', '2'])
  })
})

describe('round 50 · 图片磁贴（Kimi 风：徽章 / hover 操作层 / 删除）', () => {
  it('单张：64px 圆角磁贴 + object-cover 缩略图；右下角序号徽章「1」', async () => {
    mount()
    paste({ files: [png('solo.png')] })

    const tile = await screen.findByTestId('composer-attachment-solo.png')
    expect(tile).toHaveClass(
      'size-16',
      'rounded-control',
      'overflow-hidden',
      'border-surface-border'
    )
    expect(screen.getByTestId('composer-attachment-thumb-solo.png')).toHaveClass(
      'size-full',
      'object-cover'
    )
    // 序号徽章始终在（它就是「提及图片 N」的可见图例）
    expect(screen.getByTestId('composer-image-badge')).toHaveTextContent('1')
  })

  it('多张：右下角数字徽章 1 / 2（照 Kimi 观感）', async () => {
    mount()
    paste({ files: [png('one.png'), png('two.png')] })

    await screen.findByTestId('composer-attachment-one.png')
    const badges = screen.getAllByTestId('composer-image-badge')
    expect(badges.map((badge) => badge.textContent)).toEqual(['1', '2'])
    expect(badges[0]).toHaveClass('absolute', 'right-1', 'bottom-1', 'rounded-pill')
  })

  it('hover 才出操作层：遮罩常驻 DOM 但 opacity 0，hover / 聚焦过渡到 1（不硬切）', async () => {
    mount()
    paste({ files: [png('hover.png')] })
    await screen.findByTestId('composer-attachment-hover.png')

    const overlay = screen.getByTestId('composer-image-overlay')
    expect(overlay).toHaveClass(
      'bg-mask',
      'opacity-0',
      'group-hover:opacity-100',
      'group-focus-within:opacity-100',
      'transition-opacity'
    )
    // 两个图标钮：删除（Trash2）与 @ 提及（AtSign）；可访问名带序号
    const remove = screen.getByTestId('composer-image-remove')
    const mention = screen.getByTestId('composer-image-mention')
    expect(remove).toHaveAccessibleName('删除图片 1')
    expect(mention).toHaveAccessibleName('提及图片 1')
    expect(remove.querySelector('svg')?.getAttribute('class')).toContain('lucide-trash-2')
    expect(mention.querySelector('svg')?.getAttribute('class')).toContain('lucide-at-sign')
  })

  it('点删除：从附件条移除（与现有删除口径一致）', async () => {
    mount()
    paste({ files: [png('gone.png')] })
    await screen.findByTestId('composer-attachment-gone.png')

    fireEvent.click(screen.getByTestId('composer-image-remove'))

    expect(screen.queryByTestId('composer-attachment-gone.png')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument()
  })

  it('非图片文件仍是原样的文字 chip（不误画成磁贴）', async () => {
    mount()
    paste({ files: [new File(['内容'], 'note.txt', { type: 'text/plain' })] })

    const chip = await screen.findByTestId('composer-attachment-note.txt')
    expect(chip).not.toHaveAttribute('data-image-tile')
    expect(chip).toHaveClass('rounded-pill')
    expect(screen.queryByTestId('composer-image-overlay')).not.toBeInTheDocument()
  })
})

describe('round 50 · @ 提及（插引用文字，图片本体仍在附件里）', () => {
  it('点 @：把「图片：图N」引用插进输入框并 chip 化；发送时图片照旧走 file part', async () => {
    const { onSend } = mount()
    paste({ files: [png('one.png'), png('two.png')] })
    await screen.findByTestId('composer-attachment-one.png')

    fireEvent.click(screen.getAllByTestId('composer-image-mention')[1] as HTMLElement)

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    expect(input).toHaveValue('【引用】图片：图2 ')
    // 光标落在标记后面、焦点回输入框（既有 chip 逻辑）
    expect(input.selectionStart).toBe('【引用】图片：图2 '.length)
    expect(document.activeElement).toBe(input)
    // chip 覆盖层照常画出来（新增的图片 kind 可被解析）
    const chip = screen.getByTestId('composer-ref-chip')
    expect(chip).toHaveTextContent('图片：图2')
    expect(chip).not.toHaveTextContent('【引用】')

    // 图片本体没被提及顶掉，仍在附件里
    expect(screen.getAllByTestId('composer-image-preview-open')).toHaveLength(2)

    fireEvent.keyDown(input, { key: 'Enter' })
    const payload = sentPayload(onSend)
    expect(payload.text).toBe('【引用】图片：图2')
    expect(payload.files).toHaveLength(2)
    expect(payload.files.map((file) => file.filename)).toEqual(['one.png', 'two.png'])
  })

  it('提及插在光标处（不是顶格也不丢前文），光标停在新标记后面', async () => {
    mount()
    paste({ files: [png('mine.png')] })
    await screen.findByTestId('composer-attachment-mine.png')

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '看看这个' } })
    input.setSelectionRange(2, 2)
    fireEvent.select(input)

    fireEvent.click(screen.getByTestId('composer-image-mention'))

    expect(input).toHaveValue('看看【引用】图片：图1 这个')
    expect(input.selectionStart).toBe('看看【引用】图片：图1 '.length)
    expect(document.activeElement).toBe(input)
  })

  it('删除图片后重新编号：剩下的那张成为 1（徽章与提及同源）', async () => {
    mount()
    paste({ files: [png('one.png'), png('two.png')] })
    await screen.findByTestId('composer-attachment-one.png')

    fireEvent.click(screen.getAllByTestId('composer-image-remove')[0] as HTMLElement)

    const badges = screen.getAllByTestId('composer-image-badge')
    expect(badges.map((badge) => badge.textContent)).toEqual(['1'])
    expect(screen.getByTestId('composer-image-mention')).toHaveAccessibleName('提及图片 1')
  })
})

describe('round 50 · 点磁贴放大预览（lightbox）', () => {
  it('点磁贴空白处开预览：全屏遮罩 + 居中 contain；点遮罩空白关、Esc 关；右键不吃原生菜单', async () => {
    mount()
    paste({ files: [png('view.png')] })
    await screen.findByTestId('composer-attachment-view.png')
    expect(screen.queryByTestId('composer-image-lightbox')).not.toBeInTheDocument()

    // 点缩略图（磁贴的"空白处"= 预览钮本体）
    fireEvent.click(screen.getByTestId('composer-attachment-thumb-view.png'))

    const lightbox = screen.getByTestId('composer-image-lightbox')
    expect(lightbox).toHaveClass('fixed', 'inset-0', 'z-50')
    const img = screen.getByTestId('composer-image-lightbox-img')
    expect(img).toHaveClass('max-h-[85vh]', 'max-w-[90vw]', 'object-contain')
    expect(img.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true)
    // 原生右键菜单被拦掉（雷点 4）
    expect(fireEvent.contextMenu(img)).toBe(false)

    // Esc 关（Radix 的 dismissable layer）
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('composer-image-lightbox')).not.toBeInTheDocument()
    )

    // 再开一次：点遮罩空白（= 居中容器自己）关
    fireEvent.click(screen.getByTestId('composer-attachment-thumb-view.png'))
    fireEvent.click(screen.getByTestId('composer-image-lightbox'))
    await waitFor(() =>
      expect(screen.queryByTestId('composer-image-lightbox')).not.toBeInTheDocument()
    )
  })

  it('多张时各开各的：点第二张预览的是第二张的图', async () => {
    mount()
    paste({ files: [png('first.png', 'first-bytes'), png('second.png', 'second-bytes')] })
    await screen.findByTestId('composer-attachment-first.png')

    const second = screen.getByTestId('composer-attachment-thumb-second.png')
    fireEvent.click(second)

    const img = screen.getByTestId('composer-image-lightbox-img')
    expect(img.getAttribute('src')).toBe(second.getAttribute('src'))
    // 预览里的图是第二张（data URL 与第一张不同）
    const first = screen.getByTestId('composer-attachment-thumb-first.png')
    expect(img.getAttribute('src')).not.toBe(first.getAttribute('src'))
    expect(within(screen.getByTestId('composer-image-lightbox')).getByAltText('second.png')).toBe(
      img
    )
  })
})
