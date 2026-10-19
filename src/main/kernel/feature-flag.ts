/**
 * B2 feature flag：**默认关闭**，开与不开都不影响现有 chat 行为（现状 = 不开）。
 *
 * 为什么留 env 而不是设置项：B2 只是骨架（不接真内核），还没有需要给用户看的开关；
 * 等 C 阶段 adapter 真正接上内核再决定是否进设置页。
 */
export const KERNEL_PORT_ENV = 'KYCLAW_KERNEL_PORT'

/** 只有显式 `KYCLAW_KERNEL_PORT=1` 才视为启用；其余（含未设）一律关闭 */
export function isKernelPortEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env[KERNEL_PORT_ENV] === '1'
}
