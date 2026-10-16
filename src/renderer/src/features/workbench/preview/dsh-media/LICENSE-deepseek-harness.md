# dsh-media：移植来源、许可与第三方声明

本目录（`src/renderer/src/features/workbench/preview/dsh-media/`）的图片阅读器、HTML 静态预览、
markdown 数学/frontmatter、代码与纯文本文档体，移植自 **DeepSeek Harness（DSH）**。
逐文件对应关系写在每个文件头注里（"适配自 deepseek-harness（MIT，commit 86a4022）的 …"）。

- **上游仓库**：`deepseek-harness`（DeepSeek）
- **上游版本**：commit `86a402200d95fecef4529d969836f1fe13c6cb0d`
- **上游路径**：`packages/client/ui-sidebar-documentpreview/src/client/{image,html,markdown,code,text}/**`、
  `packages/client/ui-primitives/src/markdown/{CodeBlock,katex}.tsx`（对照，不含代码复制）
- **上游许可**：**MIT**（Copyright (c) 2026 DeepSeek，全文见下）

## 文件对照（上游 → 本目录）

| 上游                                                     | 本目录                                                                                     | 说明                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image/ImageBody.tsx`                                    | `image-body.tsx` + `formats.ts`                                                            | 缩放改走本仓已移植的 `dsh-document/ZoomViewport`（统一缩放）；Blob URL 改 data URL（CSP 只放行 `img-src data:`）；保留本仓的旋转与双击回位；补"无内在尺寸 SVG"的降级路                                                                                                |
| `zoom/**`（上游）                                        | 不复制                                                                                     | 用 `preview/dsh-document/zoom.ts` + `ZoomViewport.tsx` + `ZoomControls.tsx`（同一份移植，见该目录 NOTICE）                                                                                                                                                            |
| `html/HtmlBody.tsx` 的 `BasicHtmlFrame` 一路             | `html-viewer.tsx`                                                                          | 只移植**静态预览**；`allow-scripts` 的交互预览**不移植**（本仓明确不启用脚本模式）                                                                                                                                                                                    |
| `html/basic-document.ts` + `html/bytes.ts`               | `html-document.ts`                                                                         | DOMPurify 清洗 + 文档自带 CSP；额外把 `template` 列入禁删清单（上游 README 声明的"声明式 shadow root 会被去掉"按本意落实）                                                                                                                                            |
| `markdown/MarkdownBody.tsx`（frontmatter 分层）          | `markdown-body.tsx` + `frontmatter.ts` + `frontmatter-parse.ts` + `frontmatter-fields.tsx` | 数学：`$...$` / `$$...$$` 走 react-markdown 生态插件链（`remark-math` + `rehype-katex` + `katex` CSS）；`\(...\)` / `\[...\]` 与同一行 `$$...$$` 走 `math-compatibility.ts`（上游 `mathCompatibility` 的逐字移植，micromark 扩展，与 `remark-math` 的 `math()` 并存） |
| `ui-primitives/src/markdown/mathCompatibility.ts`        | `math-compatibility.ts`                                                                    | `\(...\)` / `\[...\]` / 同一行 `$$...$$` 的 micromark 扩展逐字移植；另加一个 remark 插件外壳（`remarkBackslashMath`）把它挂进解析器                                                                                                                                   |
| `code/CodeBody.tsx` + `ui-primitives` 代码块的文档侧体验 | `code-body.tsx`                                                                            | 行号（CSS 计数器，不进复制内容）与换行开关移植；高亮/复制仍用本仓聊天区 `CodeBlock`（不复制第二套高亮器）                                                                                                                                                             |
| `text/TextBody.tsx`（铺行这层）                          | `text-body.tsx` + `paged-text.tsx`（本仓新增，不在上游）                                   | 上游只铺行；本仓在它上面加了**文本分页**（有界页 + 游标 + 版本校验 + "加载更多" + 受控轮询提示重读），分页那些代码是本轮新写的 kyclaw 逻辑，不属于 DSH 移植                                                                                                           |
| `image/index.ts`、`html/index.ts` 等宿主注册             | 不移植                                                                                     | 那是 cordis 宿主注册（槽位/locale/注册表），本仓没有这套宿主                                                                                                                                                                                                          |

## 新增依赖（本目录引入；由 C 统一登记进 package.json）

| 包                         | 版本（建议） | 用途                                                                   | 许可                                      |
| -------------------------- | ------------ | ---------------------------------------------------------------------- | ----------------------------------------- |
| `dompurify`                | `^3.4.17`    | HTML 清洗（`html-document.ts`）                                        | Apache-2.0 或 MPL-2.0（双许可，任选其一） |
| `yaml`                     | `^2.9.1`     | frontmatter 解析（`frontmatter-parse.ts`）                             | ISC                                       |
| `katex`                    | `^0.16.47`   | 数学排版（官方 CSS 由 `markdown-body.tsx` import）                     | MIT                                       |
| `remark-math`              | `^6.0.0`     | `$...$` / `$$...$$` → math 节点                                        | MIT                                       |
| `rehype-katex`             | `^7.0.1`     | math 节点 → KaTeX HTML（依赖 `katex ^0.16`，与本表一致）               | MIT                                       |
| `micromark-factory-space`  | `^2.0.1`     | `\(...\)` / `\[...\]` 定界的 micromark 扩展（`math-compatibility.ts`） | MIT                                       |
| `micromark-util-character` | `^2.1.1`     | 同上（换行判定）                                                       | MIT                                       |
| `micromark-util-symbol`    | `^2.0.1`     | 同上（字符码 / token 名常量）                                          | MIT                                       |
| `micromark-util-types`     | `^2.0.2`     | 同上（**只做类型**；`import type` 用）                                 | MIT                                       |

`katex` 的字体随 `katex.min.css` 由构建器打进产物（几十个 woff2，约几百 KB），
CSP 的 `font-src` 回落到 `default-src 'self'`，**不需要**放宽 CSP。
四个 `micromark-*` 包都很小（合计几十 KB 源码），与 `remark-math` 同一作者、同一大版本线；
`micromark-util-types` 若不想进 dependencies，可只放 devDependencies（运行时不需要）。

## MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
