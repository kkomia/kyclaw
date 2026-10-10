import { describe, expect, it } from 'vitest'
import { classifyToolCall, isWorkspaceFileTool } from '../classify'

/**
 * 工具分级（spec §5.2：只读默认放行 / 写类默认询问 / 移动·删除永远问）。
 * 分级只按工具名（T11/T12 的命名就是契约），未知名字保守地落在"写类"——写类是默认询问那一档，
 * 不会被静默放行；真正的放行口子是用户显式打开的动作（Full access / 永久允许 / MCP 只读标记）。
 *
 * 这个函数不认识设置：MCP 名字按末段分级只是**名字证据**（`mcp__shell__delete` 仍落危险档）；
 * "MCP 未标只读默认按写类询问"由 mastra/mcp.ts 的 createMcpClassify 叠加（标只读才 read）。
 */
describe('classifyToolCall：内置文件工具', () => {
  it('只读三件套（read / glob / grep）→ read', () => {
    expect(classifyToolCall('read')).toBe('read')
    expect(classifyToolCall('glob')).toBe('read')
    expect(classifyToolCall('grep')).toBe('read')
  })

  it('写类（write / edit）→ write', () => {
    expect(classifyToolCall('write')).toBe('write')
    expect(classifyToolCall('edit')).toBe('write')
  })

  it('移动 / 删除 → dangerous（永远默认问，Full access 也不放行）', () => {
    expect(classifyToolCall('delete')).toBe('dangerous')
    expect(classifyToolCall('move')).toBe('dangerous')
  })

  it('名字大小写与空白不影响分级', () => {
    expect(classifyToolCall('Read')).toBe('read')
    expect(classifyToolCall(' EDIT ')).toBe('write')
    expect(classifyToolCall('Delete')).toBe('dangerous')
  })
})

describe('classifyToolCall：MCP / 外部工具', () => {
  it('MCP 命名 mcp__<server>__<tool>：按最后一段分级（名字证据，叠加层再按只读标记收紧）', () => {
    expect(classifyToolCall('mcp__filesystem__read')).toBe('read')
    expect(classifyToolCall('mcp__shell__delete')).toBe('dangerous')
    expect(classifyToolCall('mcp__echo__echo')).toBe('write')
  })

  it('未知工具名 → write（默认询问；不是"未知就当只读放行"）', () => {
    expect(classifyToolCall('bash')).toBe('write')
    expect(classifyToolCall('')).toBe('write')
    expect(classifyToolCall('某些中文工具')).toBe('write')
  })
})

describe('isWorkspaceFileTool：内置工作区文件工具的身份（整名判定）', () => {
  it('五件套是；MCP 名一律不是（末段同名的 mcp__a__write 也不是）', () => {
    for (const name of ['read', 'glob', 'grep', 'write', 'edit', ' WRITE ']) {
      expect(isWorkspaceFileTool(name), name).toBe(true)
    }
    for (const name of ['mcp__a__write', 'mcp__a__edit', 'delete', 'move', 'bash', '']) {
      expect(isWorkspaceFileTool(name), name).toBe(false)
    }
  })
})

describe('classifyToolCall：签名与入参', () => {
  it('接受工具入参（T11/T12 会把入参一起传来），当前不影响分级', () => {
    expect(classifyToolCall('write', { path: 'a.txt', content: 'x' })).toBe('write')
    expect(classifyToolCall('read', { path: 'a.txt' })).toBe('read')
    expect(classifyToolCall('grep', undefined)).toBe('read')
  })

  it('三档取值就是这三个字面量（T11 的开关按它分支）', () => {
    const classes = new Set([
      classifyToolCall('read'),
      classifyToolCall('write'),
      classifyToolCall('delete'),
      classifyToolCall('whatever')
    ])
    expect([...classes].sort()).toEqual(['dangerous', 'read', 'write'])
  })
})
