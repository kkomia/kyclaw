/**
 * 反斜杠数学定界（`\(...\)` 行内、`\[...\]` 块级）+ 同一行的 `$$...$$` 块。
 *
 * 逐字移植 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-primitives/src/markdown/mathCompatibility.ts` —— 它是**micromark 扩展**，
 * 复用 `micromark-extension-math` 的 token 词汇（`mathText` / `mathFlow` / …），
 * 所以只要同一次解析里 `remark-math` 也注册了 `math()`，这些 token 就会被编译成标准 math 节点
 * （`mdast-util-math` 的 handler 按 token 名认，与定界符长什么样无关）。
 *
 * **为什么必须走 tokenizer 这一层（而不是对文本做正则替换）**：
 * 代码围栏里的 `\(x\)`、行内代码里的 `` `\[y\]` `` 在 micromark 里由**各自的构造**整段吃掉，
 * 根本不会走到文本构造，所以数学定界**天然不会误伤代码块/行内代码**；反过来，正则替换必须自己
 * 重新实现"哪里是代码"的扫描，那才是误替换的源头。这条口径由 `__tests__/math.spec.tsx` 钉住。
 *
 * 与上游逐项一致的三类支持：
 *   - 行内 `\(...\)`（`previous` 判据要求前一个字符确实是反斜杠，且不是转义序列的一部分）；
 *   - 块级 `\[...\]`（可跨行，按 linePrefix 缩进继续）；
 *   - 同一行的 `$$...$$`（多行 `$$` 仍由 `micromark-extension-math` 自己的 flow 构造处理）。
 */

import { factorySpace } from 'micromark-factory-space'
import { markdownLineEnding } from 'micromark-util-character'
import { codes, constants, types } from 'micromark-util-symbol'
import type { Construct, Extension, Previous, State, Tokenizer } from 'micromark-util-types'

/** 前一个字符必须是"真反斜杠"（不是 `\\(` 这种转义出来的反斜杠）。 */
const previousBackslash: Previous = function (code) {
  if (code !== codes.backslash) return true
  const tail = this.events.at(-1)
  /* 前一个字符存在时，它必然有前一个事件。 */
  if (tail === undefined) return false
  return tail[1].type === types.characterEscape
}

/** 行内 `\(...\)`：开序列 `\(`、数据、闭序列 `\)`。 */
const tokenizeBackslashMathText: Tokenizer = function (effects, ok, nok) {
  return start

  function start(code: number | null): State | undefined {
    // 只在反斜杠上触发（文本构造自己保证）
    if (code !== codes.backslash) return nok(code)
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    return open
  }

  function open(code: number | null): State | undefined {
    if (code !== codes.leftParenthesis) return nok(code)
    effects.consume(code)
    effects.exit('mathTextSequence')
    return between
  }

  function between(code: number | null): State | undefined {
    if (code === codes.eof) return nok(code)
    if (code === codes.backslash) {
      return effects.attempt(
        { partial: true, tokenize: tokenizeClose },
        close,
        afterCloseAttempt
      )(code)
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      return between
    }
    return dataStart(code)
  }

  function afterCloseAttempt(code: number | null): State | undefined {
    return effects.check({ partial: true, tokenize: tokenizeOpen }, nok, dataStart)(code)
  }

  function dataStart(code: number | null): State | undefined {
    effects.enter('mathTextData')
    effects.consume(code)
    return code === codes.backslash ? afterDataBackslash : data
  }

  function afterDataBackslash(code: number | null): State | undefined {
    if (code === codes.backslash) {
      effects.consume(code)
      return data
    }
    return data(code)
  }

  function data(code: number | null): State | undefined {
    if (code === codes.eof || code === codes.backslash || markdownLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    effects.consume(code)
    return data
  }

  function close(code: number | null): State | undefined {
    effects.exit('mathText')
    return ok(code)
  }

  function tokenizeClose(
    closeEffects: Parameters<Tokenizer>[0],
    closeOk: State,
    closeNok: State
  ): State {
    return slash

    function slash(code: number | null): State | undefined {
      if (code !== codes.backslash) return closeNok(code)
      closeEffects.enter('mathTextSequence')
      closeEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.rightParenthesis) return closeNok(code)
      closeEffects.consume(code)
      closeEffects.exit('mathTextSequence')
      return closeOk
    }
  }

  function tokenizeOpen(
    openEffects: Parameters<Tokenizer>[0],
    openOk: State,
    openNok: State
  ): State {
    return slash

    function slash(code: number | null): State | undefined {
      if (code !== codes.backslash) return openNok(code)
      openEffects.enter(types.chunkString)
      openEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.leftParenthesis) return openNok(code)
      openEffects.consume(code)
      openEffects.exit(types.chunkString)
      return openOk
    }
  }
}

/**
 * 造一个"开标记 + 数据 + 闭标记"的块级构造（`\[…\]` 与同一行的 `$$…$$` 共用这一份）。
 * @param marker 触发字符（`\` 或 `$`）。
 * @param openMarker 开序列的第二个字符（`[` / `$`）。
 * @param closeMarker 闭序列的第二个字符（`]` / `$`）。
 * @param multiline 数据里允不允许换行（`\[…\]` 允许，`$$…$$` 同一行块不允许）。
 */
function createMathFlow(
  marker: number,
  openMarker: number,
  closeMarker: number,
  multiline: boolean
): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    // micromark 只在外层 tokenize 回调上绑定上下文（this）；内部的状态函数是普通闭包，
    // 拿不到 this，所以必须在这里留一个引用（上游同处理）。
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 见上：micromark 的 tokenizer 上下文只在回调 this 上
    const self = this
    let oddBackslashRun = false
    const tail = self.events.at(-1)
    const initialSize =
      tail?.[1].type === types.linePrefix ? tail[2].sliceSerialize(tail[1], true).length : 0

    return start

    function start(code: number | null): State | undefined {
      if (code !== marker) return nok(code)
      effects.enter('mathFlow')
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return open
    }

    function open(code: number | null): State | undefined {
      if (code !== openMarker) return nok(code)
      effects.consume(code)
      effects.exit('mathFlowFenceSequence')
      effects.exit('mathFlowFence')
      return marker === codes.dollarSign ? afterDollarOpen : content
    }

    function afterDollarOpen(code: number | null): State | undefined {
      return code === codes.dollarSign ? nok(code) : content(code)
    }

    function content(code: number | null): State | undefined {
      if (code === codes.eof) return nok(code)
      if (code === marker && (marker !== codes.dollarSign || !oddBackslashRun)) {
        return effects.attempt(
          { partial: true, tokenize: tokenizeClosingFence },
          closed,
          afterClosingFenceAttempt
        )(code)
      }
      if (markdownLineEnding(code)) {
        return multiline
          ? effects.attempt(nonLazyContinuation, afterContinuation, nok)(code)
          : nok(code)
      }
      return valueStart(code)
    }

    function afterClosingFenceAttempt(code: number | null): State | undefined {
      return marker === codes.backslash
        ? effects.check(
            { partial: true, tokenize: tokenizeOpeningFence },
            nok,
            markerValueStart
          )(code)
        : markerValueStart(code)
    }

    function afterContinuation(code: number | null): State | undefined {
      return effects.attempt(
        { partial: true, tokenize: tokenizeClosingFence },
        closed,
        initialSize ? factorySpace(effects, content, types.linePrefix, initialSize + 1) : content
      )(code)
    }

    function valueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = code === codes.backslash
      effects.consume(code)
      return value
    }

    function markerValueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = false
      effects.consume(code)
      return valueAfterMarker
    }

    function valueAfterMarker(code: number | null): State | undefined {
      if (code === marker) {
        effects.consume(code)
        return value
      }
      return value(code)
    }

    function value(code: number | null): State | undefined {
      if (code === codes.eof || code === marker || markdownLineEnding(code)) {
        effects.exit('mathFlowValue')
        return content(code)
      }
      oddBackslashRun = code === codes.backslash ? !oddBackslashRun : false
      effects.consume(code)
      return value
    }

    function closed(code: number | null): State | undefined {
      effects.exit('mathFlow')
      return ok(code)
    }

    function tokenizeClosingFence(
      closeEffects: Parameters<Tokenizer>[0],
      closeOk: State,
      closeNok: State
    ): State {
      return factorySpace(closeEffects, sequenceStart, types.linePrefix, constants.tabSize)

      function sequenceStart(code: number | null): State | undefined {
        if (code !== marker) return closeNok(code)
        closeEffects.enter('mathFlowFence')
        closeEffects.enter('mathFlowFenceSequence')
        closeEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== closeMarker) return closeNok(code)
        closeEffects.consume(code)
        closeEffects.exit('mathFlowFenceSequence')
        return factorySpace(closeEffects, after, types.whitespace)
      }

      function after(code: number | null): State | undefined {
        if (code !== codes.eof && !markdownLineEnding(code)) return closeNok(code)
        closeEffects.exit('mathFlowFence')
        return closeOk(code)
      }
    }

    function tokenizeOpeningFence(
      openEffects: Parameters<Tokenizer>[0],
      openOk: State,
      openNok: State
    ): State {
      return sequenceStart

      function sequenceStart(code: number | null): State | undefined {
        if (code !== marker) return openNok(code)
        openEffects.enter(types.chunkString)
        openEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== openMarker) return openNok(code)
        openEffects.consume(code)
        openEffects.exit(types.chunkString)
        return openOk
      }
    }
  }

  return {
    concrete: true,
    name: marker === codes.dollarSign ? 'sameLineDollarMathFlow' : 'backslashMathFlow',
    tokenize
  }
}

/** 非懒续行（跨行 `\[…\]` 里，lazy 行不算续行）。 */
const tokenizeNonLazyContinuation: Tokenizer = function (effects, ok, nok) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- 同上：上下文只在 tokenize 回调的 this 上
  const self = this

  return start

  function start(code: number | null): State | undefined {
    if (code === codes.eof) return ok(code)
    if (!markdownLineEnding(code)) return nok(code)
    effects.enter(types.lineEnding)
    effects.consume(code)
    effects.exit(types.lineEnding)
    return lineStart
  }

  function lineStart(code: number | null): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code)
  }
}

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation
}

const backslashMathText: Construct = {
  name: 'backslashMathText',
  previous: previousBackslash,
  tokenize: tokenizeBackslashMathText
}

const backslashMathFlow = createMathFlow(
  codes.backslash,
  codes.leftSquareBracket,
  codes.rightSquareBracket,
  true
)

const sameLineDollarMathFlow = createMathFlow(
  codes.dollarSign,
  codes.dollarSign,
  codes.dollarSign,
  false
)

const backslashMath: Extension = {
  flow: {
    [codes.backslash]: backslashMathFlow,
    [codes.dollarSign]: sameLineDollarMathFlow
  },
  text: { [codes.backslash]: backslashMathText }
}

/**
 * 数学这几条 token 的**类型补登记**。
 *
 * `micromark-util-types` 的 `TokenType = keyof TokenTypeMap` 是个**封闭联合**，`mathText` / `mathFlow`
 * 这一族名字由 `micromark-extension-math` 自己 `declare module` 补——而那个包是本仓**传递依赖**
 * （经 `remark-math` 进来），不是直接依赖，不保证进类型程序。这里按同一份名字与字面量类型补一次；
 * 两份声明内容一致，声明合并（declaration merging）不冲突。
 */
declare module 'micromark-util-types' {
  interface TokenTypeMap {
    mathFlow: 'mathFlow'
    mathFlowFence: 'mathFlowFence'
    mathFlowFenceSequence: 'mathFlowFenceSequence'
    mathFlowValue: 'mathFlowValue'
    mathText: 'mathText'
    mathTextData: 'mathTextData'
    mathTextSequence: 'mathTextSequence'
  }
}

/**
 * `\(...\)` / `\[...\]` / 同一行 `$$...$$` 的 micromark 语法扩展；
 * **调用方必须在同一次解析里也注册 `remark-math` 的 `math()`**，这样吐出的 token 才会编译成 math 节点。
 * @returns micromark 语法扩展。
 */
export function mathCompatibility(): Extension {
  return backslashMath
}

/**
 * remark 插件：把上面的 micromark 扩展挂进解析器。
 *
 * 与 `remark-math` 并存（它注册 `math()` 与 mdast 侧的 handler）；`\(...\)` 的旧式定界写进 md
 * 也能渲染成数学，而不是原样一串反斜杠。
 *
 * 为什么 `this: unknown` + 运行时收窄：插件的宿主是 unified 的 `Processor`（**它是个函数对象**），
 * 而 `unified` 不是本仓的直接依赖（写 `this: Processor` 就得再引一个包）；`Data` 本身是"字符串键的
 * 袋子"（可合并扩展的接口），所以这里按结构与运行时类型取 `data()`（`in` 收窄，不用 `any`、不写断言）。
 * **兜底不静默**：宿主长得不像处理器（既不是对象也不是函数、或没有 `data()`）就抛 —— 静默不挂会让
 * `\(...\)` 变成普通括号，这种"悄悄失效"比报错难查得多。
 */
export function remarkBackslashMath(this: unknown): void {
  const host: object | null =
    typeof this === 'function' || (typeof this === 'object' && this !== null) ? this : null
  if (host === null || !('data' in host)) {
    throw new Error('remarkBackslashMath：宿主不是 unified 处理器（拿不到 data()），数学定界挂不上')
  }
  const readData: unknown = host.data
  if (typeof readData !== 'function') {
    throw new Error('remarkBackslashMath：宿主不是 unified 处理器（data 不是函数），数学定界挂不上')
  }
  const data: unknown = readData.call(host)
  if (typeof data !== 'object' || data === null) {
    throw new Error('remarkBackslashMath：处理器没给出 data 对象，数学定界挂不上')
  }

  const extension = mathCompatibility()
  if ('micromarkExtensions' in data && Array.isArray(data.micromarkExtensions)) {
    data.micromarkExtensions.push(extension)
    return
  }
  Object.assign(data, { micromarkExtensions: [extension] })
}
