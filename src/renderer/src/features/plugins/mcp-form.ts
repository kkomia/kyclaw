import { textToArgs } from '@shared/mcp'
import type { McpServerConfig } from '@shared/settings'

/**
 * MCP 表单的纯逻辑（round 9；组件在 McpKeyValueEditor.tsx / 各对话框里）：
 * 键值表（headers / env）在表单里是**行**（可增删、允许空行），落盘时才是 record。
 * 空行在保存时丢弃（brief 定案）——全空 = 这个字段不写（undefined），不是空对象。
 */
export interface KeyValueRow {
  name: string
  value: string
}

export function recordToRows(record?: Record<string, string>): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))
}

export function rowsToRecord(rows: readonly KeyValueRow[]): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (name === '') continue
    record[name] = row.value
  }
  return Object.keys(record).length === 0 ? undefined : record
}

/**
 * 「＋新增」对话框的表单态：两种 transport 的字段**同时存在**（切换类型不丢已填内容），
 * 保存时只把当前 transport 的字段写进配置（brief：切换时保留各自字段、清另一类）。
 */
export interface McpAddForm {
  name: string
  transport: 'stdio' | 'http'
  command: string
  argsText: string
  url: string
  headers: KeyValueRow[]
  env: KeyValueRow[]
}

export function blankAddForm(transport: 'stdio' | 'http'): McpAddForm {
  return {
    name: transport === 'stdio' ? '新服务' : '新 HTTP 服务',
    transport,
    command: '',
    argsText: '',
    url: '',
    headers: [],
    env: []
  }
}

/** 表单 → 一条待保存的配置（`base` 管 id 与默认值，这里覆盖用户填的部分） */
export function addFormToConfig(base: McpServerConfig, form: McpAddForm): McpServerConfig {
  if (form.transport === 'stdio') {
    return {
      ...base,
      name: form.name.trim(),
      transport: 'stdio',
      command: form.command.trim(),
      args: textToArgs(form.argsText),
      env: rowsToRecord(form.env)
    }
  }
  return {
    ...base,
    name: form.name.trim(),
    transport: 'http',
    url: form.url.trim(),
    headers: rowsToRecord(form.headers)
  }
}
