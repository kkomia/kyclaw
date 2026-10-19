# 内核快照（0.2.0 / B4）

> **这个目录里只有 README 进 git**；`rc.2/` 与 `current.json` 是构建输入，113+ MiB / 12,241 文件，
> **不入库**（`.gitignore`：`resources/kernel/**` + 反排除 `!resources/kernel/README.md`）。

## 钉死的取证件（可追溯锚点）

| 项                        | 值                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 内核版本                  | `@deepseek-ai/*` **v0.2.1-rc.2**（DSH 桌面安装版内嵌内核快照）                                                                                   |
| 取证件                    | `kernel-snapshot-rc2-complete.tar.gz`（27.3 MiB，`bytes=28602571`）                                                                              |
| **SHA256（验收⑤取证值）** | `206C75FD6B01A8CDA42E58159B055408D740CB99137BF665B726D219F820905D`                                                                               |
| 包数                      | **524**（`SNAPSHOT.json.packagesKept`）                                                                                                          |
| 文件数                    | **12,241** 总文件 = node_modules **12,236** + 根 5（SNAPSHOT.json / SHA256SUMS.txt / package.json / packages.tsv / packages-by-capability.json） |
| 未压缩体积                | node_modules **118,838,345 B（113.3 MiB）**（`SNAPSHOT.json.bytes`）                                                                             |
| app.asar.unpacked 覆盖区  | **306 文件 / 1,290,831 B**（`SNAPSHOT.json.overlay`，见下）                                                                                      |
| 逐文件清单                | `rc.2/SHA256SUMS.txt`（12,236 行）                                                                                                               |
| 调研依据                  | `.superpowers/dev-verify/20261019-0.2.0/ada/kernel-snapshot.md`、`b4-packaging-research.md`（本地）                                              |

## ⚠️ 勘误：初版取证件漏了 `app.asar.unpacked` 区（PB-005 实测）

- Ada 初版 `kernel-snapshot-rc2.tar.gz`（`SHA256=BD1CB9075F497155F45B2D11A520C861173E32694569FF98D2E0477E12E7B241`，
  11,935 文件）**只从 DSH 的 `app.asar` 提取**；但 electron-builder 把一部分文件放在
  `app.asar.unpacked`（asarUnpack 区），asar 里没有它们。
- 后果：真实轮次 `require('koffi')` 立刻失败
  → `Cannot find module ...\node_modules\koffi\src\koffi\index.js`（Bao 的
  `bao/b3-4-integration-kernel-tree-koffi.log`，stub 一个请求都没收到）。
- 修复：把 unpacked 区里**包根仍在快照内**的文件 overlay 进来（按 package.json 就近包根判定）：
  **306 文件 / 1.23 MiB**，其中 `koffi` 43（650 KB）、`fontkit` 122（494 KB）、`restructure` 18、
  `@swc/helpers` 108、其余若干 README/LICENSE。被裁掉的包（LibreOffice kit 182 MB、sherpa-onnx、
  @img/sharp 等，共 752 文件 / 234.5 MB）**仍然不进包**（裁剪口径不变）。
- 重新冻结为 `kernel-snapshot-rc2-complete.tar.gz`（上面表中的 SHA256）；`SNAPSHOT.json` 里记了
  `overlay`（来源/文件数/字节数/原因）与 `baseTarballSha256`（初版取证值），`SHA256SUMS.txt` 已重算。
- 本地证据：`.superpowers/dev-verify/20261019-0.2.0/kai/`（overlay 探测报告 + 修复脚本）。

## 怎么落到这里

```powershell
# 取证件默认位置（本机，不入库）：
#   .superpowers/dev-verify/20261019-0.2.0/ada/kernel-snapshot-rc2-complete.tar.gz
pnpm fetch:kernel                      # 校验 tar.gz SHA256 → 解到 rc.2/ → 全量核对 → 写 current.json
pnpm fetch:kernel -- --verify          # 只校验现有 rc.2/ 与 current.json
pnpm fetch:kernel -- --force           # 重新解压覆盖
$env:KYCLAW_KERNEL_TARBALL = 'D:\path\to\kernel-snapshot-rc2-complete.tar.gz'; pnpm fetch:kernel   # 换源头
```

脚本会：① 校验 tar.gz 字节数 + SHA256（不匹配不接包）；② 解到临时目录并按 `SNAPSHOT.json` /
`SHA256SUMS.txt` 全量核对后才替换 `rc.2/`；③ 写 `current.json`（主进程按它找版本目录）。

## 运行时布局（随包后）

```
<安装目录>/resources/kernel/
  current.json            # { version:'rc.2', path:'rc.2', sha256:'BCA9…' }
  rc.2/
    SNAPSHOT.json
    SHA256SUMS.txt
    node_modules/@deepseek-ai/dsh/lib/bin.js   # Electron-as-node 入口
```

- `electron-builder.yml` 用 `extraResources` 原样拷到安装目录 `resources/kernel/`（**不进 asar**：
  内核树要按真实路径启动 Node，且 node-pty 要从磁盘 spawn 自己的 exe）。
- 主进程：打包态 `process.resourcesPath/kernel`，开发态 `app.getAppPath()/resources/kernel`，
  `KYCLAW_KERNEL_ROOT` 可覆盖（e2e/故障演练用；也可直接指到某个版本目录）。
- `DSH_HOME` 固定指 `userData/dsh-home`，内核数据**不落仓库、不落安装目录**。
- 换内核 = 换 tar.gz + 改 `scripts/fetch-kernel.mjs` 的 `PINNED`（版本/字节数/SHA256/文件数/overlay 数）+ 改本 README。
