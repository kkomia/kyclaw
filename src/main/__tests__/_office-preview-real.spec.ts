// @vitest-environment node
/**
 * 办公档页式预览**真链路探针**：真起 kit 子进程、真转 PDF、真落盘一份 PDF 供人打开看。
 *
 * 它回答单测证明不了的事（单测里 `run` / `kitCli` / `makeTempDir` 全是注入的假件）：
 *   ① `ELECTRON_RUN_AS_NODE=1 <process.execPath> <kit>/lib/cli.js convert --input … --output …`
 *      这条跑法在当前宿主里通不通、产出是不是一份完整 PDF；
 *   ② docx / pptx 与**旧版二进制** doc / ppt 各自能不能转出来；
 *   ③ 真进程跑过之后，自建的临时目录有没有留下残余；真取消时引擎与临时目录收没收干净。
 *
 * **每例还记录**：产出的 PDF 页数（`/Type /Page` 页对象）、pdfjs 抽出来的正文、以及**源文件的
 * sha256 在转换前后一致**（"只读不改写原件"的证据）。
 *
 * ── 宏安全：措辞必须准（别把这一例读成"宏没执行"的证据）─────────────────────
 * 夹具里的 `WithMacros.ppt` 只证明一件事：**带宏的文件也能转出 PDF**。
 * 引擎侧确实禁了宏执行（`configure` 的 `--disable-scripting`、加载参数
 * `EnableMacrosExecution=false`，出处逐条列在 `mastra/tools/office-legacy.ts` 的头注里），
 * 但**"配置里禁了宏"不等于"动态证明了宏没执行"** —— 本轮没有任何运行时观测（没有宏副作用探针、
 * 没有进程行为取证、没有对比带宏/不带宏两次转换的差异），所以**不得**拿"WithMacros.ppt 转成功"
 * 当"宏确实没跑"的证据。
 *
 * 用法（真起进程、真转换；默认跳过）：
 *   KYCLAW_OFFICE_PREVIEW_REAL=1 pnpm exec vitest run src/main/__tests__/_office-preview-real.spec.ts
 *
 * 产出落在 `.superpowers/office-preview-probe/`（本地、不入库），人可以直接打开看版式。
 * 机器上没有 `resources/libreoffice-kit`（没跑过 `pnpm fetch:libreoffice-kit`）时整组跳过；
 * 旧版 Office 夹具（`.superpowers/office-legacy-fixtures/`，本地件）不在时只跳过那几例。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  OFFICE_PREVIEW_TEMP_PREFIX,
  createOfficePreview,
  officePreviewSourceKey,
  officePreviewSourceVersion,
  type OfficePreviewRequest
} from '../office-preview'
import type { OfficePreviewFormat } from '../../shared/office-preview'
import { resolveKitCli } from '../tools/office-kit'
import {
  fixtureDocx as renderDocx,
  fixturePptx as renderPptx
} from './fixtures/office-fixtures'
import { extractPdfText } from '../pdf'

const enabled = process.env.KYCLAW_OFFICE_PREVIEW_REAL === '1'
const repoRoot = resolve(__dirname, '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'office-preview-probe')
const legacyDir = join(repoRoot, '.superpowers', 'office-legacy-fixtures')

/** 随包 kit 的 CLI（真解析，不注入）；为 null = 这台机器没装，整组跳过 */
const kitCli = resolveKitCli()
const canRun = enabled && kitCli !== null

function basenameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * **接线层那份 `read` 的参考实现**（探针里就地走一遍；接线时照这个形状写）：
 * 授权（会话根解析 + containment）在接线层已经做完，这里只负责"按预留容量有界读 + 报读到的版本"，
 * 并且**读完复检版本** —— 版本对不上就交回一个不同的版本，让队列判 `source-changed`。
 */
function authorizedSource(path: string, extension: OfficePreviewFormat): OfficePreviewRequest {
  const info = statSync(path)
  const version = officePreviewSourceVersion(info)
  return {
    extension,
    priority: 'foreground',
    source: {
      key: officePreviewSourceKey('probe', path),
      version,
      bytes: info.size,
      read: async (signal, maxBytes) => {
        signal.throwIfAborted()
        const bytes = await readFile(path)
        const after = statSync(path)
        const current = officePreviewSourceVersion(after)
        // 最多交回 maxBytes + 1 个字节（多出来的那一个用于让队列判"超预留"）
        return { bytes: new Uint8Array(bytes.subarray(0, maxBytes + 1)), version: current }
      }
    }
  }
}

/** 一份文件的 SHA256（记录"原件一个字节没动"用） */
function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 转一份真文件（走**真实现**：不注入 run / kitCli / makeTempDir），产出落证据目录 */
async function convertFixture(
  path: string,
  extension: OfficePreviewFormat,
  expectText = ''
): Promise<{
  output: string
  bytes: number
  missingFonts: string[]
  pages: number
  pageObjects: number
}> {
  // 源文件在转换前后必须逐字节一致（只读取，不改写）
  const hashBefore = sha256Of(path)
  const provider = createOfficePreview()
  try {
    const result = await provider.convert(authorizedSource(path, extension))
    const text = Buffer.from(result.pdf).toString('latin1')
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(result.pdf.byteLength).toBeGreaterThan(1000)
    expect(Array.isArray(result.missingFonts)).toBe(true)
    expect(sha256Of(path)).toBe(hashBefore)

    // 产出落盘 + 用主进程那套 pdfjs 抽一遍文字层（能抽到就是"真转出正文"的硬证据）
    const output = join(evidenceDir, `${extension}-${basenameOf(path)}.pdf`)
    await writeFile(output, result.pdf)
    const extracted = await extractPdfText(result.pdf)
    const pages = extracted.ok ? extracted.pages : 0
    const body = extracted.ok ? extracted.text.replace(/\s+/g, ' ').trim() : ''
    // `/Type /Page` 是页对象：**页数判据用它**（有的旧版文件转出来没有文字层，pdfjs 抽不出文字，
    // 但页是真在的 —— 拿"文字层页数"当判据会把"转成功但没文字"误判成失败）
    const pageObjects = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length
    console.log(
      `[probe] ${extension} ${basenameOf(path)} → ${output}\n` +
        `        产出 ${result.pdf.byteLength} 字节、PDF 页对象 ${pageObjects} 个、` +
        `文字层 ${extracted.ok ? `${pages} 页` : '抽不出（这份没有可抽的文字层）'}、` +
        `缺字体 ${JSON.stringify(result.missingFonts)}\n` +
        `        源文件 sha256 ${hashBefore.slice(0, 16)}…（转换前后一致）\n` +
        `        正文前 120 字：${body.slice(0, 120)}`
    )
    if (expectText !== '') expect(body).toContain(expectText)
    return {
      output,
      bytes: result.pdf.byteLength,
      missingFonts: result.missingFonts,
      pages,
      pageObjects
    }
  } finally {
    await provider.dispose()
  }
}

describe.skipIf(!canRun)('办公档页式预览（真链路探针）', () => {
  it('docx（仓库自己的产出器造的文档）能转成真 PDF', async () => {
    mkdirSync(evidenceDir, { recursive: true })
    const data = await renderDocx({
      title: '办公档页式预览探针',
      blocks: [
        { type: 'heading', text: '一、目的' },
        {
          type: 'paragraph',
          text: '验证 docx → PDF 这条真链路：随包 LibreOffice 起得来、产出完整。'
        },
        { type: 'heading', text: '二、说明' },
        { type: 'paragraph', text: '这一份是探针产出，不入库。' }
      ]
    })
    const path = join(evidenceDir, 'probe.docx')
    await writeFile(path, data)
    const result = await convertFixture(path, 'docx', '办公档页式预览探针')
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.pages).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('pptx（仓库自己的产出器造的 3 页 deck）能转成真 PDF', async () => {
    mkdirSync(evidenceDir, { recursive: true })
    const deck = await renderPptx({
      title: '办公档页式预览探针',
      slides: [
        { title: '封面', bullets: ['doc / docx / ppt / pptx → PDF'] },
        { title: '第二页', bullets: ['中文与数字 182.3 万辆'] },
        { title: '第三页', stats: [{ value: '3 页', label: '探针 deck' }] }
      ]
    })
    const path = join(evidenceDir, 'probe.pptx')
    await writeFile(path, deck.data)
    const result = await convertFixture(path, 'pptx', '182.3 万辆')
    expect(result.bytes).toBeGreaterThan(0)
    console.log(`[probe] 探针 deck 自报 ${deck.slides} 页`)
    expect(deck.slides).toBeGreaterThan(0)
    expect(result.pages).toBeGreaterThanOrEqual(deck.slides)
  }, 180_000)

  it('旧版二进制（doc / ppt，本地夹具）能转成真 PDF', async () => {
    mkdirSync(evidenceDir, { recursive: true })
    const cases: readonly (readonly [string, OfficePreviewFormat])[] = [
      ['SampleDoc.doc', 'doc'],
      ['simple.doc', 'doc'],
      // 带宏的文件：**只证"能转出 PDF"**，不构成"宏没执行"的动态证据（见文件头注）
      ['WithMacros.ppt', 'ppt'],
      ['basic_test_ppt_file.ppt', 'ppt']
    ]
    const present = cases.filter(([name]) => existsSync(join(legacyDir, name)))
    if (present.length === 0) {
      console.log(`[probe] 旧版夹具不在（${legacyDir}），这一例只记"没跑"`)
      return
    }
    for (const [name, extension] of present) {
      const result = await convertFixture(join(legacyDir, name), extension)
      expect(result.bytes).toBeGreaterThan(1000)
      // 页数判据用页对象（旧版夹具里 `WithMacros.ppt` 转出来没有文字层，抽不到文字 ≠ 没转出来）
      expect(result.pageObjects).toBeGreaterThanOrEqual(1)
      // `WithMacros.ppt` **只证"能转出 PDF"**：这一例不构成"宏没执行"的证据（见文件头注）
    }
  }, 300_000)

  it('真取消：中途 abort → 调用方立刻收到中止原因，引擎与自建临时目录都收干净', async () => {
    mkdirSync(evidenceDir, { recursive: true })
    // 挑一份"转起来有几十毫秒以上"的真件（8 页 deck 优先；不在就退回探针自己的 pptx）
    const deck = join(
      repoRoot,
      '.superpowers',
      'ppt-layout-fix',
      'verify-r77',
      'decks',
      'news-ppt-report-8page.pptx'
    )
    const path = existsSync(deck) ? deck : join(evidenceDir, 'probe.pptx')
    expect(existsSync(path)).toBe(true)

    // 用**真** runProcess，但外面包一层：只为拿到"引擎已经跑起来"这个时刻，再动手取消
    const { runProcess } = await import('../tools/exec')
    let scratch = ''
    let started: () => void = () => undefined
    const running = new Promise<void>((settle) => {
      started = settle
    })
    const provider = createOfficePreview(
      {},
      {
        run: async (spec) => {
          const input = spec.args[spec.args.indexOf('--input') + 1]
          if (typeof input === 'string') scratch = dirname(input)
          started()
          return await runProcess(spec)
        }
      }
    )
    const controller = new AbortController()
    const reason = new Error('探针：用户点了停止')
    try {
      const work = provider.convert(authorizedSource(path, 'pptx'), controller.signal)
      await running
      expect(scratch).not.toBe('')
      controller.abort(reason)
      await expect(work).rejects.toBe(reason)
      // 收尾要等引擎那一步真结束：自建临时目录被删掉（引擎子进程按 exec 那套杀法收）
      await vi.waitFor(
        () => {
          expect(existsSync(scratch)).toBe(false)
        },
        { timeout: 30_000, interval: 200 }
      )
      console.log(`[probe] 取消：调用方收到中止原因；自建临时目录 ${scratch} 已清理`)
    } finally {
      await provider.dispose()
    }
  }, 180_000)

  it('转换跑完之后，自建的临时目录不留残余', async () => {
    const path = join(evidenceDir, 'probe.docx')
    if (!existsSync(path)) {
      console.log('[probe] 第一例还没跑过（没有 probe.docx），这一例只记"没跑"')
      return
    }
    await convertFixture(path, 'docx')
    // 自建目录是 `mkdtemp(join(tmpdir(), OFFICE_PREVIEW_TEMP_PREFIX))`，收尾只删它一个：
    // 这里核的是"共享临时根下没有遗留我们前缀的目录"
    const leftovers = readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith(OFFICE_PREVIEW_TEMP_PREFIX)
    )
    console.log(`[probe] 临时根下遗留 ${leftovers.length} 个 ${OFFICE_PREVIEW_TEMP_PREFIX} 目录`)
    expect(leftovers).toEqual([])
  }, 180_000)
})
