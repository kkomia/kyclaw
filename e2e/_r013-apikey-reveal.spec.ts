import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ProviderConfig } from '../src/shared/providers'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * R013 · API Key 显隐真实 Electron 探针（用户人工复验不通过后补的真机证据）。
 *
 * 门禁：KYCLAW_SETTINGS_PROBE=1（需要 `pnpm build` 后的 out/ 产物）
 *
 *   pnpm build
 *   KYCLAW_SETTINGS_PROBE=1 pnpm exec playwright test e2e/_r013-apikey-reveal.spec.ts
 *
 * 用户现象与复验口径（2026-10-17）：输入后点眼睛不显示明文、输入框一直空白；已有密钥也
 * 只有圆点占位、点眼睛只换提示。复验拍板：**掩码态保留圆点占位，但点眼睛必须显示已保存的
 * 真实 key**（显式点击才回显，再点回掩码并清空）。jsdom 单测用 fireEvent.change 绕过焦点，
 * 测不到"点眼睛后焦点落在按钮上、后续键入进不了输入框"这条真实路径；本探针全部用真实
 * 鼠标/键盘事件，并落像素级证据：
 *
 *   1. 没有 key：空值 + password；
 *   2. 真实键入 sk-test-123 → value 真的是它、仍是 password（掩码）；截图像素证明圆点画出来了；
 *   3. 点眼睛 → type=text、value 可见；截图证明明文真的画出来了；
 *   4. 再点回 password；收起 / 再展开仍是 password 且草稿保留；
 *   5. 保存 → 状态已配置、输入框清空、圆点占位出现；页面与 settings.json / secrets.json 里都没有明文；
 *   6. **保存后点眼睛 → type=text、value 等于真实 key**（显示期间 DOM 里允许有明文）；
 *      再点一次回 password、value 清空、圆点占位回来；页面/输入框/设置文件重新回到无明文；
 *   7. 显式回显后焦点仍在输入框；掩码后键入新草稿、点眼睛只揭示本次输入（不重复拉取）；
 *   8. 切到另一条 provider：已回显的明文立即收回，页面 / input 都不留明文；
 *   9. 新增渠道弹窗走同一套：点眼睛不抢焦点、输入后切明文、取消重开复位。
 *
 * 失败时 expect 的消息里带输入框状态 + 事件轨迹 + 命中测试，直接作为根因证据。
 */
const enabled = process.env.KYCLAW_SETTINGS_PROBE === '1'

const DEEPSEEK: ProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  isDefault: true
}

/** 第二渠道只用于"切 provider 立即收回明文"这条断言，不参与密钥录入 */
const OPENAI: ProviderConfig = {
  id: 'openai',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:9/v1',
  model: 'gpt-test',
  isDefault: false
}

const TYPED_KEY = 'sk-test-123'
const DIALOG_KEY = 'sk-dialog-456'
const SAVED_KEY_DOTS = '••••••••••••'

interface FieldState {
  value: string
  type: string
  placeholder: string
  activeTestId: string | null
  color: string
  fontSize: string
  textSecurity: string
}

async function fieldState(page: Page, testId: string): Promise<FieldState | null> {
  return page.evaluate((id) => {
    const element = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)
    if (element === null) return null
    const style = getComputedStyle(element)
    return {
      value: element.value,
      type: element.type,
      placeholder: element.placeholder,
      activeTestId:
        document.activeElement?.getAttribute('data-testid') ??
        document.activeElement?.tagName ??
        null,
      color: style.color,
      fontSize: style.fontSize,
      textSecurity: style.getPropertyValue('-webkit-text-security')
    }
  }, testId)
}

/** 给输入框挂事件轨迹：真实键入到底有没有到达、值有没有被 React 重置，一目了然 */
async function traceKeyInput(page: Page, testId: string): Promise<void> {
  await page.evaluate((id) => {
    const input = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)
    if (input === null) throw new Error(`找不到 ${id}`)
    const trace: Array<Record<string, unknown>> = []
    ;(window as unknown as { __kyclawKeyTrace?: unknown }).__kyclawKeyTrace = trace
    for (const type of ['focus', 'blur', 'keydown', 'beforeinput', 'input', 'change']) {
      input.addEventListener(type, (event) => {
        const keyboard = event as KeyboardEvent
        const inputEvent = event as InputEvent
        trace.push({
          type,
          value: input.value,
          key: keyboard.key ?? null,
          data: inputEvent.data ?? null,
          active:
            document.activeElement?.getAttribute('data-testid') ??
            document.activeElement?.tagName ??
            null
        })
      })
    }
  }, testId)
}

async function keyTrace(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () =>
      ((window as unknown as { __kyclawKeyTrace?: Array<Record<string, unknown>> })
        .__kyclawKeyTrace ?? []) as Array<Record<string, unknown>>
  )
}

/** 输入框左侧 40% 的内部区域（避开右侧眼睛按钮与边框），用于像素对比 */
async function textClip(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('输入框没有布局盒')
  return {
    x: box.x + 10,
    y: box.y + 6,
    width: Math.max(24, box.width * 0.4 - 10),
    height: box.height - 12
  }
}

/** 失焦后截文字区：没有光标闪烁，前后两张图只差"有没有画出字符" */
async function textShot(page: Page, locator: Locator): Promise<Buffer> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  return page.screenshot({ clip: await textClip(locator) })
}

/** 点击折叠行头（展开 / 收起）；行头是 provider 容器里的第一个 button */
async function toggleRow(page: Page, providerId: string): Promise<void> {
  await page.getByTestId(`provider-${providerId}`).locator('button').first().click()
}

test.describe('R013 API Key 显隐（真实 Electron）', () => {
  test.skip(!enabled, 'KYCLAW_SETTINGS_PROBE=1 时才跑（需要 pnpm build 的 out/ 产物）')

  // eslint-disable-next-line no-empty-pattern -- Playwright 要求首参是对象解构；本用例不用 fixtures
  test('输入可真落、眼睛真出明文、已有密钥有圆点占位、焦点不被按钮抢走', async ({}, testInfo) => {
    test.setTimeout(3 * 60 * 1000)
    const launched = await launchApp({ settings: { providers: [DEEPSEEK, OPENAI] } })
    const { page, userDataDir } = launched

    try {
      await waitForChat(page)
      await page.evaluate(() => {
        window.location.hash = '#/settings/model'
      })
      await expect(page.getByTestId('model-settings')).toBeVisible({ timeout: 30_000 })
      await toggleRow(page, 'deepseek')

      const key = page.getByTestId('provider-deepseek-key')
      const toggle = page.getByTestId('provider-deepseek-key-toggle')
      const status = page.getByTestId('provider-deepseek-key-status')
      await expect(key).toBeVisible()
      await expect(status).toHaveText('未配置', { timeout: 20_000 })
      // TraceFold 展开过渡（约 0.38s）走完再截图，避免半透明中间帧影响像素对比
      await page.waitForTimeout(450)

      // 0. 没配过 key：空值 + password，没有圆点占位（不假装已有密钥）
      expect(await fieldState(page, 'provider-deepseek-key')).toMatchObject({
        value: '',
        type: 'password',
        placeholder: ''
      })

      // 命中测试：输入框左侧真的是输入框（没有被绝对定位的眼睛按钮/其他层盖住）
      const hit = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="provider-deepseek-key"]'
        )
        const eye = document.querySelector<HTMLElement>(
          '[data-testid="provider-deepseek-key-toggle"]'
        )
        if (input === null || eye === null) throw new Error('找不到输入框或眼睛按钮')
        const box = input.getBoundingClientRect()
        const left = document.elementFromPoint(box.left + 16, box.top + box.height / 2)
        const eyeBox = eye.getBoundingClientRect()
        const eyeHit = document.elementFromPoint(
          eyeBox.left + eyeBox.width / 2,
          eyeBox.top + eyeBox.height / 2
        )
        return {
          leftTestId: left?.getAttribute('data-testid') ?? null,
          leftTag: left?.tagName ?? null,
          eyeTestId: eyeHit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
          inputBox: { width: box.width, height: box.height },
          eyeBox: eyeBox.toJSON()
        }
      })
      expect(hit.leftTestId, `输入框左侧命中测试：${JSON.stringify(hit)}`).toBe(
        'provider-deepseek-key'
      )
      expect(hit.eyeTestId, `眼睛按钮命中测试：${JSON.stringify(hit)}`).toBe(
        'provider-deepseek-key-toggle'
      )

      await traceKeyInput(page, 'provider-deepseek-key')
      const emptyShot = await textShot(page, key)

      // 1. 真实键盘键入：value 必须真的是它，且默认仍是掩码
      await key.click()
      await key.pressSequentially(TYPED_KEY)
      const typed = await fieldState(page, 'provider-deepseek-key')
      expect(
        typed?.value,
        `真实键入后 value 为空 = 键没进输入框（焦点/覆盖层根因）。state=${JSON.stringify(
          typed
        )} events=${JSON.stringify(await keyTrace(page))}`
      ).toBe(TYPED_KEY)
      expect(typed?.type).toBe('password')
      const maskedShot = await textShot(page, key)
      // 掩码态必须真的画出圆点（不是空白）：和键入前的空白截图逐像素不同
      expect(
        Buffer.compare(emptyShot, maskedShot),
        `键入后掩码圆点没有画出来（文字区像素与空白一致）。state=${JSON.stringify(typed)}`
      ).not.toBe(0)
      await testInfo.attach('masked-key', { body: maskedShot, contentType: 'image/png' })

      // 2. 点眼睛 → 明文可见，且值没被清掉
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      await expect(key).toHaveAttribute('type', 'text')
      const revealed = await fieldState(page, 'provider-deepseek-key')
      expect(revealed?.value).toBe(TYPED_KEY)
      const revealedShot = await textShot(page, key)
      expect(
        Buffer.compare(maskedShot, revealedShot),
        `点眼睛前后文字区像素完全一致 = 明文没有画出来。state=${JSON.stringify(revealed)}`
      ).not.toBe(0)
      await testInfo.attach('revealed-key', { body: revealedShot, contentType: 'image/png' })

      // 3. 再点回掩码：值和焦点都在
      await toggle.click()
      await expect(key).toHaveAttribute('type', 'password')
      expect((await fieldState(page, 'provider-deepseek-key'))?.value).toBe(TYPED_KEY)
      expect(await fieldState(page, 'provider-deepseek-key')).toMatchObject({
        activeTestId: 'provider-deepseek-key'
      })

      // 4. 收起 / 再展开：回到掩码，草稿保留
      await toggleRow(page, 'deepseek')
      await expect(key).toHaveAttribute('type', 'password')
      expect((await fieldState(page, 'provider-deepseek-key'))?.value).toBe(TYPED_KEY)
      await toggleRow(page, 'deepseek')
      await expect(key).toBeVisible()
      await expect(key).toHaveAttribute('type', 'password')
      expect((await fieldState(page, 'provider-deepseek-key'))?.value).toBe(TYPED_KEY)

      // 5. 保存 → 已配置；输入框清空、圆点占位出现；明文不落任何可见处/设置文件
      await page.getByTestId('provider-deepseek-save').click()
      await expect(status).toHaveText('已配置', { timeout: 20_000 })
      await expect(key).toHaveAttribute('type', 'password')
      expect(await fieldState(page, 'provider-deepseek-key')).toMatchObject({
        value: '',
        type: 'password',
        placeholder: SAVED_KEY_DOTS
      })
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(TYPED_KEY)
      expect(
        await page.evaluate(
          (needle) =>
            Array.from(document.querySelectorAll('input')).some((input) => input.value === needle),
          TYPED_KEY
        )
      ).toBe(false)
      expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).not.toContain(TYPED_KEY)
      expect(readFileSync(join(userDataDir, 'secrets.json'), 'utf8')).not.toContain(TYPED_KEY)
      // 保存后占位色有一次 transition-colors，等它走完再截，避免拍到中间帧
      await page.waitForTimeout(450)
      await testInfo.attach('saved-key-dots', {
        body: await textShot(page, key),
        contentType: 'image/png'
      })
      await testInfo.attach('saved-key-style', {
        body: JSON.stringify(
          await key.evaluate((element) => ({
            className: element.className,
            placeholderColor: getComputedStyle(element, '::placeholder').color,
            color: getComputedStyle(element).color
          })),
          null,
          2
        ),
        contentType: 'application/json'
      })

      // 5b. 保存后重新展开：仍是密码框 + 圆点占位，页面上没有明文
      await toggleRow(page, 'deepseek')
      await expect(key).toHaveAttribute('type', 'password')
      await toggleRow(page, 'deepseek')
      await expect(key).toBeVisible()
      await expect(key).toHaveAttribute('type', 'password')
      expect(await fieldState(page, 'provider-deepseek-key')).toMatchObject({
        value: '',
        type: 'password',
        placeholder: SAVED_KEY_DOTS
      })

      // 6. 已存密钥 + 未输入：点眼睛**显式回显真实 key**（不是圆点/提示）；再点一次清空回掩码。
      //    显示期间 DOM 里有明文是预期行为，断言范围只在"关闭后"要求无明文。
      await toggle.click()
      await expect(key).toHaveAttribute('type', 'text')
      await expect(key).toHaveValue(TYPED_KEY, { timeout: 20_000 })
      const savedRevealed = await fieldState(page, 'provider-deepseek-key')
      expect(
        savedRevealed?.value,
        `点眼睛没有显示已存真实 key。state=${JSON.stringify(savedRevealed)}`
      ).toBe(TYPED_KEY)
      expect(savedRevealed?.type).toBe('text')
      await testInfo.attach('saved-key-revealed', {
        body: await textShot(page, key),
        contentType: 'image/png'
      })

      await toggle.click()
      await expect(key).toHaveAttribute('type', 'password')
      await expect(key).toHaveValue('')
      expect(await fieldState(page, 'provider-deepseek-key')).toMatchObject({
        value: '',
        type: 'password',
        placeholder: SAVED_KEY_DOTS
      })
      // 关闭显示后：页面、任何 input 的 value、两个落盘文件都不含明文
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(TYPED_KEY)
      expect(
        await page.evaluate(
          (needle) =>
            Array.from(document.querySelectorAll('input')).some((input) => input.value === needle),
          TYPED_KEY
        )
      ).toBe(false)
      expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).not.toContain(TYPED_KEY)
      expect(readFileSync(join(userDataDir, 'secrets.json'), 'utf8')).not.toContain(TYPED_KEY)

      // 7. 显式回显后焦点仍在输入框；掩码后键入新草稿、点眼睛只揭示本次输入（不重复拉取）
      await toggle.click()
      await expect(key).toHaveValue(TYPED_KEY)
      const focusAfterEye = await fieldState(page, 'provider-deepseek-key')
      expect(
        focusAfterEye?.activeTestId,
        `点眼睛后焦点不在输入框 = 后续键入会落空。state=${JSON.stringify(focusAfterEye)}`
      ).toBe('provider-deepseek-key')
      await toggle.click()
      await expect(key).toHaveAttribute('type', 'password')

      await key.click()
      await key.pressSequentially('sk-eye-first')
      await toggle.click()
      const eyeFirst = await fieldState(page, 'provider-deepseek-key')
      expect(
        eyeFirst?.value,
        `有本次输入时点眼睛没有显示草稿。state=${JSON.stringify(
          eyeFirst
        )} events=${JSON.stringify(await keyTrace(page))}`
      ).toBe('sk-eye-first')
      expect(eyeFirst?.type).toBe('text')
      // 焦点保持在输入框：继续键入的字符必须追加进草稿
      await page.keyboard.type('-tail')
      expect((await fieldState(page, 'provider-deepseek-key'))?.value).toBe('sk-eye-first-tail')
      await toggle.click()
      await expect(key).toHaveAttribute('type', 'password')
      expect((await fieldState(page, 'provider-deepseek-key'))?.value).toBe('sk-eye-first-tail')
      // 清掉这条草稿，避免它影响后面的弹窗用例与"页面无明文"的收尾判断
      await key.fill('')
      expect((await fieldState(page, 'provider-deepseek-key'))?.value).toBe('')

      // 8. 切到另一条 provider：已回显的明文立即收回，页面 / input 都不留明文
      await toggle.click()
      await expect(key).toHaveValue(TYPED_KEY)
      await toggleRow(page, 'openai')
      await expect(page.getByTestId('provider-openai-key')).toBeVisible()
      await expect(key).toHaveAttribute('type', 'password')
      await expect(key).toHaveValue('')
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(TYPED_KEY)
      expect(
        await page.evaluate(
          (needle) =>
            Array.from(document.querySelectorAll('input')).some((input) => input.value === needle),
          TYPED_KEY
        )
      ).toBe(false)

      // 9. 新增渠道弹窗：同一套显隐 + 焦点行为；取消重开复位
      await page.getByTestId('model-add').click()
      await page.getByTestId('model-add-channel').click()
      await page.getByTestId('model-add-channel-custom-openai-compatible').click()
      const dialogKey = page.getByTestId('model-add-key')
      const dialogToggle = page.getByTestId('model-add-key-toggle')
      await expect(dialogKey).toBeVisible()
      await traceKeyInput(page, 'model-add-key')
      expect(await fieldState(page, 'model-add-key')).toMatchObject({
        value: '',
        type: 'password'
      })

      // 弹窗里没有已存密钥：空输入时点眼睛不切空明文态，但焦点必须留在输入框
      await dialogToggle.click()
      const dialogFocus = await fieldState(page, 'model-add-key')
      expect(
        dialogFocus?.activeTestId,
        `弹窗里点眼睛后焦点不在输入框。state=${JSON.stringify(dialogFocus)}`
      ).toBe('model-add-key')
      expect(dialogFocus?.type).toBe('password')
      await page.keyboard.type(DIALOG_KEY)
      const dialogTyped = await fieldState(page, 'model-add-key')
      expect(
        dialogTyped?.value,
        `弹窗里点眼睛后直接键入没有落进输入框。state=${JSON.stringify(
          dialogTyped
        )} events=${JSON.stringify(await keyTrace(page))}`
      ).toBe(DIALOG_KEY)
      expect(dialogTyped?.type).toBe('password')

      // 本次有输入后，眼睛才切明文；再点回掩码草稿仍在
      await dialogToggle.click()
      await expect(dialogKey).toHaveAttribute('type', 'text')
      expect((await fieldState(page, 'model-add-key'))?.value).toBe(DIALOG_KEY)
      await dialogToggle.click()
      await expect(dialogKey).toHaveAttribute('type', 'password')
      expect((await fieldState(page, 'model-add-key'))?.value).toBe(DIALOG_KEY)

      await page.getByTestId('model-add-cancel').click()
      await expect(dialogKey).toHaveCount(0)

      await page.getByTestId('model-add').click()
      await page.getByTestId('model-add-channel').click()
      await page.getByTestId('model-add-channel-custom-openai-compatible').click()
      await expect(page.getByTestId('model-add-key')).toHaveAttribute('type', 'password')
      expect(await fieldState(page, 'model-add-key')).toMatchObject({ value: '' })
      await page.getByTestId('model-add-cancel').click()
    } finally {
      await closeApp(launched)
    }
  })
})
