import { describe, expect, it } from 'vitest'
import {
  needsTranslation,
  scriptCounts,
  targetScriptOf,
  translateEndpoint,
  translatePrompt,
  translateResultSchema,
  TRANSLATE_MAX_CHARS
} from '../translate'

/**
 * 思考翻译的三个纯函数（round 32）：
 *   1. 提示词 —— 用户给定的格式，**原样**（改一个字都要重测效果）；
 *   2. 端点 —— OpenAI 兼容的 `/chat/completions`，尾斜杠归一；
 *   3. 语言判定 —— "只有明确是目标语言才不用翻"，不确定一律按不一致处理（宁可给翻译）。
 */
describe('翻译提示词与端点', () => {
  it('提示词就是那一句（单条 user 消息的内容）：目标语言替换 + 空行 + 原文', () => {
    expect(translatePrompt('Hello world.', '简体中文')).toBe(
      '请将以下文本翻译为简体中文，直接输出翻译结果，不要进行任何解释。\n\nHello world.'
    )
    expect(translatePrompt('Hi', 'English')).toBe(
      '请将以下文本翻译为English，直接输出翻译结果，不要进行任何解释。\n\nHi'
    )
  })

  it('端点 = {baseUrl}/chat/completions（尾斜杠不会拼出 //）', () => {
    expect(translateEndpoint('http://192.168.31.18:8235/v1')).toBe(
      'http://192.168.31.18:8235/v1/chat/completions'
    )
    expect(translateEndpoint('http://192.168.31.18:8235/v1/')).toBe(
      'http://192.168.31.18:8235/v1/chat/completions'
    )
    expect(translateEndpoint('  http://127.0.0.1:8080/v1//  ')).toBe(
      'http://127.0.0.1:8080/v1/chat/completions'
    )
  })

  it('结果 schema：判别字段 ok；成功必须带非空译文，失败必须带非空人话', () => {
    expect(translateResultSchema.safeParse({ ok: true, text: '译文' }).success).toBe(true)
    expect(
      translateResultSchema.safeParse({ ok: false, message: '翻译服务没有返回内容' }).success
    ).toBe(true)
    expect(translateResultSchema.safeParse({ ok: true, text: '' }).success).toBe(false)
    expect(translateResultSchema.safeParse({ ok: false, message: '' }).success).toBe(false)
    expect(
      translateResultSchema.safeParse({ ok: true, text: '译文', message: '多余' }).success
    ).toBe(false)
    expect(translateResultSchema.safeParse({ ok: false, text: '错分支' }).success).toBe(false)
  })

  it('原文上限是个正整数（IPC 闸门与渲染端共用这一份）', () => {
    expect(TRANSLATE_MAX_CHARS).toBeGreaterThan(0)
    expect(Number.isInteger(TRANSLATE_MAX_CHARS)).toBe(true)
  })
})

describe('目标语言 → 预期脚本', () => {
  it('zh/en/ja/ko/ru 的常见写法都认得', () => {
    for (const zh of ['简体中文', '中文', '繁體中文', 'zh', 'zh-CN', 'Chinese']) {
      expect(targetScriptOf(zh), zh).toBe('han')
    }
    for (const en of ['English', 'en', 'en-US', '英文', '英语']) {
      expect(targetScriptOf(en), en).toBe('latin')
    }
    for (const ja of ['日本語', '日语', '日文', 'ja', 'Japanese']) {
      expect(targetScriptOf(ja), ja).toBe('kana')
    }
    for (const ko of ['한국어', '韩语', '韩文', 'ko', 'Korean']) {
      expect(targetScriptOf(ko), ko).toBe('hangul')
    }
    for (const ru of ['俄语', '俄文', 'ru', 'Russian']) {
      expect(targetScriptOf(ru), ru).toBe('cyrillic')
    }
  })

  it('认不出来 / 空串 → null（调用方按"不一致"处理）', () => {
    for (const unknown of ['', '   ', 'Klingon', '世界语', 'auto']) {
      expect(targetScriptOf(unknown), unknown).toBeNull()
    }
  })
})

describe('要不要翻译（只有明确是目标语言才不翻）', () => {
  const ENGLISH_COT =
    'Let me check the workspace listing first, then read the config file before writing the patch.'
  const CHINESE_COT = '先看看配置文件在不在，然后写补丁，最后跑一遍测试确认没有回归。'
  const JAPANESE = 'まず設定ファイルを確認して、それからパッチを書きます。'

  it('纯英文思考 + 目标中文 → 要翻（这是这个功能存在的理由）', () => {
    expect(needsTranslation(ENGLISH_COT, '简体中文')).toBe(true)
  })

  it('纯中文思考 + 目标中文 → 不翻（一致：全量模式不动、按钮模式不出按钮）', () => {
    expect(needsTranslation(CHINESE_COT, '简体中文')).toBe(false)
  })

  it('混排：中文占多数的按一致处理，英文占多数的按不一致处理', () => {
    // 中文是主体，夹了几个英文词（工作区/文件名）——不该再翻一遍
    expect(needsTranslation('先读配置文件 config.json，然后写补丁并跑测试。', '简体中文')).toBe(
      false
    )
    // 英文是主体，只有零星汉字
    expect(
      needsTranslation(
        'Read the 配置 file first, then apply the patch and run the tests.',
        '简体中文'
      )
    ).toBe(true)
  })

  it('目标日语只认假名：纯汉字（更可能是中文）按不一致处理，带假名的日文按一致处理', () => {
    expect(needsTranslation(CHINESE_COT, '日本語')).toBe(true)
    expect(needsTranslation(JAPANESE, '日本語')).toBe(false)
  })

  it('短文本：字母太少看不出语言 → 按不一致处理（保守，宁可多翻一次）', () => {
    expect(needsTranslation('Hmm.', '简体中文')).toBe(true)
    expect(needsTranslation('OK', '简体中文')).toBe(true)
  })

  it('一个字母都没有（纯数字/符号/代码片段）→ 不翻（没有语言可言）', () => {
    expect(needsTranslation('1 + 1 = 2', '简体中文')).toBe(false)
    expect(needsTranslation('!!! ... ???', '简体中文')).toBe(false)
  })

  it('认不出目标语言 → 一律按不一致处理（不确定就给翻译）', () => {
    expect(needsTranslation(CHINESE_COT, '')).toBe(true)
    expect(needsTranslation(CHINESE_COT, 'Klingon')).toBe(true)
  })

  it('目标英文时的反向：英文思考不翻、中文思考要翻', () => {
    expect(needsTranslation(ENGLISH_COT, 'English')).toBe(false)
    expect(needsTranslation(CHINESE_COT, 'English')).toBe(true)
  })

  it('scriptCounts 按码点归类：emoji / 数字 / 标点都不算字母', () => {
    expect(scriptCounts('abc 123 !!! 🙂')).toEqual({
      han: 0,
      latin: 3,
      kana: 0,
      hangul: 0,
      cyrillic: 0
    })
    expect(scriptCounts('汉字 + カナ + 한글 + Привет')).toEqual({
      han: 2,
      latin: 0,
      kana: 2,
      hangul: 2,
      cyrillic: 6
    })
  })
})
