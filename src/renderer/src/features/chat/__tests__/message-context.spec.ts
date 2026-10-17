import { describe, expect, it } from 'vitest'
import { composeOutgoing } from '@renderer/features/chat/composer-attachments'
import type { PendingAttachment } from '@renderer/features/chat/composer-attachments'
import {
  appendSegmentOf,
  buildUserMessageMetadata,
  carryOverMessageContext,
  CONTEXT_NAME_MAX_CHARS,
  CONTEXT_SOURCE_MAX_CHARS,
  forgetVerifiedSeals,
  formatSentAt,
  MESSAGE_CONTEXT_KEY,
  MESSAGE_CONTEXT_MAX_BYTES,
  MESSAGE_CONTEXT_VERSION,
  messageContextFits,
  readMessageContext,
  readSentAt,
  rememberVerifiedSeal,
  resolveUserDisplay,
  sameVerificationMaterial,
  sealKeyOf,
  sealSegmentDigests,
  sentAtLabel,
  SENT_AT_KEY,
  sha256Hex,
  SEGMENT_EXCERPT_CHARS,
  verifiedVerdictOf,
  verifySegmentDigests,
  type MessageContext,
  type UserMessageMetadata
} from '@renderer/features/chat/message-context'

/**
 * 006 / 008 的纯逻辑层：展示上下文的组装、严格校验（含长度 / 体量上限）、同步一阶候选、
 * **异步摘要复核（验过才藏）**、内容身份与已通过缓存、编辑重发的沿用、发送时间。
 *
 * 这些都是"metadata ↔ 正文"的对账题：所有用例的正文都走 `composeOutgoing`（真组装），
 * 不是手写的理想串 —— 边界算错在这里红，而不是在界面上"少藏一段"。
 */
function attachment(
  text: string,
  name = 'note.md',
  extra: Partial<PendingAttachment> = {}
): PendingAttachment {
  return { id: `${name}-1`, name, size: text.length, text, ...extra }
}

/** 长到摘录盖不住中段的附件（复核用例要改"中间那一小截"） */
const LONG_BODY = Array.from(
  { length: 40 },
  (_, index) => `第 ${index + 1} 行内容：abcdefghij`
).join('\n')

describe('组装出来的展示上下文（composeOutgoing → append 记录）', () => {
  it('每个追加段一条：段长 / 分隔符 / 头尾摘录；顺序与附件一致', () => {
    const outgoing = composeOutgoing({
      text: '看这两个',
      attachments: [attachment('内容 A', 'a.txt'), attachment('内容 B', 'b.txt')]
    })

    const entries = outgoing.context?.entries ?? []
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(entries.every((entry) => entry.kind === 'file')).toBe(true)
    expect(entries.every((entry) => entry.append !== undefined)).toBe(true)
    expect(entries.map((entry) => entry.append?.join)).toEqual([2, 2])
    // 段的长度与头尾摘录都对着正文里真有的那一截
    const first = entries[0].append
    expect(first).toBeDefined()
    if (first === undefined) return
    const head = `【附件】a.txt\n\`\`\`\n内容 A\n\`\`\``
    expect(first.length).toBe(head.length)
    expect(first.head).toBe(head)
    expect(first.tail).toBe(head)
    expect(outgoing.text).toContain(head)
  })

  it('只有图片（没有追加段）不带 context：metadata 不多占一格', () => {
    const outgoing = composeOutgoing({
      text: '看看',
      attachments: [
        {
          id: 'i1',
          name: 'shot.png',
          size: 3,
          image: { url: 'data:image/png;base64,AAA', mediaType: 'image/png' }
        }
      ]
    })

    expect(outgoing.context).toBeUndefined()
  })

  it('图片与文件混排：图片也记一条（kind=image）但没有 append', () => {
    const outgoing = composeOutgoing({
      text: '',
      attachments: [
        {
          id: 'i1',
          name: 'shot.png',
          size: 3,
          image: { url: 'data:image/png;base64,AAA', mediaType: 'image/png' }
        },
        attachment('正文', 'note.md')
      ]
    })

    const entries = outgoing.context?.entries ?? []
    expect(entries.map((entry) => entry.kind)).toEqual(['image', 'file'])
    expect(entries[0].append).toBeUndefined()
    // 正文为空 → 文件那一块是正文的第一段（前面没有分隔符）
    expect(entries[1].append?.join).toBe(0)
  })

  it('摘选附件的条目带 kind=quote / 行号 / 来源路径', () => {
    const outgoing = composeOutgoing({
      text: '',
      attachments: [
        attachment('选中的两行', 'notes.md', {
          quote: true,
          relative: 'docs/notes.md',
          lines: { start: 3, end: 4 }
        })
      ]
    })

    const entry = outgoing.context?.entries[0]
    expect(entry).toMatchObject({
      kind: 'quote',
      name: 'notes.md',
      source: 'docs/notes.md',
      lines: { start: 3, end: 4 }
    })
    expect(entry?.append).toBeDefined()
  })

  it('路径引用的条目：source 是载荷里的路径（正文抬头就是它）', () => {
    const outgoing = composeOutgoing({
      text: '看看',
      attachments: [
        { id: 'f1', name: 'a.bin', size: 10, path: 'src/a.bin', absolute: 'D:\\ws\\src\\a.bin' }
      ]
    })

    expect(outgoing.context?.entries[0]).toMatchObject({
      kind: 'file',
      name: 'a.bin',
      source: 'src/a.bin',
      absolute: 'D:\\ws\\src\\a.bin'
    })
  })
})

describe('盖章（sealSegmentDigests）与 metadata 体量', () => {
  it('摘要 = 平台 SHA-256（64 位小写 hex），metadata 不含附件正文；两个时间键同值', async () => {
    const outgoing = composeOutgoing({ text: '看', attachments: [attachment(LONG_BODY)] })
    const metadata = await buildUserMessageMetadata({
      at: Date.UTC(2026, 9, 16, 8, 30),
      text: outgoing.text,
      context: outgoing.context
    })

    const sealed = metadata.kyclawContext
    expect(sealed?.entries[0].append?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sealed?.entries[0].append?.sha256).toBe(
      await sha256Hex(outgoing.text.slice(-(sealed?.entries[0].append?.length ?? 0)))
    )

    const serialized = JSON.stringify(metadata)
    // 硬口径：不复制大段正文（摘录之外的中段一个字都不进 metadata；整份 metadata 仍远小于正文）
    expect(serialized).not.toContain('第 20 行内容')
    expect(serialized.length).toBeLessThan(outgoing.text.length)
    expect(sealed?.entries[0].append?.head).toHaveLength(SEGMENT_EXCERPT_CHARS)
    expect(sealed?.entries[0].append?.tail).toHaveLength(SEGMENT_EXCERPT_CHARS)

    const iso = new Date(Date.UTC(2026, 9, 16, 8, 30)).toISOString()
    expect(metadata.createdAt).toBe(iso)
    // 自有键（008 复核）：Mastra 的 v5 路径会剔掉 createdAt，所以精确时刻必须另存一份
    expect(metadata[SENT_AT_KEY]).toBe(iso)
    expect(JSON.parse(serialized)).toHaveProperty(MESSAGE_CONTEXT_KEY)
  })

  it('边界对不上（传错正文）时摘要保持 null：展示侧就不藏', async () => {
    const outgoing = composeOutgoing({ text: '看', attachments: [attachment('内容')] })
    const context = outgoing.context
    expect(context).toBeDefined()
    if (context === undefined) return
    const sealed = await sealSegmentDigests('别的正文', context)
    expect(sealed.entries[0].append?.sha256).toBeNull()
  })

  it('超体量预算：写侧干脆不挂 context（按原文显示），读侧整块不采信', async () => {
    // 20 个长来源的附件：每条的 source 1KB 级 → 序列化后必定越过 16KiB 预算
    const fat = Array.from({ length: 20 }, (_, index) =>
      attachment('内容', `f${index}.txt`, { relative: `docs/${'x'.repeat(1000)}${index}.txt` })
    )
    const outgoing = composeOutgoing({ text: '看', attachments: fat })
    const metadata = await buildUserMessageMetadata({
      at: Date.UTC(2026, 9, 16, 8, 30),
      text: outgoing.text,
      context: outgoing.context
    })

    expect(metadata.kyclawContext).toBeUndefined()
    expect(readMessageContext(metadata)).toBeNull()
    // 直接喂一份超预算的上下文给读侧：同样不采信（预算是**真 UTF-8 字节**，见 MESSAGE_CONTEXT_MAX_BYTES）
    const oversized: MessageContext = {
      v: MESSAGE_CONTEXT_VERSION,
      entries: Array.from({ length: 20 }, (_, index) => ({
        kind: 'file' as const,
        name: `f${index}.txt`,
        size: 1,
        source: 'x'.repeat(CONTEXT_SOURCE_MAX_CHARS)
      }))
    }
    const oversizedBytes = new TextEncoder().encode(JSON.stringify(oversized)).byteLength
    expect(oversizedBytes).toBeGreaterThan(MESSAGE_CONTEXT_MAX_BYTES)
    expect(messageContextFits(oversized)).toBe(false)
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: oversized })).toBeNull()

    // 中文按 UTF-8 三字节算：同样是 20 条、但内容是中文时也该超（若按 String.length 算就不会）
    const chinese: MessageContext = {
      v: MESSAGE_CONTEXT_VERSION,
      entries: Array.from({ length: 20 }, (_, index) => ({
        kind: 'file' as const,
        name: `告${index}.txt`,
        size: 1,
        source: '路'.repeat(400)
      }))
    }
    expect(JSON.stringify(chinese).length).toBeLessThan(MESSAGE_CONTEXT_MAX_BYTES)
    expect(messageContextFits(chinese)).toBe(false)
  })

  it('条目里的长字符串不采信（name / source / absolute 各有上限）', async () => {
    const { metadata } = await sealedFixture('看', [attachment('内容')])
    const good = readMessageContext(metadata)
    expect(good).not.toBeNull()
    if (good === null) return
    const entry = { ...good.entries[0] }

    const tooLongName = {
      ...good,
      entries: [{ ...entry, name: 'n'.repeat(CONTEXT_NAME_MAX_CHARS + 1) }]
    }
    const tooLongSource = {
      ...good,
      entries: [{ ...entry, source: 's'.repeat(CONTEXT_SOURCE_MAX_CHARS + 1) }]
    }
    const tooLongAbsolute = {
      ...good,
      entries: [{ ...entry, absolute: 'a'.repeat(CONTEXT_SOURCE_MAX_CHARS + 1) }]
    }
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: tooLongName })).toBeNull()
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: tooLongSource })).toBeNull()
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: tooLongAbsolute })).toBeNull()
    // 边界值（正好到上限）照旧采信
    const atLimit = {
      ...good,
      entries: [
        {
          ...entry,
          name: 'n'.repeat(CONTEXT_NAME_MAX_CHARS),
          source: 's'.repeat(CONTEXT_SOURCE_MAX_CHARS)
        }
      ]
    }
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: atLimit })).not.toBeNull()
  })
})

async function sealedFixture(
  text: string,
  attachments: PendingAttachment[]
): Promise<{ outgoing: ReturnType<typeof composeOutgoing>; metadata: UserMessageMetadata }> {
  const outgoing = composeOutgoing({ text, attachments })
  const metadata = await buildUserMessageMetadata({
    at: Date.UTC(2026, 9, 16, 8, 30),
    text: outgoing.text,
    context: outgoing.context
  })
  return { outgoing, metadata }
}

describe('resolveUserDisplay：同步一阶只算候选（隐藏要等摘要复核）', () => {
  it('核验一阶通过：候选正文只剩用户写的那句，条目按组装顺序带回来', async () => {
    const { outgoing, metadata } = await sealedFixture('看这个文件', [attachment('第一行\n第二行')])
    const display = resolveUserDisplay({ text: outgoing.text, metadata })

    expect(display.hidden).toBe(true)
    expect(display.text).toBe('看这个文件')
    expect(display.entries.map((entry) => entry.name)).toEqual(['note.md'])
    expect(display.review).toHaveLength(1)
    // **候选 ≠ 可以隐藏**：还要异步复核通过（下面 verifySegmentDigests 那组）
    expect(await verifySegmentDigests(display.review)).toBe(true)
  })

  it('两段附件：候选都藏掉；动手写的正文原样留着', async () => {
    const { outgoing, metadata } = await sealedFixture('两句', [
      attachment('A 的内容', 'a.txt'),
      attachment('B 的内容', 'b.txt')
    ])
    const display = resolveUserDisplay({ text: outgoing.text, metadata })

    expect(display.text).toBe('两句')
    expect(display.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('只有附件、用户没打字：候选正文为空串（渲染层据此不画空气泡）', async () => {
    const { outgoing, metadata } = await sealedFixture('', [attachment('内容')])
    expect(resolveUserDisplay({ text: outgoing.text, metadata }).text).toBe('')
  })

  it('没有 metadata（用户手写【附件】/ 旧消息）：原样显示，不误吃', () => {
    const handwritten = '我自己写的\n\n【附件】note.md'
    const display = resolveUserDisplay({ text: handwritten, metadata: undefined })

    expect(display.hidden).toBe(false)
    expect(display.text).toBe(handwritten)
    expect(display.entries).toEqual([])
  })

  it('段长 / 头尾 / 分隔符任一处对不上：连候选都没有（原文）', async () => {
    const { outgoing, metadata } = await sealedFixture('看', [attachment('内容')])

    const truncated = outgoing.text.slice(0, -1)
    expect(resolveUserDisplay({ text: truncated, metadata }).hidden).toBe(false)

    const frontChanged = outgoing.text.replace('【附件】', '【附 件】')
    expect(resolveUserDisplay({ text: frontChanged, metadata }).hidden).toBe(false)

    const noSeparator = outgoing.text.replace('看\n\n', '看')
    expect(resolveUserDisplay({ text: noSeparator, metadata }).hidden).toBe(false)
  })

  it('没有摘要（平台没有 crypto.subtle 的那一档）：连候选都没有', () => {
    const segment = appendSegmentOf('【附件】a.txt', 0)
    expect(segment.sha256).toBeNull()
    const metadata = {
      [MESSAGE_CONTEXT_KEY]: {
        v: MESSAGE_CONTEXT_VERSION,
        entries: [{ kind: 'file', name: 'a.txt', size: 1, source: 'a.txt', append: segment }]
      }
    }
    expect(resolveUserDisplay({ text: '【附件】a.txt', metadata }).hidden).toBe(false)
  })

  it('坏 metadata（版本不认识 / 多字段 / 缺字段 / 类型不对）一律不采信', async () => {
    const { metadata } = await sealedFixture('看', [attachment('内容')])
    const good = readMessageContext(metadata)
    expect(good).not.toBeNull()
    if (good === null) return

    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: { ...good, v: 99 } })).toBeNull()
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: { ...good, extra: 1 } })).toBeNull()
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: { v: MESSAGE_CONTEXT_VERSION } })).toBeNull()
    expect(readMessageContext({ [MESSAGE_CONTEXT_KEY]: '不是对象' })).toBeNull()
    expect(readMessageContext(undefined)).toBeNull()
    // 条目里混进一条坏的 → 整块不采信（宁可显示原文）
    expect(
      readMessageContext({
        [MESSAGE_CONTEXT_KEY]: { v: MESSAGE_CONTEXT_VERSION, entries: [{ kind: 'nope' }] }
      })
    ).toBeNull()
  })
})

describe('verifySegmentDigests：异步复核通过才允许隐藏', () => {
  it('摘录没盖住的中段被改：同步一阶会放行，摘要复核必须拦住', async () => {
    const { outgoing, metadata } = await sealedFixture('看', [attachment(LONG_BODY)])
    const first = resolveUserDisplay({ text: outgoing.text, metadata })
    expect(first.hidden).toBe(true)
    expect(await verifySegmentDigests(first.review)).toBe(true)

    // 只动中段（前 48 与后 48 字都不含它）—— 长度也不变
    const tampered = outgoing.text.replace('第 20 行内容', '第 贰拾 行内容')
    expect(tampered).toHaveLength(outgoing.text.length)
    const second = resolveUserDisplay({ text: tampered, metadata })
    expect(second.hidden).toBe(true)
    expect(await verifySegmentDigests(second.review)).toBe(false)
  })

  it('摘要算不出来（平台没有 subtle / 抛错）：回 false —— 保留原文', async () => {
    const { outgoing, metadata } = await sealedFixture('看', [attachment('内容')])
    const display = resolveUserDisplay({ text: outgoing.text, metadata })
    expect(await verifySegmentDigests(display.review, { digest: async () => null })).toBe(false)
  })

  it('超时（摘要永不返回）：回 false —— 保留原文', async () => {
    const { outgoing, metadata } = await sealedFixture('看', [attachment('内容')])
    const display = resolveUserDisplay({ text: outgoing.text, metadata })
    const never = (): Promise<string | null> => new Promise(() => {})
    expect(await verifySegmentDigests(display.review, { digest: never, timeoutMs: 20 })).toBe(false)
  })

  it('没有待复核的段：回 true（调用方不会据此隐藏 —— 没有段就没有可藏的）', async () => {
    expect(await verifySegmentDigests([])).toBe(true)
  })
})

describe('核验材料身份与"已通过"缓存（验过才藏的第二道保险，内存有界）', () => {
  it('指纹只当检索键：等长中段被改时指纹相同，但材料逐字比对必须判"不是同一批"', async () => {
    // 同一份 metadata（记录的摘要与长度都没变）+ 正文中段被改（等长、头尾不变）
    const original = await sealedFixture('看', [attachment(LONG_BODY)])
    const editedText = original.outgoing.text.replace('第 3 行内容', '第 叁 行内容')
    const a = resolveUserDisplay({
      text: original.outgoing.text,
      metadata: original.metadata
    }).review
    const b = resolveUserDisplay({ text: editedText, metadata: original.metadata }).review

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    // 指纹吃的是"记录的摘要 + 长度"（同一份 metadata → 指纹一样）
    expect(sealKeyOf(a)).toBe(sealKeyOf(b))
    // 身份看的是材料本身：段不同 → 不是同一批
    expect(sameVerificationMaterial(a, b)).toBe(false)
    expect(sameVerificationMaterial(a, a)).toBe(true)
  })

  it('只缓存"通过"，且按材料命中：验过的 A 命中；改过的 B（指纹相同）**绝不**命中', async () => {
    forgetVerifiedSeals()
    const original = await sealedFixture('看', [attachment(LONG_BODY)])
    const editedText = original.outgoing.text.replace('第 3 行内容', '第 叁 行内容')
    const a = resolveUserDisplay({
      text: original.outgoing.text,
      metadata: original.metadata
    }).review
    const b = resolveUserDisplay({ text: editedText, metadata: original.metadata }).review

    expect(verifiedVerdictOf(a)).toBeNull() // 没记过 = 没有结论（照常 pending → 再验）
    rememberVerifiedSeal(a)
    expect(verifiedVerdictOf(a)).toBe(true)
    // 同材料再问一次仍命中（逐字比对，不是看 message.id）
    expect(verifiedVerdictOf(a.map((item) => ({ ...item })))).toBe(true)
    // 指纹撞上、内容不同的那批：不命中 —— 没验过就不许藏
    expect(verifiedVerdictOf(b)).toBeNull()
    forgetVerifiedSeals()
    expect(verifiedVerdictOf(a)).toBeNull()
  })

  it('大材料不进缓存（单条超 64K 字符）：重挂时重新核验，不做无界用户数据缓存', () => {
    forgetVerifiedSeals()
    const huge = [{ segment: 'x'.repeat(64 * 1024 + 1), sha256: 'a'.repeat(64) }]
    rememberVerifiedSeal(huge)
    expect(verifiedVerdictOf(huge)).toBeNull()
    // 正好卡在上限内的小材料照记（对照片）
    const small = [{ segment: 'x'.repeat(1024), sha256: 'b'.repeat(64) }]
    rememberVerifiedSeal(small)
    expect(verifiedVerdictOf(small)).toBe(true)
  })

  it('条数超限先逐出最旧的（上限 32 条）', () => {
    forgetVerifiedSeals()
    const materials = Array.from({ length: 33 }, (_, index) => [
      { segment: `第 ${index} 段-${'y'.repeat(80)}`, sha256: String(index).padStart(64, '0') }
    ])
    for (const material of materials) rememberVerifiedSeal(material)

    expect(verifiedVerdictOf(materials[0])).toBeNull() // 被逐出
    expect(verifiedVerdictOf(materials[32])).toBe(true) // 最新的在
  })

  it('总量超限也逐出（单条合规、合起来撑爆总量）', () => {
    forgetVerifiedSeals()
    const chunk = 'z'.repeat(60 * 1024)
    const materials = [0, 1, 2, 3, 4].map((index) => [
      { segment: `${index}:${chunk}`, sha256: String(index).padStart(64, '0') }
    ])
    for (const material of materials) rememberVerifiedSeal(material)

    expect(verifiedVerdictOf(materials[0])).toBeNull()
    expect(verifiedVerdictOf(materials[4])).toBe(true)
    forgetVerifiedSeals()
  })
})

describe('编辑重发：按摘要认领原来的追加段', () => {
  it('只改了自己的字（前缀）：附件段仍认领得上，metadata 自洽（摘录 / 长度重算）', async () => {
    const { outgoing, metadata } = await sealedFixture('原问题', [attachment('内容')])
    const edited = outgoing.text.replace('原问题', '改过的问题')
    const carried = await carryOverMessageContext(metadata, edited)

    expect(carried).not.toBeNull()
    const display = resolveUserDisplay({
      text: edited,
      metadata: { [MESSAGE_CONTEXT_KEY]: carried }
    })
    expect(display.hidden).toBe(true)
    expect(display.text).toBe('改过的问题')
    expect(await verifySegmentDigests(display.review)).toBe(true)
  })

  it('改到了附件段（摘要对不上）：不沿用 —— 重发的展示按原文', async () => {
    const { outgoing, metadata } = await sealedFixture('原问题', [attachment(LONG_BODY)])
    const edited = outgoing.text.replace('第 20 行内容', '我改了这一行')
    expect(await carryOverMessageContext(metadata, edited)).toBeNull()
  })

  it('本来就没有上下文 / 没有 metadata：不沿用（也不报错）', async () => {
    const plain = await buildUserMessageMetadata({ at: Date.now(), text: '纯文本' })
    expect(await carryOverMessageContext(plain, '纯文本')).toBeNull()
    expect(await carryOverMessageContext(undefined, '纯文本')).toBeNull()
  })
})

describe('发送时间（008）', () => {
  it('readSentAt：kyclawSentAt 优先（exact）；只有 createdAt 走记录时间（exact=false）', () => {
    const at = Date.UTC(2026, 9, 16, 8, 30)
    const iso = new Date(at).toISOString()

    // 自有键在场 → 精确发送时刻
    expect(readSentAt({ [SENT_AT_KEY]: iso, createdAt: at + 5000 })).toEqual({ at, exact: true })
    // 没有自有键（旧消息 / 历史回读）→ 记录时间，且**不冒充**精确
    expect(readSentAt({ createdAt: at })).toEqual({ at, exact: false })
    expect(readSentAt({ createdAt: iso })).toEqual({ at, exact: false })
    expect(readSentAt({ createdAt: new Date(at) })).toEqual({ at, exact: false })

    // 自有键是脏数据 → 落回记录时间；两个都脏 → null（不编造）
    expect(readSentAt({ [SENT_AT_KEY]: '不是时间', createdAt: at })).toEqual({ at, exact: false })
    expect(readSentAt(undefined)).toBeNull()
    expect(readSentAt({})).toBeNull()
    expect(readSentAt({ createdAt: '不是时间' })).toBeNull()
    expect(readSentAt({ createdAt: 0 })).toBeNull()
    expect(readSentAt({ createdAt: Number.NaN })).toBeNull()
  })

  it('sentAtLabel：精确就是本地时间；记录时间带一句限定', () => {
    const at = new Date(2026, 9, 16, 14, 5, 30).getTime()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const label = `2026-${pad(10)}-${pad(16)} ${pad(14)}:${pad(5)}`

    expect(sentAtLabel({ at, exact: true })).toBe(label)
    expect(sentAtLabel({ at, exact: false })).toBe(`${label}（记录时间）`)
    expect(formatSentAt(at)).toBe(label)
  })

  it('摘录上限就是 48：更长的段只留头尾各 48', () => {
    const segment = appendSegmentOf(LONG_BODY, 2)
    expect(segment.head).toHaveLength(SEGMENT_EXCERPT_CHARS)
    expect(segment.tail).toHaveLength(SEGMENT_EXCERPT_CHARS)
    expect(segment.length).toBe(LONG_BODY.length)
  })
})
