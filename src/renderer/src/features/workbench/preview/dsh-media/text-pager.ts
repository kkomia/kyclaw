/**
 * 文本分页的**取数口**（组件只依赖这个形状；真装配在 `preview/fetch.ts` 的 `textPagerFor`）。
 *
 * 为什么要这一层：分页组件（`paged-text.tsx`）要能在单测里只喂一个假取数口就把
 * "加载更多 / 版本变了 / 重读回位"三条链路走完 —— 不必造 IPC、也不必起主进程。
 * 与 `dsh-document/office-bridge.ts` 是同一个路数（活句柄进状态，组件不碰 `window.kyclaw`）。
 */
import type { TextPageCursor, TextPageResult, TextVersionResult } from '@shared/workbench-text'

/** 一次预览的文本取数口：续读一页 + 探一下版本（轮询用）。 */
export interface TextPager {
  /**
   * 读一页：`null` = 第一页（一般已由 `readPreview` 取过，续读才用得到它）；否则带上一页的游标。
   * 版本不符 / 读的当口在变会回 `kind: 'changed'`（**不交半截**）。
   */
  readPage(cursor: TextPageCursor | null): Promise<TextPageResult>
  /** 只看现在磁盘上那份的版本与大小（不读正文）；文件没了回 `kind: 'missing'`。 */
  version(): Promise<TextVersionResult>
}
