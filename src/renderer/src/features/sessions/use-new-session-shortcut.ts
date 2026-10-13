import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { matchNewSessionShortcut } from './session-shortcuts'
import { useSessionsStore } from './sessions-store'

/**
 * 全局「新建会话」快捷键（Ctrl+K / Cmd+K）：等价于点侧栏顶部那个「新建会话」按钮 ——
 * `startNew()` 开一个**无项目草稿**（round 55 口径：不继承"最后浏览的项目"）+ 回对话页。
 *
 * 挂在 window 上（工作台的 Ctrl+T/E/G 同一写法，见 Workbench），所以**设置页/插件页也生效**；
 * Ctrl+K 在输入框里没有默认编辑行为，textarea 里按同样是新建会话（事件照常冒泡到 window）。
 * 命中就吞掉事件：Windows 上不留给别的默认动作。
 *
 * 挂载点是 AppShell（壳常驻、与当前路由无关），不在 SessionsController 上 ——
 * 那个只在会话视图里渲染，设置页就没有它了。
 */
export function useNewSessionShortcut(): void {
  const startNew = useSessionsStore((state) => state.startNew)
  const navigate = useNavigate()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 别人先认领了这一下（输入框/菜单里更贴切的 Ctrl+K，比如以后往编辑器里插链接）就别抢
      if (event.defaultPrevented) return
      if (!matchNewSessionShortcut(event)) return
      event.preventDefault()
      startNew()
      navigate('/chat')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [startNew, navigate])
}
