import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import { nativeSpecs } from './vitest.native-specs'

/**
 * 分两个 project：`native` = 会加载 libsql 原生插件 / 起真 Mastra 的那一组，并发收敛到
 * `NATIVE_MAX_WORKERS`；`unit` = 其余全部，照旧满并发。成员判定见 `vitest.native-specs.ts`。
 *
 * ## 治的是什么
 *
 * 宽口径 sweep 时一个 worker 以 `3221226505`（`0xC0000409` STATUS_STACK_BUFFER_OVERRUN，
 * Windows 上原生模块崩的典型码）退出，挂点是 `src/mastra/__tests__/ppt-template-session.spec.ts`，
 * 而**该文件单跑全绿**。这一组 spec 的共同点是进程里真装了 libsql 原生插件
 * （`@libsql/win32-x64-msvc/index.node`）：满并发时本机 8 个 fork 同时各带一份原生插件 +
 * 一份临时库，单跑只有 1 份。所以把这一组的并发封顶，是冲着"同时几份原生"这个维度去的。
 *
 * ## 边界（实测，别当它是根治）
 *
 * 限流只是**削弱**，不是消除：本机在"两个 vitest 同时跑 + electron-vite dev 占满 CPU"
 * 的极端争抢下，4 个原生 worker 时仍然复现过一次同样的 `3221226505`
 * （挂点换成 `src/mastra/__tests__/telemetry.spec.ts`；同一次跑里那条 bash 杀进程树、
 * mcp 重启、llama 引擎空闲回收的用例也一起在超时上顶穿——那一跑整机是被饿着的）。
 * 要收紧就调 `KYCLAW_VITEST_NATIVE_WORKERS`（见 `NATIVE_MAX_WORKERS`），
 * 以及**同一时间只跑一份测试**。
 */
const native = nativeSpecs()

const ALL_SPECS = ['src/**/*.{test,spec}.{ts,tsx}']

/**
 * `native` 组的同时并发数。默认 4（本机 8 核的一半），可用环境变量收紧：
 *
 *   KYCLAW_VITEST_NATIVE_WORKERS=2 node_modules/.bin/vitest run src/mastra
 *
 * 本机 8 核实测（`vitest run src/mastra`，60 个文件，均全绿；机器空载）：
 *   不限流（改动前）36.2 / 37.9s → 4 worker 45.5 / 46.6s（+22%）→ 2 worker 72.0s（+95%）。
 * 4 已经把原生插件的并发份数从 8 砍到 4；再往 2 压是"拿一倍的聚焦跑时间换更难说清的边际安全"，
 * 所以默认取 4，想更保守自己调环境变量。
 *
 * 没用 vitest 4/5 里 `singleFork: true` 的等价物（`maxWorkers: 1` + `isolate: false`）：
 *   ① 那一条同时要求 `isolate: false`（跨文件共享模块状态），这一组的 spec 各自起停真
 *      Mastra / 真 libsql 库，共享状态的风险远大于收益；
 *   ② `maxWorkers: 1` 等于组内串行：`src/mastra` 里入组的有 23 个文件，串行跑会把聚焦跑
 *      拖慢三倍以上，而仓库口径是开发期只跑聚焦。
 */
const NATIVE_MAX_WORKERS = Number(process.env.KYCLAW_VITEST_NATIVE_WORKERS ?? 4)

/**
 * Vite 层的配置（两个 project 各给一份）。
 *
 * 为什么要 `extends: false`：内联 project 默认继承根配置，而 vitest 对 `include`/`exclude`
 * 这类数组是**拼接**不是覆盖 —— 继承的话 native 组会把根配置的 `include` 也带上，等于没分组
 * （实测：继承时两个 project 都跑满 240 个文件，`unit` 的 `exclude` 也不生效）。
 * `extends: false` 的代价是不再继承 Vite 层的插件/别名、且每个 project 自己起一份 Vite server，
 * 所以这里用一份共用常量补上（改别名改这一处就够）。
 */
const viteLayer = {
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  }
}

/** 用例级档位（两个 project 共用） */
const testLayer = {
  environment: 'jsdom' as const,
  setupFiles: ['src/renderer/src/__tests__/setup.ts'],
  // round 63：满载跑全量时的现实——204 份 jsdom 环境互相抢（本机实测环境创建合计 ~900s），
  // 零散用例会在 5s 默认超时上顶穿（两次全量跑失败集还不一样；把这些文件单独跑 195/195 全过）。
  // 与"逐例补 30s"的先例同口径，统一放宽到"真挂起仍会失败、只是慢一拍"的量级。
  testTimeout: 20_000,
  hookTimeout: 30_000
}

export default defineConfig({
  ...viteLayer,
  test: {
    ...testLayer,
    include: ALL_SPECS,
    projects: [
      {
        // 与根配置完全分开：include/exclude 才不会被拼接（见 viteLayer 头注）
        extends: false,
        ...viteLayer,
        test: {
          ...testLayer,
          name: 'native',
          include: native,
          // 组内仍并行，只是同时跑的文件数封顶（`poolOptions` 在 vitest 4 起已改成顶层选项，
          // `maxForks` 改叫 `maxWorkers`）
          pool: 'forks',
          maxWorkers: NATIVE_MAX_WORKERS,
          // vitest 5 的硬要求：两个 project 的 `maxWorkers` 不同就**必须**给不同的
          // `sequence.groupOrder`。代价是两组按组号先后跑（不是同时跑）——同一个组号里才并行。
          sequence: { groupOrder: 1 }
        }
      },
      {
        extends: false,
        ...viteLayer,
        test: {
          ...testLayer,
          // 其余全部：行为与改动前一致（jsdom 环境 + 满并发）
          name: 'unit',
          include: ALL_SPECS,
          exclude: [...configDefaults.exclude, ...native],
          sequence: { groupOrder: 2 }
        }
      }
    ]
  }
})
