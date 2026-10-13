import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * round 63：**对话页「PPT」胶囊 + 模板画廊**的确定性 UI 规格（不连真模型，不花额度）。
 * round 66：选择改成**会话级** —— 这里的"还在 / 不在"跟着会话走，不再跟着全局设置走。
 *
 * 断言的是产品口径本身：
 *   1. 初始页胶囊写「PPT」（= 自动挑）；
 *   2. 点开画廊 → 分类标签 + 十张模板卡（每张是 16:9 的封面缩影）都在；
 *   3. 选「学术紫」→ 胶囊变「PPT · 学术紫」、「回自动」的 × 出现、画廊收起（截图存档）；
 *   4. **换一个新会话：回到「PPT」**（round 66 用户实报的那条 —— 草稿的选择不该跟着新会话跑）；
 *   5. 分类过滤真的少卡片；
 *   6. 清空 → 胶囊回「PPT」、× 消失（截图存档）；
 *   7. round 66：卡片**上**一行「选择项目」、卡片**下**一行 PPT，两行都只在初始页存在 ——
 *      进入对话态（已发过消息）后两行一起整行不渲染，两枚 chip 都不在卡片内部。
 *
 * 前置：先 `pnpm build`（harness 起的是 out/ 产物）。
 * 单跑：pnpm exec playwright test e2e/_r63-ppt-template.spec.ts
 */
const evidenceDir = resolve(__dirname, '..', '.superpowers/sdd/2026-10-10-kyclaw-mvp')

/**
 * 存档截图前等动效落定：卡片 hover 抬升、胶囊聚焦态、标签选中都是 --motion-main（.3s）过渡，
 * 不等它就会存下半截过渡帧（肉眼看不出来，但取证图要的是落定后的观感）。
 */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(350)
}

/** 开一个新会话（侧栏那颗 ＋；草稿 id 是新的，模板选择因此归零） */
async function newSession(page: Page): Promise<void> {
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('composer-ppt-template')).toHaveText('PPT')
}

test('PPT 模板：画廊选 / 换 / 清，新会话回初始态', async () => {
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)

    // 1. 初始页：没选模板 = 自动
    const chip = page.getByTestId('composer-ppt-template')
    await expect(chip).toHaveText('PPT')
    await expect(page.getByTestId('composer-ppt-template-clear')).toHaveCount(0)

    // 2. 点开画廊：分类标签 + 十张卡
    await chip.click()
    const gallery = page.getByTestId('ppt-template-gallery')
    await expect(gallery).toBeVisible()
    for (const category of ['all', 'report', 'academic', 'data', 'promo']) {
      await expect(page.getByTestId(`ppt-category-${category}`)).toBeVisible()
    }
    for (const name of ['极简黑白', '商务蓝', '科技暗', '暖橙', '墨绿', '紫罗兰']) {
      await expect(page.getByTestId(`ppt-template-${name}`)).toBeVisible()
    }
    await settle(page)
    await page.screenshot({ path: join(evidenceDir, '_r63-ppt-gallery.png') })

    // 3. 选「学术紫」：胶囊改名 + 画廊收起 + 清空按钮出现
    await page.getByTestId('ppt-template-学术紫').click()
    await expect(chip).toHaveText('PPT · 学术紫')
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('composer-ppt-template-clear')).toBeVisible()
    await settle(page)
    await page.screenshot({ path: join(evidenceDir, '_r63-ppt-selected.png') })

    // 4. round 66：**新会话不继承** —— 开一个新对话，胶囊必须回到「PPT」（用户实报的那条）
    await page.getByTestId('new-session').click()
    await expect(page.getByTestId('composer-ppt-template')).toHaveText('PPT')
    await expect(page.getByTestId('composer-ppt-template-clear')).toHaveCount(0)

    // 5. 分类过滤：学术研究只剩两张卡
    await page.getByTestId('composer-ppt-template').click()
    await expect(gallery).toBeVisible()
    await page.getByTestId('ppt-category-academic').click()
    await expect(page.getByTestId('ppt-category-academic')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('ppt-template-学术紫')).toBeVisible()
    await expect(page.getByTestId('ppt-template-墨绿')).toBeVisible()
    await expect(page.getByTestId('ppt-template-商务蓝')).toHaveCount(0)
    await settle(page)
    await page.screenshot({ path: join(evidenceDir, '_r63-ppt-category.png') })

    // 6. 在这个（新）会话里选一张再清空：胶囊回「PPT」、× 消失
    await page.getByTestId('ppt-template-学术紫').click()
    await expect(page.getByTestId('composer-ppt-template')).toHaveText('PPT · 学术紫')
    await page.getByTestId('composer-ppt-template-clear').click()
    await expect(page.getByTestId('composer-ppt-template')).toHaveText('PPT')
    await expect(page.getByTestId('composer-ppt-template-clear')).toHaveCount(0)
    await settle(page)
    await page.screenshot({ path: join(evidenceDir, '_r63-ppt-cleared.png') })

    // 7. 再开一个新会话：仍是初始态（清空与新会话各走一边，两条路都到「PPT」）
    await newSession(page)
  } finally {
    await closeApp(launched)
  }
})

test('PPT 模板：单独一行在卡片下方、只在初始页出现 —— 进了对话两行一起退场', async () => {
  const launched = await launchApp()
  const { page } = launched

  try {
    await waitForChat(page)
    // round 76：输入卡现在**第一帧就在**（不再等端点/列表/历史），而"初始页落位"（标题 + 卡片
    // 上下两行）要等会话实例就绪那一刻才发生 —— 量几何之前先等两行展开（data-active=true）。
    await expect(page.getByTestId('composer-project-row-collapse')).toHaveAttribute(
      'data-active',
      'true'
    )
    // 初始页：卡片上/下各一行（「选择项目」在上、PPT 在下）。对齐口径分**两半**说，两个数别混着量：
    //   ① **与卡片同列宽**：行容器自己的盒子（border box）与卡片盒子同宽、左缘对齐 —— 两行都走
    //      与 Composer 同一条配方（`mx-auto w-full max-w-(--chat-input-max-width)`，居中的是
    //      限宽列）；外面那层 CollapsibleRow（满宽 grid + overflow-hidden）不改这一列。
    //   ② **+4px**：行自带 `px-1`（4px），所以**行里的内容**（左起第一枚 chip）左缘 = 卡片左缘 + 4px
    //      —— 用户看到的对齐是这一条（「行左缘 +4」不存在：行的盒子与卡片同左缘，4px 在行的内边距上；
    //      量法：`row.left + 计算出的 padding-left` = 行的内容盒左缘，也就是行里第一枚 chip 的左缘）。
    const chip = page.getByTestId('composer-ppt-template')
    await expect(chip).toHaveText('PPT')
    const heroBox = await page.evaluate(() => {
      /** 一行量出来的三个位置：行自己的盒子、行的内容盒左缘（行自带 px-1）、行里第一枚 chip 的左缘 */
      type Row = {
        left: number
        width: number
        top: number
        bottom: number
        contentLeft: number
        chipLeft: number
      }
      const rowOf = (testId: string): Row => {
        const row = document.querySelector(`[data-testid="${testId}"]`)!
        const rect = row.getBoundingClientRect()
        return {
          left: rect.left,
          width: rect.width,
          top: rect.top,
          bottom: rect.bottom,
          contentLeft: rect.left + Number.parseFloat(getComputedStyle(row).paddingLeft),
          chipLeft: row.querySelector('button')!.getBoundingClientRect().left
        }
      }
      const composer = document.querySelector('[data-testid="composer"]')!.getBoundingClientRect()
      return {
        composerLeft: composer.left,
        composerWidth: composer.width,
        composerTop: composer.top,
        composerBottom: composer.bottom,
        projectRow: rowOf('composer-project-row'),
        pptRow: rowOf('composer-capabilities')
      }
    })
    for (const row of [heroBox.projectRow, heroBox.pptRow]) {
      // ① 与卡片同列宽：同宽、同左缘
      expect(row.left).toBeCloseTo(heroBox.composerLeft, 0)
      expect(row.width).toBeCloseTo(heroBox.composerWidth, 0)
      // ② 行里的内容（第一枚 chip）左缘 = 卡片左缘 + 行的 px-1（4px）
      expect(row.contentLeft - heroBox.composerLeft).toBeCloseTo(4, 0)
      expect(row.chipLeft - heroBox.composerLeft).toBeCloseTo(4, 0)
    }
    // 「选择项目」行在卡片**上方**（且整行收在卡片上沿之上），PPT 行在卡片**下方**
    expect(heroBox.projectRow.bottom).toBeLessThanOrEqual(heroBox.composerTop)
    expect(heroBox.pptRow.top).toBeGreaterThanOrEqual(heroBox.composerBottom)

    // round 66：两枚 chip 都**不在卡片里**（用户口径："放到对话框上面，不要嵌入到里面"）
    const insideCard = await page.evaluate(() => {
      const composer = document.querySelector('[data-testid="composer"]')!
      return {
        project: composer.contains(document.querySelector('[data-testid="composer-project"]')!),
        ppt: composer.contains(document.querySelector('[data-testid="composer-ppt-template"]')!)
      }
    })
    expect(insideCard.project).toBe(false)
    expect(insideCard.ppt).toBe(false)

    // 进对话态：任意发一条（mock provider，不连网）
    await page.getByTestId('composer-input').fill('你好')
    await page.getByTestId('composer-send').click()
    await expect(page.getByTestId('message-list')).toContainText('你好', { timeout: 20_000 })
    await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 20_000 })

    // round 66（用户口径："进入到对话之后就不要显示这个「选择项目」了"）：
    // 卡片上/下两行**一起退场** —— round 76 起退场 ≠ 卸载：两行常挂，收成 0 高 + 淡出
    // （主档时长、不硬切，见 CollapsibleRow）。所以这里按"收合到位"验，而不是"节点消失"。
    for (const testId of ['composer-project-row-collapse', 'composer-capabilities-collapse']) {
      await expect(page.getByTestId(testId)).toHaveAttribute('data-active', 'false')
      await expect(page.getByTestId(testId)).toHaveAttribute('inert', '')
    }
    await expect
      .poll(async () =>
        page.evaluate(() =>
          ['composer-project-row-collapse', 'composer-capabilities-collapse'].map(
            (id) =>
              document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().height ?? -1
          )
        )
      )
      .toEqual([0, 0])
    // 两枚 chip 跟着整行一起收着（不卸载），输入卡照旧在
    await expect(page.getByTestId('composer-project')).toHaveCount(1)
    await expect(page.getByTestId('composer-ppt-template')).toHaveCount(1)
    await expect(page.getByTestId('composer')).toBeVisible()
  } finally {
    await closeApp(launched)
  }
})
