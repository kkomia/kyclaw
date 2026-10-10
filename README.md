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
```
