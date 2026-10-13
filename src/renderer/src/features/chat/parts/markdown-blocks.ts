/** 围栏行（顶格）：``` 或 ~~~（≥3） */
const FENCE_OPEN = /^(`{3,}|~{3,})/
/** 顶格的 ATX 标题 / 分割线 —— 这两类在"前一行是空行"时必定新起一个块 */
const HARD_BLOCK_START = /^(?:#{1,6}(?: |$)|\*{3,}\s*$|(?:-{3,}|_{3,})\s*$)/

/**
 * 把流式正文切成若干块（返回 null = 没法切/不值得切，调用方整篇渲染）。
 *
 * **切点规则（保守到刻意）**：只认"前一行是空行 + 本行顶格 + 属于下面三类"的位置：
 *   1. 围栏代码块的开栏；2. ATX 标题；3. 分割线（`---` / `***` / `___`）。
 *
 * 这三类在 CommonMark/GFM 里**必定**新起一个块，而"前一行是空行 + 顶格"排掉了所有
 * "上一块会吞掉这一行"的情形：
 *   - setext 标题（`foo` 换行 `---`）要求两行**紧挨**，空行在前就不会被当成标题下划线；
 *   - 列表只在**缩进**延续（`- item` 之后的缩进块），顶格的标题/围栏会结束列表；
 *   - 段落可以被子块打断，但"空行 + 顶格"排除了 lazy continuation；
 *   - 缩进的围栏（列表项里的代码块）不匹配 `^```` 所以不会被切开。
 * 反过来，**列表项之间的空行**（`- a\n\n- b` 会让列表变松散）这类切点一个都不认 —— 那是
 * "空行 + 非顶格块起点"，切了会让松散列表变成两个紧凑列表，语义就不一样了。
 *
 * 单调性：边界只由**前缀**决定（围栏开关是前缀状态），所以流往前走时边界集合只增不减 ——
 * 已上屏的块 text 不会变，TextPart 里那些 memo 化的块才可能命中。
 *
 * 返回值：块文本数组，拼接起来与原文**逐字节相同**（首块从 0 开始，末块到文末）。只有一块时返回 null。
 *
 * 为什么单独一个文件：它是纯函数、与 React 无关，而且 TextPart.tsx 只该导出组件
 * （`react-refresh/only-export-components` 的口径）。
 */
export function splitBlocks(text: string): string[] | null {
  // 首块固定从 0 开始（第一行之前没有空行，所以循环里不会再往 0 推一个）
  const starts: number[] = [0]
  let fenceChar: string | null = null
  let previousBlank = false
  let at = 0

  while (at < text.length) {
    const newline = text.indexOf('\n', at)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(at, end)

    if (fenceChar !== null) {
      // 围栏内部：只有同种字符的闭合行才算出来（内容行长得像标题也不能当边界）
      if (line.trimStart().startsWith(fenceChar.repeat(3))) fenceChar = null
    } else {
      const open = FENCE_OPEN.exec(line)
      if (open?.[1] !== undefined) {
        fenceChar = open[1][0] ?? null
        if (previousBlank) starts.push(at)
      } else if (previousBlank && HARD_BLOCK_START.test(line)) {
        starts.push(at)
      }
    }

    previousBlank = line.trim() === ''
    at = end + 1
  }

  if (starts.length <= 1) return null
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length))
}
