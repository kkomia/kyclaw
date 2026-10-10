import { useState } from 'react'
import { useNavigate } from 'react-router'
import { navItemClass } from '../../components/shell/nav-item'

interface MockSession {
  id: string
  title: string
}

/**
 * mock 会话（本任务只搭骨架）：T9 换真实数据 —— 分组 今天/更早、重命名、删除、回灌历史。
 * 选中态先放在本地 state 里只为对上"选中底 Fills-F2"的口径，不代表真实会话状态。
 */
const MOCK_SESSIONS: MockSession[] = [
  { id: 'mock-1', title: '电源管理方案调研' },
  { id: 'mock-2', title: '周报与下周计划' },
  { id: 'mock-3', title: '把预算表换成看板' }
]

export function SessionList(): React.JSX.Element {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(MOCK_SESSIONS[0]?.id ?? null)

  return (
    <ul
      data-testid="session-list"
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
    >
      {MOCK_SESSIONS.map((session) => {
        const selected = session.id === selectedId

        return (
          <li key={session.id}>
            <button
              type="button"
              data-testid={`session-item-${session.id}`}
              aria-current={selected ? 'true' : undefined}
              className={navItemClass({ selected })}
              onClick={() => {
                setSelectedId(session.id)
                navigate('/chat')
              }}
            >
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
