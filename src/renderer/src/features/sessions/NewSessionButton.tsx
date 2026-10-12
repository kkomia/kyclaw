import { Plus } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '../../components/ui/button'

/**
 * 侧栏「新建会话」块按钮（附录 A：224 × 41）：
 * 224 = 侧栏 240 − 左右内边距 8×2，所以按钮本身 w-full、外层给 p-2；
 * 41 是实测值，覆盖 Button 的高度档（--new-session-height）。
 * 底与文字按实测取 --field-bg + 墨色（深 #1f1f1f 底 / #dbdbdb 字 = Bg-Secondary + Labels-Primary）。
 * T9：点击 = 开一个新草稿（onNew，由 SessionsController 接 store）并回到对话页；
 * 草稿在第一轮发消息时才在服务端落成真线程。
 * round 55：全局新建 = **无项目草稿**（不继承"最后浏览的项目"，根走默认工作区下的会话子目录）；
 * 要归属项目只有项目行的 ⊕ 那一条路 —— 这个按钮不带项目参数。
 */
export interface NewSessionButtonProps {
  onNew?: () => void
}

export function NewSessionButton({ onNew }: NewSessionButtonProps): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <div className="shrink-0 p-2">
      <Button
        data-testid="new-session"
        variant="ghost"
        icon={<Plus />}
        className="h-(--new-session-height) w-full border border-hairline bg-(--field-bg)"
        onClick={() => {
          onNew?.()
          navigate('/chat')
        }}
      >
        新建会话
      </Button>
    </div>
  )
}
