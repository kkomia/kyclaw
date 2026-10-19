import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { defaultSettings, type AppSettings } from '../src/shared/settings'
import { materializeStubKernel, type StubKernelOptions } from './kernel-stub/launcher'
import { STUB_REPLY_CHUNKS } from './kernel-stub/mock-reply'

/**
 * E2E 起真 Electron 实例的公共件（T16；0.2.0 / PB-021 改为 **kernel stub**）。
 *
 * 四条纪律：
 *   1. **每例一个 userData**（`mkdtemp` + `--user-data-dir`）：不碰用户的 `%APPDATA%/kyclaw`
 *      （真密钥、真会话、真设置），也顺带绕开单实例锁——锁跟着 userData 走，
 *      用户自己开着的那个实例不受影响；
 *   2. **离线可复跑**（0.2.0）：每个实例在自己的 userData 下铺一棵临时内核树
 *      （`kernel-stub/current.json` + `kernel-stub/e2e-stub/node_modules/@deepseek-ai/dsh/lib/bin.js`），
 *      用 `KYCLAW_KERNEL_ROOT` 注入。真内核（快照/模型/网络）只在显式 `kernel: 'real'` 时用；
 *      旧 `KYCLAW_FORCE_MOCK=1` 在 0.2.0 随旧内核一起删除。
 *   3. 只起 `pnpm build` 之后的 out/ 产物（package.json 的 main），不起 dev server。
 *   4. 过渡期（PB-020 删 flag 之前）：跑 stub 的 e2e 需要在命令上加 `$env:KYCLAW_KERNEL_PORT='1'`
 *      （env 会随 `process.env` 透传给 Electron）；flag 删除后不再需要。
 */
const repoRoot = resolve(__dirname, '..')

export interface LaunchOptions {
  /** 预置 settings.json 的补丁（缺的字段用 defaultSettings 的默认值补齐） */
  settings?: Partial<AppSettings>
  /** 预置 secrets.json 的 keys（base64 密文；"密文解不开"的抽查用得到） */
  secrets?: Record<string, string>
  /** 额外环境变量（默认已带 stub 内核注入；同名键覆盖） */
  env?: Record<string, string>
  /** 复用既有 userData（跨启动探针；不传 = 每例 mkdtemp 的现状） */
  userDataDir?: string
  /** 关闭时不清理 userData（默认 false = 清） */
  keepUserData?: boolean
  /**
   * 内核来源：
   *   - `stub`（默认）：离线 stub，协议回放（PB-021）；
   *   - `real`：真内核（需要本机 `resources/kernel` 快照 + 真 provider；只在显式真机探测里用）。
   */
  kernel?: 'stub' | 'real'
  /** stub 行为脚本（文本分片/间隔/场景/工具帧）；默认 = 旧 mock 三段原文 + 250ms 间隔 */
  stub?: Omit<StubKernelOptions, 'rootDir'>
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
  keepUserData: boolean
  /** stub 的 JSONL 事件日志（`kernel: 'real'` 时为空串）；证据用 */
  stubLogFile: string
}

/** stub 事件日志路径（与 `launchApp` 的落点一致；测试可在 closeApp 前读它证明"确实走了 stub"） */
export function stubLogPathOf(userDataDir: string): string {
  return join(userDataDir, 'kernel-stub.log')
}

/** 读 stub 的 JSONL 日志（文件不存在 = 空数组） */
export function readStubLog(userDataDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(stubLogPathOf(userDataDir), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'kyclaw-e2e-'))
  mkdirSync(userDataDir, { recursive: true })
  const settings: AppSettings = { ...defaultSettings(), ...options.settings }
  writeFileSync(
    join(userDataDir, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8'
  )
  if (options.secrets !== undefined) {
    writeFileSync(
      join(userDataDir, 'secrets.json'),
      `${JSON.stringify({ version: 1, keys: options.secrets }, null, 2)}\n`,
      'utf8'
    )
  }

  const kernelMode = options.kernel ?? 'stub'
  let kernelEnv: Record<string, string> = {}
  if (kernelMode === 'stub') {
    const stub = materializeStubKernel({
      rootDir: join(userDataDir, 'kernel-stub'),
      logFile: stubLogPathOf(userDataDir),
      ...options.stub
    })
    kernelEnv = stub.env
  }

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, ...kernelEnv, ...options.env } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const keepUserData = options.keepUserData === true || process.env.KYCLAW_E2E_KEEP_USERDATA === '1'
  if (keepUserData) {
    // 证据/排障：保留临时 userData，并把它（含 stub JSONL 日志）的位置打出来
    console.warn(`[e2e] keepUserData=${userDataDir} stubLog=${stubLogPathOf(userDataDir)}`)
  }
  return {
    app,
    page,
    userDataDir,
    keepUserData,
    stubLogFile: kernelMode === 'stub' ? stubLogPathOf(userDataDir) : ''
  }
}

/** 关实例 + 清临时 userData（cases 里放 finally） */
export async function closeApp(launched: LaunchedApp): Promise<void> {
  try {
    await launched.app.close()
  } catch {
    // 用例自己点过「关闭」时 app 已经退了，这里不必再抛
  }
  if (launched.keepUserData !== true) rmSync(launched.userDataDir, { recursive: true, force: true })
}

/**
 * 等界面可用：输入卡出现。
 * round 76：输入卡**第一帧就在**（不再等端点/会话列表/历史回灌），所以这一等基本是"外壳起来了"。
 * "能不能发"由发送钮的可用态把着 —— `sendMessage` 里 Playwright 点按钮会自动等到它可点，
 * 这里不必另等（也就不会把"还没就绪"误判成失败）。
 */
export async function waitForChat(page: Page): Promise<void> {
  // 60s：并发开发机（多个 agent/构建同时跑）冷启动偶发 >30s；纯等待，不改产品行为
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 60_000 })
}

/**
 * 发一条消息（输入 → 点发送钮）。
 *
 * 为什么带重填：`composer-input` 是受控组件，`waitForChat` 只看得到"壳起来了"；
 * 若 Playwright 的 `fill` 恰好落在 React 首次挂载前后，受控组件会用空 state 把 DOM 值覆盖回去，
 * 发送钮因此一直是 disabled（历史 flake：sessions/stop 用例偶发 30s 超时，截图里输入框是空的）。
 * 这里以"发送钮可用"为准重填，最多 30s（并发开发机上 agent 服务/ask-user 取数冷启动可能 >15s；
 * 纯等待，不改产品行为）；重填还不亮 = 真的被其它状态锁住（让断言明确失败）。
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input')
  const send = page.getByTestId('composer-send')
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await input.fill(text)
    if (await send.isEnabled().catch(() => false)) {
      await send.click()
      return
    }
    await page.waitForTimeout(250)
  }
  await expect(send).toBeEnabled({ timeout: 15_000 })
  await send.click()
}

/** 旧 mock 的三段原文（chat/sessions 的断言口径；stub 默认分片与它逐字一致） */
export { STUB_REPLY_CHUNKS }
