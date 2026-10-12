/**
 * 工作台四工具共用的"操作对象"：**当前会话的会话根**。
 *
 * 两件事分开：
 *   1. 这里是**纯展示口径的镜像**（`sessionWorkspaceOf`，与 sessionRoots 同序：项目 → 默认工作区
 *      → 唯一授权目录）—— 只用来判"这个会话有没有唯一的工作区"，以及显示目录名；
 *   2. 真正的路径解析与 containment 在主进程（workbench:* 通道收 threadId + 相对路径）。
 *      渲染端算出来的绝对路径只用来拼"复制路径"的显示文本，不参与任何访问判定。
 *
 * 判不出唯一根（没有工作区 / 多条并列）时 `notice` 给一句人话，四工具一起显示空态
 * —— 与输入框 `@` 的口径一致（那边也是判不出就拒绝）。
 *
 * round 49：渲染端的映射是**乐观**的（本地先补、PUT 在飞），主进程却要等回执才认。`settling`
 * 就是这段窗口（本会话的归属还在写）：按根开工的三件（文件树 / Git / 终端）据此**推迟第一次请求**，
 * 免得按主进程还没换过来的兜底根先列一次目录 / 起一个 cwd 在别处的 shell（用户实报：切换对话后
 * 文件区路径没刷新 —— 树列的是兜底工作区，而之后不会再重列）。
 */
import { useCallback } from 'react'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { KyclawWorkbenchApi, KyclawTerminalApi } from '@shared/ipc'
import { folderNameOf, sessionWorkspaceOf } from '@renderer/features/chat/session-workspace'

export interface WorkbenchRoot {
  /** 当前会话 id（草稿也算；null = 还没载入出会话） */
  threadId: string | null
  /** 会话根的绝对路径（无 = 判不出） */
  rootPath: string | null
  /** 目录名（标题栏显示用） */
  rootName: string | null
  /** 工具能不能开工（通道在 + 会话在 + 根唯一） */
  ready: boolean
  /**
   * 这个会话的项目归属还在写（本地已经画出来了、服务端还没回执）。
   *
   * `rootPath` 是渲染端的乐观口径；真正碰盘子的根由主进程按服务端映射解析 —— 回执落地之前
   * 主进程还会给出**兜底根**（默认工作区 / 唯一授权目录）。按根开工的工具要在 `settling` 为真时
   * 先不动手（列出来的目录 / 起来的 shell cwd 都是那个兜底根，而且不会再重来一次）。
   */
  settling: boolean
  /** 不能开工的原因（人话；能开工时 null） */
  notice: string | null
  workbench: KyclawWorkbenchApi | null
  terminal: KyclawTerminalApi | null
}

export function useWorkbenchRoot(): WorkbenchRoot {
  const threadId = useSessionsStore((state) => state.activeId)
  const settings = useSettingsStore((state) => state.settings)
  // **响应式订阅 mappings**，不要只选 store 上的 projectOf 函数：函数引用恒定，mappings 变了
  // （「移至项目」/ 映射快照迟到）组件不重渲染 → 树停在旧根，而主进程已按新根解析 →
  // 点文件夹报"这个文件夹不在磁盘上了"（用户实报，回归测试见 workbench-root.spec.tsx）。
  const mappings = useProjectsStore((state) => state.mappings)
  // 同理订阅 pending：它决定"主进程此刻认不认这条映射"，也是要跟着重渲染的
  const pending = useProjectsStore((state) => state.pending)
  const projectOf = useCallback(
    (id: string | null): string | null => (id === null ? null : (mappings[id] ?? null)),
    [mappings]
  )

  const workspace = sessionWorkspaceOf({ threadId, settings, projectOf })
  const workbench = window.kyclaw?.workbench ?? null
  const terminal = window.kyclaw?.terminal ?? null

  const rootPath = workspace?.path ?? null
  const settling = threadId !== null && pending[threadId] === true
  const notice =
    workbench === null
      ? '工作台通道不可用（window.kyclaw 缺失）'
      : threadId === null
        ? '当前没有会话：开始对话后工作台会跟着这个会话的工作区'
        : rootPath === null
          ? '判不出这个会话的工作区：在设置里添加一个文件夹，或指认默认工作区'
          : null

  return {
    threadId,
    rootPath,
    rootName: rootPath === null ? null : folderNameOf(rootPath),
    ready: notice === null && threadId !== null && rootPath !== null,
    settling,
    notice,
    workbench,
    terminal
  }
}

/** 相对路径 → 绝对路径（只为显示/复制，不参与访问判定；Windows 用反斜杠） */
export function absoluteOf(rootPath: string, relative: string): string {
  if (relative === '') return rootPath
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${relative.replace(/\//g, separator)}`
}
