/**
 * HTML 静态预览的文档 CSP（**唯一出处**，纯常量：没有 import、没有 DOM 依赖）。
 *
 * 为什么单独一个文件：这份策略有**两个**使用点，而且分处两个运行环境 ——
 *   1. `./html-document.ts`：把它写进清洗后文档的 `<meta http-equiv="Content-Security-Policy">`；
 *   2. `e2e/_html-preview-csp-probe.spec.ts`：真 Chromium 里量"它到底挡不挡得住"的探针里，也要用**同一份**
 *      策略去构造对照文档。
 * 探针跑在 Node（Playwright）里，而 `html-document.ts` 一 import 就会拉进 DOMPurify（需要 DOM）——
 * 所以这份常量必须住在一个**零依赖**的小文件里，两边 import 同一处，**字面量不许再有第二份**
 * （复制一份就会漂，探针量的就不再是产品实际用的那条策略）。
 *
 * 改这条要同时想到：`html-document.ts` 的三层说明（内容性质 / 这条 CSP / iframe `sandbox=""`）、
 * 以及 `html.spec.tsx` 里对 CSP 字符串的那组断言。顺序与分隔符与上游 DSH 一致（`...; ...; ...`）。
 */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
