# kyclaw

Kimi 风格三栏桌面应用：Electron 44 + React 19 壳，主进程内嵌 Mastra agent（会话/记忆/工具）。

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## 环境

- Node ≥ 22.13（`engines.node`），pnpm 11（`packageManager` 已锁版本，用 `corepack` 或直接装 pnpm 11）
- 依赖与 Electron/electron-builder 二进制的下载镜像配在 `.npmrc`（npmmirror）

## Project Setup

### Install

```bash
pnpm install
```

### Development

```bash
pnpm dev
```

### Build

```bash
# 只出 out/（electron-vite 三层产物）
pnpm build

# 首次出包前先取本机嵌入引擎的运行时（模块 3B）：下载 + SHA256 校验 + 裁剪到 resources/llama/（约 42MB）
# 二进制不入库；`pnpm package` 会检查它在不在
pnpm fetch:llama

# 出 Windows 安装包：dist/kyclaw-<version>-setup.exe（NSIS，用户级安装，不需要管理员）
pnpm package
```

安装包**没有代码签名**：首次运行会被 SmartScreen 拦一下（"更多信息 → 仍要运行"）。装完的
`%APPDATA%\kyclaw` 与 `pnpm dev` 共用同一份数据（设置、密钥、会话库），两者同时只能跑一个
（单实例锁）。

### Check

```bash
# 类型 + lint + 格式 + 单测 + 构建
pnpm check

# E2E 冒烟（Playwright 驱动真 Electron 实例：启动/流式/停止/审批/走查取证）
# 每例独立 userData、KYCLAW_FORCE_MOCK=1 离线跑，不需要 playwright install
pnpm test:e2e
```

## 更新与追踪（试点）

两个都**默认关**，不配就什么都不做（不发请求、不报错、不弹窗）。

- **更新**（electron-updater + generic 源）：地址优先看环境变量 `KYCLAW_UPDATE_URL`，其次看设置页
  「关于」栏填的更新源（**改完当场生效，不用重启**；留空 = 用打包时烘焙进 resources/app-update.yml
  的那个源）。两者都指向一个放着渠道文件（正式版 `latest.yml`、预发布 `beta.yml`）的静态目录
  （MinIO / Gitee Release 直链 / 本机模拟源都行）；一个都没有时安静待着，设置页「关于」栏只写
  「未配置更新源」。检出后自动下载，但**安装要用户点"重启并安装"**。
- **追踪**（Langfuse）：设置页「追踪」栏填服务地址 + 公私钥（地址落 settings.json，密钥经
  safeStorage 落 secrets.json），三项齐了下一次启动开始上报。服务地址可以是官方云
  （`https://cloud.langfuse.com`）或自托管实例。

```bash
# 本机模拟更新源的起法（冒烟脚本已随库入库：scripts/make-feed.mjs / scripts/serve-feed.mjs）
node scripts/make-feed.mjs update-feed 1.0.1   # 造 latest.yml + 假安装包（sha512 真算）
node scripts/serve-feed.mjs update-feed 8555   # 静态伺服
KYCLAW_UPDATE_URL=http://127.0.0.1:8555/ pnpm dev
```
