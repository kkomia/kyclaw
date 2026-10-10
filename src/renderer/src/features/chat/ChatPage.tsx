import { PagePlaceholder } from '../../components/shell/PagePlaceholder'

/** 对话页（本任务只给骨架）：消息流、输入区、工具卡由 T7 接入。 */
export function ChatPage(): React.JSX.Element {
  return <PagePlaceholder testId="chat-page" title="对话" note="消息流与输入区将在后续里程碑接入" />
}
