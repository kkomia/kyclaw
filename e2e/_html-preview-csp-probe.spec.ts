import { chromium, expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { HTML_PREVIEW_CSP } from '../src/renderer/src/features/workbench/preview/dsh-media/basic-csp'

/**
 * HTML 静态预览的**网络边界**真机探针（Chromium）：**默认跳过**，`KYCLAW_HTML_CSP_PROBE=1` 才跑。
 *
 * ## 它在这条链的验收里属于哪一层（别把三层读成一层）
 *
 * | 层 | 验什么 | 在哪 | 现状 |
 * |---|---|---|---|
 * | **A 内容性质** | 产品那份 `createBasicHtmlDocument` 的**输出字符串**里没有已知形态的外部 URL（含转义退回） | `dsh-media/__tests__/html.spec.tsx`（jsdom） | 已写，已跑绿 |
 * | **B 平台边界** | 就算字符串层漏了，**CSP + `sandbox=""`** 在真浏览器里把"自动取资源"的向量挡成**网络层零命中** | **本文件**（真 Chromium + 本机服务器当网络真值） | 已写，已跑绿 |
 * | **C 端到端** | srcdoc **由产品自己的 `createBasicHtmlDocument` 生成**，再走 B 那套测量 | 本文件（要产品构建：该函数依赖 DOMPurify + DOMParser，跑在页面里） | **未做**，由 R90 在下一测试槽验，**不伪称已验** |
 *
 * 也就是说：**本文件现在只量 B**——它构造的三份文档是手写的（只共用产品那条 CSP 常量，
 * `basic-csp.ts` 唯一出处，不许复制字面量），**不是**产品函数的产物。
 * 在那之前下面这些断言**不能**被读成"产品的 HTML 预览端到端安全"。
 *
 * ## 为什么 B 层值得单独量
 *
 * `dsh-media/html-document.ts` 的清算是**正则式**的：`@import` / `url(...)` / `image-set(...)` 的
 * 常见形态能抹掉（含反斜杠转义的保守退回），但 CSS 是门很宽的语言，解析器差异与实验性函数都可能漏。
 * 那层只承诺"已知形态"，**CSP 与 `sandbox=""` 才是必须边界** —— 那么"它们到底挡不挡得住"就必须在
 * 真浏览器里量。
 *
 * ## 判据为什么是"本机服务器命中"而不是 `page.on('request')`（实测，Chromium 156）
 *
 * 反直觉发现（本探针第一版就是这么红的）：**被 CSP 拦下的 img，`page.on('request')` 照样发事件**
 * （连 `requestfailed` 也发，与违规提示同一毫秒），但网络栈根本没收到它 —— 本机服务器计数为 0、
 * `page.route` 回调 0 次。拿 `page.on('request')` 数"出网"会把"CSP 正常拦截"误报成"仍在请求"。
 * 所以真值取**本机 HTTP 服务器收到了几条**（物理上到没到网络），`page.on('request')` 只留作
 * ③ 的"幽灵事件"诊断。另一个实测坑：父页面若是 `about:blank`（不透明源），Chromium 的
 * **Local Network Access** 权限门会把到 `127.0.0.1` 的子资源整个拦掉（阳性对照也零命中）——
 * 所以父页面由同一台本机服务器提供（127.0.0.1 侧起、侧收，不过 LNA，也不需要任何启动旗标）。
 *
 * ## 设计（差分，避免"零命中"被误读）
 *
 *   ① **benign + CSP**：普通文档 + 我们的 CSP → 帧要能加载、`data:` 图要真画出来（否则"没出网"可能
 *      只是"帧根本没起来"）；
 *   ② **hostile（同一份恶意正文）不带 CSP**：外链 img / srcset / poster / 内联 style url /
 *      **转义 CSS url** / **转义 @import** → 期望**本机服务器真的收到**（证明记录器与夹具都活着；
 *      ③ 的"零"才不是"没人试过"）；
 *   ③ **hostile + 我们的 CSP**（正文逐字相同）→ 期望**服务器零命中**；③ 与 ② 只差一个 meta，所以
 *      "零"是 CSP 造成的。同时要求 CSP 违规提示 ≥3 条（三个核心向量都被"尝试并拦下"）。
 *
 * 本探针**只连本机 127.0.0.1**（没有外部地址、没有出网、不需要 `route.abort`；夹具里的转义
 * `\68 ttp` / `@\69 mport` 同样指回本机服务器）。
 *
 * ## 前提 / 边界
 *
 * - 用 Playwright 自带的 Chromium（与应用内嵌的 Chromium 同一套 CSP/sandbox 语义，版本可能不同）；
 *   探针**不在应用渲染端里跑**：应用那份 CSP（`index.html` 的 `default-src 'self'` 等）会被 srcdoc 帧
 *   **继承**，那会更严 —— 换句话说这里量的是"我们这份构造自己扛不扛得住"，不含应用 CSP 的加成。
 * - **点击型外链不在本探针的断言里**：Chromium 没实现 CSP 的 `navigate-to`，`sandbox=""` 也允许
 *   帧内自我导航 —— 那条靠属性白名单（`<a>` 只留 `#锚点`），不是靠 CSP。要量它得单独设计（含点击）。
 * - 跑法：`KYCLAW_HTML_CSP_PROBE=1 pnpm exec playwright test e2e/_html-preview-csp-probe.spec.ts`
 *   （已装 Chromium 时不需要再下载）。证据（三档截图 + 命中/违规清单）落
 *   `.superpowers/html-preview-csp/<时间戳>/`（本地目录，不入库）。
 */
const enabled = process.env.KYCLAW_HTML_CSP_PROBE === '1'

/** 1×1 真 PNG（base64 到处共用：data: 正对照 + 本机服务器对图片路径的响应体） */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

/**
 * 恶意正文：常见形态 + **转义形态**（后者是正则式清算可能漏掉的）。全部指向本机服务器。
 * `@import` 按 CSS 规则必须排在其它规则**之前**——排在后面即使无 CSP 也不加载，夹具自身要有效。
 */
const hostileBody = (base: string): string => {
  const port = new URL(base).port
  return [
    `<img src="${base}/plain.png" alt="plain">`,
    `<img srcset="${base}/set.png 1x" alt="set">`,
    `<video poster="${base}/poster.png"></video>`,
    `<p style="background: url(${base}/inline.png)">inline</p>`,
    `<!-- \\68 ttp = http、\\69 mport = import：产品那层正则认不出来，靠 CSP 兜 -->`,
    `<style>@\\69 mport url("${base}/escaped-import.css"); body{background:url(\\68 ttp://127.0.0.1:${port}/escaped-url.png)}</style>`
  ].join('\n')
}

const BENIGN_BODY = `<p id="probe-ok">ok</p><img id="probe-pic" alt="pic" src="${TINY_PNG_DATA_URL}">`

/** 把正文装成我们那种文档（`withCsp` 决定有没有那条 meta —— ①/③ 有、② 没有） */
function documentOf(body: string, withCsp: boolean): string {
  const policy = withCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`
    : ''
  return `<!doctype html><html><head>${policy}</head><body>${body}</body></html>`
}

test.describe('HTML 静态预览：网络边界（Chromium 探针）', () => {
  test.skip(
    !enabled,
    'KYCLAW_HTML_CSP_PROBE=1 时才跑（真 Chromium 里量 CSP/sandbox 的拦截，约十几秒）'
  )

  test('同一份恶意文档：不带 CSP 会出网，带我们的 CSP 网络层零命中', async () => {
    test.setTimeout(120_000)
    const outDir = join('.superpowers', 'html-preview-csp', String(Date.now()))
    mkdirSync(outDir, { recursive: true })
    console.log(`[probe] 证据目录：${outDir}`)

    /** 网络层真值：本机服务器收到的路径（物理上到没到网络，就看这一份） */
    const serverHits: string[] = []
    const server = createServer((request, response) => {
      serverHits.push(request.url ?? '/')
      if (request.url === '/harness.html') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><html><body><h1>harness</h1></body></html>')
        return
      }
      if ((request.url ?? '').endsWith('.css')) {
        response.writeHead(200, { 'content-type': 'text/css' })
        response.end('')
        return
      }
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(Buffer.from(TINY_PNG_BASE64, 'base64'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('拿不到本机探针服务器的端口')
    }
    const base = `http://127.0.0.1:${address.port}`

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      /** ③ 的"幽灵事件"诊断：被 CSP 拦下的 img 也会在 page 级发 request（别当判据，见文件头） */
      let ghosts: string[] = []
      /** 渲染端控制台（CSP 违规会在这里留话，是"向量被尝试并拦下"的证据） */
      const consoleLines: string[] = []
      page.on('request', (request) => {
        const url = request.url()
        if (url.startsWith(`${base}/`) && url !== `${base}/harness.html`) ghosts.push(url)
      })
      page.on('console', (message) => consoleLines.push(message.text()))

      // 父页面必须由本机服务器同源提供：about:blank 作父时本地网络会被 LNA 权限门拦掉（见文件头）
      await page.goto(`${base}/harness.html`)
      serverHits.length = 0

      /** 插一个 sandbox="" 的 srcdoc 帧（与 `html-viewer.tsx` 同一套属性） */
      const inject = async (marker: string, html: string): Promise<void> => {
        await page.evaluate(
          ({ marker: name, html: content }) => {
            const frame = document.createElement('iframe')
            frame.setAttribute('sandbox', '')
            frame.setAttribute('data-probe', name)
            frame.setAttribute('referrerpolicy', 'no-referrer')
            frame.style.cssText = 'width:320px;height:200px;border:0'
            document.body.append(frame)
            frame.srcdoc = content
          },
          { marker, html }
        )
      }
      const drop = async (marker: string): Promise<void> => {
        await page.evaluate((name) => {
          document.querySelector(`iframe[data-probe="${name}"]`)?.remove()
        }, marker)
      }
      const settle = (): Promise<void> => page.waitForTimeout(1000)

      // ① 正对照：普通文档 + CSP —— 帧要真的起来，data: 图要真的画出来
      await inject('benign', documentOf(BENIGN_BODY, true))
      await settle()
      const benign = page.frameLocator('iframe[data-probe="benign"]')
      await expect(benign.locator('#probe-ok')).toBeVisible()
      const naturalWidth = await benign
        .locator('#probe-pic')
        .evaluate((element) => (element as HTMLImageElement).naturalWidth)
      expect(naturalWidth, 'data: 图应当在 sandbox 帧里画出来').toBeGreaterThan(0)
      console.log(
        `[probe] ① 正对照：帧可加载、data: 图 ${naturalWidth}px 宽、服务器命中 ${serverHits.length} 条`
      )
      await page.screenshot({ path: join(outDir, '01-benign-csp.png') })
      await drop('benign')
      serverHits.length = 0

      // ② 灵敏度对照：同一份恶意正文，**不带** CSP → 本机服务器必须真的收到
      await inject('hostile-open', documentOf(hostileBody(base), false))
      await settle()
      const attempted = [...serverHits]
      console.log(
        `[probe] ② 不带 CSP：服务器命中 ${attempted.length} 条 → ${attempted.join(' | ')}`
      )
      expect(attempted, '不带 CSP 时本机服务器应收到这些向量 —— 记录器与夹具的阳性对照').toEqual(
        expect.arrayContaining(['/plain.png', '/escaped-url.png', '/escaped-import.css'])
      )
      await page.screenshot({ path: join(outDir, '02-hostile-no-csp.png') })
      writeFileSync(join(outDir, '02-hostile-no-csp.hits.txt'), `${attempted.join('\n')}\n`)
      await drop('hostile-open')
      serverHits.length = 0

      // ③ 必须边界：正文逐字相同，只多一条我们的 CSP → 网络层零命中；违规提示证明"尝试并拦下"
      ghosts = []
      const consoleMark = consoleLines.length
      await inject('hostile-csp', documentOf(hostileBody(base), true))
      await settle()
      const blocked = [...serverHits]
      const violations = consoleLines
        .slice(consoleMark)
        .filter((line) => /Content Security Policy/.test(line))
      console.log(
        `[probe] ③ 带我们的 CSP：服务器命中 ${blocked.length} 条；CSP 违规提示 ${violations.length} 条；` +
          `幽灵 request ${ghosts.length} 条（被拦的 img 也发事件，不当判据）`
      )
      await expect(
        page.frameLocator('iframe[data-probe="hostile-csp"]').locator('body')
      ).toBeAttached()
      expect(blocked, '带 CSP 时本机服务器不该收到任何向量请求').toEqual([])
      expect(
        violations.length,
        '② 里能加载的向量在 ③ 都应被 CSP 拦出违规提示（零命中不等于没人试过）'
      ).toBeGreaterThanOrEqual(3)
      await page.screenshot({ path: join(outDir, '03-hostile-with-csp.png') })
      writeFileSync(
        join(outDir, '03-hostile-with-csp.log.txt'),
        [
          `server hits: ${blocked.length}`,
          `violations: ${violations.length}`,
          `ghost requests: ${ghosts.length}`,
          ...violations.map((line) => `  ${line.slice(0, 200)}`)
        ].join('\n') + '\n'
      )
      await drop('hostile-csp')
    } finally {
      await browser.close()
      server.close()
    }
  })
})
