/**
 * IPC 错误人话化（round 25）：Electron 的 `invoke` 失败会把主进程错误的 message 包成
 * `Error invoking remote method '<channel>': Error: …` 再到渲染端——用户图1 看到的
 * 就是这串机器话（`EPERM …` 裸横幅）。展示前统一剥包装：
 *   - 去 `Error invoking remote method '<channel>': ` 前缀（可多层）；
 *   - 去主进程 Error 再套的 `Error: ` 前缀（可多层）；
 *   - 只留**第一行**（尾部堆栈/换行不进横幅）；
 *   - 剥完为空 → 回原始首行（宁可漏剥，不吞掉信息）。
 * 用法：所有"把错误文案展示给用户"的地方走它（console/日志里保留原始错误，不去包装）。
 */
export function unwrapIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  let message = raw
  for (;;) {
    const next = message
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '')
    if (next === message) break
    message = next
  }
  const firstLine = (message.split('\n')[0] ?? '').trim()
  if (firstLine !== '') return firstLine
  const rawFirst = (raw.split('\n')[0] ?? '').trim()
  return rawFirst === '' ? raw : rawFirst
}
