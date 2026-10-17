// @vitest-environment node
/**
 * `src/main/office-protocol.ts`（M3-S1 · `kyclaw-office://` 协议）聚焦单测：
 * 纯函数（MIME / 路径解析 / 逃逸 / host / Range）为主，handler 用真实临时文件覆盖
 * 200/206/404/403 与响应头；另钉住"两份 CSP 逐字一致、主 CSP 只多 frame-src"这个安全不变量。
 *
 * 纪律：一个 Electron 都不起（`protocol.handle` 的接线不在本文件覆盖范围，真机由 e2e 探针验）；
 * 临时目录都是本文件 `mkdtemp` 建的，收尾只删自己建的这些。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICE_SCHEME,
  OFFICE_SURFACE_CSP,
  createOfficeProtocolHandler,
  officeContentType,
  parseByteRange,
  resolveOfficeAsset
} from '../office-protocol'

const ROOT = 'C:/kyclaw-out/renderer'
const SURFACE = 'kyclaw-office://surface'

/** 本文件自建的临时目录（收尾只删这些） */
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kyclaw-office-protocol-'))
  directories.push(directory)
  return directory
}

/** 造一棵最小的 out/renderer：office.html + 一个 100 字节的 JS + assets 子目录 */
async function tempRendererRoot(): Promise<{ root: string; html: string; js: string }> {
  const root = await tempRoot()
  const html = '<!doctype html><title>surface</title>'
  const js = `console.log('${'x'.repeat(80)}')\n` // 100 字节上下，Range 断言用真实长度算
  await writeFile(join(root, 'office.html'), html, 'utf8')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'office.js'), js, 'utf8')
  await writeFile(join(root, 'assets', 'mystery.bin'), 'binary-ish', 'utf8')
  return { root, html, js }
}

/** 把解析结果收成好断言的形状 */
function resolvedUrl(root: string, url: string): string {
  const asset = resolveOfficeAsset(root, url)
  if (asset.kind !== 'file') throw new Error(`解析失败：${asset.status} ${asset.reason}`)
  return asset.filePath.replaceAll('\\', '/')
}

describe('officeContentType：MIME 表（未知扩展名回落八位字节流）', () => {
  it('wasm / 字体 / 脚本 / 样式 等按计划表给 MIME', () => {
    expect(officeContentType('C:/x/assets/docx_bg.wasm')).toBe('application/wasm')
    expect(officeContentType('C:/x/assets/font.ttf')).toBe('font/ttf')
    expect(officeContentType('C:/x/assets/font.otf')).toBe('font/otf')
    expect(officeContentType('C:/x/assets/font.woff2')).toBe('font/woff2')
    expect(officeContentType('C:/x/assets/app.js')).toBe('text/javascript; charset=utf-8')
    expect(officeContentType('C:/x/assets/app.css')).toBe('text/css; charset=utf-8')
    expect(officeContentType('C:/x/office.html')).toBe('text/html; charset=utf-8')
    expect(officeContentType('C:/x/assets/data.json')).toBe('application/json; charset=utf-8')
    expect(officeContentType('C:/x/assets/app.js.map')).toBe('application/json; charset=utf-8')
    expect(officeContentType('C:/x/assets/icon.svg')).toBe('image/svg+xml')
  })

  it('扩展名大小写不敏感；未知扩展名 / 无扩展名回落 octet-stream', () => {
    expect(officeContentType('C:/x/assets/DOCX.WASM')).toBe('application/wasm')
    expect(officeContentType('C:/x/assets/FONT.TTF')).toBe('font/ttf')
    expect(officeContentType('C:/x/assets/chunk.abc')).toBe('application/octet-stream')
    expect(officeContentType('C:/x/assets/LICENSE')).toBe('application/octet-stream')
  })
})

describe('resolveOfficeAsset：host / 根路径 / 归一化', () => {
  it('根路径（/、空、带 query）都映射到 office.html', () => {
    for (const url of [`${SURFACE}/`, SURFACE, `${SURFACE}/?nonce=abc`, `${SURFACE}/#x`]) {
      expect(resolvedUrl(ROOT, url)).toBe(`${ROOT}/office.html`)
    }
  })

  it('host 只认 surface：其它 host / 别名 host / 其它 scheme 都 404', () => {
    for (const url of [
      'kyclaw-office://other/office.html',
      'kyclaw-office://surface.evil/office.html',
      'kyclaw-office://[::1]/office.html',
      'file:///C:/out/renderer/office.html',
      'not a url'
    ]) {
      const asset = resolveOfficeAsset(ROOT, url)
      expect(asset.kind).toBe('error')
      if (asset.kind === 'error') expect([400, 404]).toContain(asset.status)
    }
  })

  it('重复斜杠 / 点段 / 反斜杠都归一化到同一文件', () => {
    expect(resolvedUrl(ROOT, `${SURFACE}//office.html`)).toBe(`${ROOT}/office.html`)
    expect(resolvedUrl(ROOT, `${SURFACE}/%2e/office.html`)).toBe(`${ROOT}/office.html`)
    expect(resolvedUrl(ROOT, `${SURFACE}/assets%5capp.js`)).toBe(`${ROOT}/assets/app.js`)
    expect(resolvedUrl(ROOT, `${SURFACE}/assets\\app.js`)).toBe(`${ROOT}/assets/app.js`)
    // URL 解析本身会折掉明文点段（这里记录行为：折完仍在 root 内）
    expect(resolvedUrl(ROOT, `${SURFACE}/assets/../office.html`)).toBe(`${ROOT}/office.html`)
  })

  it('编码逃逸（%2f / %5c 造出的 ..）一律 403，且不回绝对路径', () => {
    for (const url of [
      `${SURFACE}/assets%2f..%2f..%2fsecret.txt`,
      `${SURFACE}/assets%5c..%5c..%5csecret.txt`,
      `${SURFACE}/%2e%2e%2fsecret.txt`,
      `${SURFACE}/assets%2f..%2f..%2f..%2fWindows%2fwin.ini`
    ]) {
      const asset = resolveOfficeAsset(ROOT, url)
      expect(asset.kind, url).toBe('error')
      if (asset.kind === 'error') {
        expect(asset.status, url).toBe(403)
        expect(asset.reason).not.toContain(ROOT)
      }
    }
  })

  it('畸形编码 / NUL 注入按 400 处理（不当成合法路径）', () => {
    for (const url of [`${SURFACE}/%E0%A4%A`, `${SURFACE}/%00secret`]) {
      const asset = resolveOfficeAsset(ROOT, url)
      expect(asset.kind, url).toBe('error')
      if (asset.kind === 'error') expect(asset.status).toBe(400)
    }
  })

  it('scheme / host 常量与壳侧 surface-url 的约定一致', () => {
    expect(OFFICE_SCHEME).toBe('kyclaw-office')
    const parsed = new URL(`${SURFACE}/`)
    expect(parsed.protocol).toBe(`${OFFICE_SCHEME}:`)
    expect(parsed.host).toBe('surface')
    // 注意：Node 的 URL.origin 对非 special scheme 恒为 'null'；真实 origin 由 Chromium 里
    // location.origin 给出（e2e 探针断言 'kyclaw-office://surface'），这里只钉 scheme/host。
  })
})

describe('parseByteRange：单段 Range 解析', () => {
  it('start-end / start- / -suffix 三种形态', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    // 尾部越界按文件末尾截断
    expect(parseByteRange('bytes=95-200', 100)).toEqual({ start: 95, end: 99 })
    // 整个文件
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
  })

  it('不合法 / 越界 / 多段 / 空 size 一律 null（调用方回落 200 全量）', () => {
    for (const header of [
      undefined,
      null,
      '',
      'bytes=',
      'bytes=-',
      'bytes=abc-def',
      'bytes=100-200', // start 越界
      'bytes=50-10', // end < start
      'bytes=0-1,5-6', // 多段不支持
      'items=0-9'
    ]) {
      expect(parseByteRange(header, 100), String(header)).toBeNull()
    }
    expect(parseByteRange('bytes=0-9', 0)).toBeNull()
  })
})

describe('createOfficeProtocolHandler：响应状态 / 头 / Range', () => {
  it('根路径 200：text/html + 与 office.html meta 逐字一致的 CSP + nosniff + length', async () => {
    const { root, html } = await tempRendererRoot()
    const handler = createOfficeProtocolHandler({ rootDir: root })
    const response = await handler(new Request(`${SURFACE}/`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(OFFICE_SURFACE_CSP)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(html)))
    expect(await response.text()).toBe(html)
  })

  it('无 Range 的 JS：200 + content-length；未知扩展名 octet-stream 且不带 CSP', async () => {
    const { root } = await tempRendererRoot()
    const handler = createOfficeProtocolHandler({ rootDir: root })
    const response = await handler(new Request(`${SURFACE}/assets/office.js`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0)

    const unknown = await handler(new Request(`${SURFACE}/assets/mystery.bin`))
    expect(unknown.status).toBe(200)
    expect(unknown.headers.get('content-type')).toBe('application/octet-stream')
    expect(unknown.headers.get('content-security-policy')).toBeNull()
  })

  it('Range 命中 206：content-range / content-length / accept-ranges；体就是那一段', async () => {
    const { root, js } = await tempRendererRoot()
    const handler = createOfficeProtocolHandler({ rootDir: root })
    const response = await handler(
      new Request(`${SURFACE}/assets/office.js`, { headers: { Range: 'bytes=0-9' } })
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 0-9/${Buffer.byteLength(js)}`)
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe(js.slice(0, 10))
  })

  it('suffix Range 与越界 Range：前者 206，后者忽略 Range 回 200 全量', async () => {
    const { root, js } = await tempRendererRoot()
    const handler = createOfficeProtocolHandler({ rootDir: root })

    const suffix = await handler(
      new Request(`${SURFACE}/assets/office.js`, { headers: { Range: 'bytes=-5' } })
    )
    expect(suffix.status).toBe(206)
    expect(await suffix.text()).toBe(js.slice(-5))

    const beyond = await handler(
      new Request(`${SURFACE}/assets/office.js`, { headers: { Range: 'bytes=99999-' } })
    )
    expect(beyond.status).toBe(200)
    expect(await beyond.text()).toBe(js)
  })

  it('404（不存在 / 非 surface host）与 403（编码逃逸）只回文本，不回绝对路径', async () => {
    const { root } = await tempRendererRoot()
    const handler = createOfficeProtocolHandler({ rootDir: root })

    const missing = await handler(new Request(`${SURFACE}/missing.js`))
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain(root)

    const host = await handler(new Request('kyclaw-office://other/office.html'))
    expect(host.status).toBe(404)

    const escape = await handler(new Request(`${SURFACE}/assets%2f..%2f..%2fsecret.txt`))
    expect(escape.status).toBe(403)
    expect(await escape.text()).not.toContain(root)
  })
})

describe('安全不变量：两份 CSP 逐字一致，主 CSP 只多 frame-src', () => {
  /** 仓库根：vitest 从仓库根跑（与 vitest.config.ts 的 resolve('src/...') 同口径） */
  const repoRoot = process.cwd()

  it('office.html 的 meta CSP === 协议响应头用的 OFFICE_SURFACE_CSP', async () => {
    const html = await readFile(join(repoRoot, 'src/renderer/office.html'), 'utf8')
    const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)
    expect(match, 'office.html 里没有 CSP meta').not.toBeNull()
    expect(match?.[1]).toBe(OFFICE_SURFACE_CSP)
  })

  it('主 renderer 的 CSP 只新增 frame-src，脚本仍无 wasm-unsafe-eval / unsafe-eval', async () => {
    const html = await readFile(join(repoRoot, 'src/renderer/index.html'), 'utf8')
    const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)
    expect(match, 'index.html 里没有 CSP meta').not.toBeNull()
    const csp = match?.[1] ?? ''
    expect(csp).toContain("frame-src 'self' kyclaw-office: http://localhost:5173")
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toContain('wasm-unsafe-eval')
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).not.toContain('blob:')
    // dev 的 localhost 只出现在 frame-src 一项里（不整串放宽）
    expect(csp.split('http://localhost:5173')).toHaveLength(2)
  })
})
