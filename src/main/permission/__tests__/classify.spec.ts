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
    expect(classifyToolCall('ask_user')).toBe('read')
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

  it('round28 能力类：bash / fetch 按写类；git 只读三件套 read、add / commit 写类', () => {
    expect(classifyToolCall('bash')).toBe('write')
    expect(classifyToolCall('fetch')).toBe('write')
    expect(classifyToolCall('git_status')).toBe('read')
    expect(classifyToolCall('git_diff')).toBe('read')
    expect(classifyToolCall('git_log')).toBe('read')
    expect(classifyToolCall('git_add')).toBe('write')
    expect(classifyToolCall('git_commit')).toBe('write')
    // 大小写与空白同样不敏感
    expect(classifyToolCall(' Bash ')).toBe('write')
    expect(classifyToolCall('Git_Commit')).toBe('write')
  })

  it('名字大小写与空白不影响分级', () => {
    expect(classifyToolCall('Read')).toBe('read')
    expect(classifyToolCall(' EDIT ')).toBe('write')
    expect(classifyToolCall('Delete')).toBe('dangerous')
  })

  it('模块 4 产出物 + 增量编辑四件（edit_ppt / edit_docx / edit_excel）→ write（默认问；不是"未知名字碰巧落在 write"）', () => {
    for (const name of [
      'create_report',
      'create_pdf',
      'create_excel',
      // edit_excel 与 create_excel 同理（就地改已有的一份 .xlsx）
      'edit_excel',
      'create_ppt',
      'create_docx',
      // round 76：edit_ppt 是"就地改已有的一份 .pptx"，与 create_ppt 同档
      'edit_ppt',
      // edit_docx 与 create_docx 同理（就地改已有的一份 .docx）
      'edit_docx'
    ]) {
      expect(classifyToolCall(name), name).toBe('write')
    }
    // 大小写与空白同样不敏感（与既有表项同口径）
    expect(classifyToolCall(' Edit_Excel ')).toBe('write')
  })

  it('round 45 联网搜索：web_search 与 fetch 同档（write = 默认问那一档）', () => {
    expect(classifyToolCall('web_search')).toBe('write')
    expect(classifyToolCall('web_search')).toBe(classifyToolCall('fetch'))
    // 大小写与空白同样不敏感（与既有表项同口径）
    expect(classifyToolCall(' Web_Search ')).toBe('write')
  })

  /**
   * round 68 修订：render_ppt 是**派生只读产物**（把已有 deck 逐页导成页图给模型看），
   * 写入只落在 `<deck 名>_页图/`，所以按只读档免审 —— 非 full 工作区里每次自检都弹卡，
   * 拦下的收益远小于代价。免审的前提由 render-ppt 的越界拒绝撑着（见那个工具的用例）。
   */
  it('render_ppt（派生只读产物）→ read；不再属于"按写类判审批"的那张表', () => {
    expect(classifyToolCall('render_ppt')).toBe('read')
    expect(classifyToolCall(' Render_Ppt ')).toBe('read')
    expect(isWorkspaceFileTool('render_ppt')).toBe(false)
  })
})

describe('classifyToolCall：MCP / 外部工具', () => {
  it('MCP 命名 mcp__<server>__<tool>：按最后一段分级（名字证据，叠加层再按只读标记收紧）', () => {
    expect(classifyToolCall('mcp__filesystem__read')).toBe('read')
    expect(classifyToolCall('mcp__shell__delete')).toBe('dangerous')
    expect(classifyToolCall('mcp__echo__echo')).toBe('write')
    // round28 表项也按末段进"名字证据"（`mcp__x__bash` 仍只是 write 档）
    expect(classifyToolCall('mcp__x__bash')).toBe('write')
    expect(classifyToolCall('mcp__x__git_add')).toBe('write')
    // round45 的 web_search 同理：MCP 里的同名工具只借"名字证据"，审批走外部工具那一档
    expect(classifyToolCall('mcp__x__web_search')).toBe('write')
  })

  it('未知工具名 → write（默认询问；不是"未知就当只读放行"）', () => {
    expect(classifyToolCall('unknown_tool')).toBe('write')
    expect(classifyToolCall('')).toBe('write')
    expect(classifyToolCall('某些中文工具')).toBe('write')
  })
})

describe('isWorkspaceFileTool：内置工作区文件工具的身份（整名判定）', () => {
  it('五件套 + 产出物 + 增量编辑三件（edit_ppt / edit_docx / edit_excel）是；MCP 名一律不是（末段同名的 mcp__a__write 也不是）', () => {
    for (const name of [
      'read',
      'glob',
      'grep',
      'write',
      'edit',
      ' WRITE ',
      // 模块 4：产出物只写 guard 解析出来的那个路径，执行同样 fail closed → 与五件套同档
      'create_report',
      'create_pdf',
      'create_excel',
      'create_ppt',
      'create_docx',
      // edit_excel 与 create_excel 同一个引擎（artifactTarget 先解析再改），同类
      'edit_excel',
      // round 76：edit_ppt 与 create_ppt 同一个引擎（artifactTarget 先解析再改），同类
      'edit_ppt',
      // edit_docx 与 create_docx 同一个引擎，同类
      'edit_docx'
    ]) {
      expect(isWorkspaceFileTool(name), name).toBe(true)
    }
    for (const name of [
      'mcp__a__write',
      'mcp__a__edit',
      'mcp__a__create_report',
      'delete',
      'move',
      'bash',
      'fetch',
      'web_search',
      'git_add',
      // round 68 修订：render_ppt 按只读档免审，不再靠这张表判审批（见上面那组用例）
      'render_ppt',
      ''
    ]) {
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
