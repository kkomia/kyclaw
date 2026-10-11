import { Plus, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Input } from '@renderer/components/ui/input'
import type { KeyValueRow } from './mcp-form'

/**
 * 键值行编辑器（round 9，MCP 表单共用）：一行 = [名称][值][×]，下面一枚「添加」。
 * 受控组件（行由调用方持有）；允许空行，空行在保存时由 `rowsToRecord` 丢弃。
 * HTTP 的 Headers 与 stdio 的环境变量复用同一份（brief：复用同一组件）。
 */
export interface McpKeyValueEditorProps {
  rows: readonly KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  /** testid 前缀：行 `-row-<i>`、名/值 `-name-<i>` / `-value-<i>`、删除 `-remove-<i>`、添加 `-add` */
  testIdPrefix: string
  namePlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
}

export function McpKeyValueEditor({
  rows,
  onChange,
  testIdPrefix,
  namePlaceholder = '名称',
  valuePlaceholder = '值',
  addLabel = '添加'
}: McpKeyValueEditorProps): React.JSX.Element {
  const patchRow = (index: number, patch: Partial<KeyValueRow>): void => {
    onChange(rows.map((row, current) => (current === index ? { ...row, ...patch } : row)))
  }

  return (
    <div data-testid={testIdPrefix} className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div
          key={index}
          data-testid={`${testIdPrefix}-row-${index}`}
          className="flex items-center gap-2"
        >
          <Input
            data-testid={`${testIdPrefix}-name-${index}`}
            aria-label={namePlaceholder}
            className="flex-1"
            value={row.name}
            placeholder={namePlaceholder}
            onChange={(event) => patchRow(index, { name: event.target.value })}
          />
          <Input
            data-testid={`${testIdPrefix}-value-${index}`}
            aria-label={valuePlaceholder}
            className="flex-1"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(event) => patchRow(index, { value: event.target.value })}
          />
          <IconButton
            data-testid={`${testIdPrefix}-remove-${index}`}
            label="删除这一行"
            icon={<X />}
            className="border-transparent hover:bg-hover"
            onClick={() => onChange(rows.filter((_, current) => current !== index))}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        data-testid={`${testIdPrefix}-add`}
        icon={<Plus />}
        className="self-start"
        onClick={() => onChange([...rows, { name: '', value: '' }])}
      >
        {addLabel}
      </Button>
    </div>
  )
}
