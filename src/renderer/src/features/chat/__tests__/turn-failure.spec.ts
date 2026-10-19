import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { parseTurnFailure } from '@shared/turn-failure'
import {
  failurePresentationOf,
  turnFailureDetail,
  turnFailureOfMessage,
  turnFailureTitle
} from '../turn-failure'

/**
 * PB-037：失败轮 metadata 的解析/文案/dedupe 判定（单一出口）。
 * 红线：坏形状不猜；aborted/interrupted 只显示「已中断」，不许当 error。
 */
function failure(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { turn: 3, kind, ...extra }
}

describe('PB-037 turnFailure 解析', () => {
  it('三种合法 kind；turn 必须是非负整数', () => {
    expect(parseTurnFailure(failure('error', { code: 'rate-limit', message: '太频繁' }))).toEqual({
      turn: 3,
      kind: 'error',
      code: 'rate-limit',
      message: '太频繁'
    })
    expect(parseTurnFailure(failure('aborted'))).toEqual({ turn: 3, kind: 'aborted' })
    expect(parseTurnFailure(failure('interrupted'))).toEqual({ turn: 3, kind: 'interrupted' })
  })

  it('kind 不在白名单 / turn 缺失或非法 / 非对象 → null（不猜 source）', () => {
    expect(parseTurnFailure(failure('completed'))).toBeNull()
    expect(parseTurnFailure({ kind: 'error' })).toBeNull()
    expect(parseTurnFailure({ turn: -1, kind: 'error' })).toBeNull()
    expect(parseTurnFailure({ turn: 1.5, kind: 'error' })).toBeNull()
    expect(parseTurnFailure(null)).toBeNull()
    expect(parseTurnFailure('error')).toBeNull()
  })

  it('空 code/message 当作没写（不展示空串）', () => {
    expect(parseTurnFailure(failure('error', { code: '  ', message: '' }))).toEqual({
      turn: 3,
      kind: 'error'
    })
  })
})

describe('PB-037 turnFailure 文案：三种 kind 各自钉死', () => {
  it('error：标题「这一轮没有完成」，message 优先；有 message 时 code 单独一行', () => {
    const f = parseTurnFailure(failure('error', { code: 'E_RATE', message: '服务限流' }))!
    expect(turnFailureTitle(f)).toBe('这一轮没有完成')
    expect(turnFailureDetail(f)).toBe('服务限流')
    expect(f).not.toBeNull()
  })

  it('error：只有 code 时，detail 用 code（不重复一行）', () => {
    const f = parseTurnFailure(failure('error', { code: 'E_ONLY' }))!
    expect(turnFailureDetail(f)).toBe('E_ONLY')
  })

  it('aborted / interrupted：标题「已中断」，不产生失败原因（只读中断）', () => {
    for (const kind of ['aborted', 'interrupted']) {
      const f = parseTurnFailure(failure(kind, { message: '不该显示' }))!
      expect(turnFailureTitle(f)).toBe('已中断')
      expect(turnFailureDetail(f)).toBeNull()
    }
  })
})

describe('PB-037 failurePresentationOf：消息卡优先、dock 不双显', () => {
  const failedUser = (metadata: Record<string, unknown>): UIMessage =>
    ({ id: 'u1', role: 'user', parts: [{ type: 'text', text: '问题' }], metadata }) as UIMessage
  const okUser = (id: string): UIMessage =>
    ({ id, role: 'user', parts: [{ type: 'text', text: '新问题' }] }) as UIMessage
  const error = new Error('流失败')

  it('最近一条 user 有 turnFailure → 消息卡存在，dock 错误卡不显示', () => {
    expect(failurePresentationOf([failedUser({ turnFailure: failure('error') })], error)).toEqual({
      messageCard: true,
      dockErrorVisible: false
    })
  })

  it('没有消息卡 / 不是最近一轮 → dock 错误卡显示', () => {
    expect(failurePresentationOf([okUser('u1')], error)).toEqual({
      messageCard: false,
      dockErrorVisible: true
    })
    expect(
      failurePresentationOf([failedUser({ turnFailure: failure('error') }), okUser('u2')], error)
    ).toEqual({
      messageCard: false,
      dockErrorVisible: true
    })
  })

  it('无 error 时 dock 不显示；坏 metadata 不算消息卡', () => {
    expect(failurePresentationOf([failedUser({ turnFailure: failure('error') })], null)).toEqual({
      messageCard: true,
      dockErrorVisible: false
    })
    expect(failurePresentationOf([failedUser({ turnFailure: { kind: 'error' } })], error)).toEqual({
      messageCard: false,
      dockErrorVisible: true
    })
  })

  it('turnFailureOfMessage 只认 metadata.turnFailure', () => {
    expect(turnFailureOfMessage(failedUser({ turnFailure: failure('interrupted') }))).toEqual({
      turn: 3,
      kind: 'interrupted'
    })
    expect(
      turnFailureOfMessage(failedUser({ turnFailure: { kind: 'completed', turn: 1 } }))
    ).toBeNull()
  })
})
