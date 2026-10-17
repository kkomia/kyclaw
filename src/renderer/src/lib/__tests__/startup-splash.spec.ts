import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  advanceStartupSplash,
  completedStartupStages,
  dismissStartupSplash,
  failStartupSplash,
  INITIAL_STARTUP_PERCENT,
  SPLASH_FADE_MS,
  SPLASH_FILL_MS,
  STARTUP_STAGE_ORDER,
  STARTUP_STAGES,
  type StartupStageId
} from '../startup-splash'

/**
 * 012（启动白屏，用户返工：要确定的百分比进度）：
 *   - HTML 壳里必须**先**有 kyclaw 标记 + **阶段百分比**进度条，再轮到模块脚本；
 *   - 初始百分比与 STARTUP_STAGES 的 shell-visible 档一致；没有按时间滑动的假进度；
 *   - 每个真实阶段（bundle 执行 / 设置读盘 / React 提交 / 壳退场）推进固定档位，
 *     更早 / 未知阶段不倒退，卡住就停在最近完成值；
 *   - 晚到的 settings-loaded 不会丢：已完成阶段会记录，壳还在时显示“设置已就绪”，
 *     但百分比不倒退；
 *   - React 首屏提交后先留一帧给 80%，下一帧才写 100%，再等宽度过渡走完才淡出；
 *   - 失败态优先：尚未执行的退场计划会被取消，错误文案不会被“启动完成”盖掉；
 *   - 主题跟窗口底色同一来源（系统浅/深），不制造新的白闪。
 *
 * 这里不启动 Electron，也不跑真窗口：HTML 壳读源文件，退场/失败行为在 jsdom 里钉住。
 */
const HTML = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
const SHELL_STAGE = STARTUP_STAGES['shell-visible']
const FRAME_MS = 20

function installSplash(): HTMLElement {
  document.documentElement.setAttribute('data-startup-completed-stages', 'shell-visible')
  document.body.innerHTML =
    `<div id="app-splash" role="status" aria-live="polite" aria-label="kyclaw 正在启动"` +
    ` data-startup-stage="shell-visible" data-startup-percent="${INITIAL_STARTUP_PERCENT}">` +
    `<div class="app-splash__inner">` +
    `<div class="app-splash__track" role="progressbar" aria-label="启动阶段进度"` +
    ` data-progress-kind="stages" aria-valuemin="0" aria-valuemax="100"` +
    ` aria-valuenow="${INITIAL_STARTUP_PERCENT}"` +
    ` aria-valuetext="启动阶段 ${INITIAL_STARTUP_PERCENT}%，${SHELL_STAGE.status}">` +
    `<div class="app-splash__fill" style="width: ${INITIAL_STARTUP_PERCENT}%"></div>` +
    `</div>` +
    `<div class="app-splash__meta">` +
    `<p class="app-splash__status">${SHELL_STAGE.status}</p>` +
    `<span class="app-splash__percent" aria-hidden="true">` +
    `<span class="app-splash__percent-label">阶段</span> ` +
    `<span class="app-splash__percent-value">${INITIAL_STARTUP_PERCENT}%</span>` +
    `</span>` +
    `</div>` +
    `<p class="app-splash__detail" hidden></p>` +
    `</div></div>`
  return document.getElementById('app-splash') as HTMLElement
}

function trackOf(splash: HTMLElement): HTMLElement {
  return splash.querySelector('.app-splash__track') as HTMLElement
}

function fillOf(splash: HTMLElement): HTMLElement {
  return splash.querySelector('.app-splash__fill') as HTMLElement
}

function statusOf(splash: HTMLElement): HTMLElement {
  return splash.querySelector('.app-splash__status') as HTMLElement
}

function percentLabelOf(splash: HTMLElement): HTMLElement {
  return splash.querySelector('.app-splash__percent') as HTMLElement
}

function percentValueOf(splash: HTMLElement): HTMLElement {
  return splash.querySelector('.app-splash__percent-value') as HTMLElement
}

function detailOf(splash: HTMLElement): HTMLElement {
  return splash.querySelector('.app-splash__detail') as HTMLElement
}

/** jsdom 的 TransitionEvent 支持不稳：用普通 Event 补 propertyName，模拟真实冒泡 */
function transitionEndOn(target: EventTarget, propertyName = 'opacity'): void {
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { value: propertyName })
  target.dispatchEvent(event)
}

function advanceFrames(count = 1): void {
  vi.advanceTimersByTime(FRAME_MS * count)
}

function finishFillTransition(splash: HTMLElement): void {
  transitionEndOn(fillOf(splash), 'width')
}

function finishFade(splash: HTMLElement): void {
  transitionEndOn(splash)
}

beforeEach(() => {
  vi.useFakeTimers()
  document.documentElement.removeAttribute('data-startup-completed-stages')
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-startup-completed-stages')
})

describe('启动 HTML 壳（012 返工）', () => {
  it('启动画面在模块脚本之前：kyclaw 标记 + 阶段百分比进度条', () => {
    const splashAt = HTML.indexOf('id="app-splash"')
    const rootAt = HTML.indexOf('id="root"')
    const scriptAt = HTML.indexOf('<script type="module"')

    expect(splashAt).toBeGreaterThan(-1)
    expect(rootAt).toBeGreaterThan(-1)
    expect(scriptAt).toBeGreaterThan(-1)
    // body 里先出现启动画面（React 根在后），首帧不让出空白
    expect(splashAt).toBeLessThan(rootAt)
    expect(rootAt).toBeLessThan(scriptAt)

    const shell = HTML.slice(splashAt, scriptAt)
    expect(shell).toContain('kyclaw')
    expect(shell).toContain('role="progressbar"')
    expect(shell).toContain('aria-label="启动阶段进度"')
    expect(shell).toContain('data-progress-kind="stages"')
    expect(shell).toContain('aria-valuemin="0"')
    expect(shell).toContain('aria-valuemax="100"')
    expect(shell).toContain(`aria-valuenow="${INITIAL_STARTUP_PERCENT}"`)
    expect(shell).toContain(
      `aria-valuetext="启动阶段 ${INITIAL_STARTUP_PERCENT}%，${SHELL_STAGE.status}"`
    )
    expect(shell).toContain('app-splash__fill')
    expect(shell).toContain(`style="width: ${INITIAL_STARTUP_PERCENT}%"`)
    expect(shell).toContain('app-splash__percent-value')
    expect(shell).toContain(`>${INITIAL_STARTUP_PERCENT}%<`)
    expect(shell).toContain('阶段')
    expect(shell).toContain('app-splash__detail')
    // 初始已完成阶段与静态初值同源；main.tsx 执行后从这里继续累加。
    expect(HTML).toContain('data-startup-completed-stages="shell-visible"')
  })

  it('百分比只来自真实阶段：没有按时间滑动的假进度', () => {
    // 旧的不定进度条靠无限 keyframes 假装在动；返工后必须彻底移除。
    expect(HTML).not.toContain('@keyframes app-splash-slide')
    expect(HTML).not.toContain('animation: app-splash-slide')
    // 初始档位与阶段表同源（改阶段表时单测会把这处硬编码揪出来）。
    expect(HTML).toContain('data-startup-stage="shell-visible"')
    expect(HTML).toContain(`data-startup-percent="${INITIAL_STARTUP_PERCENT}"`)
  })

  it('文案把百分比称为阶段进度，不承诺耗时', () => {
    expect(HTML).toContain('阶段百分比')
    expect(HTML).toContain('不是耗时')
    expect(HTML).toContain('启动阶段进度')
    expect(HTML).toContain(`启动阶段 ${INITIAL_STARTUP_PERCENT}%`)
  })

  it('主题跟系统走且先铺画布底色，不制造新的白闪', () => {
    expect(HTML).toContain('prefers-color-scheme: dark')
    expect(HTML).toContain('#fbfaf9')
    expect(HTML).toContain('#181817')
    // 启动壳不参与 data-theme 切换：它先跟窗口底色（系统主题）走；落盘主题在壳底下应用，
    // 淡出时露出的就是用户选的主题，不会先出现一块空白/反色画布。
    expect(HTML).not.toContain('data-theme')
  })

  it('减少动效时进度条不做宽度过渡，壳也不做淡出过渡', () => {
    const reducedMotion = HTML.slice(HTML.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotion).toContain('#app-splash')
    expect(reducedMotion).toContain('.app-splash__fill')
    expect(reducedMotion).toContain('transition: none')
  })
})

describe('启动进度（012 返工）', () => {
  it('初始进度是阶段表里的确定值，aria 与可见百分比一致', () => {
    const splash = installSplash()
    const track = trackOf(splash)

    expect(track).toHaveAttribute('aria-valuenow', String(INITIAL_STARTUP_PERCENT))
    expect(track).toHaveAttribute(
      'aria-valuetext',
      `启动阶段 ${INITIAL_STARTUP_PERCENT}%，${SHELL_STAGE.status}`
    )
    expect(fillOf(splash).style.width).toBe(`${INITIAL_STARTUP_PERCENT}%`)
    expect(percentLabelOf(splash)).toHaveTextContent(`阶段 ${INITIAL_STARTUP_PERCENT}%`)
    expect(percentValueOf(splash)).toHaveTextContent(`${INITIAL_STARTUP_PERCENT}%`)
    expect(splash).toHaveAttribute('data-startup-stage', 'shell-visible')
    expect(splash).toHaveAttribute('data-startup-percent', String(INITIAL_STARTUP_PERCENT))
    expect(completedStartupStages()).toEqual(['shell-visible'])
  })

  it('阶段表按固定档位单调递增，终点是 100%', () => {
    const percents = STARTUP_STAGE_ORDER.map((stageId) => STARTUP_STAGES[stageId].percent)

    expect([...STARTUP_STAGE_ORDER].sort()).toEqual(Object.keys(STARTUP_STAGES).sort())
    expect(percents).toEqual([...percents].sort((left, right) => left - right))
    expect(new Set(percents).size).toBe(percents.length)
    expect(percents[percents.length - 1]).toBe(100)
  })

  it('真实阶段按固定档位推进，且单调不倒退（更早 / 未知阶段停在最近完成值）', () => {
    const splash = installSplash()
    const track = trackOf(splash)
    const label = percentLabelOf(splash)

    const entry = STARTUP_STAGES['renderer-entry'].percent
    expect(advanceStartupSplash('renderer-entry')).toBe(entry)
    expect(track).toHaveAttribute('aria-valuenow', String(entry))
    expect(track.getAttribute('aria-valuetext')).toContain(`启动阶段 ${entry}%`)
    expect(track.getAttribute('aria-valuetext')).toContain(STARTUP_STAGES['renderer-entry'].status)
    expect(fillOf(splash).style.width).toBe(`${entry}%`)
    expect(label).toHaveTextContent(`阶段 ${entry}%`)

    const settings = STARTUP_STAGES['settings-loaded'].percent
    expect(advanceStartupSplash('settings-loaded')).toBe(settings)
    expect(track).toHaveAttribute('aria-valuenow', String(settings))
    expect(fillOf(splash).style.width).toBe(`${settings}%`)

    // 更早的阶段不会把进度拨回去
    expect(advanceStartupSplash('renderer-entry')).toBe(settings)
    // 未知阶段保持最近完成值
    expect(advanceStartupSplash('unknown' as StartupStageId)).toBe(settings)
    expect(track).toHaveAttribute('aria-valuenow', String(settings))
    expect(track.getAttribute('aria-valuetext')).toContain(`启动阶段 ${settings}%`)
    expect(label).toHaveTextContent(`阶段 ${settings}%`)

    const committed = STARTUP_STAGES['react-committed']
    expect(advanceStartupSplash('react-committed')).toBe(committed.percent)
    expect(track).toHaveAttribute('aria-valuenow', String(committed.percent))
    expect(track.getAttribute('aria-valuetext')).toContain(`启动阶段 ${committed.percent}%`)
    expect(track.getAttribute('aria-valuetext')).toContain(committed.status)
  })

  it('MutationObserver 记录真实阶段顺序：百分比只增不减', () => {
    const splash = installSplash()
    const seen: number[] = []
    const observer = new MutationObserver(() => undefined)
    observer.observe(splash, { attributes: true, attributeFilter: ['data-startup-percent'] })

    const record = (): void => {
      if (observer.takeRecords().length === 0) return
      seen.push(Number(splash.getAttribute('data-startup-percent')))
    }

    advanceStartupSplash('renderer-entry')
    record()
    advanceStartupSplash('settings-loaded')
    record()
    advanceStartupSplash('react-committed')
    record()

    observer.disconnect()

    expect(seen).toEqual([40, 60, 80])
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1] ?? 0)
    }
    expect(splash).toHaveAttribute('data-startup-percent', '80')
    expect(splash).toHaveAttribute('data-startup-stage', 'react-committed')
    expect(splash).not.toHaveAttribute('data-startup-late-stage')
    expect(completedStartupStages()).toEqual([
      'shell-visible',
      'renderer-entry',
      'settings-loaded',
      'react-committed'
    ])
  })

  it('settings-loaded 晚于 React 提交：记录完成、显示“设置已就绪”，百分比不倒退', () => {
    const splash = installSplash()
    const committed = STARTUP_STAGES['react-committed'].percent

    advanceStartupSplash('renderer-entry')
    advanceStartupSplash('react-committed')
    expect(advanceStartupSplash('settings-loaded')).toBe(committed)

    expect(splash).toHaveAttribute('data-startup-percent', String(committed))
    expect(splash).toHaveAttribute('data-startup-stage', 'react-committed')
    expect(splash).toHaveAttribute('data-startup-late-stage', 'settings-loaded')
    expect(percentValueOf(splash)).toHaveTextContent(`${committed}%`)
    expect(fillOf(splash).style.width).toBe(`${committed}%`)
    expect(trackOf(splash)).toHaveAttribute('aria-valuenow', String(committed))

    const detail = detailOf(splash)
    expect(detail).not.toHaveAttribute('hidden')
    expect(detail).toHaveTextContent('设置已就绪')

    const valueText = trackOf(splash).getAttribute('aria-valuetext') ?? ''
    expect(valueText).toContain(`启动阶段 ${committed}%`)
    expect(valueText).toContain('设置已就绪')
    expect(completedStartupStages()).toContain('settings-loaded')
  })

  it('壳已退场后晚到的阶段仍记录完成，但不重开启动壳', () => {
    installSplash()
    advanceStartupSplash('renderer-entry')
    advanceStartupSplash('react-committed')
    dismissStartupSplash()
    advanceFrames(2)
    finishFillTransition(document.getElementById('app-splash') as HTMLElement)
    finishFade(document.getElementById('app-splash') as HTMLElement)
    expect(document.getElementById('app-splash')).toBeNull()

    expect(advanceStartupSplash('settings-loaded')).toBe(0)
    expect(completedStartupStages()).toContain('settings-loaded')
    expect(document.getElementById('app-splash')).toBeNull()
  })
})

describe('启动画面退场（012 返工）', () => {
  it('80% 先绘制，100% / 退场在下一帧与真实宽度过渡之后（不丢中间档）', () => {
    const splash = installSplash()
    advanceStartupSplash('renderer-entry')
    advanceStartupSplash('settings-loaded')
    advanceStartupSplash('react-committed')

    dismissStartupSplash()

    // 同一个 layout effect 之后仍停在 80%，没有同步补成 100%。
    expect(splash).toHaveAttribute('data-startup-percent', '80')
    expect(trackOf(splash)).toHaveAttribute('aria-valuenow', '80')
    expect(fillOf(splash).style.width).toBe('80%')
    expect(statusOf(splash)).toHaveTextContent('正在进入工作区…')
    expect(splash).not.toHaveClass('is-leaving')

    // 第一帧只让 80% 上屏；第二帧才写 100%。
    advanceFrames(1)
    expect(splash).toHaveAttribute('data-startup-percent', '80')
    advanceFrames(1)
    expect(splash).toHaveAttribute('data-startup-percent', '100')
    expect(trackOf(splash)).toHaveAttribute('aria-valuenow', '100')
    expect(fillOf(splash).style.width).toBe('100%')
    expect(statusOf(splash)).toHaveTextContent('启动完成')
    expect(percentLabelOf(splash)).toHaveTextContent('阶段 100%')
    expect(splash).not.toHaveClass('is-leaving')

    // 100% 的宽度过渡真的走完，才开始淡出。
    finishFillTransition(splash)
    expect(splash).toHaveClass('is-leaving')
    expect(splash).toHaveAttribute('aria-hidden', 'true')
    expect(trackOf(splash)).toHaveAttribute('aria-valuenow', '100')

    finishFade(splash)
    expect(document.getElementById('app-splash')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('子元素的过渡 / 别的 propertyName 不会提前拆掉启动壳', () => {
    const splash = installSplash()
    const track = trackOf(splash)
    advanceStartupSplash('react-committed')

    dismissStartupSplash()
    advanceFrames(2)

    transitionEndOn(track)
    expect(splash).not.toHaveClass('is-leaving')
    transitionEndOn(fillOf(splash), 'transform')
    expect(splash).not.toHaveClass('is-leaving')
    transitionEndOn(splash, 'transform')
    expect(splash).not.toHaveClass('is-leaving')

    finishFillTransition(splash)
    expect(splash).toHaveClass('is-leaving')
    transitionEndOn(splash, 'transform')
    expect(document.getElementById('app-splash')).not.toBeNull()

    finishFade(splash)
    expect(document.getElementById('app-splash')).toBeNull()
  })

  it('过渡事件没来（减少动效 / 被跳过）时按兜底时长移除', () => {
    installSplash()

    dismissStartupSplash()
    // 两帧 + 宽度过渡兜底 + 淡出兜底
    vi.advanceTimersByTime(FRAME_MS * 2 + SPLASH_FILL_MS + 100 + SPLASH_FADE_MS + 100)

    expect(document.getElementById('app-splash')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('没有壳、重复调用都不抛；重复调用不会排队两次退场', () => {
    expect(() => dismissStartupSplash()).not.toThrow()

    const splash = installSplash()
    dismissStartupSplash()
    dismissStartupSplash()
    advanceFrames(2)

    expect(splash).toHaveAttribute('data-startup-percent', '100')
    finishFillTransition(splash)
    expect(splash).toHaveClass('is-leaving')
    finishFade(splash)
    expect(document.getElementById('app-splash')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('退场已排队但尚未执行时失败：取消计划，不被 100 / 退场覆盖', () => {
    const splash = installSplash()
    advanceStartupSplash('renderer-entry')
    advanceStartupSplash('react-committed')

    dismissStartupSplash()
    failStartupSplash('启动失败：测试')

    // 失败立即生效；排队的 100% 与淡出被取消。
    expect(splash).toHaveClass('is-failed')
    expect(splash).toHaveAttribute('data-startup-percent', '80')
    expect(trackOf(splash)).toHaveAttribute('aria-valuenow', '80')
    expect(trackOf(splash)).toHaveAttribute('aria-valuetext', '启动失败')

    advanceFrames(4)
    vi.advanceTimersByTime(SPLASH_FILL_MS + SPLASH_FADE_MS + 200)
    expect(splash).not.toHaveClass('is-leaving')
    expect(splash).toHaveAttribute('data-startup-percent', '80')
    expect(statusOf(splash)).toHaveTextContent('启动失败：测试')
    expect(document.getElementById('app-splash')).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('100% 已写入但宽度过渡未结束时失败：停在失败态，不再淡出', () => {
    const splash = installSplash()
    advanceStartupSplash('renderer-entry')
    advanceStartupSplash('react-committed')
    dismissStartupSplash()
    advanceFrames(2)
    expect(splash).toHaveAttribute('data-startup-percent', '100')

    failStartupSplash('启动失败：测试')

    expect(splash).toHaveClass('is-failed')
    expect(splash).not.toHaveClass('is-leaving')
    expect(statusOf(splash)).toHaveTextContent('启动失败：测试')
    expect(trackOf(splash)).toHaveAttribute('aria-valuetext', '启动失败')
    expect(trackOf(splash)).toHaveAttribute('aria-hidden', 'true')

    // 原来的宽度监听 / 兜底已被取消，不再触发淡出。
    finishFillTransition(splash)
    vi.advanceTimersByTime(SPLASH_FILL_MS + SPLASH_FADE_MS + 200)
    expect(splash).not.toHaveClass('is-leaving')
    expect(document.getElementById('app-splash')).not.toBeNull()
  })

  it('失败停在最近完成值：显示失败态，进度不再前进、不自动退场', () => {
    const splash = installSplash()
    const track = trackOf(splash)
    const last = STARTUP_STAGES['renderer-entry'].percent
    advanceStartupSplash('renderer-entry')

    failStartupSplash('启动失败：测试')

    expect(splash).toHaveClass('is-failed')
    expect(track).toHaveAttribute('aria-valuenow', String(last))
    expect(track).toHaveAttribute('aria-valuetext', '启动失败')
    expect(track).toHaveAttribute('aria-hidden', 'true')
    expect(percentLabelOf(splash).textContent).toBe('')

    // 失败后阶段事件不能再把比例往前推
    expect(advanceStartupSplash('react-committed')).toBe(last)
    expect(track).toHaveAttribute('aria-valuenow', String(last))

    // 失败态是终点：dismiss 不会把错误画面淡出，也不会把比例补成 100
    dismissStartupSplash()
    expect(splash).not.toHaveClass('is-leaving')
    expect(track).toHaveAttribute('aria-valuenow', String(last))
    vi.advanceTimersByTime(SPLASH_FADE_MS + 100)
    expect(document.getElementById('app-splash')).not.toBeNull()
  })

  it('首屏提交前失败：停在错误文案上，不再转进度条，读屏标签同步', () => {
    const splash = installSplash()

    failStartupSplash()

    expect(splash).toHaveClass('is-failed')
    expect(splash).toHaveAttribute('role', 'alert')
    expect(splash).toHaveAttribute('aria-live', 'assertive')
    expect(splash).toHaveAttribute('aria-label', 'kyclaw 启动失败')
    expect(splash.querySelector('.app-splash__status')).toHaveTextContent('启动失败')
    expect(splash.querySelector('.app-splash__track')).toHaveAttribute('aria-hidden', 'true')
    // 失败态不自动退场：留着错误文案，用户能看到发生了什么
    vi.advanceTimersByTime(SPLASH_FADE_MS + 100)
    expect(document.getElementById('app-splash')).not.toBeNull()
  })

  it('没有壳 / 已经退场时 fail 不抛、不把画面重新盖回来', () => {
    expect(() => failStartupSplash()).not.toThrow()

    const splash = installSplash()
    dismissStartupSplash()
    advanceFrames(2)
    finishFillTransition(splash)
    failStartupSplash()

    expect(splash).not.toHaveClass('is-failed')
    expect(splash).toHaveClass('is-leaving')
  })
})
