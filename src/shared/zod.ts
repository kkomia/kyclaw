/**
 * 跨边界 schema 的 zod 入口：预置 **jitless**（不走动态代码生成）。
 *
 * 为什么（T5 实机实测）：渲染端 index.html 的 CSP 是 `script-src 'self'`（没有 'unsafe-eval'），
 * Electron 的 preload 跑在同一份 CSP 下。zod 4 在首次 parse 时会**动态生成**校验函数
 * （`Doc.compile` → `new Function`），于是 preload 里的 `safeParse` 抛
 * `EvalError: Code generation from strings disallowed for this context`：
 * 结构校验静默失效——`settings:get` 回退默认值，重启后主题/字号回到默认（写盘正常，只有读回坏了）。
 *
 * jitless 只把"生成校验函数"换成解释执行，校验语义与拒绝行为不变；这些 schema 都是几个字段的小对象，
 * 这点性能不值得用 `unsafe-eval` 去换（那会真削 CSP）。
 *
 * 注意：zod 在 **schema 构造时**读这个开关，所以 `shared/*` 里的 schema 定义必须 import 本模块，
 * 而不是直接 import 'zod'。
 */
import { z } from 'zod'

z.config({ jitless: true })

export { z }
