/**
 * R91 打包态预览验收（**真安装包目录**，不是 `out/` 构建态）：
 * 用 `dist/win-unpacked/kyclaw.exe`（或用 `KYCLAW_PACKAGED_PREVIEW_EXE` 指到别处，例如某次发布解出来的
 * 目录）起真应用，**通过 UI 的文件树**逐档看预览，另验「关于 → 更新日志」读到本版、以及终端真命令回显。
 *
 * ── 门与前置（门开着就是硬闸门，**不静默跳过**）─────────────────────────────────
 *   门：`KYCLAW_PACKAGED_PREVIEW=1`；没开就整文件 skip。
 *   开着时：缺打包件 / 缺 app.asar.unpacked 的原生件 / 缺随包 kit / 缺随包发行日志 / 缺许可声明 /
 *   asar 里混进根 `patches/**` / 缺旧版（.doc/.xls/.ppt）夹具 —— 任一都在 `beforeAll` **直接 fail**，
 *   报错里带完整路径。
 *
 * ── 与 R90 的分工 ──────────────────────────────────────────────────────────────
 *   · R90（`_r90-preview-release.spec.ts`）跑 `out/` 构建态，覆盖更全（含截图、复制、取消、缩放）；
 *   · 这里只认**装出来的那一份**，覆盖面刻意收窄到"装完后还能不能看"：Office 两类 + 表格两类 +
 *     HTML + SVG、关于页的本版日志、终端回显、以及安装目录的 file/asar 路径。
 *   · 更新源/换源/下载阶段那条在 `update-notes.spec.ts`（另一个已有 exe override 的探针）。
 *
 * ── 隔离与凭据 ───────────────────────────────────────────────────────────────
 *   · profile 与工作区都在 `mkdtemp` 里（`writePackagedProfile`：显式 workspace +
 *     `defaultWorkspaceInitialized: true`）→ **不碰真实 `%APPDATA%\kyclaw`、不碰 `<home>/kyclaw/工作区`**；
 *   · 夹具只写进**产品自己给出的会话根**（`files-root` 的 title），且断言它落在临时工作区里；
 *   · 不读任何 secret 文件；provider 指向本地 scripted stub（`startInteractiveProvider()`），
 *     **不需要真模型**：本探针只借它走一条最小回合把会话/工作台立起来，不做对话断言。
 *
 * ── 跑法（需要先有打包件）────────────────────────────────────────────────────
 *   corepack pnpm --config.verify-deps-before-run=false package        # 或 build:unpack
 *   KYCLAW_PACKAGED_PREVIEW=1 corepack pnpm --config.verify-deps-before-run=false exec playwright test \
 *     e2e/_r91-packaged-preview.spec.ts
 *   证据：`.superpowers/packaged-preview/<时间戳>-<pid>/`（截图 + `packaged.json`；截图要人眼看）
 */
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { startInteractiveProvider } from './fixtures/interactive'
import {
  packagedExePath,
  packagedLayout,
  packagedResourceProblems,
  removePackagedProfile,
  repoVersion,
  writePackagedProfile,
  type PackagedProfile
} from './fixtures/packaged-preview'
import { LEGACY_FIXTURES_DIR, writeR90Fixtures } from './fixtures/r90'

const ENABLED = process.env.KYCLAW_PACKAGED_PREVIEW === '1'
const EVIDENCE_DIR = resolve('.superpowers', 'packaged-preview', `${Date.now()}-${process.pid}`)
/** 旧版三件（.doc/.xls/.ppt）的本地来源；缺了就是硬闸门（R90 同款口径） */
const LEGACY_SOURCES = ['SampleDoc.doc', 'chinese-provinces.xls', 'basic_test_ppt_file.ppt']
/** 终端回显的"执行过才出现"标记：命令里发 `$$`，只有真执行才会变成数字 */
const PTY_MARKER_PATTERN = /KYCLAW_R91_PTY_OK_\d+/

/** 点文件树里的某一行（单击 = 内联预览；与 R90 同一套定位口径） */
async function clickFile(
  page: Page,
  name: string,
  mode: 'inline' | 'tab' = 'inline'
): Promise<void> {
  const row = page.locator(`[data-testid="file-row"][data-kind="file"][data-relative="${name}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  if (mode === 'inline') await row.click()
  else await row.dblclick()
}

/**
 * 打开右栏的文件工具。面板开关有两个**同名不同事**的 `work-panel-toggle`（互斥渲染）：
 * 面板**关**时它是 AppShell 的浮动「展开工作台」（`inChat && !workPanelOpen` 才渲染），开着时才是
 * 工作台头部那颗「收起工作台」——所以不能拿它当"确保打开"用。「面板已开」的唯一稳定信号是
 * 工作台头部那颗 `workbench-close`（`workPanelOpen` 才渲染，见 Workbench 头部图标簇）。
 */
async function openFilesTool(page: Page): Promise<void> {
  const panel = page.locator('[data-testid="workbench-panel"][data-kind="files"]')
  // ① 面板关着（启动默认）就先开：此刻 DOM 里那颗 toggle 必是浮动那颗
  if ((await page.getByTestId('workbench-close').count()) === 0) {
    await page.getByTestId('work-panel-toggle').click()
    await expect(page.getByTestId('workbench-close')).toBeVisible({ timeout: 10_000 })
  }
  // ② 没有文件标签：空态（标签全关光）点空态入口；否则点那颗「文件」标签 —— 标签可见文本是
  //    根目录名（tabLabel 口径），按 id 前缀定位才稳（tab id = `${kind}-${seq}`，`workbench-tab-<id>`）
  if ((await panel.count()) === 0) {
    const empty = page.getByTestId('workbench-empty-action-files')
    if ((await empty.count()) > 0 && (await empty.isVisible())) {
      await empty.click()
    } else {
      // 已有别的标签、还没有文件标签：空态入口不在，走窗口级快捷键
      // （workbench-actions：Ctrl+Shift+E = 开/切「文件」，监听挂 window，面板收起也生效）
      await page.keyboard.press('Control+Shift+E')
    }
  } else if ((await panel.getAttribute('data-active')) !== 'true') {
    await page.locator('[id^="workbench-tab-files-"]').first().click()
  }
  await expect(panel).toHaveAttribute('data-active', 'true', { timeout: 10_000 })
  await expect(page.getByTestId('files-root')).toBeVisible({ timeout: 30_000 })
}

test.describe('R91 打包态预览（真安装包目录）', () => {
  test.skip(
    !ENABLED,
    'KYCLAW_PACKAGED_PREVIEW=1 才跑（需先 pnpm package / build:unpack 产出 win-unpacked）'
  )

  const exePath = packagedExePath()
  const layout = packagedLayout(exePath)
  const version = repoVersion()
  let provider: Awaited<ReturnType<typeof startInteractiveProvider>> | undefined
  let profile: PackagedProfile | undefined
  let app: ElectronApplication | undefined
  let page: Page
  /** 终端输出的原文（断言用；同时落进证据） */
  let terminalData = ''

  test.beforeAll(async () => {
    if (!ENABLED) return
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    // 硬闸门①：安装目录的文件/asar 路径（缺什么写什么，别白起一次 Electron）
    const problems = packagedResourceProblems(layout, version)
    expect(problems, `打包件不满足发布前置：\n- ${problems.join('\n- ')}`).toEqual([])
    // 硬闸门②：旧版夹具在本地（R90 同款口径：缺一份就红，不静默少测一块）
    const missing = LEGACY_SOURCES.filter((name) => !existsSync(join(LEGACY_FIXTURES_DIR, name)))
    expect(
      missing,
      `缺旧版夹具（${LEGACY_FIXTURES_DIR}）：请先准备 ${LEGACY_SOURCES.join(' / ')}`
    ).toEqual([])

    provider = await startInteractiveProvider()
    profile = writePackagedProfile(provider.url)
    const env: Record<string, string | undefined> = { ...process.env, KYCLAW_FORCE_MOCK: '0' }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({
      executablePath: exePath,
      args: [`--user-data-dir=${profile.profileDir}`],
      cwd: resolve('.'),
      env: env as Record<string, string>
    })
    page = await app.firstWindow()
    page.on('crash', () => console.log('[r91] page crashed'))
    app.process().stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') console.log(`[r91:main-stderr] ${text}`)
    })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!window.kyclaw?.settings)
    await page.getByTestId('composer-input').waitFor({ timeout: 30_000 })

    // 会话起来工作台才有根：借本地 scripted provider 走一条最小回合（不验对话本身）
    provider.enqueue({ text: 'R91 就绪' })
    await page.getByTestId('composer-input').fill('R91 准备')
    await page.getByTestId('composer-send').click()
    await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({
      timeout: 30_000
    })
    await openFilesTool(page)

    // 夹具写进**产品自己给出的会话根**，并断言它落在临时工作区里（不碰真 home）
    const sessionRoot = await page.getByTestId('files-root').getAttribute('title')
    expect(sessionRoot ?? '', '文件树没给出根路径（工作台还没就绪？）').not.toBe('')
    expect(
      realpathSync(sessionRoot ?? '')
        .toLowerCase()
        .startsWith(realpathSync(profile.workspace).toLowerCase()),
      `会话根没落在临时工作区里（会碰真 home？）：${sessionRoot}`
    ).toBe(true)
    const fixtures = await writeR90Fixtures(sessionRoot ?? '', {
      sentinelUrl: 'http://127.0.0.1:1/r91-sentinel'
    })
    await page.getByTestId('files-refresh').click()

    writeFileSync(
      join(EVIDENCE_DIR, 'packaged.json'),
      `${JSON.stringify(
        {
          exe: exePath,
          version,
          profile: profile.profileDir,
          workspace: profile.workspace,
          sessionRoot,
          written: fixtures.written.map((fixture) => fixture.name),
          skipped: fixtures.skipped
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    // 门开着时"缺哪份跳哪份"不允许（旧版三件也在里面）
    expect(fixtures.skipped, `缺夹具：${JSON.stringify(fixtures.skipped, null, 2)}`).toEqual([])
  })

  test.afterAll(async () => {
    if (app !== undefined) await app.close().catch(() => undefined)
    if (provider !== undefined) await provider.close().catch(() => undefined)
    if (profile !== undefined) removePackagedProfile(profile.root)
  })

  test('安装目录：app.asar / 解出来的原生件 / 随包 kit / 本版日志 / 许可声明（无根 patches）', () => {
    expect(statSync(layout.asar).size).toBeGreaterThan(0)
    expect(packagedResourceProblems(layout, version)).toEqual([])
    writeFileSync(
      join(EVIDENCE_DIR, 'resources.json'),
      `${JSON.stringify({ layout, version, problems: [] }, null, 2)}\n`,
      'utf8'
    )
  })

  test('文件树：Office 两类（docx / pptx）→ 真阅读器；表格两类（xlsx / xls）→ 只读表格', async () => {
    test.setTimeout(240_000)
    for (const name of ['报告.docx', '汇报.pptx'] as const) {
      await clickFile(page, name, 'inline')
      const viewer = page.getByTestId('dsh-office-viewer')
      await expect(page.getByTestId('file-preview-office')).toBeVisible({ timeout: 30_000 })
      await expect(viewer).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
      await expect(page.getByTestId('dsh-office-error')).toHaveCount(0)
      await page.getByTestId('file-preview-body').screenshot({
        path: join(EVIDENCE_DIR, `office-${name.replace(/\./g, '-')}.png`)
      })
    }
    for (const name of ['台账.xlsx', '底表.xls'] as const) {
      await clickFile(page, name, 'inline')
      await expect(page.getByTestId('file-preview-table')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('excel-preview')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('excel-preview-error')).toHaveCount(0)
      await page.getByTestId('file-preview-body').screenshot({
        path: join(EVIDENCE_DIR, `table-${name.replace(/\./g, '-')}.png`)
      })
    }
  })

  test('文件树：HTML 走 sandbox 预览（不给 allow-scripts / allow-same-origin）、SVG 按图片渲染', async () => {
    test.setTimeout(120_000)
    // 夹具里的外链哨兵（127.0.0.1:1）由 R90 对账"没发出去"；这里只钉 sandbox 属性与渲染本身
    await clickFile(page, '网页.html', 'inline')
    await expect(page.getByTestId('file-preview-html')).toBeVisible({ timeout: 30_000 })
    const frame = page.getByTestId('dsh-html-preview')
    await expect(frame).toBeVisible({ timeout: 30_000 })
    const sandbox = (await frame.getAttribute('sandbox')) ?? ''
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    await page.getByTestId('file-preview-body').screenshot({
      path: join(EVIDENCE_DIR, 'html-网页.png')
    })

    await clickFile(page, '预览.svg', 'inline')
    const image = page.getByTestId('file-preview-image').first()
    await expect(image).toBeVisible({ timeout: 30_000 })
    await expect(image).toHaveAttribute('data-loaded', 'true', { timeout: 30_000 })
    await expect(page.getByTestId('file-preview-image-error')).toHaveCount(0)
    await page.getByTestId('file-preview-body').screenshot({
      path: join(EVIDENCE_DIR, 'image-预览.svg.png')
    })
  })

  test('关于页：版本就是本版；常驻「更新日志」读到的是随包那一份（不依赖远端）', async () => {
    await page.evaluate(() => {
      window.location.hash = '#/settings/about'
    })
    await expect(page.getByTestId('about-version')).toContainText(version, { timeout: 30_000 })
    // 常驻入口读的是**随包**的 <版本>.md（主进程 `updates:releaseNotes`，断网 / 没配源也能看）——
    // 与源上「发现新版本」那块（`about-release-notes`，要等远端有新版才出现）是两件事：
    // 本用例不碰远端那块、也不等它。
    const toggle = page.getByTestId('about-bundled-notes-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('about-bundled-notes-title')).toContainText(
      `本版本（${version}）`
    )
    const text = page.getByTestId('about-bundled-notes-text')
    await expect(text).toContainText(version, { timeout: 30_000 })
    // 钉住是 ok 态：不是"本版暂无发行说明"、也不是"读不出来"那两态（那两态是假绿的口子）
    await expect(page.getByTestId('about-bundled-notes-empty')).toHaveCount(0)
    await expect(page.getByTestId('about-bundled-notes-error')).toHaveCount(0)
    await page.screenshot({ path: join(EVIDENCE_DIR, 'about-bundled-notes.png') })
  })

  test('终端：真起 PTY，命令回显里出现"执行过才有"的标记', async () => {
    test.setTimeout(120_000)
    // 上一条用例去过设置页（侧栏换成设置导航，没有会话列表）：先回对话页再取会话 id
    await page.evaluate(() => {
      window.location.hash = '#/chat'
    })
    await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({
      timeout: 30_000
    })
    const sessionTestId = await page
      .locator('[data-testid^="session-item-"]')
      .first()
      .getAttribute('data-testid')
    const threadId = (sessionTestId ?? '').replace('session-item-', '')
    expect(threadId, '没拿到会话 id（工作台那条先决条件没满足？）').not.toBe('')

    await page.evaluate(() => {
      const store = window as unknown as { __r91?: string[]; __r91Off?: () => void }
      store.__r91 = []
      store.__r91Off = window.kyclaw.terminal.onData((payload) => {
        store.__r91?.push(payload.data)
      })
    })
    const sessionId = await page.evaluate(async (id) => {
      const session = await window.kyclaw.terminal.start(id, 80, 24)
      return session.id
    }, threadId)
    await page.evaluate(async (id) => {
      await window.kyclaw.terminal.write(id, 'echo KYCLAW_R91_PTY_OK_$$\n')
    }, sessionId)
    await expect
      .poll(
        async () =>
          page.evaluate(() => (window as unknown as { __r91?: string[] }).__r91?.join('') ?? ''),
        {
          timeout: 60_000,
          message: '终端应该真执行出标记（回声里只有 $$，数字是 shell 展开出来的）'
        }
      )
      .toMatch(PTY_MARKER_PATTERN)
    terminalData = await page.evaluate(
      () => (window as unknown as { __r91?: string[] }).__r91?.join('') ?? ''
    )
    await page.evaluate(async (id) => {
      await window.kyclaw.terminal.dispose(id)
    }, sessionId)
    await page.evaluate(() => (window as unknown as { __r91Off?: () => void }).__r91Off?.())
    writeFileSync(join(EVIDENCE_DIR, 'terminal.txt'), `${terminalData}\n`, 'utf8')
    expect(
      terminalData.match(PTY_MARKER_PATTERN)?.[0] ?? '',
      '终端回显里应带上执行产生的标记（没有它 = 命令没真跑）'
    ).not.toBe('')
    expect(terminalData, 'PTY 回显里应当能看到输入的命令原文（含 $$ 占位符）').toContain('$$')
  })
})
