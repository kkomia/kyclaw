import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-e2e-'))
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
  return { app, page, userDataDir }
}

/** 关实例 + 清临时 userData（cases 里放 finally） */
export async function closeApp(launched: LaunchedApp): Promise<void> {
  try {
    await launched.app.close()
  } catch {
    // 用例自己点过「关闭」时 app 已经退了，这里不必再抛
  }
  rmSync(launched.userDataDir, { recursive: true, force: true })
}

/** 等界面可用：输入卡出现（transport 端点 + 会话列表都就绪了） */
export async function waitForChat(page: Page): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 })
}

/** 发一条消息（输入 → 点发送钮） */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-send').click()
}
