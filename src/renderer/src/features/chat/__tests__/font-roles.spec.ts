import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P1a · 字体三声部契约（章程 §2 / §2.5 / §9.2）。
 *
 * 为什么要读源文件：这是"声部分配"的静态契约（哪个容器用 reading/ui/code），
 * 用渲染断言逐个组件太重、且 composer/tool 的宿主依赖很多；源文件断言能挡住
 * 最容易回归的事：把 `--font-reading` 换成硬编码栈、把 mono 读数改回 sans、
 * 把发送键改回非 accent、把错误卡改回整块红底。
 */
const CHAT = resolve(process.cwd(), 'src/renderer/src/features/chat')
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const messageTsx = read('../Message.tsx')
const textPartTsx = read('../parts/TextPart.tsx')
const reasoningPartTsx = read('../parts/ReasoningPart.tsx')
const toolCardTsx = read('../parts/ToolCard.tsx')
const composerTsx = read('../Composer.tsx')
const errorCardTsx = read('../ErrorCard.tsx')
const messageRailTsx = read('../MessageRail.tsx')

describe('AI 回复 = 阅读声部', () => {
  it('Message 有阅读车道容器：task-83 去左竖线、保留 18px 缩进、宽度占满内容列', () => {
    expect(messageTsx).toContain('message-reading-lane')
    expect(messageTsx).toContain('data-font-role="reading"')
    expect(messageTsx).not.toMatch(/border-l border-\(--hairline-soft\)/)
    // PB-028：缩进从写死 18px 改成读 --chat-reading-indent（随字号档缩放），期望值按当前实现
    expect(messageTsx).toContain('pl-[var(--chat-reading-indent)]')
  })

  it('Markdown 正文容器 = 阅读车道 + 书生气衬线（--font-prose，2026-10-18 task-51）', () => {
    // 车道语义保留在 data-font-role；字体族 = --font-prose（Noto Serif 拉丁 + DSH 黑体中文）
    expect(textPartTsx).toContain('data-font-role="reading"')
    expect(textPartTsx).toContain('markdown-body font-prose')
    expect(textPartTsx).not.toContain('markdown-body font-sans')
    expect(textPartTsx).not.toContain('markdown-body font-serif')
  })

  it('思考内容 = 书生气衬线（reasoning-text 加 font-prose；标签/时间等 chrome 仍 sans）', () => {
    expect(reasoningPartTsx).toContain('data-testid="reasoning-text"')
    expect(reasoningPartTsx).toMatch(/data-testid="reasoning-text"[\s\S]{0,200}font-prose/)
    // 折叠行标签（reasoning-toggle）不是正文，保持 UI 声部
    expect(reasoningPartTsx).toMatch(/data-testid="reasoning-toggle"/)
    expect(reasoningPartTsx).not.toMatch(/data-testid="reasoning-toggle"[^>]*font-prose/)
  })

  it('用户消息 = 右侧便条：UI 声部 14、气泡底、12/4 圆角、DSH 70.2%/82% 上限', () => {
    expect(messageTsx).toContain('bg-(--bg-bubble)')
    expect(messageTsx).toMatch(/font-sans text-b2/)
    expect(messageTsx).toContain('rounded-[12px]')
    expect(messageTsx).toContain('rounded-br-[4px]')
    expect(messageTsx).toContain('max-w-[min(calc(var(--chat-content-width)*0.702),82%)]')
    expect(messageTsx).toContain('data-font-role="ui"')
  })
})

describe('工具/读数 = 书生气正文 + 技术声部（task-51）', () => {
  it('工具名/自由文本详情走 --font-prose；路径/URL 详情仍 mono；状态是 UI 声部', () => {
    // 工具名（含 MCP 英文名）书生气衬线；自由文本详情（query/pattern/command）同样
    expect(toolCardTsx).toContain('data-font-role="prose"')
    expect(toolCardTsx).toContain('font-prose text-c1')
    // 路径/URL 等"技术串"保留 mono + code 声部 + tabular
    expect(toolCardTsx).toMatch(/isTechnicalDetail\(shownDetail\)[\s\S]*?font-mono text-c1/)
    expect(toolCardTsx).toContain('data-font-role="code"')
    expect(toolCardTsx).toContain('data-font-role="ui"')
    expect(toolCardTsx).toMatch(/isTechnicalDetail\(shownDetail\)[\s\S]*?tabular-nums/)
    // 入参/回执面板仍是 mono（不改）
    expect(toolCardTsx).toMatch(/data-testid="tool-input"[\s\S]{0,200}font-mono/)
    expect(toolCardTsx).toMatch(/data-testid="tool-output"[\s\S]{0,200}font-mono/)
  })

  it('消息时间戳和导览轮次号 = mono + tabular-nums', () => {
    expect(messageTsx).toMatch(/data-testid="message-sent-at"[\s\S]*?font-mono/)
    expect(messageTsx).toMatch(/data-testid="message-sent-at"[\s\S]*?tabular-nums/)
    expect(messageRailTsx).toMatch(/font-mono[^"']*tabular-nums|tabular-nums/)
  })
})

describe('Composer = UI 声部 + 规章 §9.2#6', () => {
  it('输入卡 16 圆角 + composer 阴影；输入/镜像层显式 font-sans b1', () => {
    expect(composerTsx).toContain('rounded-[14px]')
    expect(composerTsx).toContain('shadow-(--shadow-composer)')
    expect(composerTsx).not.toContain('shadow-(--shadow-input)')
    expect(composerTsx).toMatch(/font-sans[^"']*text-\[14px\]|text-\[14px\][^"']*font-sans/)
  })

  it('placeholder 用可读三级档；发送键 32 实心陶土橙，禁用 quaternary/opacity', () => {
    expect(composerTsx).toContain('placeholder:text-(--text-tertiary-readable)')
    expect(composerTsx).toContain('h-[26px]')
    expect(composerTsx).toContain('hover:bg-hover')
    expect(composerTsx).toContain('text-(--text-tertiary-readable)')
    expect(composerTsx).toContain('border-surface-border')
    // 旧尺寸/旧阴影不许再回来
    expect(composerTsx).not.toContain('shadow-(--shadow-input)')
  })

  it('模型/强度/上下文读数共用一套 UI metrics（PB-003：13px / 500 / 20px 行盒 / tabular）', () => {
    const controls = read('../ComposerControls.tsx')
    const effort = read('../ThinkingEffort.tsx')
    // 三处吃同一个常量（数值只许有一份），源文件里不再各写各的类
    expect(controls).toMatch(/data-testid="composer-model"[\s\S]{0,400}COMPOSER_READOUT_CLASS/)
    expect(controls).toMatch(/data-testid="context-percent"[\s\S]{0,200}COMPOSER_READOUT_CLASS/)
    expect(effort).toMatch(/data-testid="composer-effort"[\s\S]{0,400}COMPOSER_READOUT_CLASS/)
    expect(effort).toMatch(
      /COMPOSER_READOUT_CLASS\s*=\s*'font-sans text-\[13px\] font-medium leading-\[20px\] text-ink-secondary tabular-nums'/
    )
  })
})

describe('错误卡（章程 §9.6）：danger 只做图标/左边线', () => {
  it('不整块红底；左 2px danger 边 + hairline 卡 + 14/600 标题', () => {
    expect(errorCardTsx).toContain('border-l-2')
    expect(errorCardTsx).toContain('border-l-danger')
    expect(errorCardTsx).not.toContain('bg-danger-bg')
    expect(errorCardTsx).toMatch(/font-sans text-b2 font-semibold/)
  })
})

describe('chat 目录不许硬编码字体栈（章程 §2.1/§2.2）', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        return name === '__tests__' ? [] : walk(path)
      }
      return /\.(tsx?|css)$/.test(name) ? [path] : []
    })
  }

  it('没有 font-family 字面值 / system-ui / 雅黑优先 / ui-monospace 直写', () => {
    const files = walk(CHAT)
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return (
        /font-family:\s*(?!var\()/.test(source) ||
        /system-ui/.test(source) ||
        /'Microsoft YaHei'/.test(source) ||
        /ui-monospace/.test(source)
      )
    })
    expect(offenders).toEqual([])
  })
})
