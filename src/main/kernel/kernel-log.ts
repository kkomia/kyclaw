/**
 * B4 / PB-006：内核启动日志（验收④：启动失败必须写入日志，UI 可明示原因）。
 *
 * 为什么单独一个文件而不是 console.log：
 *   - 打包后的 Windows GUI 应用**没有可读的控制台**；用户/支持同学要能看到"内核为什么没起来"；
 *   - 固定落点 `<userData>/logs/kernel.log`：与内核数据（`<userData>/dsh-home`）同目录族，
 *     不落安装目录（安装目录只读语义）、不落仓库；
 *   - 只记**脱敏后的**诊断（token/cookie 不进日志，红线见 kernel-process 的 redactKernelDiagnostics）。
 *
 * 纪律：日志失败**绝不**影响启动（没有日志也要把内核起来/把错误抛出去）；超限就滚一份 `.1`。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单份日志上限：内核启动日志是低频事件，4 MiB 足够；超了滚成 `.1`（只留一代） */
export const KERNEL_LOG_MAX_BYTES = 4 * 1024 * 1024

export interface KernelLog {
  readonly file: string
  /** 追加一条事件行：`<ISO 时间> <事件名> <JSON 详情>`（详情值里有换行也会被 JSON 转义） */
  event(name: string, details?: Readonly<Record<string, unknown>>): void
}

/** 纯函数：拼一行日志（单测直接钉格式；真正的写盘在 createKernelLog） */
export function formatKernelLogLine(
  at: Date,
  name: string,
  details: Readonly<Record<string, unknown>> = {}
): string {
  return `${at.toISOString()} ${name} ${JSON.stringify(details)}\n`
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < KERNEL_LOG_MAX_BYTES) return
    renameSync(file, `${file}.1`)
  } catch {
    // 滚动失败不挡启动：继续往原文件追加（大不了大一点）
  }
}

/** 创建追加式内核日志；任何写盘错误都吞掉并退回 console.warn（日志不该成为启动失败原因） */
export function createKernelLog(file: string): KernelLog {
  return {
    file,
    event(name: string, details: Readonly<Record<string, unknown>> = {}): void {
      try {
        mkdirSync(dirname(file), { recursive: true })
        rotateIfNeeded(file)
        appendFileSync(file, formatKernelLogLine(new Date(), name, details), 'utf8')
      } catch (error) {
        console.warn('[kyclaw] 内核日志写入失败（不影响启动）', file, error)
      }
    }
  }
}
