/**
 * 冷启动打点（round 73）：把"从渲染端开始加载到能打字"这条链上的几个时间点记下来，
 * 在「可输入」那一刻打**一行**汇总。只记内存、只打一行，不改任何行为。
 *
 * 为什么要有它：冷启动到可输入的耗时是体感的一半，而这条链横跨主进程、渲染端与两条 HTTP 往返 ——
 * 没有打点就只能猜。打点是"先测再改"的前提，所以它常驻（不是一次性的临时插桩）。
 *
 * 口径（别把它变成状态机）：
 *   - 时间基于 `performance.now()` = 相对**本文档的导航开始**（即窗口开始加载渲染端那一刻）；
 *   - `performance.timeOrigin` 是那个起点的**绝对时间**（epoch ms）—— 主进程 index.ts 的启动分解
 *     也打 epoch 时间，两条线按这个对齐，就能拼出"进程启动 → 可输入"的全程；
 *   - 同名 mark 只记第一次（React StrictMode 下 effect 会跑两遍）；
 *   - 汇总只在「可输入」那一笔打；链断在半路（起不来 / 报错）就不打（错误卡本身说得更清楚）。
 *
 * 模块级状态 → 测试之间用 `resetStartupMarks()` 清（探针读的也是这份 marks）。
 */
export interface StartupMark {
  name: string
  /** `performance.now()`：相对本文档的导航开始 */
  at: number
}

/** 链的终点：聊天页输入框已经挂到 DOM 上（能打字了） */
export const STARTUP_FINAL_MARK = '可输入'

const marks: StartupMark[] = []

export function startupMark(name: string): void {
  if (marks.some((mark) => mark.name === name)) return
  marks.push({ name, at: performance.now() })
  if (name === STARTUP_FINAL_MARK) report()
}

/** 当前已有的打点（副本；探针与排障读它） */
export function startupMarks(): StartupMark[] {
  return marks.map((mark) => ({ ...mark }))
}

/** 清空（模块级状态；探针在每个用例前调） */
export function resetStartupMarks(): void {
  marks.length = 0
}

/**
 * 每笔给"距上一笔的增量"，最后一笔给"自导航开始的总量"——一眼看清时间花在哪一段。
 */
function report(): void {
  const steps = marks.map((mark, index) => {
    const previous = marks[index - 1]?.at ?? 0
    return `${mark.name} ${Math.round(mark.at)}ms(+${Math.round(mark.at - previous)})`
  })
  console.info(`[kyclaw] 启动分解（渲染端）: ${steps.join(' · ')}`)
  console.info(
    `[kyclaw] 渲染端时间原点（epoch ms，与主进程那条线对齐用）: ${Math.round(performance.timeOrigin)}`
  )
}
