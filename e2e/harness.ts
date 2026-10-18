import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { defaultSettings, type AppSettings } from '../src/shared/settings'

/**
 * E2E 起真 Electron 实例的公共件（T16）。
 *
 * 三条纪律：
 *   1. **每例一个 userData**（`mkdtemp` + `--user-data-dir`）：不碰用户的 `%APPDATA%/kyclaw`
 *      （真密钥、真会话、真设置），也顺带绕开单实例锁——锁跟着 userData 走，
 *      用户自己开着的那个实例不受影响；
 *   2. `KYCLAW_FORCE_MOCK=1`（R3）：离线 mock provider，不读任何密钥、零网络；
 *   3. 只起 `pnpm build` 之后的 out/ 产物（package.json 的 main），不起 dev server。
 */
const repoRoot = resolve(__dirname, '..')

export interface LaunchOptions {
  /** 预置 settings.json 的补丁（缺的字段用 defaultSettings 的默认值补齐） */
  settings?: Partial<AppSettings>
  /** 预置 secrets.json 的 keys（base64 密文；"密文解不开"的抽查用得到） */
  secrets?: Record<string, string>
  /** 额外环境变量（默认已带 KYCLAW_FORCE_MOCK=1） */
  env?: Record<string, string>
  /** 复用既有 userData（跨启动探针；不传 = 每例 mkdtemp 的现状） */
  userDataDir?: string
  /** 关闭时不清理 userData（默认 false = 清） */
  keepUserData?: boolean
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
  keepUserData: boolean
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

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, KYCLAW_FORCE_MOCK: '1', ...options.env } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userDataDir, keepUserData: options.keepUserData === true }
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
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 })
}

/** 发一条消息（输入 → 点发送钮） */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-send').click()
}
