import { describe, expect, it } from 'vitest'
import {
  EMPTY_KNOWN_SOURCES,
  MAX_SOURCES,
  SOURCE_SNIPPET_CHARS,
  citationContextsFromText,
  citationKey,
  citationLabel,
  clipSnippet,
  decodeHtmlEntities,
  extractCitations,
  extractCitationsFromTexts,
  hostOf,
  knownSourcesFromParts,
  mergeKnownSources,
  parseFetchSource,
  parseWebSearchSources,
  safeHttpUrl,
  type CitationHint
} from '../citations'

/**
 * 0.1.3 网页引用：纯解析口径。
 *
 * 这一组不渲染 DOM，钉的是**协议、安全边界与 provenance**：
 * 正文 URL 不授权来源；只有命中已完成工具结果 allowlist 的数字链接才算来源；
 * 代码 / reference / HTML 实体与渲染口径一致；web_search / fetch 的 allowlist 建立。
 */
const SEARCH_OUTPUT = [
  '联网搜索「巴黎人口」（后端：免费档）',
  '',
  '1. Paris - Wikipedia',
  '   URL: https://example.org/paris',
  '   发布: 2026-10-01',
  '   摘要: 巴黎是法国的首都，人口约 210 万。',
  '',
  '2. Paris history',
  '   URL: https://example.org/paris/history?page=2',
  '   摘要: 历史段落。'
].join('\n')

function keyOf(url: string): string {
  return citationKey(url) ?? ''
}

/** 建一份只有 URL、没有展示信息的 allowlist（证明"键存在即授权"） */
function known(...urls: string[]): Map<string, CitationHint> {
  return new Map(urls.map((url) => [keyOf(url), {}]))
}

function knownWith(entries: [string, CitationHint][]): Map<string, CitationHint> {
  return new Map(entries.map(([url, hint]) => [keyOf(url), hint]))
}

describe('citationLabel：只认 1–3 位数字', () => {
  it('接受 1 / [12] / ^3 与模型套的加粗', () => {
    expect(citationLabel('1')).toBe('1')
    expect(citationLabel('[12]')).toBe('12')
    expect(citationLabel('^3')).toBe('3')
    expect(citationLabel('**1**')).toBe('1')
    expect(citationLabel(' 7 ')).toBe('7')
  })

  it('普通链接文本 / 4 位数字 / 小数 / 空串不算', () => {
    expect(citationLabel('Wikipedia')).toBeUndefined()
    expect(citationLabel('1234')).toBeUndefined()
    expect(citationLabel('1.2')).toBeUndefined()
    expect(citationLabel('')).toBeUndefined()
    expect(citationLabel('[1')).toBeUndefined()
  })

  it('HTML 实体按渲染结果解码（&#49; 就是 1）', () => {
    expect(citationLabel('&#49;')).toBe('1')
    expect(citationLabel('&#x31;')).toBe('1')
  })
})

describe('safeHttpUrl / hostOf：只放行带主机名的 http(s)', () => {
  it('接受 http / https，返回 URL 规范化后的 href', () => {
    expect(safeHttpUrl('https://example.org/a')).toBe('https://example.org/a')
    expect(safeHttpUrl('http://example.org')).toBe('http://example.org/')
    expect(safeHttpUrl('HTTPS://EXAMPLE.ORG/a')).toBe('https://example.org/a')
    expect(safeHttpUrl('  https://example.org/x  ')).toBe('https://example.org/x')
  })

  it('拒绝 javascript / data / 相对路径 / mailto / 带凭据的 URL', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeHttpUrl('data:text/html,x')).toBeUndefined()
    expect(safeHttpUrl('/relative')).toBeUndefined()
    expect(safeHttpUrl('mailto:a@b.com')).toBeUndefined()
    expect(safeHttpUrl('https://user:pass@example.org/')).toBeUndefined()
    expect(safeHttpUrl('')).toBeUndefined()
  })

  it('实体编码的危险协议解码后再判：不能靠 &colon; 混进来', () => {
    expect(safeHttpUrl('javascript&colon;alert(1)')).toBeUndefined()
    expect(safeHttpUrl('https://example.org/?a=1&amp;b=2')).toBe('https://example.org/?a=1&b=2')
  })

  it('host 去 www、统一小写；非默认端口显示，默认端口不显示', () => {
    expect(hostOf('https://www.Example.org/a')).toBe('example.org')
    expect(hostOf('http://sub.example.org:8080/')).toBe('sub.example.org:8080')
    expect(hostOf('https://example.org:443/a')).toBe('example.org')
    expect(hostOf('http://example.org:80/a')).toBe('example.org')
    expect(hostOf('https://www.example.org:8443/a')).toBe('example.org:8443')
    expect(hostOf('https://www.com/')).toBe('www.com')
    expect(hostOf('not a url')).toBe('')
  })
})

describe('citationKey：fragment 忽略，query 保留，www / 端口归一', () => {
  it('同一页不同锚点合并；不同 query 仍是两条', () => {
    expect(citationKey('https://Example.ORG:443/a?x=1#frag')).toBe('https://example.org/a?x=1')
    expect(citationKey('http://example.org:80/a#x')).toBe('http://example.org/a')
    expect(citationKey('https://example.org/a?x=1#a')).toBe(
      citationKey('https://example.org/a?x=1#b')
    )
    expect(citationKey('https://example.org/a?x=1')).not.toBe(
      citationKey('https://example.org/a?x=2')
    )
    expect(citationKey('javascript:alert(1)')).toBeUndefined()
  })

  it('www 与 apex 同键；非默认端口保留、默认端口归一', () => {
    expect(citationKey('https://www.example.org/x')).toBe(citationKey('https://example.org/x'))
    expect(citationKey('https://example.org:8443/x')).toBe('https://example.org:8443/x')
    expect(citationKey('https://example.org:443/x')).toBe(citationKey('https://example.org/x'))
  })
})

describe('extractCitations：正文只负责引用，工具结果负责授权（P0 provenance）', () => {
  it('正文 URL 不在 allowlist 里：不返回来源（旧版反向断言已修）', () => {
    const allow = known('https://example.org/paris')
    expect(extractCitations('[1](https://not-in-tools.example/x)', allow)).toEqual([])
    expect(extractCitations('[1](https://not-in-tools.example/x "看起来像标题")', allow)).toEqual(
      []
    )
    expect(extractCitations('[1](https://example.org/paris)', EMPTY_KNOWN_SOURCES)).toEqual([])
  })

  it('命中 allowlist：fragment / www / 默认端口按同一 citationKey 归一', () => {
    const allow = known('https://www.example.org/paris')
    const sources = extractCitations(
      '[1](https://example.org/paris#history) [2](https://example.org:443/paris)',
      allow
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      label: '1',
      url: 'https://example.org/paris#history',
      host: 'example.org'
    })
  })

  it('按首次出现排序；同 URL 不同 fragment 只留一条，后出现的 title 回填', () => {
    const allow = known('https://b.example/x', 'https://a.example/y')
    const sources = extractCitations(
      [
        '[2](https://b.example/x "B")',
        '[1](https://a.example/y)',
        '[2](https://b.example/x#part)',
        '[1](https://a.example/y "A later")'
      ].join(' '),
      allow
    )

    expect(sources.map((source) => source.label)).toEqual(['2', '1'])
    expect(sources[0]).toMatchObject({
      label: '2',
      url: 'https://b.example/x',
      host: 'b.example',
      title: 'B'
    })
    expect(sources[1]).toMatchObject({
      label: '1',
      url: 'https://a.example/y',
      host: 'a.example',
      title: 'A later'
    })
  })

  it('fragment 不产生重复来源，query 是另一个来源', () => {
    const allow = known('https://a.example/x', 'https://a.example/x?page=2')
    const sources = extractCitations(
      '[1](https://a.example/x#one) [1](https://a.example/x#two) [1](https://a.example/x?page=2)',
      allow
    )

    expect(sources).toHaveLength(2)
    expect(sources[0]?.url).toBe('https://a.example/x#one')
    expect(sources[1]?.url).toBe('https://a.example/x?page=2')
  })

  it('围栏代码与行内代码里的链接不算来源（即使 URL 在 allowlist 里）', () => {
    const allow = known(
      'https://code.example/x',
      'https://inline.example/y',
      'https://body.example/z'
    )
    const sources = extractCitations(
      [
        '```md',
        '[1](https://code.example/x)',
        '```',
        '`[2](https://inline.example/y)`',
        '正文 [3](https://body.example/z "Z")'
      ].join('\n'),
      allow
    )

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      label: '3',
      url: 'https://body.example/z',
      title: 'Z'
    })
  })

  it('blockquote 围栏、缩进代码、HTML 注释里的链接都不算来源', () => {
    const allow = known(
      'https://quote-code.example/x',
      'https://indented.example/y',
      'https://comment.example/z',
      'https://body.example/ok'
    )
    const sources = extractCitations(
      [
        '> ```md',
        '> [1](https://quote-code.example/x)',
        '> ```',
        '',
        '    [2](https://indented.example/y)',
        '',
        '<!-- [3](https://comment.example/z) -->',
        '',
        '正文 [4](https://body.example/ok)'
      ].join('\n'),
      allow
    )

    expect(sources.map((source) => source.label)).toEqual(['4'])
    expect(sources[0]?.url).toBe('https://body.example/ok')
  })

  it('标题后的缩进代码也算代码（没有空行也按块边界起块）', () => {
    const allow = known('https://code.example/x', 'https://body.example/ok')
    const sources = extractCitations(
      ['# 标题', '    [1](https://code.example/x)', '', '正文 [2](https://body.example/ok)'].join(
        '\n'
      ),
      allow
    )

    expect(sources.map((source) => source.label)).toEqual(['2'])
    expect(sources[0]?.url).toBe('https://body.example/ok')
  })

  it('reference-style link（full / collapsed / shortcut）与内联链接同口径', () => {
    const allow = known(
      'https://a.example/ref',
      'https://b.example/collapsed',
      'https://c.example/shortcut'
    )
    const doc = [
      '[ref]: https://a.example/ref "Ref title"',
      '[2]: https://b.example/collapsed',
      '[3]: https://c.example/shortcut',
      '',
      '正文 [1][ref] [2][] [3]'
    ].join('\n')

    const sources = extractCitations(doc, allow)
    expect(sources.map((source) => source.label)).toEqual(['1', '2', '3'])
    expect(sources[0]).toMatchObject({
      url: 'https://a.example/ref',
      title: 'Ref title'
    })
    expect(sources[1]?.url).toBe('https://b.example/collapsed')
    expect(sources[2]?.url).toBe('https://c.example/shortcut')
  })

  it('列表项里的 reference definition 也认（renderer 同口径）', () => {
    const allow = known('https://d.example/list')
    const sources = extractCitations(
      ['- [ref]: https://d.example/list "List def"', '', '正文 [1][ref]'].join('\n'),
      allow
    )

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      url: 'https://d.example/list',
      title: 'List def'
    })
  })

  it('reference definition 本身不渲染，也不会自己变成来源', () => {
    const allow = known('https://a.example/ref')
    expect(extractCitations('[1]: https://a.example/ref "Only definition"', allow)).toEqual([])
  })

  it('HTML 实体：正文 &amp; 与工具结果 & 命中同一来源，href 用解码后的 URL', () => {
    const allow = known('https://example.org/paris?a=1&b=2')
    const sources = extractCitations('[1](https://example.org/paris?a=1&amp;b=2 "Paris")', allow)

    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('https://example.org/paris?a=1&b=2')
    expect(sources[0]?.host).toBe('example.org')
  })

  it('普通链接、危险协议、相对路径、图片都不算', () => {
    expect(
      extractCitations(
        [
          '[docs](https://a.example/docs)',
          '[1](javascript:alert(1))',
          '[2](data:text/html,x)',
          '[3](/relative)',
          '[4](mailto:a@b.com)',
          '![1](https://image.example/x)'
        ].join(' '),
        known('https://a.example/docs', 'https://image.example/x')
      )
    ).toEqual([])
  })

  it('URL 里的平衡括号与尖括号目标都能完整取出', () => {
    const allow = known(
      'https://en.wikipedia.org/wiki/Paris_(disambiguation)',
      'https://example.org/a_(b)'
    )
    const sources = extractCitations(
      '[1](https://en.wikipedia.org/wiki/Paris_(disambiguation) "Paris (disambiguation)") ' +
        "[2](<https://example.org/a_(b)> 'Angle')",
      allow
    )

    expect(sources[0]).toMatchObject({
      url: 'https://en.wikipedia.org/wiki/Paris_(disambiguation)',
      title: 'Paris (disambiguation)'
    })
    expect(sources[1]).toMatchObject({
      url: 'https://example.org/a_(b)',
      title: 'Angle'
    })
  })

  it('来源数量有上限（病态长回复不撑爆面板）', () => {
    const urls = Array.from(
      { length: MAX_SOURCES + 5 },
      (_, index) => `https://limit.example/${index}`
    )
    const text = urls.map((url, index) => `[${(index % 999) + 1}](${url})`).join(' ')

    expect(extractCitations(text, known(...urls))).toHaveLength(MAX_SOURCES)
  })

  it('allowlist 只补已有正文来源的 title/snippet，不会自己新增来源', () => {
    const allow = knownWith([
      ['https://a.example/x', { title: 'Hint title', snippet: 'Hint snippet' }]
    ])
    const sources = extractCitations('[1](https://a.example/x)', allow)

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      title: 'Hint title',
      snippet: 'Hint snippet'
    })
    expect(extractCitations('没有正文链接', allow)).toEqual([])
    expect(extractCitations('[1](https://other.example/y)', allow)).toEqual([])
  })

  it('正文后面补的 title 优先于工具结果的 title', () => {
    const allow = knownWith([['https://a.example/x', { title: 'Tool title', snippet: 'S' }]])
    const sources = extractCitations(
      '[1](https://a.example/x) [1](https://a.example/x "Link title")',
      allow
    )

    expect(sources[0]).toMatchObject({ title: 'Link title', snippet: 'S' })
  })

  it('按 text part 分别提取：未闭合围栏不会吞掉下一个 part 的真实引用', () => {
    const allow = known('https://a.example/x', 'https://b.example/y')
    const sources = extractCitationsFromTexts(
      ['```md\n[1](https://a.example/x)', '[2](https://b.example/y)```'],
      allow
    )

    expect(sources.map((source) => source.label)).toEqual(['2'])
    expect(sources[0]?.url).toBe('https://b.example/y')
  })
})

describe('parseWebSearchSources：web_search 结构化输出', () => {
  it('解析 formatSearchOutcome 的稳定文本（标题 / URL / 摘要）', () => {
    expect(parseWebSearchSources(SEARCH_OUTPUT)).toEqual([
      {
        title: 'Paris - Wikipedia',
        url: 'https://example.org/paris',
        snippet: '巴黎是法国的首都，人口约 210 万。'
      },
      {
        title: 'Paris history',
        url: 'https://example.org/paris/history?page=2',
        snippet: '历史段落。'
      }
    ])
  })

  it('支持结构化对象、JSON 字符串与 content 包裹', () => {
    const hit = {
      title: 'Structured',
      url: 'https://example.org/structured',
      snippet: 'Structured snippet'
    }
    expect(parseWebSearchSources({ hits: [hit] })).toEqual([hit])
    expect(parseWebSearchSources({ results: [hit] })).toEqual([hit])
    expect(parseWebSearchSources(JSON.stringify({ results: [hit] }))).toEqual([hit])
    expect(
      parseWebSearchSources({ content: [{ type: 'text', text: SEARCH_OUTPUT }] })
    ).toHaveLength(2)
    expect(
      parseWebSearchSources({ content: [{ type: 'text', value: SEARCH_OUTPUT }] })
    ).toHaveLength(2)
  })

  it('content 内部再包 JSON 也能解析', () => {
    const hit = {
      title: 'Nested',
      url: 'https://example.org/nested',
      snippet: 'Nested snippet'
    }
    expect(
      parseWebSearchSources({ content: [{ type: 'text', text: JSON.stringify({ hits: [hit] }) }] })
    ).toEqual([hit])
  })

  it('每个结果只认第一条 URL 行（摘要里再出现的 URL 不覆盖）', () => {
    const output = [
      '联网搜索「注入」（后端：免费档）',
      '',
      '1. Real',
      '   URL: https://real.example/x',
      '   摘要: 第一行',
      '   URL: https://fake.example/y'
    ].join('\n')

    expect(parseWebSearchSources(output)).toEqual([
      {
        title: 'Real',
        url: 'https://real.example/x',
        snippet: '第一行'
      }
    ])
  })

  it('不安全 URL / 非搜索回执原文不猜成结果', () => {
    expect(parseWebSearchSources({ hits: [{ title: 'Bad', url: 'javascript:alert(1)' }] })).toEqual(
      []
    )
    expect(
      parseWebSearchSources('后端原文：\n1. not a real hit\n   URL: https://x.example')
    ).toEqual([])
  })

  it('摘要裁到 160 字（含省略号）', () => {
    const long = 'a'.repeat(SOURCE_SNIPPET_CHARS + 10)
    const [source] = parseWebSearchSources({
      hits: [{ title: 'Long', url: 'https://example.org/long', snippet: long }]
    })

    expect(source?.snippet.endsWith('…')).toBe(true)
    expect(Array.from(source?.snippet ?? '')).toHaveLength(SOURCE_SNIPPET_CHARS + 1)
    expect(clipSnippet('  a\n b  ')).toBe('a b')
  })

  it('HTML 实体在标题 / 摘要 / URL 里按可见文本解码', () => {
    expect(decodeHtmlEntities('A &amp; B &#49;')).toBe('A & B 1')
    const [source] = parseWebSearchSources({
      hits: [
        {
          title: 'A &amp; B',
          url: 'https://example.org/a?x=1&amp;y=2',
          snippet: '&lt;tag&gt;'
        }
      ]
    })
    expect(source).toEqual({
      title: 'A & B',
      url: 'https://example.org/a?x=1&y=2',
      snippet: '<tag>'
    })
  })
})

describe('knownSourcesFromParts：已完成工具结果的 provenance allowlist', () => {
  it('静态 tool-web_search / dynamic-tool 都认；未完成 / 其它工具不认', () => {
    const known = knownSourcesFromParts([
      { type: 'tool-web_search', state: 'output-available', output: SEARCH_OUTPUT },
      { type: 'tool-web_search', state: 'input-available', output: SEARCH_OUTPUT },
      { type: 'tool-read', state: 'output-available', output: SEARCH_OUTPUT },
      {
        type: 'dynamic-tool',
        toolName: 'web_search',
        state: 'output-available',
        output: {
          hits: [
            {
              title: 'Odd',
              url: 'https://odd.example/x',
              snippet: 'Odd snippet'
            }
          ]
        }
      }
    ])

    expect(known.get(keyOf('https://example.org/paris'))).toMatchObject({
      title: 'Paris - Wikipedia',
      snippet: '巴黎是法国的首都，人口约 210 万。'
    })
    expect(known.get(keyOf('https://odd.example/x'))).toMatchObject({
      title: 'Odd',
      snippet: 'Odd snippet'
    })
    expect(known.size).toBe(3)
  })

  it('没有 title/snippet 的 URL 也进 allowlist（键存在即授权）', () => {
    const known = knownSourcesFromParts([
      {
        type: 'tool-web_search',
        state: 'output-available',
        output: { hits: [{ url: 'https://bare.example/x' }] }
      }
    ])

    expect(known.has(keyOf('https://bare.example/x'))).toBe(true)
    expect(known.get(keyOf('https://bare.example/x'))).toEqual({})
  })

  it('fetch：input.url 与 final-url 都授权；未完成 / 出错不授权；不猜正文里的 URL', () => {
    const known = knownSourcesFromParts([
      {
        type: 'tool-fetch',
        state: 'output-available',
        input: { url: 'https://example.org/start' },
        output: [
          'HTTP 200',
          'content-type: text/html',
          'final-url: https://www.example.org/final',
          '',
          'URL: https://body-only.example/not-a-tool-target',
          'final-url: https://body-injected.example/fake'
        ].join('\n')
      },
      {
        type: 'tool-fetch',
        state: 'input-available',
        input: { url: 'https://pending.example/x' },
        output: 'HTTP 200'
      },
      {
        type: 'tool-fetch',
        state: 'output-error',
        input: { url: 'https://error.example/x' },
        errorText: '失败'
      },
      {
        type: 'dynamic-tool',
        toolName: 'fetch',
        state: 'output-available',
        input: { url: 'https://dynamic.example/x' },
        output: 'HTTP 200'
      }
    ])

    expect(known.has(keyOf('https://example.org/start'))).toBe(true)
    // final-url 的 www 与 apex 同键
    expect(known.has(keyOf('https://example.org/final'))).toBe(true)
    expect(known.has(keyOf('https://pending.example/x'))).toBe(false)
    expect(known.has(keyOf('https://error.example/x'))).toBe(false)
    expect(known.has(keyOf('https://body-only.example/not-a-tool-target'))).toBe(false)
    expect(known.has(keyOf('https://body-injected.example/fake'))).toBe(false)
    expect(known.has(keyOf('https://dynamic.example/x'))).toBe(true)
  })

  it('fetch 的 allowlist 能让正文引用通过 provenance', () => {
    const known = knownSourcesFromParts([
      {
        type: 'tool-fetch',
        state: 'output-available',
        input: { url: 'https://example.org/start' },
        output: 'HTTP 200\nfinal-url: https://example.org/final\n\n正文'
      }
    ])
    const sources = extractCitations('[1](https://example.org/final "Final")', known)

    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('https://example.org/final')
    expect(sources[0]?.title).toBe('Final')
  })

  it('mergeKnownSources：同 key 只补空位，不覆盖已有 title/snippet', () => {
    const target = new Map<string, CitationHint>([
      [keyOf('https://a.example/x'), { title: 'Keep', snippet: 'Keep snippet' }]
    ])
    mergeKnownSources(
      target,
      new Map([
        [keyOf('https://a.example/x'), { title: 'Other', snippet: 'Other snippet' }],
        [keyOf('https://b.example/y'), { title: 'B' }]
      ])
    )

    expect(target.get(keyOf('https://a.example/x'))).toEqual({
      title: 'Keep',
      snippet: 'Keep snippet'
    })
    expect(target.get(keyOf('https://b.example/y'))).toEqual({ title: 'B' })
  })
})

describe('parseFetchSource：fetch 回执的标题/摘要（2026-10-18 引用返工）', () => {
  it('原始 HTML：<title> + meta description（优先描述，不把导航噪音当摘要）', () => {
    const output = [
      'HTTP 200',
      'content-type: text/html; charset=utf-8',
      '',
      '<!doctype html><html><head><title>示例页面标题</title>',
      '<meta name="description" content="这是页面的 meta 描述。"></head>',
      '<body><nav>导航噪音</nav><p>正文第一段。</p></body></html>'
    ].join('\n')

    const hint = parseFetchSource(output)
    expect(hint.title).toBe('示例页面标题')
    expect(hint.snippet).toContain('这是页面的 meta 描述')
    expect(hint.snippet).not.toContain('导航噪音')
  })

  it('无 meta description：退回首个 <p>；再退回全文可见文本（script 不残留）', () => {
    const paragraphOnly = parseFetchSource(
      'HTTP 200\ncontent-type: text/html\n\n<html><body><p>第一段正文。</p><p>第二段。</p></body></html>'
    )
    expect(paragraphOnly.title).toBeUndefined()
    expect(paragraphOnly.snippet).toContain('第一段正文')

    const bodyOnly = parseFetchSource(
      'HTTP 200\n\n<html><body><script>alert("x")</script><div>可见文字</div></body></html>'
    )
    expect(bodyOnly.snippet).toContain('可见文字')
    expect(bodyOnly.snippet).not.toContain('alert')
  })

  it('reader 形状（Jina Markdown）：Title 行取标题；Markdown Content 之后取摘要', () => {
    const output = [
      'HTTP 200',
      'content-type: text/plain',
      '',
      'Title: Jina 页面标题',
      '',
      'URL Source: https://example.org/page',
      '',
      'Markdown Content:',
      '这是干净的正文内容，包含 [链接](https://example.org/x) 与 **加粗**。'
    ].join('\n')

    const hint = parseFetchSource(output)
    expect(hint.title).toBe('Jina 页面标题')
    expect(hint.snippet).toContain('这是干净的正文内容')
    expect(hint.snippet).not.toContain('URL Source')
    expect(hint.snippet).not.toContain('https://example.org/x')
  })

  it('纯文本：不编标题；摘要截到 160 字', () => {
    const hint = parseFetchSource(`HTTP 200\ncontent-type: text/plain\n\n${'正文'.repeat(200)}`)
    expect(hint.title).toBeUndefined()
    expect(hint.snippet?.endsWith('…')).toBe(true)
    expect(Array.from(hint.snippet ?? '').length).toBeLessThanOrEqual(SOURCE_SNIPPET_CHARS + 1)
  })

  it('空输出 / 二进制占位：不猜（返回空对象）', () => {
    expect(parseFetchSource('')).toEqual({})
    expect(parseFetchSource('HTTP 200\n\n')).toEqual({})
  })
})

describe('knownSourcesFromParts：fetch 也补 title/snippet', () => {
  it('fetch 回的 HTML 标题/描述写进 allowlist（不再只有 URL）', () => {
    const known = knownSourcesFromParts([
      {
        type: 'tool-fetch',
        state: 'output-available',
        input: { url: 'https://example.org/page' },
        output: [
          'HTTP 200',
          'content-type: text/html',
          '',
          '<html><head><title>页面标题</title>',
          '<meta name="description" content="页面描述。"></head><body></body></html>'
        ].join('\n')
      }
    ])

    expect(known.get(keyOf('https://example.org/page'))).toMatchObject({
      title: '页面标题',
      snippet: '页面描述。'
    })
  })
})

describe('citationContextsFromText：正文上下文兜底', () => {
  const known: Map<string, CitationHint> = new Map([[keyOf('https://example.org/paris'), {}]])

  it('命中 allowlist 的引用返回所在句子（去掉链接标记/URL/序号）', () => {
    const contexts = citationContextsFromText(
      '第一句不算。巴黎人口约 210 万 [1](https://example.org/paris "Paris - Wikipedia")。第三句。',
      known
    )
    const context = contexts.get(keyOf('https://example.org/paris')) ?? ''
    expect(context).toContain('巴黎人口约 210 万')
    expect(context).not.toContain('https://example.org/paris')
    expect(context).not.toContain('[1]')
  })

  it('未命中 allowlist / 代码块里的引用不产生上下文', () => {
    expect(citationContextsFromText('[1](https://not-in-tools.example/x)', known).size).toBe(0)

    const fenced = [
      '```',
      '[1](https://example.org/paris)',
      '```',
      '正文 [1](https://example.org/paris)。'
    ].join('\n')
    const contexts = citationContextsFromText(fenced, known)
    const context = contexts.get(keyOf('https://example.org/paris')) ?? ''
    expect(context).toContain('正文')
    expect(context).not.toContain('```')
  })
})
