import { describe, expect, it } from 'vitest'
import { unwrapIpcError } from '@renderer/lib/ipc-error'

/**
 * IPC 错误人话化（round 25）：Electron 的 invoke 失败会把主进程错误包成
 * `Error invoking remote method '<channel>': Error: …`——展示前统一剥掉。
 */
describe('unwrapIpcError', () => {
  it('剥掉 `Error invoking remote method <channel>: ` 包装（主进程 Error 再套的一层也剥）', () => {
    expect(
      unwrapIpcError(
        new Error(
          "Error invoking remote method 'plugins:remove-marketplace': Error: 删除被占用：C:\\x（关掉占用它的程序后重试）"
        )
      )
    ).toBe('删除被占用：C:\\x（关掉占用它的程序后重试）')
  })

  it('没有包装的普通错误：原样（只取第一行）', () => {
    expect(unwrapIpcError(new Error('设置落盘失败'))).toBe('设置落盘失败')
    expect(unwrapIpcError(new Error('认证失败（401）：密钥无效\n    at foo.js:1:1'))).toBe(
      '认证失败（401）：密钥无效'
    )
  })

  it('多层包装 / 非 Error 值 / 空消息：都给可展示的一行', () => {
    expect(
      unwrapIpcError(
        new Error(
          "Error invoking remote method 'a': Error invoking remote method 'b': Error: 真原因"
        )
      )
    ).toBe('真原因')
    expect(unwrapIpcError('字符串错误')).toBe('字符串错误')
    expect(unwrapIpcError(new Error(''))).toBe('')
  })

  it('剥完为空 → 回原始首行（宁可漏剥不吞信息）', () => {
    expect(unwrapIpcError(new Error("Error invoking remote method 'x': \n"))).toContain(
      'Error invoking remote method'
    )
  })
})
