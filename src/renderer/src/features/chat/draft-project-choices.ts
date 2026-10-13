/**
 * 草稿会话的项目选择（round 64，`threadId → projectId | null`）。
 *
 * 给谁用：「选择项目」胶囊（ProjectChip）。**草稿**（服务端还不认识这个会话 id）阶段挑的项目
 * 不能立刻写映射 —— 那是"给服务端认识的东西记账"，草稿 id 记上去是悬空的；但界面又必须当场
 * 显示这份选择（胶囊文案、权限 chip、附件根都读 projects-store 的映射）。所以：
 *   - 挑中时往这里记一笔 + 本地补一份映射（见 ProjectChip.choose）；
 *   - 物化完成（sessions-store 的 threads 里出现它）那一刻，由 ProjectChip 的 effect 取走这一笔
 *     走正规通道（projects-store.assignSession）补写。
 *
 * 为什么单独一个模块（而不是放在 ProjectChip.tsx 里）：那份底账要比组件活得久 —— 挑完项目又切走
 * 会话、再切回来（组件按 activeId 重挂）时它还得在；另外 react-refresh 只允许组件文件导出组件。
 * 它同时是**本地映射的兜底**：projects-store 拉过一次服务端快照（refresh）会把"服务端还不知道的
 * 草稿归属"冲掉，取走那一刻仍以这里记的为准。
 */
const draftChoices = new Map<string, string | null>()

/** 记下这条草稿挑的项目（null = 明确选了「不使用文件夹」） */
export function rememberDraftProjectChoice(threadId: string, projectId: string | null): void {
  draftChoices.set(threadId, projectId)
}

/** 某条草稿记下的项目（undefined = 没记过；null = 明确选了「不使用文件夹」） */
export function draftProjectChoiceOf(threadId: string): string | null | undefined {
  return draftChoices.get(threadId)
}

/** 取走这一笔（物化完成、映射写出去了）——取走即不再留，不会重复写 */
export function takeDraftProjectChoice(threadId: string): string | null | undefined {
  const choice = draftChoices.get(threadId)
  if (choice !== undefined) draftChoices.delete(threadId)
  return choice
}

/** 测试用：回到初始状态（模块级 Map 不随 render 重置） */
export function resetDraftProjectChoices(): void {
  draftChoices.clear()
}
