/**
 * 路由页懒加载的占位（P1 包体优化）：页面 chunk 在路上时，壳/侧栏保持不动，只在内容区
 * 居中一圈 spinner —— 与各页面自己的「加载中」同观感（Spinner + 页面底色），不闪白。
 *
 * testid 供懒加载契约测试/探针断言；`Spinner` 自带 role=status + “加载中”语义。
 */
import { Spinner } from '../ui/spinner'

export function RouteFallback(): React.JSX.Element {
  return (
    <div data-testid="route-loading" className="flex min-h-0 flex-1 items-center justify-center">
      <Spinner label="页面加载中" className="text-ink-tertiary" />
    </div>
  )
}
