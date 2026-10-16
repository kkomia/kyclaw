/**
 * frontmatter 的字段列表（懒加载分块：YAML 解析器不进启动包）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/markdown/frontmatter-fields.tsx` 的渲染那半
 * （解析在 `frontmatter-parse.ts`）：YAML 非法或顶层不是映射时，整块原文兜底（由调用方把 verbatim 元素传进来）。
 *
 * 与上游一致的做法：这个模块由 `markdown-body.tsx` 用 `React.lazy` 懒加载，解析器（yaml）跟着单独一块；
 * 加载失败就继续显示原文块，正文照常可读。
 */
import { useMemo, type ReactNode } from 'react'
import { parseFrontmatterFields } from './frontmatter-parse'
import './dsh-media.css'

/**
 * frontmatter 字段列表。
 * @param props `source` 是原文；`fallback` 是非法/非映射时显示的原文块。
 * @returns 字段表、原文块，或什么都没有（空块）。
 */
export function FrontmatterFields({
  source,
  fallback
}: {
  source: string
  fallback: ReactNode
}): ReactNode {
  const fields = useMemo(() => parseFrontmatterFields(source), [source])
  if (fields === undefined) return fallback
  if (fields.length === 0) return null
  return (
    <dl data-testid="dsh-frontmatter-fields" className="dsh-media-frontmatter-fields">
      {fields.map((field, index) => (
        <div key={index} className="dsh-media-frontmatter-field">
          <dt className="dsh-media-frontmatter-key">{field.key}</dt>
          <dd
            className={field.block ? 'dsh-media-frontmatter-block' : 'dsh-media-frontmatter-value'}
          >
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
