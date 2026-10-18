import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('task-123 · 主题色回归契约', () => {
  it('发送键 hover/focus 转 accent；base 仍是文字色', () => {
    const css = read('src/renderer/src/features/chat/composer-send.css')
    expect(css).toMatch(/\.composer-send:hover[\s\S]*?color: var\(--accent\)/)
    expect(css).toContain('var(--accent)')
    const composer = read('src/renderer/src/features/chat/Composer.tsx')
    expect(composer).toContain('text-ink')
  })

  it('AI 身份点：accent token / aria-hidden / 运行中动画 / reduced 静态', () => {
    const tsx = read('src/renderer/src/features/chat/parts/TurnProcess.tsx')
    expect(tsx).toContain('data-testid="ai-identity-spark"')
    expect(tsx).toContain('aria-hidden')
    expect(tsx).toContain('text-(--accent)')
    expect(tsx).toContain('motion-reduce:animate-none')
    const css = read('src/renderer/src/features/chat/turn-process.css')
    expect(css).toContain('@keyframes identity-spark')
  })
})
