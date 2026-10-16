# dsh-table：移植来源、许可与第三方声明

本目录的表格预览（xls / xlsx / csv / tsv）移植自 **DeepSeek Harness（DSH）**。

- **上游仓库**：`deepseek-harness`（本地研究快照在 `.superpowers/research/deepseek-harness`）
- **上游 commit**：`86a402200d95fecef4529d969836f1fe13c6cb0d`
- **上游路径**：`packages/client/ui-sidebar-documentpreview/src/client/excel/**`、`packages/client/ui-sidebar-documentpreview/src/config.ts` 的 `excel` 段、`patches/**`
- **上游许可**：MIT（Copyright © 2026 DeepSeek），原文见本文件末尾

## 文件对照（上游 → 本目录）

| 上游                                 | 本目录                         | 说明                                                                                                                                 |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `excel/index.ts`（宿主注册）         | ——                             | **不移植**：那是 cordis 宿主注册（扩展名表 / 槽位 / locale / limits 注入），本仓库没有这套宿主，改由 `ExcelPreview.tsx` 一个入口收口 |
| `excel/LazyExcelBody.tsx`            | `ExcelPreview.tsx`             | 对外入口（懒加载重解析链）                                                                                                           |
| `excel/excel.tsx`                    | `ExcelBody.tsx`                | 只读界面（FortuneSheet 配置与两条提示）                                                                                              |
| `excel/ExcelBody.module.css`         | `ExcelPreview.css`             | 上游是 CSS Module，这里改成挂在组件根类下的普通样式表                                                                                |
| `excel/model.ts`                     | `model.ts`                     | 展示数据形状 + 单元格收尾；上游的上限来自宿主配置，这里补 `EXCEL_LIMITS` 缺省常量                                                    |
| `excel/error.ts`                     | `errors.ts`                    | 另加一类 `worker`（见"口径差异"）                                                                                                    |
| `excel/format.ts`                    | `format.ts`                    | 另加 `excelFormatOrNull`（React 入口不抛异常）                                                                                       |
| `excel/locales.ts`                   | `text.ts`                      | 只取 `zh` 一份（本部署只有中文，不引 i18n 框架）                                                                                     |
| `excel/convert.ts`                   | `convert.ts`                   | ——                                                                                                                                   |
| `excel/xlsx.ts`                      | `xlsx.ts`                      | 类型面按本仓库 tsconfig 收敛（`.ts` 后缀 import 改掉、`contiguousBuffer` 显式化）                                                    |
| `excel/xlsx-archive.ts`              | `xlsx-archive.ts`              | ——                                                                                                                                   |
| `excel/xls.ts`                       | `xls.ts`                       | ——                                                                                                                                   |
| `excel/delimited.ts`                 | `delimited.ts`                 | ——                                                                                                                                   |
| `excel/parse.ts` + `excel/worker.ts` | `parse.ts` + `excel.worker.ts` | Worker 来源从 `?raw` + Blob 改成 Vite 的 worker 打包；**去掉同线程兜底**（见"口径差异"）；协议类型抽到 `worker-protocol.ts`          |
| `excel/asset-imports.d.ts`           | ——                             | 不需要：`vite/client` 已声明 `*?inline` / `*?raw` / `*.module.css`                                                                   |
| `src/config.ts` 的 `excel` 段        | `model.ts` 的 `EXCEL_LIMITS`   | 上限缺省（`maxCells` / `timeoutMs` 取上游值；`maxBytes` 见"口径差异"）                                                               |

## 生效中的补丁：FortuneSheet 两份（已配置）

仓库根的 `patches/` 下两份补丁**逐字节取自上游**（SHA256 与上游 `pnpm-lock.yaml` 里记的 `patch_hash` 完全相同），
并在 `pnpm-workspace.yaml` 正式登记：

| 补丁                                        | SHA256（= 上游 patch_hash）                                        | 改了哪几处                                                                                                                                          | 效果                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `patches/@fortune-sheet__core@1.0.4.patch`  | `8791a230763dbf853fd65d627c68c31de37209992851377855e16cf08ea70532` | `rangeValueToHtml` 改用 `_.escape`；`drawFreezeLine` 在 `allowEdit === false` 时直接返回；`handleGlobalWheel` 增加只读态的像素级平移                | 复制成 HTML 时 `&` 等字符不再漏转义；只读态不画冻结线手柄；触控板两轴按像素平移 |
| `patches/@fortune-sheet__react@1.0.4.patch` | `2932e52e79afcd4ced08cfa123b5eded786c85043da32f622f3e80af6fc96c37` | 编辑栏只读时显示 `cell.f` 且用 `textContent`（不用 `innerHTML`）；切换工作表时恢复该表自己的 `luckysheet_select_save`；工作表标签滚动按钮的宽度算法 | 编辑栏显示公式原文、无 HTML 注入面；切表保住选区；标签多时滚动按钮不误判        |

```yaml
# pnpm-workspace.yaml（已写入）
patchedDependencies:
  '@fortune-sheet/core@1.0.4': patches/@fortune-sheet__core@1.0.4.patch
  '@fortune-sheet/react@1.0.4': patches/@fortune-sheet__react@1.0.4.patch
```

- 安装后确认补丁真生效（两条 grep，值为 1 即已打上）：
  - `grep -c "Read-only trackpad panning" node_modules/@fortune-sheet/core/dist/index.esm.js`
  - `grep -c "allowEdit === false ? cell.f" node_modules/@fortune-sheet/react/dist/index.esm.js`
- 安全边界：这两个包是**本仓新引入的依赖，别处没人用**（`package.json` 里只有本特性引用），所以补丁的影响面仅限本目录。
- 补丁可套用性已核对：对 npm 上发布的 1.0.4 tarball 做 `patch -p1 --dry-run`，两份都**无一条 hunk 失败**（只改 `dist/index.esm.js` 与 `dist/index.js`，不动 `package.json`）。

## 未启用的补丁：ExcelJS（附带隔离性调查结论）

`dsh-table/patches/exceljs@4.4.0.patch`（SHA256 `c1bf8ac8f319dab382f08e3a669b715e691d46c703ac5a4163eb383fbedd1d48`，与上游 patch_hash 相同）
**没有启用**，也**没有**写进 `pnpm-workspace.yaml`。理由是它无法与主进程现有的 ExcelJS 用法隔离：

1. **pnpm 的补丁按"包名 + 版本"匹配，不认别名、不认导入方**。pnpm 11.0.8 的 `patching/config` 里
   `groupPatchedDependencies` 只按包名分组（`exact[version]` / `range` / `all`），命中判定是
   `getPatchInfo(patchFileGroups, pkgName, pkgVersion)` —— **只有包名与版本两个键**。
   所以 `exceljs-preview: npm:exceljs@4.4.0` 这种别名拿不到独立实例：它解析出来的包名仍是 `exceljs`、
   版本仍是 `4.4.0`，补丁会同时命中主进程那份（`edit_excel` / `workbench-office` 也用它）。
   反方向也不行：同一个版本只允许一份补丁（多份会 `PATCH_KEY_CONFLICT`）。
2. **"换个版本 + 定向补丁"这条路走不通**：补丁只对 4.4.0 干净可套（实测 7 个文件全过）；对 4.3.0 实测
   `dist/exceljs.js` **15/15 hunk 全失败**、`lib/xlsx/xlsx.js` 也失败 1/10。要换版本就得**手工重写**一份
   针对那份 bundle 的补丁——在没有测试槽的情况下等于往解析链里塞一份没人验过的补丁，不做。
3. 上游补丁本身的收益（非标准命名空间前缀、`/xl/` 绝对或 `../` 关系目标、UTF-16 编码的 XML 部件、
   外部/歧义部件直接拒）都是**少见但真实**的畸形工作簿场景。**四种格式（xls/xlsx/csv/tsv）不因此砍掉**，
   只是这几类文件在 stock ExcelJS 上更脆（解析失败会落到"无法打开此表格"+ 重试，不会画出错内容）。

要重新考虑这条，可选项（都需要主控拍板 + 连带复验 `edit_excel` / `workbench-office`）：
(a) 接受全局影响，把补丁加进 `patchedDependencies`；
(b) 换一个可信的 exceljs 重发布包做别名（本机未找到可信来源，属供应链风险，不建议）；
(c) 只在 `xlsx-archive.ts`（本目录自己的文件）里做**安全子集**的规范化，例如把 UTF-16 的 XML 部件
重编码成 UTF-8——这只是补丁收益的一小块，且同样需要先有测试覆盖，本轮未做。

## 本目录新引入的第三方依赖

| 包                     | 版本   | 许可       | 用在哪                                                                                       |
| ---------------------- | ------ | ---------- | -------------------------------------------------------------------------------------------- |
| `@fortune-sheet/core`  | 1.0.4  | MIT        | 展示数据结构与数字格式（`update`）/ 缩放常量                                                 |
| `@fortune-sheet/react` | 1.0.4  | MIT        | 只读表格画布（`Workbook`）与它的样式表                                                       |
| `exceljs`              | 4.4.0  | MIT        | XLSX 解析（**仓库原有依赖**，主进程 `edit_excel` 也在用；本目录**不加补丁**）                |
| `xlsx`（SheetJS）      | 0.20.3 | Apache-2.0 | 老版 `.xls`（BIFF）解析 + 代码页表；装的是官方 CDN 的 tarball（npm 上的 `xlsx` 停在 0.18.5） |
| `papaparse`            | 5.7.0  | MIT        | CSV / TSV 切分                                                                               |
| `fflate`               | 0.8.3  | MIT        | XLSX 包的读 / 写（摘掉 DrawingML 后回写一份临时包）                                          |
| `fast-xml-parser`      | 5.11.1 | MIT        | 关系部件与工作表 XML 的扫描                                                                  |
| `@types/papaparse`     | 5.5.2  | MIT        | 上面那个的 TypeScript 类型                                                                   |

## 与上游的口径差异（只列会改变用户可见行为的）

1. **`maxBytes` 缺省 32 MiB**（上游 16 MiB）：与 kyclaw 字节通道的上限对齐，免得"主进程放行、
   渲染端又拿超过上限挡回去"。`maxCells`（25 万格）与 `timeoutMs`（15s）保持上游值。
2. **解析严格隔离在 Worker 里，没有同线程兜底**（上游会退回主线程）：
   - 环境里没有 Worker（jsdom 等）或 Worker 起不来 / 加载失败 / 收发失败 → 一律回 `ExcelPreviewError('worker')`，
     界面说"表格解析组件没能启动（Worker 不可用）。重试一次；再不行就用本地应用打开这份表格。"并摆**重试**按钮；
   - 不可信的大文件**不会**落在主线程上跑：那样既阻塞 UI，超时也真掐不断；
   - 无论成功 / 失败 / 超时 / abort，都立刻 `terminate()` 并摘掉全部回调 —— 中断即释放。
3. **失败种类多了 `worker` 这一类**（`errors.ts`；`worker-protocol.ts` 的白名单里仍然只有 Worker 会回的四种：
   `invalid` / `tooLarge` / `timeout` / `encoding`）。
4. **界面按"失败种类"取人话**（`ExcelPreviewError.code` → `text.ts`），不拿异常 message 直接当文案；
   不是 `ExcelPreviewError` 的异常一律按 `invalid` 说。
5. **不给缩放加 UI**：上游表格预览也没有缩放控件（它的 `zoom/` 模块只服务图片与 PDF）。
   FortuneSheet 自带的 `Ctrl` `+` / `-` / `0` 键盘缩放照旧可用。
6. **每个文件头部** 标注了上游路径；正文逻辑与上游一致，改动只在 import 形式、类型与上面几条。

## MIT License（上游 DSH 原文）

```text
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
