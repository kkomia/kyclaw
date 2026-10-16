import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createBasicHtmlDocument } from '../html-document'
import { DshHtmlViewer } from '../html-viewer'

/** 一份"什么都带一点"的源件：脚本、外链、表单、内联样式、data 图片、模板、内联锚点、sprite 引用。 */
const SOURCE = `<!doctype html>
<html><head><title>样例</title><link rel="stylesheet" href="https://evil.example/a.css"></head>
<body>
<script>window.parent && (window.parent.x = 1)</script>
<template shadowrootmode="open"><script>alert(1)</script></template>
<a href="https://evil.example/click">点我</a>
<img src="data:image/png;base64,iVBORw0KGgo=" alt="内联图">
<form action="https://evil.example/post"><input name="a"></form>
<p style="color: red">正文</p>
</body></html>`

/**
 * 恶意源件：外链资源、CSS 外链、表单动作、SVG/表单/嵌套文档、meta refresh、base。
 * 这一份的用途只有一条：**输出里不许出现任何外部 URL**（下面按字符串断言，不看 CSP）。
 */
const HOSTILE = `<!doctype html>
<html><head>
<title>恶意</title>
<base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example/next">
<link rel="preload" as="image" href="https://evil.example/p.png">
<link rel="stylesheet" href="https://evil.example/s.css">
<style>
  @import url("https://evil.example/import.css");
  body { background: url('https://evil.example/bg.png'); }
  .keep { background: url(data:image/png;base64,QUJD); color: blue; }
  .set { background-image: image-set("https://evil.example/1.png" 1x, url(data:image/png;base64,QQ) 2x); }
</style>
</head>
<body>
<img src="https://evil.example/track.png" alt="外链图">
<img srcset="https://evil.example/a.png 1x, data:image/gif;base64,R0lGOD 2x" src="data:image/gif;base64,R0lGOD" alt="候选">
<source src="https://evil.example/x.mp4" type="video/mp4">
<video poster="https://evil.example/poster.jpg" src="https://evil.example/v.mp4"><track src="https://evil.example/t.vtt"></video>
<iframe src="https://evil.example/frame"></iframe>
<object data="https://evil.example/o.svg"></object>
<embed src="https://evil.example/e.svg">
<form action="https://evil.example/post" method="post"><input name="pw"><button formaction="https://evil.example/2">提交</button></form>
<p style="background: url(https://evil.example/inline.png); color: red" class="keep">正文</p>
<svg onload="alert(1)">
  <script>alert(2)</script>
  <image href="https://evil.example/s.png"/>
  <use xlink:href="https://evil.example/u.svg#icon"/>
  <foreignObject><img src="https://evil.example/fo.png"></foreignObject>
</svg>
<a href="#anchor">文内锚点</a>
<a href="https://evil.example/click">外链</a>
</body></html>`

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
/**
 * UTF-16 字节（**带 BOM**；`be` 控制字节序）。手搓而不是用 Buffer：这条 spec 跑在 jsdom 环境，
 * 不该为了一份夹具把 Node 的 Buffer 拉进渲染端的类型面。
 */
const utf16 = (text: string, be = false): Uint8Array => {
  const body = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const lo = code & 0xff
    const hi = (code >> 8) & 0xff
    body[index * 2] = be ? hi : lo
    body[index * 2 + 1] = be ? lo : hi
  }
  const bom = be ? [0xfe, 0xff] : [0xff, 0xfe]
  return new Uint8Array([...bom, ...body])
}
/** 同样的 UTF-16 字节，但**去掉 BOM**（用来测"不带 BOM 不猜编码"） */
const utf16NoBom = (text: string): Uint8Array => utf16(text).subarray(2)

describe('createBasicHtmlDocument：清洗 + 自带 CSP', () => {
  const doc = createBasicHtmlDocument(encode(SOURCE))

  it('脚本、`<link>`、`<template>` 都不在（声明式 shadow root 连载体一起删）', () => {
    expect(doc).not.toMatch(/<script/i)
    expect(doc).not.toMatch(/<link/i)
    expect(doc).not.toMatch(/<template/i)
    expect(doc).toContain('正文')
  })

  it('自带最严 CSP：脚本/连接/框架/表单/远程资源全禁，只留内联样式与 data:', () => {
    expect(doc).toContain("script-src 'none'")
    expect(doc).toContain("connect-src 'none'")
    expect(doc).toContain("frame-src 'none'")
    expect(doc).toContain("form-action 'none'")
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("style-src 'unsafe-inline'")
    expect(doc).toContain('img-src data:')
  })

  it('内联样式与 data: 图片保留（静态内容照常看得见）', () => {
    expect(doc).toContain('color: red')
    expect(doc).toContain('data:image/png;base64')
  })

  it('CSP meta 排在 head 最前，且整份是合法文档开头', () => {
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    const headAt = doc.indexOf('<head>')
    const metaAt = doc.indexOf('http-equiv="Content-Security-Policy"')
    const titleAt = doc.indexOf('<title>')
    expect(metaAt).toBeGreaterThan(headAt)
    expect(metaAt).toBeLessThan(titleAt)
  })
})

/**
 * 本轮的安全核心：**输出字符串里没有外部 URL**。
 * 下面这些断言都是对**字符串**做的 —— 不引用 CSP、不引用 sandbox、也不依赖"惰性文档不取资源"
 * 这条引擎行为；哪一层将来被改坏，这一组都会红。
 */
describe('createBasicHtmlDocument：外部资源一律不留在输出里', () => {
  const doc = createBasicHtmlDocument(encode(HOSTILE))

  it('整份输出里没有 http(s) 链接（外链图 / 表单 / SVG / meta / base 全算）', () => {
    expect(doc).not.toMatch(/https?:\/\//i)
    expect(doc).not.toContain('evil.example')
  })

  it('外链 `<img src>` 被删（后缀与属性名都在，值没了）', () => {
    expect(doc).toContain('外链图')
    expect(doc).not.toMatch(/src="https?:/i)
  })

  it('`srcset` 整条删（候选列表不做解析，一律不留）', () => {
    expect(doc).not.toMatch(/srcset/i)
    // 同一张图的内联 `src` 仍在（静态图照常显示）
    expect(doc).toContain('data:image/gif;base64,R0lGOD')
  })

  it('`poster` / `<source src>` / `<track src>` 都没了（媒体不会去取外链）', () => {
    expect(doc).not.toMatch(/poster=/i)
    expect(doc).not.toMatch(/<source[^>]*src=/i)
    expect(doc).not.toMatch(/<track[^>]*src=/i)
  })

  it('嵌套文档与插件（iframe / object / embed）连元素一起删', () => {
    expect(doc).not.toMatch(/<iframe/i)
    expect(doc).not.toMatch(/<object/i)
    expect(doc).not.toMatch(/<embed/i)
  })

  it('表单元素保留（静态布局），但 `action` / `formaction` 没了', () => {
    expect(doc).toMatch(/<form[^>]*>/i)
    expect(doc).toMatch(/<input/i)
    expect(doc).not.toMatch(/\saction=/i)
    expect(doc).not.toMatch(/\sformaction=/i)
  })

  it('`<meta http-equiv>` 与 `<base>` 都不在（不进输出、也不会自动跳转）', () => {
    expect(doc).not.toMatch(/http-equiv="refresh"/i)
    expect(doc).not.toMatch(/<base/i)
    // 我们补的那条 CSP meta 是清洗之后加进去的，必须还在
    expect(doc).toContain('Content-Security-Policy')
  })

  it('SVG：脚本、onload、外链 href 都不在（内联锚点不受影响）', () => {
    expect(doc).not.toMatch(/alert\(/i)
    expect(doc).not.toMatch(/onload=/i)
    expect(doc).not.toMatch(/xlink:href="https?:/i)
    expect(doc).not.toMatch(/<image[^>]*href="https?:/i)
    expect(doc).not.toMatch(/<img src="https?:/i)
  })

  it('`<a>`：文内锚点保留，外链 href 删掉（点不动外链）', () => {
    expect(doc).toContain('文内锚点')
    expect(doc).toContain('href="#anchor"')
    expect(doc).not.toMatch(/href="https?:/i)
    expect(doc).not.toMatch(/href="\/\//)
  })
})

describe('createBasicHtmlDocument：CSS 外链（@import / url() / image-set）', () => {
  const doc = createBasicHtmlDocument(encode(HOSTILE))

  it('`@import` 整条删（外链样式表不会被取）', () => {
    expect(doc).not.toMatch(/@import/i)
  })

  it('`style` 里的 `url()` 外链换成 `none`，data: 的 url 与其余样式原样保留', () => {
    expect(doc).not.toMatch(/url\(['"]?https?:/i)
    expect(doc).not.toMatch(/url\(['"]?\/\//)
    expect(doc).toContain('url(data:image/png;base64,QUJD)')
    expect(doc).toContain('color: blue')
  })

  it('内联 `style=` 属性同样处理：外链背景换 none，其它声明不动', () => {
    expect(doc).toContain('background: none')
    expect(doc).toContain('color: red')
  })

  it('`image-set()` 里带外链候选（含裸字符串）整段换成 `none`', () => {
    expect(doc).not.toContain('1.png')
    expect(doc).toMatch(/background-image:\s*none/i)
  })

  it('相对路径与协议相对同样不认（base URL 是应用自己，不是文档所在目录）', () => {
    const relative = createBasicHtmlDocument(
      encode(
        '<img src="a/b.png"><img src="//evil.example/c.png"><p style="background:url(./d.png)">x</p>'
      )
    )
    expect(relative).not.toMatch(/src="a\/b\.png"/)
    expect(relative).not.toContain('//evil.example')
    expect(relative).not.toMatch(/url\(\.\/d\.png\)/)
  })

  it('CSS 反斜杠转义（`\\75 rl(` / `url\\28` / `@\\69 mport`）：整段样式保守退回，不留外链', () => {
    const escaped = createBasicHtmlDocument(
      encode(
        '<style>body{background:url(\\68 ttps://evil.example/a.png)}@\\69 mport url("https://evil.example/b.css");</style>'
      )
    )
    expect(escaped).not.toContain('evil.example')
    // 该 <style> 的内容被整段退回成 `none`（这条样式失效，但没有请求）
    expect(escaped).toMatch(/<style[^>]*>\s*none\s*<\/style>/i)

    const escapedParen = createBasicHtmlDocument(
      encode('<style>.x{background:url\\28 https://evil.example/c.png \\29}</style>')
    )
    expect(escapedParen).not.toContain('evil.example')

    // 正常转义（不是 URL）不该被误伤：`content: "\\201C"` 原样保留
    const cosmetic = createBasicHtmlDocument(encode('<style>.q::before{content:"\\201C"}</style>'))
    expect(cosmetic).toContain('content')
    expect(cosmetic).not.toMatch(/<style[^>]*>\s*none\s*<\/style>/i)
  })
})

describe('createBasicHtmlDocument：编码（BOM 明示才认，与主进程 sniff 同一组）', () => {
  it('UTF-8（无 BOM / 带 BOM）都解得出，BOM 不会漏进正文', () => {
    const plain = createBasicHtmlDocument(encode('<p>无 BOM</p>'))
    expect(plain).toContain('无 BOM')
    const withBom = createBasicHtmlDocument(
      new Uint8Array([0xef, 0xbb, 0xbf, ...encode('<p>有 BOM</p>')])
    )
    expect(withBom).toContain('有 BOM')
    expect(withBom).not.toContain('\uFEFF')
  })

  it.each([
    ['UTF-16LE', false],
    ['UTF-16BE', true]
  ] as const)('%s（带 BOM）：解得出正文，且清洗照样生效', (_name, be) => {
    const doc = createBasicHtmlDocument(
      utf16('<html><body><p>十六位正文</p><script>x</script></body></html>', be)
    )
    expect(doc).toContain('十六位正文')
    expect(doc).not.toMatch(/<script/i)
  })

  it('UTF-16 带 BOM 的恶意件：外部 URL 同样不留在输出里', () => {
    const doc = createBasicHtmlDocument(
      utf16('<html><body><img src="https://evil.example/t.png"></body></html>')
    )
    expect(doc).not.toContain('evil.example')
  })

  it('无效 UTF-8（无 BOM）：抛错，不做替换字符兜底', () => {
    expect(() => createBasicHtmlDocument(new Uint8Array([0xc3, 0x28, 0x3c, 0x70, 0x3e]))).toThrow()
    expect(() => createBasicHtmlDocument(new Uint8Array([0x80, 0x80]))).toThrow()
  })

  it('UTF-16 但不带 BOM：**不猜编码** —— 解出来带 NUL（ASCII 后全跟 NUL，字节全都合法 UTF-8）→ 拒收', () => {
    // 这种误编码里每个字节都是合法 UTF-8，fatal 拦不住 —— 判据是解出来的正文里有 NUL
    expect(() => createBasicHtmlDocument(utf16NoBom('<p>no bom</p>'))).toThrow()
    // 恶意正文同样拒收：不会以任何形态（元素或转义文本）走到 frame
    expect(() =>
      createBasicHtmlDocument(utf16NoBom('<img src="https://evil.example/x.png">'))
    ).toThrow()
  })
})

describe('DshHtmlViewer：隔离 frame', () => {
  it('valid bytes → sandbox="" 的 iframe，srcdoc 里带着洗过的文档', () => {
    render(<DshHtmlViewer bytes={encode(SOURCE)} />)
    const frame = screen.getByTestId('dsh-html-preview')
    expect(frame.tagName).toBe('IFRAME')
    // 一个权限都不给：无脚本、无同源、无表单、无弹窗（`allow=""` 再收掉设备类能力）
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('allow')).toBe('')
    const srcdoc = frame.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain("script-src 'none'")
    expect(srcdoc).not.toMatch(/<script/i)
  })

  it('恶意件：srcdoc 里没有外部 URL（字符串层面就先掐掉）', () => {
    render(<DshHtmlViewer bytes={encode(HOSTILE)} />)
    const srcdoc = screen.getByTestId('dsh-html-preview').getAttribute('srcdoc') ?? ''
    expect(srcdoc).not.toMatch(/https?:\/\//i)
    expect(srcdoc).toContain('Content-Security-Policy')
  })

  it('读不出来（无效字节）→ 人话（不空白、也不硬塞半份乱码进 frame）', () => {
    render(<DshHtmlViewer bytes={new Uint8Array([0xc3, 0x28])} />)
    expect(screen.getByTestId('dsh-html-error')).toHaveTextContent('读不出来')
    expect(screen.queryByTestId('dsh-html-preview')).toBeNull()
  })

  it('UTF-16 但不带 BOM（恶意正文）同样读不出来：人话 + 没有 frame（不会以转义文本混进来）', () => {
    render(<DshHtmlViewer bytes={utf16NoBom('<img src="https://evil.example/x.png">')} />)
    expect(screen.getByTestId('dsh-html-error')).toHaveTextContent('读不出来')
    expect(screen.queryByTestId('dsh-html-preview')).toBeNull()
  })

  it('UTF-16LE（带 BOM）能进 frame（与主进程 sniff 的口径一致）', () => {
    render(<DshHtmlViewer bytes={utf16('<html><body><p>十六位</p></body></html>')} />)
    const srcdoc = screen.getByTestId('dsh-html-preview').getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('十六位')
  })
})

/** 顺带钉住"没有 dangerouslySetInnerHTML"这条口径：HTML 只进 iframe 属性，不进应用 DOM。 */
describe('DshHtmlViewer：HTML 不进应用 DOM', () => {
  it('渲染之后容器里只有 iframe，没有源件的元素', () => {
    const { container } = render(<DshHtmlViewer bytes={encode(SOURCE)} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    // 连"正文"这两个字都不在应用 DOM 里（只躺在 srcdoc 属性值里）
    expect(container.textContent).not.toContain('正文')
  })

  it('换一份字节会重算文档（引用身份变化即换文）', () => {
    const first = encode('<p>第一份</p>')
    const { rerender } = render(<DshHtmlViewer bytes={first} />)
    expect(screen.getByTestId('dsh-html-preview').getAttribute('srcdoc')).toContain('第一份')
    const second = encode('<p>第二份</p>')
    rerender(<DshHtmlViewer bytes={second} />)
    const srcdoc = screen.getByTestId('dsh-html-preview').getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('第二份')
    expect(srcdoc).not.toContain('第一份')
  })

  it('外链 href 已删，文内锚点还在：可点的只有同一份文档内的跳转', () => {
    render(<DshHtmlViewer bytes={encode(SOURCE)} />)
    const srcdoc = screen.getByTestId('dsh-html-preview').getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('点我')
    expect(srcdoc).not.toMatch(/<a[^>]*href="https?:/i)
  })
})

/** jsdom 不做真导航：这里只确认 frame 是"数据进属性、不触发加载事件"的路子。 */
describe('DshHtmlViewer：frame 不触发应用侧动作', () => {
  it('srcdoc 属性在渲染后就能读到（不需要等加载）', () => {
    render(<DshHtmlViewer bytes={encode('<p>ok</p>')} />)
    const frame = screen.getByTestId('dsh-html-preview') as HTMLIFrameElement
    expect(frame.getAttribute('srcdoc')).toBeTruthy()
    // 没有 src：不会去取任何 URL
    expect(frame.getAttribute('src')).toBeNull()
    fireEvent.load(frame)
    expect(screen.getByTestId('dsh-html-preview')).toBeInTheDocument()
  })
})
