import { describe, expect, it } from 'vitest'
import type { DocxCommandId, DocxSelectCommandId } from '@betteroffice/docx-react'
import {
  OFFICE_QAT_ITEMS,
  OFFICE_RIBBON_TABS,
  findOfficeRibbonTab,
  isOfficeRibbonCommand,
  isOfficeRibbonHostToggle,
  isOfficeRibbonSeparator,
  officeRibbonCommandKey,
  ribbonCommandsOfTab,
  type OfficeRibbonCommandItem,
  type OfficeRibbonTab
} from '../components/office-ribbon-model'

/**
 * 模型完整性护栏（A2-prep）。
 *
 * 白名单是**手工从 `@betteroffice/docx-react@0.4.3` 的 d.mts `DocxCommandArgs`（:561-645）
 * 抄下来的 48 个真实命令**，不运行时读包（隔离面/单测都不引内核）：
 *   - `satisfies readonly DocxCommandId[]` 让 TS 也校验这份白名单本身没过期；
 *   - 模型里出现白名单之外的 id（假入口）这里必红。
 */
const REAL_DOCX_COMMAND_IDS = [
  'undo',
  'redo',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'superscript',
  'subscript',
  'clearFormatting',
  'paragraphStyle',
  'fontFamily',
  'fontSize',
  'textColor',
  'highlightColor',
  'alignment',
  'lineSpacing',
  'bulletList',
  'numberedList',
  'indent',
  'outdent',
  'setLtr',
  'setRtl',
  'insertLink',
  'insertImage',
  'insertTable',
  'insertPageBreak',
  'insertSectionBreakNextPage',
  'insertSectionBreakContinuous',
  'insertTOC',
  'imageWrap',
  'imageTransform',
  'imageProperties',
  'tableAction',
  'pageSetup',
  'watermark',
  'editingMode',
  'reviewAccept',
  'reviewReject',
  'reviewPrevious',
  'reviewNext',
  'commentsSidebar',
  'open',
  'save',
  'print',
  'find',
  'replace',
  'reportIssue',
  'zoom'
] as const satisfies readonly DocxCommandId[]

/** d.mts:652 的 8 个选择器命令：select 类项只能从这 8 个里挑 */
const REAL_DOCX_SELECT_COMMAND_IDS = [
  'paragraphStyle',
  'fontFamily',
  'fontSize',
  'alignment',
  'lineSpacing',
  'imageWrap',
  'editingMode',
  'zoom'
] as const satisfies readonly DocxSelectCommandId[]

const EXPECTED_TAB_IDS = ['home', 'insert', 'layout', 'review', 'view'] as const

/** 明确不放进 v1 ribbon 的真实命令（原因见 a2-prep-report.md，不属于"漏项"） */
const DELIBERATELY_UNUSED_COMMAND_IDS = ['open', 'print', 'reportIssue'] as const

function allTabs(): readonly OfficeRibbonTab[] {
  return OFFICE_RIBBON_TABS
}

function allCommandItems(): readonly OfficeRibbonCommandItem[] {
  return allTabs().flatMap((tab) => ribbonCommandsOfTab(tab))
}

function allItemIds(): readonly string[] {
  return allTabs().flatMap((tab) =>
    tab.groups.flatMap((group) => group.items.map((item) => ('host' in item ? item.host : item.id)))
  )
}

describe('office-ribbon-model：5 个 tab 与分组结构', () => {
  it('恰好 5 个 tab（开始/插入/布局/审阅/视图），没有空的绘图/设计 tab', () => {
    expect(allTabs().map((tab) => tab.id)).toEqual([...EXPECTED_TAB_IDS])
    expect(allTabs().map((tab) => tab.label)).toEqual(['开始', '插入', '布局', '审阅', '视图'])
    // 不存在 fake tab（绘图/设计/文件…）
    for (const tab of allTabs()) {
      expect(['home', 'insert', 'layout', 'review', 'view']).toContain(tab.id)
    }
  })

  it('每个 tab 至少 2 个非空分组；组 id 在 tab 内唯一；组标签非空', () => {
    const tabIds = new Set<string>()
    for (const tab of allTabs()) {
      expect(tabIds.has(tab.id)).toBe(false)
      tabIds.add(tab.id)
      expect(tab.groups.length).toBeGreaterThanOrEqual(2)
      const groupIds = new Set<string>()
      for (const group of tab.groups) {
        expect(group.label.length).toBeGreaterThan(0)
        expect(group.items.length).toBeGreaterThan(0)
        expect(groupIds.has(group.id)).toBe(false)
        groupIds.add(group.id)
      }
    }
  })

  it('分隔线只出现在组内中间：不领首、不结尾、不连续', () => {
    for (const tab of allTabs()) {
      for (const group of tab.groups) {
        expect(isOfficeRibbonSeparator(group.items[0]!)).toBe(false)
        expect(isOfficeRibbonSeparator(group.items[group.items.length - 1]!)).toBe(false)
        group.items.forEach((item, index) => {
          if (!isOfficeRibbonSeparator(item)) return
          expect(index).toBeGreaterThan(0)
          expect(isOfficeRibbonSeparator(group.items[index - 1]!)).toBe(false)
        })
      }
    }
  })

  it('命令/图标/标签都不为空，testId 不重复', () => {
    const testIds = new Set<string>()
    for (const tab of allTabs()) {
      for (const group of tab.groups) {
        for (const item of group.items) {
          if (!isOfficeRibbonCommand(item)) continue
          expect(item.label.length).toBeGreaterThan(0)
          expect(item.icon.length).toBeGreaterThan(0)
          if (item.testId === undefined) continue
          expect(testIds.has(item.testId)).toBe(false)
          testIds.add(item.testId)
        }
      }
    }
  })
})

describe('office-ribbon-model：命令必须来自内核真实命令集（没有假入口）', () => {
  it('所有命令 id 都在 48 个真实命令白名单里', () => {
    const whitelist = new Set<string>(REAL_DOCX_COMMAND_IDS)
    for (const item of allCommandItems()) {
      expect(whitelist.has(item.id), `未知命令（假入口？）：${item.id}`).toBe(true)
    }
  })

  it('select 类项只使用 d.mts 的 8 个选择器命令；split 只给颜色命令；builtin 只给需要内核控件的项', () => {
    const selectIds = new Set<string>(REAL_DOCX_SELECT_COMMAND_IDS)
    const builtinControlIds = new Set(['insertTable', 'tableAction', 'imageTransform'])
    for (const item of allCommandItems()) {
      if (item.type === 'select') expect(selectIds.has(item.id)).toBe(true)
      if (item.type === 'split') expect(['textColor', 'highlightColor']).toContain(item.id)
      if (item.control === 'builtin') expect(builtinControlIds.has(item.id)).toBe(true)
    }
    // 需要参数/自带菜单的三项确实标了 builtin（否则 A2 会盲执行一次无参命令）
    for (const id of builtinControlIds) {
      expect(
        allCommandItems().some((item) => item.id === id && item.control === 'builtin'),
        id
      ).toBe(true)
    }
  })

  it('唯一性口径 = id + args：对齐 4 个变体合法，重复同参项会红', () => {
    const keys = allCommandItems().map(officeRibbonCommandKey)
    expect(new Set(keys).size).toBe(keys.length)
    // 对齐确实以 4 个不同参数出现
    const alignment = allCommandItems().filter((item) => item.id === 'alignment')
    expect(alignment).toHaveLength(4)
    expect(alignment.map((item) => officeRibbonCommandKey(item))).toEqual([
      'alignment:{"value":"left"}',
      'alignment:{"value":"center"}',
      'alignment:{"value":"right"}',
      'alignment:{"value":"both"}'
    ])
  })

  it('每个真实命令都有归属（ribbon / QAT / 明确不用），没有静默漏项', () => {
    const ribbonIds = new Set(allCommandItems().map((item) => item.id))
    const qatIds = new Set(
      OFFICE_QAT_ITEMS.filter((item) => item.type !== 'status').map((item) => item.id)
    )
    const accounted = new Set<string>([...ribbonIds, ...qatIds, ...DELIBERATELY_UNUSED_COMMAND_IDS])
    expect(accounted.size).toBe(REAL_DOCX_COMMAND_IDS.length)
    for (const id of REAL_DOCX_COMMAND_IDS) expect(accounted.has(id), `漏项：${id}`).toBe(true)
  })

  it('不出现剪贴板/绘图/字数统计等内核没有的假能力', () => {
    const forbidden = new Set(['copy', 'cut', 'paste', 'printPreview', 'wordCount', 'draw', 'ink'])
    for (const id of allItemIds()) expect(forbidden.has(id)).toBe(false)
  })
})

describe('office-ribbon-model：QAT / 视图宿主开关 / helper', () => {
  it('QAT = 保存/撤销/重做（真实命令）+ 自动保存状态占位', () => {
    expect(OFFICE_QAT_ITEMS.map((item) => item.id)).toEqual(['save', 'undo', 'redo', 'save-state'])
    expect(OFFICE_QAT_ITEMS.map((item) => item.type)).toEqual([
      'button',
      'button',
      'button',
      'status'
    ])
    const status = OFFICE_QAT_ITEMS.find((item) => item.type === 'status')
    expect(status?.label).toBe('已保存')
  })

  it('视图 tab 的标尺/大纲/页边距参考线是宿主开关（不是内核命令 id）', () => {
    const view = findOfficeRibbonTab('view')
    expect(view).toBeDefined()
    const display = view?.groups.find((group) => group.id === 'display')
    expect(display).toBeDefined()
    const hosts = (display?.items ?? []).filter(isOfficeRibbonHostToggle)
    expect(hosts.map((item) => item.host)).toEqual(['ruler', 'outline', 'margin-guides'])
    // 宿主开关不能和真实命令 id 撞名
    const commandIds = new Set<string>(REAL_DOCX_COMMAND_IDS)
    for (const host of hosts) expect(commandIds.has(host.host)).toBe(false)
  })

  it('helper：find / 展平 / 类型守卫 / key', () => {
    expect(findOfficeRibbonTab('home')?.label).toBe('开始')
    expect(findOfficeRibbonTab('view')?.label).toBe('视图')
    expect(findOfficeRibbonTab('home') === undefined).toBe(false)

    const home = findOfficeRibbonTab('home')
    expect(home).toBeDefined()
    const commands = ribbonCommandsOfTab(home!).map((item) => item.id)
    expect(commands).toContain('bold')
    expect(commands).toContain('fontFamily')
    expect(commands).not.toContain('undo') // undo/redo 在 QAT，不在 tab 里

    const separator = home!.groups[0]!.items.find(isOfficeRibbonSeparator)
    expect(separator).toBeUndefined() // 第一组没有分隔线
    const textGroup = home!.groups.find((group) => group.id === 'text')
    expect(textGroup?.items.some(isOfficeRibbonSeparator)).toBe(true)

    const bold: OfficeRibbonCommandItem = {
      type: 'toggle',
      id: 'bold',
      label: '加粗',
      icon: 'Bold'
    }
    expect(officeRibbonCommandKey(bold)).toBe('bold')
    expect(isOfficeRibbonCommand(bold)).toBe(true)
    expect(isOfficeRibbonHostToggle(bold)).toBe(false)
  })
})
