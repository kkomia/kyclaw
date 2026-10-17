# 内置技能与随包渲染器的第三方来源与许可（THIRD_PARTY_NOTICES）

`resources/skills/` 下的内置技能大多是 kyclaw 自研的**工具口径手册**（讲 `create_ppt` / `create_docx` /
`create_excel` / `create_pdf` / `create_report` 怎么用）。其中若干排版、结构与写作规范节的**内容养分**
采纳自下列开源项目，按各自的许可在此声明。每个技能文件末尾的「来源与许可」一节写明了它具体采纳了哪些
文件、取的哪个版本、以及我们做了哪些修改。

本文件本身不是技能（技能加载器只认 `<名字>/SKILL.md` 这种形态的一级子目录），它是随包分发的许可声明。
它同时覆盖**随包分发的东西**：第 3 节是 `render_ppt` / 办公档页式预览用的 LibreOffice 渲染引擎；
第 4 节是我们移植的 DeepSeek Harness 代码（MIT）；第 5 节是随包与内联进产物的第三方包（表格预览那一组、
数学排版与净化新增的一组、两份 FortuneSheet 补丁）—— 最后一组尤其要看，它们的 npm 包**不随包**
（代码在构建时被内联进渲染端 bundle），所以许可文本只能由本文件承载。

| 节  | 对象                                                                                                                                                 | 许可           | 随包位置                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| 1   | MiniMax-AI/skills 的排版与写作规范                                                                                                                   | MIT            | 内容并入 `resources/skills/*/SKILL.md`                                  |
| 2   | anthropics/skills 的 `skill-creator` 写作口径                                                                                                        | Apache-2.0     | 内容并入 `resources/skills/skill-author/SKILL.md`                       |
| 3   | `@deepseek-ai/libreoffice-kit`（含预编译 LibreOffice）                                                                                               | MPL-2.0        | `resources/libreoffice-kit/`（安装目录 `resources/libreoffice-kit/`）   |
| 4   | DeepSeek Harness 的代码（office 页式预览 / 表格预览的移植来源）                                                                                      | MIT            | 编译进主进程与渲染端产物（app.asar 内）                                 |
| 5   | 随包依赖与内联进产物的第三方包（FortuneSheet 两补丁 / SheetJS / papaparse / fflate / fast-xml-parser / pdfjs 与其字体 / katex 等数学排版与净化一组） | 各自见 5.1–5.5 | `dependencies` 进 app.asar；`devDependencies` 构建时内联进渲染端 bundle |

---

## 1. MiniMax-AI/skills（MIT）

- 仓库：https://github.com/MiniMax-AI/skills
- 采纳版本：commit `60aaae52bb2af8162732751a4332f62a5fef518b`
- 采纳的文件与去向：

| 上游文件                                                          | 内容                                                   | 采纳到          |
| ----------------------------------------------------------------- | ------------------------------------------------------ | --------------- |
| `skills/minimax-docx/references/cjk_typography.md`                | 中文字号对照、全角标点、中西文混排、GB/T 9704 公文结构 | `docx/SKILL.md` |
| `skills/minimax-docx/references/design_principles.md`             | 层级对比与留白原则                                     | `docx/SKILL.md` |
| `skills/minimax-docx/references/cjk_university_template_guide.md` | 中文文档的章节与标题层级惯例                           | `docx/SKILL.md` |
| `skills/pptx-generator/references/slide-types.md`                 | 五类页面与字号层级、内容页子类型                       | `pptx/SKILL.md` |
| `skills/pptx-generator/references/design-system.md`               | 字号阶梯与间距比例、配色一致性                         | `pptx/SKILL.md` |
| `skills/pptx-generator/references/pitfalls.md`                    | 排版常见错误清单                                       | `pptx/SKILL.md` |
| `skills/minimax-xlsx/references/format.md`                        | 行类型标准、数字格式语义、假设区与结果区分离           | `xlsx/SKILL.md` |
| `skills/minimax-pdf/design/design.md`                             | 强调色规则、配色反模式、内页克制清单、成品质检         | `pdf/SKILL.md`  |

我们的改动都是**删减与改写**（删掉 OpenXML / C# / PptxGenJS / ReportLab 的参数层，只保留能落到我们
工具字段上的判断），没有引入上游的代码或脚本。许可原文：

```
MIT License

Copyright (c) 2026 MiniMax

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
```

---

## 2. anthropics/skills — skills/skill-creator（Apache License 2.0）

> 注意区分：**同一仓库里的 `skills/docx`、`skills/pdf`、`skills/pptx`、`skills/xlsx` 不在本次采纳范围内**。
> 那四个目录的 `LICENSE.txt` 是 Anthropic 自有的 source-available 条款（“© 2025 Anthropic, PBC. All rights reserved.”，
> 明文禁止复制、派生、再分发），我们**没有**复制其中任何文本、脚本或模板。

- 仓库：https://github.com/anthropics/skills
- 采纳版本：2026-10-13 取的 `main`，路径 `skills/skill-creator/`
- 采纳内容：技能写作口径（description 是唯一触发开关且要主动、四段骨架、命令句、篇幅与分层、渐进式披露）→ `skill-author/SKILL.md` 第七节
- 许可原文：

```
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2026 Anthropic, PBC.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

---

## 3. @deepseek-ai/libreoffice-kit 与它的预编译 LibreOffice 引擎（MPL-2.0）

`render_ppt`（交付前逐页渲染自检）靠这份引擎把 `.pptx` 导成逐页 PNG。它是 DeepSeek Harness 开源的
一层 Node 包装 + **预编译的 LibreOffice**：我们**原样分发上游的 npm 产物，没有修改其中任何文件**。

- 上游仓库：https://github.com/deepseek-ai/dsh-libreoffice-kit
- 取的版本：`0.1.5`（入口包与引擎包同版本）
- 怎么取得：`pnpm fetch:libreoffice-kit` → `scripts/fetch-libreoffice-kit.mjs`。版本 pin 在脚本里，
  包从 npm 拉（本机走 `registry.npmmirror.com`），npm 按 `package-lock.json` 里的 `integrity`
  逐一校验，校验不过就不落地。
- 分发的形式：`resources/libreoffice-kit/`（不入 git，安装目录里对应 `resources/libreoffice-kit/`，
  **在 asar 之外**——里面的 exe 要从磁盘上直接执行）

| 包                                        | 版本                         | 许可           | 装到                                                                    |
| ----------------------------------------- | ---------------------------- | -------------- | ----------------------------------------------------------------------- |
| `@deepseek-ai/libreoffice-kit`            | 0.1.5                        | MPL-2.0        | `resources/libreoffice-kit/node_modules/@deepseek-ai/libreoffice-kit/`  |
| `@deepseek-ai/libreoffice-kit-win32-x64`  | 0.1.5                        | MPL-2.0        | 同目录下 `.../libreoffice-kit-win32-x64/`（**内含预编译 LibreOffice**） |
| `koffi`、`@koromix/koffi-win32-x64`       | 3.1.1                        | MIT            | 同目录（FFI 原生扩展）                                                  |
| `fflate`、`saxes`、`fontkit` 及其传递依赖 | 见同目录 `package-lock.json` | MIT 等各自许可 | 同目录（许可文本随各自的 `LICENSE` 文件）                               |

npm 包的完整性（`package-lock.json` 的 `integrity`，安装时强制校验；换版本请一并更新这里）：

| 包                                             | `integrity`（sha512）                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@deepseek-ai/libreoffice-kit@0.1.5`           | `H12xtUsAyl70zFeQ5pk5GGRc3N1+6zn+DVAcqwlguI6EvqopBGP3xkUmePU7g5f6ydYlDZLWedHT9lTSL7zLxA==` |
| `@deepseek-ai/libreoffice-kit-win32-x64@0.1.5` | `uKuDGZdofxuW4iRmUh8b3+XWU28JeOCYMTAONzo7tEHIq00DV2cARcgUYiTP7gUH49tH4A/RyPMOVEBzK7qjjw==` |
| `koffi@3.1.1`                                  | `mRX6AMeeKCxSOeOopqAcLAl5jcNvge7NAG8l7rF/8gGJATI0tdHFYjteIdE0mGOtWdsrJOij+PjnP8Q9c1gwgA==` |
| `@koromix/koffi-win32-x64@3.1.1`               | `KqHPmvj6QILhNyI/To8QSihHsijeVGIYYPBOUnXEpcnH2LuLbargY4Hd6dDeTN3Z90uUUxN+1FWz1UnhVzFOiA==` |

### 3.1 MPL-2.0 要求的几件事，我们怎么满足

MPL-2.0 是**文件级** copyleft：分发可执行件时要① 给出许可文本、② 告知接收方**如何取得源码**（§3.2）。
我们改动的只是"怎么调用它"（`src/mastra/tools/render-ppt.ts`），LibreOffice 与包装层本身一个字节没动，
所以没有 §3.1 意义上的 Modified Source Files 要公开。

1. **许可文本**：随包分发，不额外张贴 ——
   - 包装层：`resources/libreoffice-kit/node_modules/@deepseek-ai/libreoffice-kit/LICENSE`（MPL-2.0 全文）
     与同目录 `NOTICE`（内含源自 LibreOffice Core 的 `fontdefs.cxx` 那部分登记，MPL-2.0 + Apache-2.0）；
   - 引擎：`.../libreoffice-kit-win32-x64/licenses/LibreOffice-MPL-2.0.txt`、
     `licenses/DeepSeek-Harness-MIT.txt`、`licenses/LibreOffice-third-party.html`（351KB 全量第三方声明）、
     `program/license.txt`（LibreOffice 自己那份 MPL-2.0 + 第三方清单与跳转目录）、
     `program/NOTICE`（Apache-2.0 部分要求的 NOTICE）。

2. **源码可得性（§3.2）**：引擎包里带着 **`sources/`（803KB）**，随包一起分发给用户：
   - `sources/core-source.json` / `core.json`：上游仓库 `https://github.com/LibreOffice/core.git`、
     精确 commit `bce0998afefdbc355585ca324285661a2170ba77`（LibreOffice `26.8.0.3`）、
     完整的 `configure` 参数；
   - `sources/core-changes.patch` 与 `sources/engine/native/patches/*.patch`：上游源码之上打的全部补丁；
   - `sources/engine/**` 与 `sources/scripts/*.mjs`：构建脚本（checkout、configure、交叉/本地构建、
     打包与产物校验）；
   - `sources/payload-shaping.json`：裁剪规则。

   也就是说：**重建这个可执行件需要的东西（精确 revision + 补丁 + 构建配方）都在包里**，源码树本身
   按该 commit 从上游公共仓库取即可（MPL §3.2(b) 允许源码"从网络位置提供"）。
   我们没有把完整的 LibreOffice 源码树（GB 级）塞进安装包；若日后要满足"完全离线/内网分发"的场景，
   把 `sources/core-<revision>.tar.xz` 一并随包是**追加**动作，不需要改现在的这套配置。

3. **专利/商标**：LibreOffice 与 The Document Foundation 的商标不在 MPL 的授权范围内，我们只在必要处
   以描述性方式提及它（"随包的 LibreOffice 渲染器"）；安装包的产品名是 `kyclaw`，未使用其品牌元素。

### 3.2 体积（本机 win32-x64 实测，未压缩）

| 部分                                  | 大小                  | 说明                                                |
| ------------------------------------- | --------------------- | --------------------------------------------------- |
| `bin/libreoffice-kit.exe`             | 178.5 MB              | 自包含的引擎（LibreOffice 静态链进去）              |
| `program/`                            | 12 MB                 | share / readmes / `license.txt` / `NOTICE`          |
| `sources/`                            | 803 KB                | 源码配方、补丁、构建脚本（MPL 义务，见上）          |
| `licenses/`                           | 368 KB                | MPL-2.0 全文 + 第三方声明                           |
| 引擎包小计                            | 182.0 MiB（190.9 MB） | npm 的 `unpackedSize` 实测                          |
| 包装层 + `koffi` + 字体库等           | 12.4 MiB              |                                                     |
| **`resources/libreoffice-kit/` 合计** | **194.4 MiB**         | 安装包（NSIS 压缩后）因此增大约一半量级，见打包报告 |

下面附 MPL-2.0 全文（与上面 `licenses/LibreOffice-MPL-2.0.txt` 同一份内容）。

```
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

---

## 4. DeepSeek Harness 的代码（MIT）—— 办公档与表格预览的移植来源

办公档的两条预览链（主进程的**页式预览**与渲染端的**表格预览**）都是把 DeepSeek Harness（DSH）的
现成实现移植过来的；这一节是那份 MIT 代码的归属与原文。

- 上游仓库：`deepseek-harness`（本地研究快照在 `.superpowers/research/deepseek-harness`）
- 上游 commit：`86a402200d95fecef4529d969836f1fe13c6cb0d`
- 上游许可：MIT（Copyright © 2026 DeepSeek）

| 我们这边                                                                   | 上游路径                                                             | 移植方式                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/main/office-preview.ts`（页式预览后端）                               | `packages/document/office-to-pdf/src/{queue,output,errors,index}.ts` | 队列准入、内容寻址缓存、源一致性、取消语义、产出校验照搬；**引擎那一段改成子进程跑随包 kit CLI** |
| `src/renderer/src/features/workbench/preview/dsh-table/**`（表格预览界面） | `packages/client/ui-sidebar-documentpreview/src/client/excel/**`     | 见该目录自己的 `NOTICE.md`（文件对照、口径差异、补丁说明）；`patches/**` 的两份补丁见 §5.3       |

**注意**：`src/renderer/.../dsh-table/NOTICE.md` 在 `src/` 下，打包配置排除了 `src/**`，所以那份文件
**不随包**；随包的是本文件 —— 这就是把要点在这里再写一遍的原因。

MIT 许可原文（上游 `LICENSE`，逐字）：

```
MIT License

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
```

---

## 5. 随包分发与内联进产物的第三方依赖

分两种形态，许可义务的落点不同：

| 形态                                                   | 谁属这一档                                                                                                                                                   | 包内有没有许可文件                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **随包（`dependencies`）**：包目录整份进 app.asar      | `pdfjs-dist`、`exceljs`、`mammoth`、`docx`、`pptxgenjs`、`node-pty` 等                                                                                       | 有：各自 `LICENSE` 随包（0.1.1 包实测，见 §5.2）                                      |
| **内联（`devDependencies`，构建时打进渲染端 bundle）** | `@fortune-sheet/core`、`@fortune-sheet/react`、`xlsx`、`papaparse`、`fflate`、`fast-xml-parser`、`katex`、`remark-math`、`rehype-katex`、`dompurify`、`yaml` | **没有**：包本身不进安装包，只有编译后的代码进 bundle —— **许可文本必须由本文件给出** |

### 5.1 表格预览用的一组（构建期内联）

| 包                              | 版本   | 许可       | 用在哪                                                     |
| ------------------------------- | ------ | ---------- | ---------------------------------------------------------- |
| `@fortune-sheet/core`           | 1.0.4  | MIT        | 展示数据结构与数字格式、缩放常量（附 §5.3 的只读态补丁）   |
| `@fortune-sheet/react`          | 1.0.4  | MIT        | 只读表格画布（`Workbook`）与样式表（附 §5.3 的只读态补丁） |
| `@fortune-sheet/formula-parser` | 0.2.13 | MIT        | 公式解析（`@fortune-sheet/core` 的依赖）                   |
| `xlsx`（SheetJS 社区版）        | 0.20.3 | Apache-2.0 | 老版 `.xls`（BIFF）解析与代码页表                          |
| `papaparse`                     | 5.7.0  | MIT        | CSV / TSV 切分                                             |
| `fflate`                        | 0.8.3  | MIT        | XLSX 包的读 / 写                                           |
| `fast-xml-parser`               | 5.11.1 | MIT        | 关系部件与工作表 XML 的扫描                                |
| `@types/papaparse`              | 5.5.2  | MIT        | TypeScript 类型（**只在构建期用，不进产物**）              |

`@fortune-sheet/core` 与 `@fortune-sheet/react` 的 npm tarball **没有附带许可文本**
（`package.json` 的 `license` 字段写的是 MIT），下面用的是上游仓库
`https://github.com/ruilisi/fortune-sheet` 的 `LICENSE` 原文。

`xlsx`（0.20.3）的许可是 **Apache-2.0**（不是 MIT）：它自带的 `LICENSE` 就是 Apache-2.0 全文，
**全文见本文件第 2 节**（同一份标准文本，不重复贴一遍）。

MIT 原文（**逐份照抄，版权行各不相同**）：

**papaparse**

```
The MIT License (MIT)

Copyright (c) 2015 Matthew Holt

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**fflate**

```
MIT License

Copyright (c) 2026 Arjun Barrett

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
```

**fast-xml-parser**

```
MIT License

Copyright (c) 2017 Amit Kumar Gupta

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
```

**@fortune-sheet/core、@fortune-sheet/react**

```
MIT License

Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd

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
```

`@fortune-sheet/formula-parser` 是上面那两份的依赖，同为 MIT；它的 tarball 里同样没有许可文本。

### 5.1.1 这些包自己带上来的 MIT 传递依赖（同样内联进渲染端 bundle）

下表是表格预览那条链**新带进来**的传递依赖（每个都随上面的包一起被内联进渲染端产物）；
许可原文逐份照抄（版权行各不相同）。

| 包                              | 版本                                      | 许可 | 谁的依赖                      |
| ------------------------------- | ----------------------------------------- | ---- | ----------------------------- |
| `@fortune-sheet/formula-parser` | 0.2.13                                    | MIT  | @fortune-sheet/core           |
| `@formulajs/formulajs`          | 2.9.3                                     | MIT  | @fortune-sheet/formula-parser |
| `tiny-emitter`                  | 2.1.0                                     | MIT  | @fortune-sheet/formula-parser |
| `dayjs`                         | 1.11.23                                   | MIT  | @fortune-sheet/core           |
| `immer`                         | 9.0.12                                    | MIT  | @fortune-sheet/core / react   |
| `lodash`                        | 4.18.1                                    | MIT  | @fortune-sheet/core / react   |
| `numeral`                       | 2.0.6                                     | MIT  | @fortune-sheet/core           |
| `uuid`                          | 8.3.2（`@fortune-sheet/core` 的嵌套依赖） | MIT  | `@fortune-sheet/core`         |
| `regenerator-runtime`           | 0.14.1                                    | MIT  | @fortune-sheet/react          |
| `strnum`                        | 2.5.1                                     | MIT  | fast-xml-parser               |

**`@fortune-sheet/formula-parser`**（`LICENSE`）

```
(The MIT License)

Copyright (c) Handsoncode sp. z o.o. <hello@handsoncode.net>

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
```

**`@formulajs/formulajs`**（`LICENSE`）

```
Copyright (c) 2014 Sutoiku, Inc.

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Other libraries included:

BESSELI, BESSELJ, BESSELK, BESSELY functions:

Copyright (c) 2013 SheetJS

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

jStat - JavaScript Statistical Library:

Copyright (c) 2013 jStat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

**`tiny-emitter`**（`LICENSE`）

```
The MIT License (MIT)

Copyright (c) 2017 Scott Corgan

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
```

**`dayjs`**（`LICENSE`）

```
MIT License

Copyright (c) 2018-present, iamkun

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
```

**`immer`**（`LICENSE`）

```
MIT License

Copyright (c) 2017 Michel Weststrate

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
```

**`lodash`**（`LICENSE`）

```
Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```

**`numeral`**（`LICENSE`）

```
Copyright (c) 2016 Adam Draper

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

**`uuid`**（`LICENSE.md`）

```
The MIT License (MIT)

Copyright (c) 2010-2020 Robert Kieffer and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**`regenerator-runtime`**（`LICENSE`）

```
MIT License

Copyright (c) 2014-present, Facebook, Inc.

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
```

**`strnum`**（`LICENSE`）

```
MIT License

Copyright (c) 2021 Natural Intelligence

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
```

### 5.2 PDF 预览：pdfjs-dist 与它随包的字体（Apache-2.0 + 两份字体许可）

`pdfjs-dist@6.4.299` 是 `dependencies`，**包目录整份进 app.asar**。0.1.1 安装包实测（用
`@electron/asar` 列包内条目）：

- `node_modules/pdfjs-dist/LICENSE`（Apache-2.0 全文）—— **在包里**（全文另见本文件第 2 节）
- `node_modules/pdfjs-dist/cmaps/LICENSE`、`node_modules/pdfjs-dist/iccs/LICENSE` —— 在包里
- `node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT`、`LICENSE_LIBERATION` —— 在包里，
  内容与下面的原文一致

两份字体许可**都不是 MIT / Apache**，照实写：

- **Foxit 系列 `.pfb`（standard_fonts/FoxitDingbats/Fixed/Serif/Symbol）**：BSD 三条款风格的
  PDFium 许可（`Copyright 2014 PDFium Authors. All rights reserved.`），原文：
- **Liberation 系列 `.ttf`（LiberationSans-\*）**：Red Hat 的最终用户许可协议 —— **GPLv2 加字体例外**
  （嵌入文档不因此被 GPL 覆盖），并含商标与担保条款（`Copyright © 2007-2011 Red Hat, Inc.`）。
  这份**不是**宽松许可（勿混称 MIT/Apache）。原文（逐字，与包内
  `node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION` 同一份）：

```
LICENSE AGREEMENT AND LIMITED PRODUCT WARRANTY
LIBERATION FONT SOFTWARE

This agreement governs the use of the Software and any updates to the Software, regardless of the delivery mechanism. Subject to the following terms, Red Hat, Inc. ("Red Hat") grants to the user ("Client") a license to this work pursuant to the GNU General Public License v.2 with the exceptions set forth below and such other terms as are set forth in this End User License Agreement.

 1. The Software and License Exception. LIBERATION font software  (the "Software") consists of TrueType-OpenType formatted font software for rendering LIBERATION typefaces in sans-serif, serif, and monospaced character styles. You are licensed to use, modify, copy, and distribute the Software pursuant to the GNU General Public License v.2 with the following exceptions:

  (a) As a special exception, if you create a document which uses this font, and embed this font or unaltered portions of this font into the document, this font does not by itself cause the resulting document to be covered by the GNU General Public License. This exception does not however invalidate any other reasons why the document might be covered by the GNU General Public License. If you modify this font, you may extend this exception to your version of the font, but you are not obligated to do so. If you do not wish to do so, delete this exception statement from your version.

  (b) As a further exception, any distribution of the object code of the Software in a physical product must provide you the right to access and modify the source code for the Software and to reinstall that modified version of the Software in object code form on the same physical product on which you received it.

 2. Intellectual Property Rights. The Software and each of its components, including the source code, documentation, appearance, structure and organization are owned by Red Hat and others and are protected under copyright and other laws. Title to the Software and any component, or to any copy, modification, or merged portion shall remain with the aforementioned, subject to the applicable license. The "LIBERATION" trademark is a trademark of Red Hat, Inc. in the U.S. and other countries. This agreement does not permit Client to distribute modified versions of the Software using Red Hat's trademarks. If Client makes a redistribution of a modified version of the Software, then Client must modify the files names to remove any reference to the Red Hat trademarks and must not use the Red Hat trademarks in any way to reference or promote the modified Software.

 3. Limited Warranty. To the maximum extent permitted under applicable law, the Software is provided and licensed "as is" without warranty of any kind, expressed or implied, including the implied warranties of merchantability, non-infringement or fitness for a particular purpose. Red Hat does not warrant that the functions contained in the Software will meet Client's requirements or that the operation of the Software will be entirely error free or appear precisely as described in the accompanying documentation.

 4. Limitation of Remedies and Liability. To the maximum extent permitted by applicable law, Red Hat or any Red Hat authorized dealer will not be liable to Client for any incidental or consequential damages, including lost profits or lost savings arising out of the use or inability to use the Software, even if Red Hat or such dealer has been advised of the possibility of such damages.

 5. General. If any provision of this agreement is held to be unenforceable, that shall not affect the enforceability of the remaining provisions. This agreement shall be governed by the laws of the State of North Carolina and of the United States, without regard to any conflict of laws provisions, except that the United Nations Convention on the International Sale of Goods shall not apply.
Copyright © 2007-2011 Red Hat, Inc. All rights reserved. LIBERATION is a trademark of Red Hat, Inc.

------------------------------------------------------------------------------

The text of the GNU General Public License, version 2, referenced above:

		    GNU GENERAL PUBLIC LICENSE
		       Version 2, June 1991

 Copyright (C) 1989, 1991 Free Software Foundation, Inc.,
 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

			    Preamble

  The licenses for most software are designed to take away your
freedom to share and change it.  By contrast, the GNU General Public
License is intended to guarantee your freedom to share and change free
software--to make sure the software is free for all its users.  This
General Public License applies to most of the Free Software
Foundation's software and to any other program whose authors commit to
using it.  (Some other Free Software Foundation software is covered by
the GNU Lesser General Public License instead.)  You can apply it to
your programs, too.

  When we speak of free software, we are referring to freedom, not
price.  Our General Public Licenses are designed to make sure that you
have the freedom to distribute copies of free software (and charge for
this service if you wish), that you receive source code or can get it
if you want it, that you can change the software or use pieces of it
in new free programs; and that you know you can do these things.

  To protect your rights, we need to make restrictions that forbid
anyone to deny you these rights or to ask you to surrender the rights.
These restrictions translate to certain responsibilities for you if you
distribute copies of the software, or if you modify it.

  For example, if you distribute copies of such a program, whether
gratis or for a fee, you must give the recipients all the rights that
you have.  You must make sure that they, too, receive or can get the
source code.  And you must show them these terms so they know their
rights.

  We protect your rights with two steps: (1) copyright the software, and
(2) offer you this license which gives you legal permission to copy,
distribute and/or modify the software.

  Also, for each author's protection and ours, we want to make certain
that everyone understands that there is no warranty for this free
software.  If the software is modified by someone else and passed on, we
want its recipients to know that what they have is not the original, so
that any problems introduced by others will not reflect on the original
authors' reputations.

  Finally, any free program is threatened constantly by software
patents.  We wish to avoid the danger that redistributors of a free
program will individually obtain patent licenses, in effect making the
program proprietary.  To prevent this, we have made it clear that any
patent must be licensed for everyone's free use or not licensed at all.

  The precise terms and conditions for copying, distribution and
modification follow.

		    GNU GENERAL PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. This License applies to any program or other work which contains
a notice placed by the copyright holder saying it may be distributed
under the terms of this General Public License.  The "Program", below,
refers to any such program or work, and a "work based on the Program"
means either the Program or any derivative work under copyright law:
that is to say, a work containing the Program or a portion of it,
either verbatim or with modifications and/or translated into another
language.  (Hereinafter, translation is included without limitation in
the term "modification".)  Each licensee is addressed as "you".

Activities other than copying, distribution and modification are not
covered by this License; they are outside its scope.  The act of
running the Program is not restricted, and the output from the Program
is covered only if its contents constitute a work based on the
Program (independent of having been made by running the Program).
Whether that is true depends on what the Program does.

  1. You may copy and distribute verbatim copies of the Program's
source code as you receive it, in any medium, provided that you
conspicuously and appropriately publish on each copy an appropriate
copyright notice and disclaimer of warranty; keep intact all the
notices that refer to this License and to the absence of any warranty;
and give any other recipients of the Program a copy of this License
along with the Program.

You may charge a fee for the physical act of transferring a copy, and
you may at your option offer warranty protection in exchange for a fee.

  2. You may modify your copy or copies of the Program or any portion
of it, thus forming a work based on the Program, and copy and
distribute such modifications or work under the terms of Section 1
above, provided that you also meet all of these conditions:

    a) You must cause the modified files to carry prominent notices
    stating that you changed the files and the date of any change.

    b) You must cause any work that you distribute or publish, that in
    whole or in part contains or is derived from the Program or any
    part thereof, to be licensed as a whole at no charge to all third
    parties under the terms of this License.

    c) If the modified program normally reads commands interactively
    when run, you must cause it, when started running for such
    interactive use in the most ordinary way, to print or display an
    announcement including an appropriate copyright notice and a
    notice that there is no warranty (or else, saying that you provide
    a warranty) and that users may redistribute the program under
    these conditions, and telling the user how to view a copy of this
    License.  (Exception: if the Program itself is interactive but
    does not normally print such an announcement, your work based on
    the Program is not required to print an announcement.)

These requirements apply to the modified work as a whole.  If
identifiable sections of that work are not derived from the Program,
and can be reasonably considered independent and separate works in
themselves, then this License, and its terms, do not apply to those
sections when you distribute them as separate works.  But when you
distribute the same sections as part of a whole which is a work based
on the Program, the distribution of the whole must be on the terms of
this License, whose permissions for other licensees extend to the
entire whole, and thus to each and every part regardless of who wrote it.

Thus, it is not the intent of this section to claim rights or contest
your rights to work written entirely by you; rather, the intent is to
exercise the right to control the distribution of derivative or
collective works based on the Program.

In addition, mere aggregation of another work not based on the Program
with the Program (or with a work based on the Program) on a volume of
a storage or distribution medium does not bring the other work under
the scope of this License.

  3. You may copy and distribute the Program (or a work based on it,
under Section 2) in object code or executable form under the terms of
Sections 1 and 2 above provided that you also do one of the following:

    a) Accompany it with the complete corresponding machine-readable
    source code, which must be distributed under the terms of Sections
    1 and 2 above on a medium customarily used for software interchange; or,

    b) Accompany it with a written offer, valid for at least three
    years, to give any third party, for a charge no more than your
    cost of physically performing source distribution, a complete
    machine-readable copy of the corresponding source code, to be
    distributed under the terms of Sections 1 and 2 above on a medium
    customarily used for software interchange; or,

    c) Accompany it with the information you received as to the offer
    to distribute corresponding source code.  (This alternative is
    allowed only for noncommercial distribution and only if you
    received the program in object code or executable form with such
    an offer, in accord with Subsection b above.)

The source code for a work means the preferred form of the work for
making modifications to it.  For an executable work, complete source
code means all the source code for all modules it contains, plus any
associated interface definition files, plus the scripts used to
control compilation and installation of the executable.  However, as a
special exception, the source code distributed need not include
anything that is normally distributed (in either source or binary
form) with the major components (compiler, kernel, and so on) of the
operating system on which the executable runs, unless that component
itself accompanies the executable.

If distribution of executable or object code is made by offering
access to copy from a designated place, then offering equivalent
access to copy the source code from the same place counts as
distribution of the source code, even though third parties are not
compelled to copy the source along with the object code.

  4. You may not copy, modify, sublicense, or distribute the Program
except as expressly provided under this License.  Any attempt
otherwise to copy, modify, sublicense or distribute the Program is
void, and will automatically terminate your rights under this License.
However, parties who have received copies, or rights, from you under
this License will not have their licenses terminated so long as such
parties remain in full compliance.

  5. You are not required to accept this License, since you have not
signed it.  However, nothing else grants you permission to modify or
distribute the Program or its derivative works.  These actions are
prohibited by law if you do not accept this License.  Therefore, by
modifying or distributing the Program (or any work based on the
Program), you indicate your acceptance of this License to do so, and
all its terms and conditions for copying, distributing or modifying
the Program or works based on it.

  6. Each time you redistribute the Program (or any work based on the
Program), the recipient automatically receives a license from the
original licensor to copy, distribute or modify the Program subject to
these terms and conditions.  You may not impose any further
restrictions on the recipients' exercise of the rights granted herein.
You are not responsible for enforcing compliance by third parties to
this License.

  7. If, as a consequence of a court judgment or allegation of patent
infringement or for any other reason (not limited to patent issues),
conditions are imposed on you (whether by court order, agreement or
otherwise) that contradict the conditions of this License, they do not
excuse you from the conditions of this License.  If you cannot
distribute so as to satisfy simultaneously your obligations under this
License and any other pertinent obligations, then as a consequence you
may not distribute the Program at all.  For example, if a patent
license would not permit royalty-free redistribution of the Program by
all those who receive copies directly or indirectly through you, then
the only way you could satisfy both it and this License would be to
refrain entirely from distribution of the Program.

If any portion of this section is held invalid or unenforceable under
any particular circumstance, the balance of the section is intended to
apply and the section as a whole is intended to apply in other
circumstances.

It is not the purpose of this section to induce you to infringe any
patents or other property right claims or to contest validity of any
such claims; this section has the sole purpose of protecting the
integrity of the free software distribution system, which is
implemented by public license practices.  Many people have made
generous contributions to the wide range of software distributed
through that system in reliance on consistent application of that
system; it is up to the author/donor to decide if he or she is willing
to distribute software through any other system and a licensee cannot
impose that choice.

This section is intended to make thoroughly clear what is believed to
be a consequence of the rest of this License.

  8. If the distribution and/or use of the Program is restricted in
certain countries either by patents or by copyrighted interfaces, the
original copyright holder who places the Program under this License
may add an explicit geographical distribution limitation excluding
those countries, so that distribution is permitted only in or among
countries not thus excluded.  In such case, this License incorporates
the limitation as if written in the body of this License.

  9. The Free Software Foundation may publish revised and/or new versions
of the General Public License from time to time.  Such new versions will
be similar in spirit to the present version, but may differ in detail to
address new problems or concerns.

Each version is given a distinguishing version number.  If the Program
specifies a version number of this License which applies to it and "any
later version", you have the option of following the terms and conditions
either of that version or of any later version published by the Free
Software Foundation.  If the Program does not specify a version number of
this License, you may choose any version ever published by the Free Software
Foundation.

  10. If you wish to incorporate parts of the Program into other free
programs whose distribution conditions are different, write to the author
to ask for permission.  For software which is copyrighted by the Free
Software Foundation, write to the Free Software Foundation; we sometimes
make exceptions for this.  Our decision will be guided by the two goals
of preserving the free status of all derivatives of our free software and
of promoting the sharing and reuse of software generally.

			    NO WARRANTY

  11. BECAUSE THE PROGRAM IS LICENSED FREE OF CHARGE, THERE IS NO WARRANTY
FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW.  EXCEPT WHEN
OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES
PROVIDE THE PROGRAM "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED
OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.  THE ENTIRE RISK AS
TO THE QUALITY AND PERFORMANCE OF THE PROGRAM IS WITH YOU.  SHOULD THE
PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL NECESSARY SERVICING,
REPAIR OR CORRECTION.

  12. IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN WRITING
WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MAY MODIFY AND/OR
REDISTRIBUTE THE PROGRAM AS PERMITTED ABOVE, BE LIABLE TO YOU FOR DAMAGES,
INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING
OUT OF THE USE OR INABILITY TO USE THE PROGRAM (INCLUDING BUT NOT LIMITED
TO LOSS OF DATA OR DATA BEING RENDERED INACCURATE OR LOSSES SUSTAINED BY
YOU OR THIRD PARTIES OR A FAILURE OF THE PROGRAM TO OPERATE WITH ANY OTHER
PROGRAMS), EVEN IF SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE
POSSIBILITY OF SUCH DAMAGES.

		     END OF TERMS AND CONDITIONS

	    How to Apply These Terms to Your New Programs

  If you develop a new program, and you want it to be of the greatest
possible use to the public, the best way to achieve this is to make it
free software which everyone can redistribute and change under these terms.

  To do so, attach the following notices to the program.  It is safest
to attach them to the start of each source file to most effectively
convey the exclusion of warranty; and each file should have at least
the "copyright" line and a pointer to where the full notice is found.

    <one line to give the program's name and a brief idea of what it does.>
    Copyright (C) <year>  <name of author>

    This program is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License along
    with this program; if not, write to the Free Software Foundation, Inc.,
    51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.

Also add information on how to contact you by electronic and paper mail.

If the program is interactive, make it output a short notice like this
when it starts in an interactive mode:

    Gnomovision version 69, Copyright (C) year name of author
    Gnomovision comes with ABSOLUTELY NO WARRANTY; for details type `show w'.
    This is free software, and you are welcome to redistribute it
    under certain conditions; type `show c' for details.

The hypothetical commands `show w' and `show c' should show the appropriate
parts of the General Public License.  Of course, the commands you use may
be called something other than `show w' and `show c'; they could even be
mouse-clicks or menu items--whatever suits your program.

You should also get your employer (if you work as a programmer) or your
school, if any, to sign a "copyright disclaimer" for the program, if
necessary.  Here is a sample; alter the names:

  Yoyodyne, Inc., hereby disclaims all copyright interest in the program
  `Gnomovision' (which makes passes at compilers) written by James Hacker.

  <signature of Ty Coon>, 1 April 1989
  Ty Coon, President of Vice

This General Public License does not permit incorporating your program into
proprietary programs.  If your program is a subroutine library, you may
consider it more useful to permit linking proprietary applications with the
library.  If this is what you want to do, use the GNU Lesser General
Public License instead of this License.
```

```
// Copyright 2014 PDFium Authors. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google Inc. nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 5.3 表格预览的两份 FortuneSheet 补丁（逐字节取自上游 DSH）

`patches/` 下两份补丁在 `pnpm-workspace.yaml` 的 `patchedDependencies` 里正式登记（安装时由 pnpm 自动套用），
**逐字节取自上游 DSH 的 `patches/**`**（SHA256 与上游 `pnpm-lock.yaml` 的 `patch_hash` 相同）：

| 补丁                                        | 改了哪几处                                                                                                    | 效果                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `patches/@fortune-sheet__core@1.0.4.patch`  | `rangeValueToHtml` 改用 `_.escape`；`drawFreezeLine` 在只读态直接返回；`handleGlobalWheel` 加只读态像素级平移 | 复制成 HTML 不再漏转义；只读态不画冻结线手柄；触控板两轴平移 |
| `patches/@fortune-sheet__react@1.0.4.patch` | 编辑栏只读时显示公式原文并改用 `textContent`；切表恢复该表自己的选区；工作表标签滚动按钮宽度算法              | 编辑栏无 HTML 注入面；切表保住选区；标签多时不误判           |

补丁只改这两个包（仓库里只有表格预览用它们），对既有功能没有影响面。

### 5.4 这一节没做到的（边界，别当"已穷尽"）

- 表格预览那条链**已经补到传递依赖**（§5.1 + §5.1.1，逐份原文）。**还没补的是另一档**：
  `dependencies` 里那些随包进 app.asar 的包（`exceljs`、`mammoth`、`docx`、`pptxgenjs`、`node-pty`、
  AI-SDK 全家等）**没有逐包清单** —— 它们各自的 `LICENSE` 确实随包在 asar 内，但没有落到这份文件上。
  要穷尽得单开一轮依赖清点。
- 本轮**没有跑构建**，所以"某个包确实被内联进产物"这件事没有在产物上实测（依据是渲染端 import
  关系 + vite 的打包口径）；`pdfjs-dist` 那几条之所以写"在包里"，是因为用 `@electron/asar`
  列过 0.1.1 的实际安装包（真凭据），两者不是一回事。
- **§5.5 / §5.5.1 那一组（katex / remark-math / rehype-katex / dompurify / yaml 及其传递依赖）**：
  直接依赖与传递闭包都已逐份列出（包内没有许可文件的那 16 个改读同版本的上游 tag，来源逐条写明）。
  **仍待做的**：在**构建产物**上逐包核对"是否真被内联"——`pnpm build` 现在被另一处 import 报错挡着
  （`src/renderer/src/features/workbench/preview/dsh-media/math-compatibility.ts` 里
  `import { factorySpace } from 'micromark-factory-space'` 解析不到：该包在 `.pnpm` 里装了 2.1.0，
  但没 hoist 到 `node_modules` 根），等那份接线落定后再回来把这条边界收掉。

### 5.5 数学排版与净化新增的一组（构建期内联）

版本按仓库 `save-exact` 习惯**钉死**（`package.json` 里不带 `^`）；`katex` 钉在 0.16 线是刻意的——
`rehype-katex@7` 的依赖是 `katex@^0.16.0`，钉 0.19 会踩出两份 katex（样式与 JS 版本也会对不上）。

| 包             | 版本    | 许可                    | 是什么                                               |
| -------------- | ------- | ----------------------- | ---------------------------------------------------- |
| `katex`        | 0.16.47 | MIT                     | 数学公式排版（KaTeX 本体：样式 + DOM 结构）          |
| `remark-math`  | 6.0.0   | MIT                     | react-markdown 那条链上的 remark 数学插件            |
| `rehype-katex` | 7.0.1   | MIT                     | 同一条链上的 rehype 渲染插件（把数学节点交给 KaTeX） |
| `dompurify`    | 3.4.17  | (MPL-2.0 OR Apache-2.0) | HTML 净化；我们按 **Apache-2.0** 这一支依赖（见下）  |
| `yaml`         | 2.9.1   | ISC                     | YAML 文本解析                                        |

**katex**（npm 包内 `LICENSE` 原文）：

```text
The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors

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
```

**remark-math 与 rehype-katex**：两份 npm tarball 都**没有**附带许可文件（`package.json` 的 `license`
字段写的都是 MIT）。两者出自同一个单仓 `remarkjs/remark-math`（`rehype-katex` 是它的子包，
`repository` 字段指向 `.../tree/main/packages/rehype-katex`），下面用的是该仓库根 `license` 的原文
（实测 tag `6.0.0` 可取；`rehype-katex-7.0.1` / `7.0.1` 这类 tag 取不到，故不引）：

```text
(The MIT License)

Copyright (c) 2017 Junyoung Choi <fluke8259@gmail.com>

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
```

**dompurify** 是**双许可**（`package.json` 写 `(MPL-2.0 OR Apache-2.0)`）：包内的 `LICENSE` 是
**Apache-2.0 全文**，`LICENSE-MPL` 是 MPL-2.0 全文。我们按 **Apache-2.0** 依赖（内联进 bundle 的形态下
这一支最干净），因此**Apache-2.0 全文见本文件第 2 节**（同一份标准文本，不重复贴一遍）；
包内没有 `NOTICE` 文件，无需额外携带。

**yaml**（npm 包内 `LICENSE` 原文，ISC）：

```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

**KaTeX 的字体**（`dist/fonts/` 下 60 个文件，CSS 通过 `url(fonts/…)` 引用）：**本包内没有单独的字体许可文件**
——tarball 里只有一份 `LICENSE`（MIT 全文，即上面那份），README 的 License 一节也只写
"KaTeX is licensed under the MIT License"。所以按**包自身的口径**记为 MIT，本文件不做额外假定；
若将来需要更严格的字体来源核对，要另开一轮去查上游仓库的字体来源声明（本包里没有承载）。

这一组只补到**直接依赖**：传递依赖（`mdast-util-math`、`micromark-extension-math`、`hast-util-*`、
`unified`、`vfile`、`@types/*`、katex 自带的 `commander` 等）见 §5.5.1；那节的"会被内联"是按依赖边推的，
构建产物上的逐包核对在 §5.4 里标注为待办。

### 5.5.1 这一组带上来的传递依赖（会被内联的那些）

下表是 `katex` / `remark-math` / `rehype-katex` / `dompurify` / `yaml` **新带进来**的传递闭包（版本取自安装后的 `pnpm-lock.yaml`；许可字段与许可原文都读**已安装**的包，包内没有许可文件的那几个改读同版本的上游 tag，来源逐条列出）。
只有类型声明的 `@types/*` 与 katex 的 CLI 依赖 `commander` 不进产物（后者已核对：`katex` 的浏览器入口 `dist/katex.mjs` 里 0 次引用），所以它们不列原文；其余逐份照抄。另外提醒：本节的"会被内联"是按 `pnpm-lock.yaml` 的依赖边推的，**没有**在构建产物上逐包核对（`pnpm build` 现在被另一处 import 报错挡着，见 §5.4）。

| 包                                                  | 版本   | 许可         | 谁的依赖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 备注                                                       |
| --------------------------------------------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `@types/debug`                                      | 4.1.13 | MIT          | micromark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 只有类型，不进产物                                         |
| `@types/hast`                                       | 3.0.5  | MIT          | hast-util-from-dom / hast-util-from-html / hast-util-from-html-isomorphic / hast-util-from-parse5 / hast-util-is-element / hast-util-parse-selector / hast-util-to-text / hastscript / mdast-util-math / rehype-katex                                                                                                                                                                                                                                                                      | 只有类型，不进产物                                         |
| `@types/katex`                                      | 0.16.8 | MIT          | micromark-extension-math / rehype-katex                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 只有类型，不进产物                                         |
| `@types/mdast`                                      | 4.0.4  | MIT          | mdast-util-from-markdown / mdast-util-math / mdast-util-phrasing / mdast-util-to-markdown / mdast-util-to-string / remark-math                                                                                                                                                                                                                                                                                                                                                             | 只有类型，不进产物                                         |
| `@types/ms`                                         | 2.1.0  | MIT          | @types/debug                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 只有类型，不进产物                                         |
| `@types/unist`                                      | 3.0.3  | MIT          | @types/hast / @types/mdast / hast-util-from-parse5 / hast-util-to-text / mdast-util-from-markdown / mdast-util-to-markdown / unified / unist-util-find-after / unist-util-is / unist-util-remove-position / unist-util-stringify-position / unist-util-visit / unist-util-visit-parents / vfile / vfile-location / vfile-message                                                                                                                                                           | 只有类型，不进产物                                         |
| `bail`                                              | 2.0.2  | MIT          | unified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                            |
| `character-entities`                                | 2.0.2  | MIT          | decode-named-character-reference                                                                                                                                                                                                                                                                                                                                                                                                                                                           |                                                            |
| `comma-separated-tokens`                            | 2.0.3  | MIT          | hastscript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                            |
| `commander`                                         | 8.3.0  | MIT          | katex                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | katex 的 CLI 依赖；`dist/katex.mjs` 里 0 次引用 → 不进产物 |
| `debug`                                             | 4.4.3  | MIT          | micromark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `decode-named-character-reference`                  | 1.3.0  | MIT          | mdast-util-from-markdown / micromark / micromark-core-commonmark / micromark-util-decode-string                                                                                                                                                                                                                                                                                                                                                                                            |                                                            |
| `dequal`                                            | 2.0.3  | MIT          | devlop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                            |
| `devlop`                                            | 1.1.0  | MIT          | hast-util-from-html / hast-util-from-parse5 / mdast-util-from-markdown / mdast-util-math / micromark / micromark-core-commonmark / micromark-extension-math / micromark-factory-label / micromark-util-subtokenize / unified                                                                                                                                                                                                                                                               |                                                            |
| `entities`                                          | 4.3.0  | BSD-2-Clause | parse5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                            |
| `extend`                                            | 3.0.2  | MIT          | unified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                            |
| `hast-util-from-dom`                                | 5.0.1  | ISC          | hast-util-from-html-isomorphic                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                            |
| `hast-util-from-html-isomorphic`                    | 2.0.0  | MIT          | rehype-katex                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |                                                            |
| `hast-util-from-html`                               | 2.0.3  | MIT          | hast-util-from-html-isomorphic                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                                            |
| `hast-util-from-parse5`                             | 8.0.3  | MIT          | hast-util-from-html                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                            |
| `hast-util-is-element`                              | 3.0.0  | MIT          | hast-util-to-text                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                            |
| `hast-util-parse-selector`                          | 4.0.0  | MIT          | hastscript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                            |
| `hast-util-to-text`                                 | 4.0.2  | MIT          | rehype-katex                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |                                                            |
| `hastscript`                                        | 9.0.1  | MIT          | hast-util-from-dom / hast-util-from-parse5                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                            |
| `is-plain-obj`                                      | 4.1.0  | MIT          | unified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                            |
| `longest-streak`                                    | 3.1.0  | MIT          | mdast-util-math / mdast-util-to-markdown                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                            |
| `mdast-util-from-markdown`                          | 2.1.0  | MIT          | mdast-util-math                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                            |
| `mdast-util-math`                                   | 3.0.0  | MIT          | remark-math                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                            |
| `mdast-util-phrasing`                               | 4.1.0  | MIT          | mdast-util-to-markdown                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                            |
| `mdast-util-to-markdown`                            | 2.2.0  | MIT          | mdast-util-math                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                            |
| `mdast-util-to-string`                              | 4.0.0  | MIT          | mdast-util-from-markdown / mdast-util-to-markdown                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                            |
| `micromark-core-commonmark`                         | 2.0.4  | MIT          | micromark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-extension-math`                          | 3.1.0  | MIT          | remark-math                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                            |
| `micromark-factory-destination`                     | 2.0.0  | MIT          | micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-factory-label`                           | 2.0.0  | MIT          | micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-factory-space`                           | 2.1.0  | MIT          | micromark / micromark-core-commonmark / micromark-extension-math / micromark-factory-title / micromark-factory-whitespace                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-factory-title`                           | 2.0.0  | MIT          | micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-factory-whitespace`                      | 2.0.0  | MIT          | micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-util-character`                          | 2.0.0  | MIT          | mdast-util-to-markdown / micromark / micromark-core-commonmark / micromark-extension-math / micromark-factory-destination / micromark-factory-label / micromark-factory-space / micromark-factory-title / micromark-factory-whitespace / micromark-util-classify-character / micromark-util-decode-string / micromark-util-sanitize-uri                                                                                                                                                    |                                                            |
| `micromark-util-chunked`                            | 2.0.0  | MIT          | micromark / micromark-core-commonmark / micromark-util-combine-extensions / micromark-util-subtokenize                                                                                                                                                                                                                                                                                                                                                                                     |                                                            |
| `micromark-util-classify-character`                 | 2.0.0  | MIT          | mdast-util-to-markdown / micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                            |
| `micromark-util-combine-extensions`                 | 2.0.0  | MIT          | micromark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-util-decode-numeric-character-reference` | 2.0.0  | MIT          | mdast-util-from-markdown / micromark / micromark-util-decode-string                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                            |
| `micromark-util-decode-string`                      | 2.0.1  | MIT          | mdast-util-from-markdown / mdast-util-to-markdown                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                            |
| `micromark-util-edit-map`                           | 1.0.0  | MIT          | micromark / micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                            |
| `micromark-util-encode`                             | 2.0.0  | MIT          | micromark / micromark-util-sanitize-uri                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                            |
| `micromark-util-html-tag-name`                      | 2.0.0  | MIT          | mdast-util-to-markdown / micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                            |
| `micromark-util-normalize-identifier`               | 2.0.0  | MIT          | mdast-util-from-markdown / micromark / micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                           |                                                            |
| `micromark-util-resolve-all`                        | 2.0.0  | MIT          | micromark / micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                            |
| `micromark-util-sanitize-uri`                       | 2.0.0  | MIT          | micromark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `micromark-util-subtokenize`                        | 2.0.0  | MIT          | micromark / micromark-core-commonmark                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                            |
| `micromark-util-symbol`                             | 2.0.0  | MIT          | mdast-util-from-markdown / micromark / micromark-core-commonmark / micromark-extension-math / micromark-factory-destination / micromark-factory-label / micromark-factory-title / micromark-factory-whitespace / micromark-util-character / micromark-util-chunked / micromark-util-classify-character / micromark-util-decode-numeric-character-reference / micromark-util-decode-string / micromark-util-normalize-identifier / micromark-util-sanitize-uri / micromark-util-subtokenize |                                                            |
| `micromark-util-types`                              | 2.0.3  | MIT          | mdast-util-from-markdown / micromark / micromark-core-commonmark / micromark-extension-math / micromark-factory-destination / micromark-factory-label / micromark-factory-space / micromark-factory-title / micromark-factory-whitespace / micromark-util-character / micromark-util-classify-character / micromark-util-combine-extensions / micromark-util-edit-map / micromark-util-resolve-all / micromark-util-subtokenize                                                            |                                                            |
| `micromark`                                         | 4.0.3  | MIT          | mdast-util-from-markdown                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                            |
| `ms`                                                | 2.1.3  | MIT          | debug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                            |
| `parse5`                                            | 7.0.0  | MIT          | hast-util-from-html                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                            |
| `property-information`                              | 7.2.0  | MIT          | hast-util-from-parse5 / hastscript                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                            |
| `space-separated-tokens`                            | 2.0.2  | MIT          | hastscript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                            |
| `trough`                                            | 2.2.0  | MIT          | unified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                            |
| `unified`                                           | 11.0.5 | MIT          | remark-math                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                            |
| `unist-util-find-after`                             | 5.0.0  | MIT          | hast-util-to-text                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                            |
| `unist-util-is`                                     | 6.0.1  | MIT          | mdast-util-phrasing / unist-util-find-after / unist-util-visit / unist-util-visit-parents                                                                                                                                                                                                                                                                                                                                                                                                  |                                                            |
| `unist-util-remove-position`                        | 5.0.0  | MIT          | hast-util-from-html-isomorphic / mdast-util-math                                                                                                                                                                                                                                                                                                                                                                                                                                           |                                                            |
| `unist-util-stringify-position`                     | 4.0.0  | MIT          | mdast-util-from-markdown / vfile-message                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                            |
| `unist-util-visit-parents`                          | 6.0.2  | MIT          | rehype-katex / unist-util-visit                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                            |
| `unist-util-visit`                                  | 5.1.0  | MIT          | mdast-util-to-markdown / unist-util-remove-position                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                            |
| `vfile-location`                                    | 5.0.3  | MIT          | hast-util-from-parse5                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                            |
| `vfile-message`                                     | 4.0.3  | MIT          | hast-util-from-html / vfile                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                            |
| `vfile`                                             | 6.0.3  | MIT          | hast-util-from-html / hast-util-from-parse5 / rehype-katex / unified / vfile-location                                                                                                                                                                                                                                                                                                                                                                                                      |                                                            |
| `web-namespaces`                                    | 2.0.1  | MIT          | hast-util-from-dom / hast-util-from-parse5                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                            |
| `zwitch`                                            | 2.0.4  | MIT          | mdast-util-to-markdown                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                            |

**文本 1**（`bail@2.0.2`、`character-entities@2.0.2`、`mdast-util-to-string@4.0.0`、`unist-util-find-after@5.0.0`、`unist-util-visit@5.1.0`）

```
(The MIT License)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 2**（`comma-separated-tokens@2.0.3`、`hast-util-is-element@3.0.0`、`hast-util-parse-selector@4.0.0`、`space-separated-tokens@2.0.2`、`unist-util-remove-position@5.0.0`、`unist-util-stringify-position@4.0.0`、`unist-util-visit-parents@6.0.2`、`vfile-location@5.0.3`、`web-namespaces@2.0.1`、`zwitch@2.0.4`）

```
(The MIT License)

Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 3**（`debug@4.4.3`）

```
(The MIT License)

Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2018-2021 Josh Junon

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the 'Software'), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 4**（`decode-named-character-reference@1.3.0`、`hast-util-from-parse5@8.0.3`、`hastscript@9.0.1`、`mdast-util-from-markdown@2.1.0`、`mdast-util-to-markdown@2.2.0`、`micromark-core-commonmark@2.0.4`、`micromark-factory-space@2.1.0`、`micromark-util-decode-string@2.0.1`、`micromark-util-edit-map@1.0.0`、`micromark-util-types@2.0.3`、`micromark@4.0.3`、`vfile-message@4.0.3`）

```
(The MIT License)

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 5**（`dequal@2.0.3`）

```
The MIT License (MIT)

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

**文本 6**（`devlop@1.1.0`）

```
(The MIT License)

Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 7**（`entities@4.3.0`）

```
Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

**文本 8**（`extend@3.0.2`）

```
The MIT License (MIT)

Copyright (c) 2014 Stefan Thomas

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 9**（`hast-util-from-dom@5.0.1`）

```
(ISC License)

Copyright (c) Keith McKnight <keith@mcknig.ht>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

**文本 10**（`hast-util-from-html-isomorphic@2.0.0`）

```
(The MIT License)

Copyright (c) 2023 Remco Haszing <remcohaszing@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 11**（`hast-util-from-html@2.0.3`）

```
(The MIT License)

Copyright (c) 2022 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 12**（`hast-util-to-text@4.0.2`）

```
(The MIT License)

Copyright (c) 2019 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 13**（`is-plain-obj@4.1.0`）

```
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 14**（`longest-streak@3.1.0`）

```
(The MIT License)

Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 15**（`mdast-util-math@3.0.0`、`micromark-extension-math@3.1.0`、`micromark-factory-destination@2.0.0`、`micromark-factory-label@2.0.0`、`micromark-factory-title@2.0.0`、`micromark-factory-whitespace@2.0.0`、`micromark-util-character@2.0.0`、`micromark-util-chunked@2.0.0`、`micromark-util-classify-character@2.0.0`、`micromark-util-combine-extensions@2.0.0`、`micromark-util-decode-numeric-character-reference@2.0.0`、`micromark-util-encode@2.0.0`、`micromark-util-html-tag-name@2.0.0`、`micromark-util-normalize-identifier@2.0.0`、`micromark-util-resolve-all@2.0.0`、`micromark-util-sanitize-uri@2.0.0`、`micromark-util-subtokenize@2.0.0`、`micromark-util-symbol@2.0.0`）

```
(The MIT License)

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

上面这份文本有 16 个包是**从上游仓库取的**（npm tarball 里没有许可文件），来源：

- `micromark-factory-destination@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-factory-destination@2.0.0/license
- `micromark-factory-label@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-factory-label@2.0.0/license
- `micromark-factory-title@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-factory-title@2.0.0/license
- `micromark-factory-whitespace@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-factory-whitespace@2.0.0/license
- `micromark-util-character@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-character@2.0.0/license
- `micromark-util-chunked@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-chunked@2.0.0/license
- `micromark-util-classify-character@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-classify-character@2.0.0/license
- `micromark-util-combine-extensions@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-combine-extensions@2.0.0/license
- `micromark-util-decode-numeric-character-reference@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-decode-numeric-character-reference@2.0.0/license
- `micromark-util-encode@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-encode@2.0.0/license
- `micromark-util-html-tag-name@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-html-tag-name@2.0.0/license
- `micromark-util-normalize-identifier@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-normalize-identifier@2.0.0/license
- `micromark-util-resolve-all@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-resolve-all@2.0.0/license
- `micromark-util-sanitize-uri@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-sanitize-uri@2.0.0/license
- `micromark-util-subtokenize@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-subtokenize@2.0.0/license
- `micromark-util-symbol@2.0.0` — https://cdn.jsdelivr.net/gh/micromark/micromark@micromark-util-symbol@2.0.0/license

**文本 16**（`mdast-util-phrasing@4.1.0`）

```
(The MIT License)

Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>
Copyright (c) 2017 Victor Felder <victor@draft.li>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 17**（`ms@2.1.3`）

```
The MIT License (MIT)

Copyright (c) 2020 Vercel, Inc.

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
```

**文本 18**（`parse5@7.0.0`）

```
Copyright (c) 2013-2019 Ivan Nikulin (ifaaan@gmail.com, https://github.com/inikulin)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

**文本 19**（`property-information@7.2.0`）

```
(The MIT License)

Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 20**（`trough@2.2.0`）

```
(The MIT License)

Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

**文本 21**（`unified@11.0.5`、`vfile@6.0.3`）

```
(The MIT License)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

**文本 22**（`unist-util-is@6.0.1`）

```
(The MIT license)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### 5.4 Office 编辑器隔离面（0.2.0 · M3-S3 起内联进 office bundle）

S3 把 `@betteroffice/docx-react`（devDependency，构建期打进**隔离面**的独立 bundle）接进产品；
它带来的传递依赖**不进安装包**，只有编译后的代码进 `kyclaw-office://surface/` 的产物，
因此按本节第二档口径（构建期内联）由本文件给出许可文本。版本取自本机 lockfile 的实际解析：

| 包                                                                                                               | 版本                                  | 许可 | 用在哪                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---- | ------------------------------------------------------------- |
| `@radix-ui/react-select` 及其依赖（`number`/`primitive`/`react-*`/`rect` 共 25 个包）                            | 2.4.1 等（见下方版权组）              | MIT  | 编辑器工具栏的字体/字号/列表等下拉选择（`docx-react` 的依赖） |
| `@floating-ui/core` / `@floating-ui/dom` / `@floating-ui/react-dom` / `@floating-ui/utils`                       | 1.8.0 / 1.8.0 / 2.1.9 / 0.2.12        | MIT  | 上述下拉的定位（`@radix-ui/react-popper` 的依赖）             |
| `sonner`                                                                                                         | 2.0.8                                 | MIT  | 编辑器内的轻提示（toast）                                     |
| `clsx`                                                                                                           | 2.1.1                                 | MIT  | 类名拼接（产品自身也在用，同一版本）                          |
| `aria-hidden`                                                                                                    | 1.2.6                                 | MIT  | 弹层打开时对背景做 aria-hidden（radix 依赖）                  |
| `detect-node-es`                                                                                                 | 1.1.0                                 | MIT  | 运行时环境判断（`use-sidecar` 的依赖）                        |
| `get-nonce`                                                                                                      | 1.0.1                                 | MIT  | 单例 nonce（`react-remove-scroll` 的依赖）                    |
| `react-remove-scroll` / `react-remove-scroll-bar` / `react-style-singleton` / `use-callback-ref` / `use-sidecar` | 2.7.2 / 2.3.8 / 2.2.3 / 1.3.3 / 1.1.3 | MIT  | 弹层滚动锁与样式单例（radix 依赖）                            |
| `tslib`                                                                                                          | 2.8.1                                 | 0BSD | TypeScript 运行时辅助（各 radix 包的编译产物依赖）            |

> `@radix-ui/react-select@2.4.1` 与产品自身的 radix（dialog/dropdown-menu/popover/tooltip）
> 版本不一定相同；Vite 各自打包，互不影响（S0 已用 `pnpm why` 记录）。

MIT 许可原文（**逐份照抄，版权行各不相同**；同一版权行覆盖的包已在上面表格列出）：

**文本 A — Copyright (c) 2022 WorkOS**（上表 25 个 `@radix-ui/*` 包）

```
MIT License

Copyright (c) 2022 WorkOS

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
```

**文本 B — Copyright (c) 2021-present Floating UI contributors**（`@floating-ui/*` 4 个包）

```
MIT License

Copyright (c) 2021-present Floating UI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 C — Copyright (c) 2023 Emil Kowalski**（`sonner`）

```
MIT License

Copyright (c) 2023 Emil Kowalski

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
```

**文本 D — Copyright (c) Luke Edwards**（`clsx`）

```
MIT License

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**文本 E — Copyright (c) 2017 Anton Korzunov**（`aria-hidden` / `react-remove-scroll` /
`react-remove-scroll-bar` / `react-style-singleton` / `use-callback-ref` / `use-sidecar`；
其中 `react-remove-scroll-bar` 的 npm tarball 没有附带 LICENSE 文件，`package.json` 声明 MIT，
与同作者其余包为同一份文本）

```
MIT License

Copyright (c) 2017 Anton Korzunov

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
```

**文本 F — Copyright (c) 2020 Anton Korzunov**（`get-nonce`）

```
MIT License

Copyright (c) 2020 Anton Korzunov

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
```

**文本 G — Copyright (c) 2017 Ilya Kantor**（`detect-node-es`）

```
MIT License

Copyright (c) 2017 Ilya Kantor

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
```

**文本 H — 0BSD**（`tslib`）

```
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

---

## 6. BetterOffice 编辑器内核与字体（0.2.0，只接 DOCX 的第一步）

0.2.0 起 Office 面（隔离 iframe）里的 DOCX 编辑器/查看器用 **BetterOffice**。四个包都放
`devDependencies`：包目录**不进安装包**（打包态 asar 里没有 `node_modules/@betteroffice`），
代码与字体在构建时被 Vite 内联进 office 渲染入口的 bundle（落成 `out/renderer/assets/*`），
所以许可文本只能由本文件承载（口径同第 5 节开头那张表）。`@betteroffice/docx-i18n` 是
`docx-react` 的传递依赖，同样随 bundle 分发，同样按本节声明。

| 包                         | 版本  | 许可                   | 用在哪                                                           |
| -------------------------- | ----- | ---------------------- | ---------------------------------------------------------------- |
| `@betteroffice/docx`       | 0.4.3 | Apache-2.0             | OOXML 解析 / 排版 / 编辑内核（Rust→WASM，4 个 `.wasm`）          |
| `@betteroffice/docx-react` | 0.4.3 | Apache-2.0             | 编辑器 / 查看器的 React 组件与样式（`styles.css`）               |
| `@betteroffice/docx-i18n`  | 0.4.3 | Apache-2.0             | `docx-react` 的界面文案（传递依赖）                              |
| `@betteroffice/fonts`      | 0.4.0 | Apache-2.0 AND OFL-1.1 | 随编辑器分发的西文字体（17 个字体族、65 个 `.ttf`）              |
| `@betteroffice/fonts-cjk`  | 0.4.0 | Apache-2.0 AND OFL-1.1 | 中日韩字体（Noto Sans SC/TC/JP/KR + Noto Serif SC，5 个 `.otf`） |

上游：`https://github.com/openooxml/betteroffice`（npm 上 `author=OpenOOXML`、
`homepage=https://betteroffice.dev/`），版本取自 npmmirror（`registry.npmmirror.com`）。
`@betteroffice/fonts-cjk` 是 `@betteroffice/fonts` 的 optional peer（中文必需显式安装）。
`fonts` 与 `fonts-cjk` 的 `package.json` 都把 `license` 写成 `(Apache-2.0 AND OFL-1.1)`：
**代码 Apache-2.0、字体 OFL-1.1**（两个包各带一份 Apache-2.0 的 `LICENSE` 与按字体族拆分的
`LICENSES/OFL-*.txt`）。

**字体的分发形态**：字体不以独立文件随安装包分发，而是以**构建内联形式随 JS bundle 分发**
（Vite 把它们落成 `out/renderer/assets/*.ttf|*.otf` 静态资产，运行时由 office 隔离面经同源协议取）。
OFL-1.1 第 2 条要求每一份副本都带著作权声明与许可文本：本节的字体版权行 + OFL-1.1 全文随本声明
分发即满足该项 —— 本文件经 `extraResources` 原样进安装目录的 `resources/skills/`，不在 asar 里。

### 6.1 Apache-2.0 全文（`@betteroffice/docx` / `docx-react` / `docx-i18n`，以及 `fonts` / `fonts-cjk` 的代码部分）

四个包各自带的 `LICENSE` 是**同一份** Apache-2.0 文本（四份 sha256 逐字节相同：
`004ed989f5f3e9941e180bcb338385aa5db84e3a929305b52551096e430e6707`）。原文照抄如下：

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2026 The OpenOOXML contributors

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### 6.2 OFL-1.1 全文（`@betteroffice/fonts` / `@betteroffice/fonts-cjk` 的字体部分）

包内 `LICENSES/` 按字体族逐份给出 OFL 文本（`fonts` 17 份、`fonts-cjk` 1 份），正文都是
**同一份 SIL Open Font License 1.1**，只有开头的版权行不同（统一下列在 6.3）。全文照抄
`node_modules/@betteroffice/fonts-cjk/LICENSES/OFL-NotoCJK.txt` 的正文部分：

```
This Font Software is licensed under the SIL Open Font License,
Version 1.1.

This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font
creation efforts of academic and linguistic communities, and to
provide a free and open framework in which fonts may be shared and
improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to
any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software
components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to,
deleting, or substituting -- in part or in whole -- any of the
components of the Original Version, by changing formats or by porting
the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed,
modify, redistribute, and sell modified and unmodified copies of the
Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the
corresponding Copyright Holder. This restriction only applies to the
primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created using
the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### 6.3 字体版权行（OFL 要求的著作权声明；逐字体族照抄包内 `LICENSES/OFL-*.txt`）

`@betteroffice/fonts@0.4.0`（17 个字体族、65 个 `.ttf`）：

- **Caladea**：`Copyright 2012 The Caladea Project Authors (https://github.com/huertatipografica/Caladea)`
- **Carlito**：`Copyright 2013 The Carlito Project Authors (https://github.com/googlefonts/carlito), with Reserved Font Name "Carlito"`
- **Comic Relief**：`Copyright 2013 The Comic Relief Project Authors (https://github.com/loudifier/Comic-Relief)`
- **DM Sans**：`Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts)`
- **DM Serif Display**：`Copyright 2014-2018 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries. Copyright 2019 Google LLC.`
- **Gelasio**：`Copyright 2022 The Gelasio Project Authors (https://github.com/SorkinType/Gelasio)`
- **Heebo**：`Copyright 2014 The Heebo Project Authors (https://github.com/OdedEzer/heebo)`
- **Inter**：`Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)`
- **Liberation**（Sans / Serif / Mono）：
  `Digitized data copyright (c) 2010 Google Corporation with Reserved Font Arimo, Tinos and Cousine.`
  `Copyright (c) 2012 Red Hat, Inc. with Reserved Font Name Liberation.`
- **Montserrat**：`Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git)`
- **Noto Naskh Arabic / Noto Sans Arabic**：`Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)`
- **Noto Sans Hebrew**：`Copyright 2022 The Noto Project Authors (https://github.com/notofonts/hebrew)`
- **Open Sans**：`Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans)`
- **Oswald**：`Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont)`
- **Poppins**：`Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)`
- **Roboto**：`Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic)`
- **Source Sans 3**：`Copyright 2010-2020 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries.`

`@betteroffice/fonts-cjk@0.4.0`（5 个 `.otf`；`LICENSES/OFL-NotoCJK.txt`）：

- **Noto Sans SC / TC / JP / KR**（`NotoSansSC-Regular.otf`、`NotoSansTC-Regular.otf`、
  `NotoSansJP-Regular.otf`、`NotoSansKR-Regular.otf`）：
  `Copyright 2014-2021 Adobe (https://adobe.com/), with Reserved Font Name 'Source'.`
- **Noto Serif SC**（`NotoSerifSC-Regular.otf`）：
  `Copyright 2017-2024 Adobe (https://adobe.com/), with Reserved Font Name 'Source'.`

### 6.4 本节的边界（别当"已穷尽"）

- 本节只覆盖**第一步接的 DOCX**（`@betteroffice/docx*` + 字体）；表格 / 演示的 Office 内核还没接，
  将来接入时按同口径在本文件追加。
- S0（依赖 + 入口 + 许可基线）的 office 入口**故意不 import 编辑器**，所以本步构建产物里还没有
  wasm / 字体，**也还没产生这几个包代码的分发义务**；S1 首次 import 编辑器后，`docx-react` 的
  传递依赖里新引入的那几个（如 `sonner`、`@radix-ui/react-select@2.4.1`，均 MIT）会随 bundle 内联，
  届时要把它们的许可文本补进第 5 节（同类 MIT 口径已有先例）。
- 体积口径（未压缩，`@betteroffice/*` npm 包内实测）：`docx` 的 4 个 wasm 合计 30,073,417 B
  （≈ 28.7 MiB）；`fonts` 的 65 个 ttf 合计 14,876,000 B（≈ 14.2 MiB）；`fonts-cjk` 的 5 个 otf
  合计 34,818,280 B（≈ 33.2 MiB）。它们随渲染端 bundle 分发，不进 asar 的 `dependencies`。
