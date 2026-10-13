/**
 * 「工作区之外」那一档（round 75）的**运行期镜像**。
 *
 * 为什么要有这份镜像（而不是像 `permissionRules` 那样从 service 的取值函数注入）：
 * 审批判定（`mastra/tools/guard.ts`）拿到的 `ToolContext` 是 `mastra/agents/kyclaw.ts` 装配的，
 * 那个文件这一轮由另一处改动持有 —— **不动它就接不上新的注入字段**。所以档位走"模块级注册表"
 * 这条通道（仓库里已有同一个先例：`mastra/skills/runtime.ts` 的本部署事实注册表，头注里写着
 * 同样的理由）。
 *
 * 谁来写：**只有 `main/settings.ts`** —— 应用里读设置 / 写设置都从那里过（`readSettings` 是
 * 设置唯一的读口，`updateSettings` 是唯一的写口），于是"设置页改了档位"下一轮工具调用就生效，
 * 与 `permissionRules` 的现读口径一致。谁来读：`guard.createToolContext` 的缺省取值函数
 * （生产装配不显式传，用的就是它）。
 *
 * 缺省 `ask`：注册表还没被任何一次设置读写碰过时（单测、无设置的进程）就是保守档 ——
 * 区外的操作逐次询问。测试可以显式 `setOutsideMode('full')` 或走 `createToolContext` 的
 * `outsideMode` 选项注入，不必依赖全局状态。
 */
import type { WorkspaceMode } from '../../shared/settings'

/** 注册表内容（进程级一份；`main/settings.ts` 每次读写设置时刷它） */
let current: WorkspaceMode = 'ask'

/** 装上当前档位（`main/settings.ts` 的读/写设置各调一次） */
export function setOutsideMode(mode: WorkspaceMode): void {
  current = mode === 'full' ? 'full' : 'ask'
}

/** 现读当前档位（审批判定的缺省来源） */
export function outsideMode(): WorkspaceMode {
  return current
}

/** 复原成缺省（测试用：模块级状态不随用例重置） */
export function resetOutsideMode(): void {
  current = 'ask'
}
