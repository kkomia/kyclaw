import { describe, expect, it } from 'vitest'
import { CONNECTION_TEST_SCOPE_NOTE, type ConnectionTestResult } from '@shared/ipc'
import {
  CONNECTION_TEST_STATUS_LABELS,
  CONNECTION_TEST_STEP_LABELS,
  connectionTestHeadline
} from '../status-text'

/**
 * 「测试连接」的两处文案（用户反馈 005）：分项结论的中文 + 那句大字。
 * 钉的是语义，不是排版：`unverified` **不许**说成通过，"能对话"的门槛是连通 + 流式，
 * 而**工具那步没过时大字必须说出来**（不能被读成整体通过）。
 */
function result(patch: Partial<ConnectionTestResult>): ConnectionTestResult {
  return {
    ok: true,
    latencyMs: 128,
    steps: [
      { id: 'connectivity', status: 'passed', latencyMs: 40, detail: '通了' },
      { id: 'streaming', status: 'passed', latencyMs: 60, detail: '拿到正文' },
      { id: 'tools', status: 'passed', latencyMs: 28, detail: '调了工具' }
    ],
    scopeNote: CONNECTION_TEST_SCOPE_NOTE,
    ...patch
  }
}

describe('connectionTestHeadline', () => {
  it('三步都过才说"连接正常"，并带上延迟', () => {
    expect(connectionTestHeadline(result({}))).toBe('连接正常，延迟 128 ms')
  })

  it('ok 但工具那步没过：大字里一并说清（不许读成"整体通过"）', () => {
    expect(
      connectionTestHeadline(
        result({
          steps: [
            { id: 'connectivity', status: 'passed', detail: '通了' },
            { id: 'streaming', status: 'passed', detail: '拿到正文' },
            { id: 'tools', status: 'failed', detail: '工具参数不合法' }
          ]
        })
      )
    ).toBe('连接与流式正常，但工具调用没有通过（延迟 128 ms）')
  })

  it('工具那步"未验证"也算没通过（同样进大字）', () => {
    expect(
      connectionTestHeadline(
        result({
          steps: [
            { id: 'connectivity', status: 'passed', detail: '通了' },
            { id: 'streaming', status: 'passed', detail: '拿到正文' },
            { id: 'tools', status: 'unverified', detail: '模型没调工具' }
          ]
        })
      )
    ).toBe('连接与流式正常，但工具调用没有通过（延迟 128 ms）')
  })

  it('不到门槛（连通/流式没全过）就只说"没能确认可用"，原因由分项与 message 说话', () => {
    expect(connectionTestHeadline(result({ ok: false, message: '认证失败（401）' }))).toBe(
      '没能确认可用'
    )
    expect(connectionTestHeadline(result({ ok: false }))).toBe('没能确认可用')
  })
})

describe('分项文案', () => {
  it('三步各有一句中文（005：用户要能一眼看出是哪一环没过）', () => {
    expect(Object.values(CONNECTION_TEST_STEP_LABELS)).toEqual(['连通', '流式对话', '流式工具'])
  })

  it('四档状态都不互相冒充：未验证既不是通过也不是失败', () => {
    expect(CONNECTION_TEST_STATUS_LABELS.passed).toBe('通过')
    expect(CONNECTION_TEST_STATUS_LABELS.failed).toBe('失败')
    expect(CONNECTION_TEST_STATUS_LABELS.unverified).toBe('未验证')
    expect(CONNECTION_TEST_STATUS_LABELS.skipped).toBe('未执行')
  })
})
