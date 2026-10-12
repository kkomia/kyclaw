/**
 * 预览选区的自绘右键菜单（round 42 只是「文件」工具的内联预览，这里抽成共享件，
 * 预览标签（PreviewTool）跟着走同一条 —— 两条路的菜单形态与发布口径逐字一致）。
 *
 * 三件事：
 *   - **原生右键一律拦掉**（整个包进来的区域，不只是选中文字那一小块）：`display:contents` 的包装层
 *     不进布局、不叠框线，只做事件拦截；
 *   - 有选区：[添加到上下文（摘选）/ 复制 / 全选]；没有：[全选]（最小集合，不摆点了没用的项）；
 *   - 摘选只报「哪个会话的哪个文件 / 哪段文字 / 在源文里的行号区间」——位置在**源文在手**的这一侧
 *     算好（订阅方只看得到选中的文字本身；口径见 composer-inbox.ts 的 linesOfSelection）。
 *
 * 「全选」选哪块内容：默认是包装层自己的子树；调用方的内容不都在这一层里时（内联预览的
 * BottomSheet 里还挂着标题条）用 `bodyRef` 指到真正的预览体上 —— 选中范围与 round 42 一致。
 */
import { Copy, MessageSquarePlus, TextSelect } from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react'
import { linesOfSelection, publishContextItem } from '@renderer/features/chat/composer-inbox'
import { ContextMenu, type ContextMenuState, type ContextMenuItem } from '../ContextMenu'
import { baseNameOf } from './fetch'

export function SelectionContextMenu({
  threadId,
  relative,
  sourceText,
  bodyRef,
  children
}: {
  /** 发布的会话（null = 没有会话：事件挂不到任何输入卡上，与既有口径一致 —— 不发布） */
  threadId: string | null
  /** 这份预览的文件（工作区相对路径；摘选载荷里的路径就是它） */
  relative: string
  /** 源文（算行号用）；字节通道 / 拿不到源文时 null —— 位置就省略，不瞎编 */
  sourceText: string | null
  /** 「全选」的目标；不传 = 组件自己这层包装（内容全在里面时够用） */
  bodyRef?: RefObject<HTMLDivElement | null>
  children: ReactNode
}): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const ownRef = useRef<HTMLDivElement>(null)

  /** 把选中的那段交给输入卡（名称带「摘选」，与整份文件区分开；位置见头注） */
  const addSelectionToContext = useCallback(
    (text: string): void => {
      if (threadId === null) return
      const lines = sourceText === null ? null : linesOfSelection(sourceText, text)
      publishContextItem({
        source: 'selection',
        threadId,
        relative,
        name: `${baseNameOf(relative)} 摘选`,
        text,
        ...(lines === null ? {} : { lines })
      })
    },
    [relative, sourceText, threadId]
  )

  /** 「全选」：把预览体的内容整体选上（选中后右键就是"有选区"那一档菜单） */
  const selectAll = useCallback((): void => {
    const node = bodyRef?.current ?? ownRef.current
    const selection = window.getSelection()
    if (node === null || selection === null) return
    const range = document.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [bodyRef])

  /**
   * 预览区的右键 = 自绘菜单（雷点 4：原生菜单一律拦掉——整块预览区都拦，不只是选中文字那一小块）。
   * 有选区：[添加到上下文（摘选）/ 复制 / 全选]；没有：[全选]（最小集合，不摆点了没用的项）。
   */
  const onContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    const selected = window.getSelection()?.toString() ?? ''
    const items: ContextMenuItem[] = []
    if (selected.trim() !== '') {
      items.push({
        id: 'context',
        label: '添加到上下文（摘选）',
        icon: <MessageSquarePlus />,
        onSelect: () => addSelectionToContext(selected)
      })
      items.push({
        id: 'copy',
        label: '复制',
        icon: <Copy />,
        onSelect: () => {
          void navigator.clipboard?.writeText(selected)
        }
      })
    }
    items.push({
      id: 'select-all',
      label: '全选',
      icon: <TextSelect />,
      onSelect: selectAll
    })
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  return (
    <>
      <div ref={ownRef} className="contents" onContextMenu={onContextMenu}>
        {children}
      </div>
      {menu === null ? null : <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
