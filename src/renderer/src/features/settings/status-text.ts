import type {
  ConnectionTestResult,
  ConnectionTestStepId,
  ConnectionTestStepStatus,
  LangfuseState,
  UpdateState
} from '@shared/ipc'
import type { RecallStatus } from '@shared/memory'

/**
 * 设置页两处状态行的文案（T17）：纯函数单独放一份 —— 组件文件只导出组件（react-refresh 口径），
 * 文案规则也可以被单测直接钉住。
 *
 * 两条纪律：零 emoji；不解释后端怎么实现（只说用户能看到的那件事）。
 */

/** 「关于」栏：更新状态一行话 */
export function updateStatusText(state: UpdateState | null): string {
  if (state === null) return '正在读取…'
  const { status, configured } = state
  switch (status.phase) {
    case 'idle':
      return configured ? '尚未检查' : '未配置更新源'
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return '已是最新版本'
    case 'available':
      return status.version === undefined ? '发现新版本' : `发现新版本 ${status.version}`
    case 'downloading':
      return status.version === undefined
        ? `正在下载 ${status.percent ?? 0}%`
        : `正在下载 ${status.version}（${status.percent ?? 0}%）`
    case 'downloaded':
      return status.version === undefined
        ? '新版本已下载，重启后安装'
        : `新版本 ${status.version} 已下载`
    case 'error':
      return `检查失败：${status.message ?? '未知原因'}`
  }
}

/** 每一步的名字（005：结论要分项展示，用户才看得出是哪一环没过） */
export const CONNECTION_TEST_STEP_LABELS: Record<ConnectionTestStepId, string> = {
  connectivity: '连通',
  streaming: '流式对话',
  tools: '流式工具'
}

/**
 * 四档结论的中文（`unverified` 刻意不用"成功"也不用"失败"：那一步**跑过了但没验出来**，
 * 冒充成功就是 005 要修的那件事）
 */
export const CONNECTION_TEST_STATUS_LABELS: Record<ConnectionTestStepStatus, string> = {
  passed: '通过',
  failed: '失败',
  unverified: '未验证',
  skipped: '未执行'
}

/**
 * 「测试连接」结果里那一句大字（005）：`ok` 的含义是**"能对话"**（连通 + 流式都通过）。
 * 但工具那一步不参与 `ok`——所以它没过时，大字里必须一并说清，不能被读成"整体通过"。
 * 具体哪一环没过、看到了什么，由下面的分项与那句 `message` 说话。
 */
export function connectionTestHeadline(result: ConnectionTestResult): string {
  if (!result.ok) return '没能确认可用'
  const tools = result.steps.find((step) => step.id === 'tools')
  if (tools !== undefined && tools.status !== 'passed') {
    return `连接与流式正常，但工具调用没有通过（延迟 ${result.latencyMs} ms）`
  }
  return `连接正常，延迟 ${result.latencyMs} ms`
}

/**
 * 「追踪」栏：三项齐了才算"已配置"（与主进程 telemetry.ts 的"配齐"判定同一口径；
 * 主进程那边还要再与显式开关一起看，见 langfuseStatusText）
 */
export function langfuseConfigured(state: LangfuseState): boolean {
  return state.endpoint.trim().length > 0 && state.publicKey.hasKey && state.secretKey.hasKey
}

/**
 * 「追踪」栏状态行：配置是"落盘的值"，active 是"本次运行有没有真挂上导出"——两件事分开说，
 * 所以改完配置到重启前，这行字不会撒谎。
 *
 * round 86（010）：显式开关（`enabled`，与「记忆」栏同一手法由设置值传进来）优先过一遍 ——
 * 关着就说"已关闭"；若本次运行还挂着导出（启动时是开着的），补一句"重启应用后停止"。
 */
export function langfuseStatusText(state: LangfuseState | null, enabled: boolean): string {
  if (state === null) return '正在读取…'
  if (!enabled) return state.active ? '已关闭，重启应用后停止' : '已关闭'
  if (langfuseConfigured(state)) return state.active ? '已开启' : '已配置，重启应用后开启'
  return state.active ? '本次运行已开启，重启应用后停止' : '未开启（缺地址或密钥）'
}

/**
 * 「记忆」栏的语义召回状态行（round 28）：同一套纪律——`enabled` 是用户现在的选择，
 * `active` 是本次运行的事实（装配只在启动时做一次），两者不一致时由**设置值**说话，
 * 一致时用服务端那句现成人话（`detail`：已开启（本地模型）/ 正在准备 / 不可用的原因）。
 */
export function recallStatusText(recall: RecallStatus | null, enabled: boolean): string {
  if (recall === null) return '正在读取…'
  if (recall.active && !enabled) return '本次运行已开启，重启应用后停止'
  if (!recall.active && !enabled) return '未开启'
  return recall.detail
}
