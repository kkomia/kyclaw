// @vitest-environment node
/**
 * B4 / 验收④：内核启动失败要经 IPC 原样到错误卡；Electron 的 IPC 前缀必须剥掉。
 */
import { describe, expect, it } from 'vitest'
import { cleanIpcErrorMessage } from '../ipc-error'

describe('cleanIpcErrorMessage：只剥 Electron IPC 前缀，不改写原文', () => {
  it('剥掉 "Error invoking remote method ...: Error: " 前缀', () => {
    expect(
      cleanIpcErrorMessage(
        new Error(
          "Error invoking remote method 'agent:endpoint': Error: 内核启动失败（KERNEL_MANIFEST_MISSING）：内核目录里没有 current.json；日志：C:\\x\\kernel.log"
        )
      )
    ).toBe(
      '内核启动失败（KERNEL_MANIFEST_MISSING）：内核目录里没有 current.json；日志：C:\\x\\kernel.log'
    )
  })

  it('没有前缀的错误原样返回（含普通中文错误）', () => {
    expect(cleanIpcErrorMessage(new Error('内核入口未配置（KERNEL_NOT_CONFIGURED）：…'))).toBe(
      '内核入口未配置（KERNEL_NOT_CONFIGURED）：…'
    )
    expect(cleanIpcErrorMessage(new Error('agent 服务尚未启动'))).toBe('agent 服务尚未启动')
  })

  it('非 Error 输入转字符串（不吞信息）', () => {
    expect(cleanIpcErrorMessage('boom')).toBe('boom')
    expect(cleanIpcErrorMessage(undefined)).toBe('undefined')
  })
})
