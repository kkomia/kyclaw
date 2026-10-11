// @vitest-environment node
/**
 * zip 读取器（测试用）：产品侧已经把它提升成 `../artifact-check` 的 `readZipEntries`
 * （带 EOCD 扫描 / 局部头核对 / inflateRaw / CRC32 校验），这里只做 re-export —— 测试断言的
 * 就是产品那条读侧口径，别再造一份会漂移的实现。
 *
 * 为什么不用新依赖（如 yauzl/jszip）：产出物测试要的是"**真解包**看一眼容器结构"——
 * 比"同库读回"更硬的一点是：它能证明 [Content_Types].xml / word/document.xml / ppt/slides/slideN.xml
 * 这些**部件路径**真的按 OOXML 规矩落了，而不是某个库私有的中间格式。
 */
export { readZipEntries } from '../artifact-check'

/** 取条目文本；条目不在时把"有哪些条目"一起抛出来（排障用） */
export function zipText(entries: Map<string, Buffer>, name: string): string {
  const entry = entries.get(name)
  if (entry === undefined) {
    throw new Error(`zip 里没有 ${name}；实际条目：${[...entries.keys()].join(', ')}`)
  }
  return entry.toString('utf8')
}
