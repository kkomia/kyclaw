/**
 * P1 路由懒加载占位契约：chunk 在路上时内容区给一个居中 spinner，
 * 壳/侧栏不动（集成场景由 module-host.spec 覆盖），不闪白、不改变页面加载态语义。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RouteFallback } from '../RouteFallback'

describe('RouteFallback', () => {
  it('渲染居中占位：route-loading + 可朗读的“页面加载中”', () => {
    render(<RouteFallback />)
    const host = screen.getByTestId('route-loading')
    expect(host).toHaveClass('flex', 'min-h-0', 'flex-1', 'items-center', 'justify-center')
    expect(host.querySelector('[role="status"]')).toHaveAttribute('aria-label', '页面加载中')
  })
})
