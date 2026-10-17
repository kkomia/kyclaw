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
const toolCardTsx = read('../parts/ToolCard.tsx')
const composerTsx = read('../Composer.tsx')
const errorCardTsx = read('../ErrorCard.tsx')
const messageRailTsx = read('../MessageRail.tsx')

describe('AI 回复 = 阅读声部', () => {
  it('Message 有阅读车道容器：44em + 左侧 1px 页边线 + 18px 缩进', () => {
    expect(messageTsx).toContain('message-reading-lane')
    expect(messageTsx).toContain('data-font-role="reading"')
    expect(messageTsx).toContain('--prose-measure')
    expect(messageTsx).toMatch(/border-l border-\(--hairline-soft\)/)
    expect(messageTsx).toContain('pl-[18px]')
  })

  it('Markdown 正文容器 = reading 声部（衬线 class + data 属性）', () => {
    expect(textPartTsx).toContain('markdown-body font-serif')
    expect(textPartTsx).toContain('data-font-role="reading"')
  })

  it('用户消息 = 右侧便条：UI 声部 14、气泡底、12/4 圆角、65% 上限', () => {
    expect(messageTsx).toContain('bg-(--bg-bubble)')
    expect(messageTsx).toMatch(/font-sans text-b2/)
    expect(messageTsx).toContain('rounded-[12px]')
    expect(messageTsx).toContain('rounded-br-[4px]')
    expect(messageTsx).toContain('max-w-[65%]')
    expect(messageTsx).toContain('data-font-role="ui"')
  })
})

describe('工具/读数 = 技术声部（mono + tabular）', () => {
  it('工具名/路径/详情用 font-mono 且标 code 声部；状态是 UI 声部', () => {
    expect(toolCardTsx).toMatch(/font-mono text-c1/)
    expect(toolCardTsx).toContain('data-font-role="code"')
    expect(toolCardTsx).toContain('data-font-role="ui"')
    expect(toolCardTsx).toMatch(/data-testid="tool-detail"[\s\S]*?tabular-nums/)
  })

  it('消息时间戳和导览轮次号 = mono + tabular-nums', () => {
    expect(messageTsx).toMatch(/data-testid="message-sent-at"[\s\S]*?font-mono/)
    expect(messageTsx).toMatch(/data-testid="message-sent-at"[\s\S]*?tabular-nums/)
    expect(messageRailTsx).toMatch(/font-mono[^"']*tabular-nums|tabular-nums/)
  })
})

describe('Composer = UI 声部 + 规章 §9.2#6', () => {
  it('输入卡 16 圆角 + composer 阴影；输入/镜像层显式 font-sans b1', () => {
    expect(composerTsx).toContain('rounded-input')
    expect(composerTsx).toContain('shadow-(--shadow-composer)')
    expect(composerTsx).not.toContain('shadow-(--shadow-input)')
    expect(composerTsx).toMatch(/font-sans[^"']*text-b1|text-b1[^"']*font-sans/)
  })

  it('placeholder 用可读三级档；发送键 32 实心陶土橙，禁用 quaternary/opacity', () => {
    expect(composerTsx).toContain('placeholder:text-(--text-tertiary-readable)')
    expect(composerTsx).toContain('size-8')
    expect(composerTsx).toContain('bg-(--button-primary-bg)')
    expect(composerTsx).toContain('text-(--text-quaternary)')
    expect(composerTsx).toContain('opacity-60')
    // 旧尺寸/旧阴影不许再回来
    expect(composerTsx).not.toContain('shadow-(--shadow-input)')
  })

  it('模型/上下文 chip 是技术读数：mono 12', () => {
    const controls = read('../ComposerControls.tsx')
    expect(controls).toMatch(/data-testid="composer-model"[\s\S]{0,400}font-mono text-c1/)
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
