/**
 * HTML 静态预览的文档装配（清洗 + 自带 CSP）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/html/basic-document.ts` 与同目录 `bytes.ts`。
 * 这就是 DSH README 里 "interactivePreview Off" 那条**静态预览**路。
 *
 * ## 输出的性质（可测）+ 这道闸的边界
 *
 * 凡是**已知形态**的资源承载属性（`src`/`srcset`/`poster`/`action`/`formaction`/`background`/`ping` …）
 * 与 CSS 外链（`@import`、`url(...)`、`image-set(...)`，**含反斜杠转义的保守退回**）都被抹掉 ——
 * 测试按字符串钉住的就是这些形态。
 *
 * **但不要读成"绝对没有外部 URL"**：这是正则式的处理，CSS 又是门很宽的语言（解析器差异、实验性函数、
 * 没覆盖到的载体都可能绕过）。所以：
 *   - **CSP 与 `sandbox=""` 不是"补充层"，而是必须边界** —— 漏过上面这一层的请求由它们挡；
 *   - 真实浏览器里的负向验证见 `e2e/_html-preview-csp-probe.spec.ts`（**默认跳过**；它在 Chromium 里
 *     用"同一份恶意文档 ± 我们的 CSP"做差分：控制组真发出请求、CSP 组零请求才算数）；
 *   - **没跑到就不算**：本轮没跑浏览器，这些断言与探针都还是待验状态。
 *
 * ## 三层各管什么（**没有任何一层声称"单独绝对"**）
 *
 *   1) **清洗 + 资源抹除**（本文件）：删脚本/框架/表单承载物/外链承载物，并把已知形态的外部 URL 抹净
 *      —— 这一层给出的是**内容性质**（可测：字符串里没有那些形态）；
 *   2) **文档自带 CSP**（常量住在 `./basic-csp.ts`，与真机探针**共用同一份**，逐条不改）：
      `default-src 'none'` … —— 兜住第 1 层漏掉的形态；
 *   3) **iframe `sandbox=""`**（见 `html-viewer.tsx`）：一个权限都不给的独立浏览上下文。
 *
 * 一条**不在这三层里的已知限制**（照实写）：点击型外链（`)` 里的 `<a href="https://…">`）**不由
 * CSP 兜** —— Chromium 没有实现 `navigate-to`，而 `sandbox=""` 允许**帧内自我导航**。它靠的是
 * 第 1 层里那条**属性白名单**（DOM 解析后按元素分档判，不受 CSS 转义影响）：`<a>/<area>` 只留
 * `#锚点`。也就是说这条依赖"属性层没被改坏"，不是"平台替我挡"。
 *
 * ## 为什么仍在 DOMParser 里过一遍、而不是 RETURN_DOM / innerHTML
 *
 * DOMPurify 的 `RETURN_DOM` 系列会把节点建在**应用文档**里；"在应用文档里解析"这一路恰恰是历史上
 * 会提前触发资源请求的写法。这里坚持"字符串进、字符串出"，中间那次 `DOMParser` 得到的是**没有浏览
 * 上下文的惰性文档**（规范上不为它取子资源 —— 但这条**依赖引擎实现**，所以第 1 层的"输出里没有外部
 * URL"才是我们要的保证；本轮没有浏览器实测，不拿惰性文档当安全论据）。
 *
 * 与上游的两处差异（都在安全侧）：
 *   - 额外把 `template` 列进 `FORBID_TAGS`：上游 README 写了"声明式 shadow root 会在重新解析前被去掉"，
 *     但它的保留清单里没有 `template`；这里按那句话的本意**真删**（`<template shadowrootmode>` 是声明式
 *     shadow root 的载体，静态预览里没有它的合理用途）。
 *   - 解码按 **BOM 明示**走：UTF-8（含 BOM）或 UTF-16LE/BE（带 BOM），无效序列抛错交给调用方给人话，
 *     **不做替换字符兜底**、**不猜编码**；解出来带 U+0000 的同样抛错（不带 BOM 的 UTF-16 过了 UTF-8
 *     的解就是这种形态 —— 每个字节都合法，只有 NUL 抓得住）。与主进程 `sniffFormat` 接受的那一组
 *     **逐项一致**（那边也是"UTF-8 / UTF-16LE·BE 且带 BOM"，不带 BOM 的 UTF-16 两边都不认）。
 */
import DOMPurify from 'dompurify'
import { HTML_PREVIEW_CSP } from './basic-csp'

/** 静态预览里一律删掉的标签（含承载外链、表单与嵌套文档能力的那些）。 */
const FORBID_TAGS = [
  'noscript',
  'base',
  'link',
  'meta',
  'iframe',
  'frame',
  'object',
  'embed',
  'template',
  'set',
  'animate',
  'animateMotion',
  'animateTransform'
]

/**
 * 一律删掉的属性：这些属性**本身就是一条请求或一次动作**，不看它的 URL 长什么样。
 *   - `srcset` / `imagesrcset` / `data-srcset`：候选列表要按规范解析（`data:` 里就带逗号），
 *     解析错了会漏，所以整条删掉（静态预览用不上响应式候选）；
 *   - `poster` / `data-src` / `data-poster` / `data-background` / `lowsrc` / `dynsrc`：媒体与懒加载载体；
 *   - `action` / `formaction`：表单动作（`sandbox=""` 与 CSP 也会挡，但这里先删干净）；
 *   - `ping`（点击外发）、`manifest`、`srcdoc`、`background`（老式背景图）；
 *   - `http-equiv` / `content`：`<meta>` 已被 `FORBID_TAGS` 删掉，这两条是兜底。
 *
 * `href` / `xlink:href` **不在**这张表里：它们按"是不是导航元素"分档判（见 `hrefAllowed`）——
 * `<a>` / `<area>` 只留文档内锚点 `#id`，`<use>` / `<image>` 这类资源引用连 `data:` 也放行
 * （内联 sprite 与内联图照常显示）。外链 href 由 `ALLOWED_URI_REGEXP` 与 `scrubDocument` 两层删掉。
 */
const RESOURCE_ATTRS = [
  'srcset',
  'imagesrcset',
  'data-srcset',
  'poster',
  'data-src',
  'data-poster',
  'data-background',
  'lowsrc',
  'dynsrc',
  'action',
  'formaction',
  'ping',
  'manifest',
  'srcdoc',
  'background',
  'http-equiv',
  'content'
]

/**
 * 允许保留的 URL：**只认内联 `data:` 与文档内锚点 `#id`**。
 * 相对路径（`img/a.png`）、协议相对（`//host/x`）、各种协议（http/https/file/blob/ftp…）一律抹掉 ——
 * 这份文档在 iframe 里的 base URL 是**应用自己**，相对路径同样是一次本机/网络请求。
 */
const ALLOWED_URI = /^(?:data:|#)/i

/** 抹 URL 时要再扫一遍的属性（配置级已删大半，这里是"配置万一被改坏"的第二次机会） */
const URI_ATTRS = [
  'src',
  'href',
  'xlink:href',
  'poster',
  'action',
  'formaction',
  'data',
  'background',
  'ping',
  'manifest',
  'srcdoc',
  'srcset',
  'imagesrcset'
]

/** URL 值是否允许保留（先去掉控制字符与空白：` \n da\tta:` 这类写法不做解码猜测，直接不认） */
function urlAllowed(value: string): boolean {
  const text = stripUrlNoise(value)
  return text !== '' && ALLOWED_URI.test(text)
}

/**
 * 去掉空白与控制字符：` \n da\tta:` / `java\0script:` 这类"把字符藏起来"的写法一律还原成普通串再判。
 * 用循环而不是正则：`no-control-regex` 就是为了提醒"控制字符出现在正则里通常是写错了"，这里是有意的。
 */
function stripUrlNoise(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code > 0x20 && code !== 0x7f) out += char
  }
  return out
}

/** 一段 CSS 里有没有"会被取的外部 URL"（`url(...)` 或 image-set 里的裸字符串候选） */
function hasExternalUrl(css: string): boolean {
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!urlAllowed(match[2] ?? '')) return true
  }
  // image-set / -webkit-image-set 的候选可以是裸字符串：`image-set("http://x" 1x)`
  for (const match of css.matchAll(/["']([^"']*)["']/g)) {
    if (!urlAllowed(match[1] ?? '')) return true
  }
  return false
}

/**
 * CSS 反斜杠转义的**粗略还原**（`\68 ttp` → `http`、`\75 rl` → `url`、`@\69 mport` → `@import`）。
 * 只用于**检测**，不用于改写：这不是 CSS 解析器，只处理"十六进制转义"与"单字符转义"两种写法。
 */
function unescapeCss(css: string): string {
  return css.replace(
    /\\(?:([0-9a-f]{1,6})\s?|(.))/gi,
    (_all: string, hex: string | undefined, plain: string | undefined) =>
      hex === undefined ? (plain ?? '') : String.fromCodePoint(Number.parseInt(hex, 16) || 0)
  )
}

/**
 * 转义旁路的**保守退回**：正则那几趟认不出 `\75 rl(...)` / `url\28 ...` / `@\69 mport` 这类写法，
 * 所以先看"这份 CSS 里有没有反斜杠"，有就把转义粗略还原一遍、**只对 url()/@import/image-set 三个
 * 载体**再查一次外链 —— 查出来就**整段样式退回 `none`**（宁可这段样式失效，也不让一条请求溜出去）。
 *
 * 为什么不用"整段有反斜杠就丢"：`content: "\201C"` 这类正常转义很常见，丢它们是白丢；
 * 为什么不用"逐条声明删"：那需要真解析 CSS（本轮明确不重造）。
 * **这条仍然不是穷尽**：CSS 是门很宽的语言，解析器差异与实验性函数都可能绕过；
 * 所以 CSP 与 sandbox 不是"补充"，而是**必须边界**（见文件头）。
 */
function cssEscapeNeedsFallback(css: string): boolean {
  if (!css.includes('\\')) return false
  const decoded = unescapeCss(css)
  for (const match of decoded.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!urlAllowed(match[2] ?? '')) return true
  }
  for (const call of decoded.matchAll(/(?:-webkit-)?image-set\(([^()]*)\)/gi)) {
    for (const quoted of (call[1] ?? '').matchAll(/["']([^"']*)["']/g)) {
      if (!urlAllowed(quoted[1] ?? '')) return true
    }
  }
  // `@import` 后面是相对路径 / 外链 / 协议相对：一并退回（data: 与 #锚点没有意义，也退回）
  for (const match of decoded.matchAll(/@import[^;]*;?/gi)) {
    const target = /url\(\s*(['"]?)([^'")\s;]*)\1|["']([^"']*)["']|([^\s;'")]+)/i.exec(match[0])
    const value = target?.[2] ?? target?.[3] ?? target?.[4] ?? ''
    if (!urlAllowed(value)) return true
  }
  return false
}

/**
 * `href` 分档：`<a>` / `<area>` 是**导航**，只留 `#锚点`（点一下不会离开本文档）；
 * 其余（SVG 的 `<use>` / `<image>` 这类**资源引用**）连 `data:` 也放行（内联 sprite / 内联图照常显示）。
 */
function hrefAllowed(tag: string, value: string): boolean {
  const text = stripUrlNoise(value)
  return tag === 'a' || tag === 'area' ? text.startsWith('#') : urlAllowed(text)
}

/**
 * 把 `name(...)` 形式的函数调用（**含嵌套括号**）整段交给 `replace`。
 * 为什么不用一条正则：`image-set(url(data:…) 1x, "http://x" 2x)` 里的括号是配对的，`[^()]*` 匹配不到，
 * 那样会漏掉裸字符串候选。这里只做括号计数，不去理解 CSS 语义。
 */
function replaceCalls(
  css: string,
  names: readonly string[],
  replace: (call: string) => string
): string {
  let out = css
  for (const name of names) {
    let from = 0
    for (;;) {
      const at = out.toLowerCase().indexOf(`${name}(`, from)
      if (at < 0) break
      const open = at + name.length
      let depth = 0
      let end = -1
      for (let index = open; index < out.length; index += 1) {
        const char = out[index]
        if (char === '(') depth += 1
        else if (char === ')') {
          depth -= 1
          if (depth === 0) {
            end = index
            break
          }
        }
      }
      if (end < 0) break // 括号不闭合：不猜，原样留下
      const call = out.slice(at, end + 1)
      const next = replace(call)
      out = out.slice(0, at) + next + out.slice(end + 1)
      from = at + Math.max(next.length, 1)
    }
  }
  return out
}

/**
 * 处理一段 CSS：删 `@import`，把非 `data:` / 非锚点的 `url(...)` 换成 `none`，
 * 含外链候选的 `image-set(...)`（含嵌套括号与裸字符串候选）整段换成 `none`。
 * **其余静态样式原样保留**（布局、配色、字号都在）。
 *
 * 没覆盖的：CSS 里别的"能带 URL 的函数"（如实验性的 `image()`）—— Chromium 不实现它，
 * 而且这里只删不认，真有异常值最多是样式失效，不会变成一次请求（这条按未验登记）。
 */
function scrubCss(css: string): string {
  // 转义旁路：先保守退回（整段 styles 变 `none`），再走下面那几趟常规处理
  if (cssEscapeNeedsFallback(css)) return 'none'
  const withoutImports = css
    // `@import` 是一条样式表请求，整条删（含分号缺省与带 media 的写法）
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole: string, _quote: string, value: string) =>
      urlAllowed(value) ? whole : 'none'
    )
  return replaceCalls(withoutImports, ['image-set', '-webkit-image-set'], (call) =>
    hasExternalUrl(call) ? 'none' : call
  )
}

/** 在惰性文档里做第二次复验 + CSS 处理（不进应用文档：只在 DOMParser 得到的这棵树里动） */
function scrubDocument(parsed: Document): void {
  for (const element of parsed.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase()
    for (const name of URI_ATTRS) {
      const value = element.getAttribute(name)
      if (value === null) continue
      let ok: boolean
      if (name === 'href' || name === 'xlink:href') {
        ok = hrefAllowed(tag, value)
      } else {
        // srcset 一律不留（见 RESOURCE_ATTRS 的说明），其余按白名单
        ok = name !== 'srcset' && name !== 'imagesrcset' && urlAllowed(value)
      }
      if (!ok) element.removeAttribute(name)
    }
    const style = element.getAttribute('style')
    if (style !== null) element.setAttribute('style', scrubCss(style))
  }
  for (const style of parsed.querySelectorAll('style')) {
    style.textContent = scrubCss(style.textContent ?? '')
  }
}

/**
 * 按 BOM 决定编码并整份解码；无效字节序列、以及**解出来带 U+0000 的**抛错（调用方翻成人话）。
 * @param data 完整字节。
 * @returns 解码后的文本（保证不含 U+0000）。
 */
export function decodeText(data: Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const [b0, b1, b2] = [bytes[0], bytes[1], bytes[2]]
  let text: string
  // BOM 明示：UTF-8（EF BB BF）/ UTF-16LE（FF FE）/ UTF-16BE（FE FF）
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3))
  } else if (b0 === 0xff && b1 === 0xfe) {
    text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
  } else if (b0 === 0xfe && b1 === 0xff) {
    text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
  } else {
    // 没有 BOM：只按 UTF-8 严格解（UTF-16 不带 BOM 不猜 —— 猜错就是半份乱码）
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  // U+0000 不是能显示的正文（HTML 解析器把它当解析错误，静默丢掉）。解出来带 NUL 的，几乎总是不带 BOM
  // 的 UTF-16 过了 UTF-8 的解 —— ASCII 字符后面全跟一个 NUL，每个字节都是合法 UTF-8，`fatal` 拦不住，
  // 光靠字节合法性抓不出来；按"读不出来"拒收（fail closed，与主进程 sniff 的"不认"两边一致）。
  if (text.includes('\u0000')) {
    throw new Error('解码结果含 U+0000（多半是不带 BOM 的 UTF-16 或二进制残渣）')
  }
  return text
}

/**
 * 把一份 HTML 字节洗成"无脚本、无外链承载、无表单动作"的静态文档。
 * @param data 完整 HTML 字节（UTF-8，或带 BOM 的 UTF-16LE/BE）。
 * @returns 以 CSP meta 开头的完整文档字符串（CSP 排在 head 最前）；已知形态的外部 URL 都不留在里面，
 *   **但不宣称穷尽** —— 漏网的由那份 CSP 与 iframe 的 `sandbox=""` 兜（见文件头的边界说明）。
 */
export function createBasicHtmlDocument(data: Uint8Array): string {
  const clean = DOMPurify.sanitize(decodeText(data), {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS,
    // 配置级预去除：外链承载属性在这里就没了（不是靠后面的 CSP 兜）
    FORBID_ATTR: [...RESOURCE_ATTRS],
    // 只放行 data: 与 #锚点；https/相对/协议相对/javascript 一律判不合法 → 直接删属性
    ALLOWED_URI_REGEXP: ALLOWED_URI
  })
  const parsed = new DOMParser().parseFromString(clean, 'text/html')
  scrubDocument(parsed)
  const policy = parsed.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', HTML_PREVIEW_CSP)
  parsed.head.prepend(policy)
  return `<!doctype html>${parsed.documentElement.outerHTML}`
}
