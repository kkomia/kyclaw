// @vitest-environment node
/**
 * PB-043：内核**运行期崩溃**（ready 之后进程退出）的用户可见面。
 *
 * 现状（PB-006 的已知缺口）：ready 之后 `exit` 监听被摘掉，只剩 log-only 的 `'error'`；
 * 崩溃当场零提示，下一次动作只报「连接中断 / 本轮生成失败」，**没有退出码、没有日志路径**，
 * 用户无法判断"是内核死了"还是"网络断了"。
 *
 * 本 spec 钉住最小修复的错误文案：
 *   1. 崩溃后发消息 → 文案含 `内核进程已退出（exitCode=…）`、`请重启应用`、`kernel.log` 绝对路径；
 *   2. signal 退出（exitCode=null）→ 文案用 signal 名；
 *   3. 未崩溃时该函数不参与（由调用点决定），保持 null 语义。
 */
import { describe, expect, it } from 'vitest'
import { kernelExitMessage } from '../kernel-startup'

const LOG = 'C:\\Users\\me\\AppData\\Roaming\\kyclaw\\logs\\kernel.log'

describe('PB-043 运行期崩溃文案', () => {
  it('exitCode=1 → 含退出码、重启建议、kernel.log 绝对路径', () => {
    const text = kernelExitMessage({ exitCode: 1, signal: null }, LOG)
    expect(text).toContain('内核进程已退出（exitCode=1）')
    expect(text).toContain('请重启应用')
    expect(text).toContain(LOG)
  })

  it('signal 退出（exitCode=null）→ 文案用 signal 名，不写成 exitCode=null', () => {
    const text = kernelExitMessage({ exitCode: null, signal: 'SIGKILL' }, LOG)
    expect(text).toContain('SIGKILL')
    expect(text).not.toContain('exitCode=null')
  })

  it('没有日志落点（测试/纯诊断）→ 不编造路径，只少那一句', () => {
    const text = kernelExitMessage({ exitCode: 2, signal: null })
    expect(text).toContain('exitCode=2')
    expect(text).not.toContain('日志：')
  })
})
