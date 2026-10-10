import { Plus } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '../../components/ui/button'

/**
 * 侧栏「新建会话」块按钮（附录 A：224 × 41）：
 * 224 = 侧栏 240 − 左右内边距 8×2，所以按钮本身 w-full、外层给 p-2；
 * 41 是实测值，覆盖 Button 的高度档（--new-session-height）。
 * 底与文字按实测取 --field-bg + 墨色（深 #1f1f1f 底 / #dbdbdb 字 = Bg-Secondary + Labels-Primary）。
 * 本任务的最简语义是"回到对话页"，真实新建由 T9 接上。
 */
export function NewSessionButton(): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <div className="shrink-0 p-2">
      <Button
        data-testid="new-session"
        variant="ghost"
        icon={<Plus />}
        className="h-(--new-session-height) w-full border border-hairline bg-(--field-bg)"
        onClick={() => navigate('/chat')}
      >
        新建会话
      </Button>
    </div>
  )
}
