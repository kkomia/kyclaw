/**
 * PB-016 / CR-24 的打包 wasm 闸门单测（**纯函数**：只喂 asar 路径清单，不碰打包件、不起 Electron、不联网）。
 *
 * 为什么放在 `src/main/__tests__` 而不是 `e2e/`：
 *   · `e2e/` 是 Playwright 的 `testDir`（那里放 `*.spec.ts` 会被 `pnpm test:e2e` 当浏览器用例跑）；
 *   · vitest 的 include 只有 `src/**`（见 `vitest.config.ts` 的 `ALL_SPECS`）。
 * 被测对象是 `e2e/fixtures/packaged-preview.ts` 里的纯函数，跨目录 import——与
 * `release-notes-scripts.spec.ts` 测 `scripts/package.mjs` 是同一先例。
 *
 * 覆盖（R2-03 要求 + R2-06 两个洞）：
 *   真实 11 个基线 / 缺 1 个依赖 / 依赖全缺 / Office 少一个 / Office 多一个 / 两类同时坏 /
 *   `.pnpm` 深路径不误报 / **同名 basename 在别的包下不得满足闸门**（R2-06①）/
 *   **依赖 wasm 混进 `out/renderer` 不把 Office 计数顶成 7**（R2-06②）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEPENDENCY_WASM_BASELINE,
  OFFICE_WASM_COUNT,
  wasmGateProblems
} from '../../../e2e/fixtures/packaged-preview'

/** PB-016 before 实测的那 6 个 Office wasm（名字带内容 hash，闸门只数个数） */
const OFFICE_WASM = [
  'out/renderer/assets/docx_edit_bg-D7N4HOOt.wasm',
  'out/renderer/assets/docx_layout_bg-DU7PnfGq.wasm',
  'out/renderer/assets/docx_parse_bg-C4cA19mh.wasm',
  'out/renderer/assets/ooxml_opc_bg-BBWy9-mN.wasm',
  'out/renderer/assets/pptx_wasm_bg-qh_XpSnz.wasm',
  'out/renderer/assets/xlsx_wasm_bg-B4N7ROAd.wasm'
]

/** 依赖自带 5 个（hoisted 布局：`node_modules/<包>/…`） */
const PDFJS_WASM = [
  'node_modules/pdfjs-dist/wasm/jbig2.wasm',
  'node_modules/pdfjs-dist/wasm/openjpeg.wasm',
  'node_modules/pdfjs-dist/wasm/qcms_bg.wasm',
  'node_modules/pdfjs-dist/wasm/quickjs-eval.wasm'
]
const XXHASH_WASM = 'node_modules/xxhash-wasm/workerd/xxhash.wasm'

/** PB-016 实测的真实基线：6 Office + 5 依赖 = 11 个 wasm */
const REAL_BASELINE = [...OFFICE_WASM, ...PDFJS_WASM, XXHASH_WASM]

/** 断言 helper：把问题清单拍平成一段文本，好按子串查 */
function joined(problems: readonly string[]): string {
  return problems.join('\n')
}

describe('wasmGateProblems（PB-016 / CR-24 打包 wasm 闸门）', () => {
  it('基线自身是 6 个 Office + 5 个依赖（改基线必须同步改这份单测）', () => {
    expect(OFFICE_WASM_COUNT).toBe(6)
    expect(DEPENDENCY_WASM_BASELINE.map((item) => item.name)).toEqual([
      'quickjs-eval.wasm',
      'openjpeg.wasm',
      'jbig2.wasm',
      'qcms_bg.wasm',
      'xxhash.wasm'
    ])
    expect(DEPENDENCY_WASM_BASELINE.every((item) => item.packageName !== '')).toBe(true)
  })

  it('真实 11 个基线 → 过', () => {
    expect(wasmGateProblems(REAL_BASELINE)).toEqual([])
  })

  it('缺 1 个依赖 wasm（openjpeg）→ 只报一条，点名期望路径模式', () => {
    const problems = wasmGateProblems(REAL_BASELINE.filter((path) => !path.endsWith('/openjpeg.wasm')))
    expect(problems).toHaveLength(1)
    expect(joined(problems)).toContain('openjpeg.wasm')
    expect(joined(problems)).toContain('node_modules/pdfjs-dist/**/openjpeg.wasm')
    // 其余 4 个依赖不该被牵连
    expect(joined(problems)).not.toContain('jbig2.wasm')
    expect(joined(problems)).not.toContain('xxhash.wasm')
  })

  it('5 个依赖全缺 → 一条问题里点名 5 个（含期望路径）', () => {
    const problems = wasmGateProblems(OFFICE_WASM)
    expect(problems).toHaveLength(1)
    for (const name of ['quickjs-eval.wasm', 'openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm', 'xxhash.wasm']) {
      expect(joined(problems)).toContain(name)
    }
    expect(joined(problems)).toContain('node_modules/pdfjs-dist/**/quickjs-eval.wasm')
    expect(joined(problems)).toContain('node_modules/xxhash-wasm/**/xxhash.wasm')
  })

  it('Office wasm 少一个（5 个）→ 数量闸门红', () => {
    const problems = wasmGateProblems([...OFFICE_WASM.slice(0, 5), ...PDFJS_WASM, XXHASH_WASM])
    expect(problems).toHaveLength(1)
    expect(joined(problems)).toContain('Office wasm 数量是 5，期望 6')
  })

  it('Office wasm 多一个（7 个）→ 数量闸门红', () => {
    const problems = wasmGateProblems([
      ...OFFICE_WASM,
      'out/renderer/assets/extra-SURPRISE.wasm',
      ...PDFJS_WASM,
      XXHASH_WASM
    ])
    expect(problems).toHaveLength(1)
    expect(joined(problems)).toContain('Office wasm 数量是 7，期望 6')
  })

  it('Office 少一个 + 依赖缺一个 → 两条问题都报，不互相遮蔽', () => {
    const problems = wasmGateProblems([...OFFICE_WASM.slice(0, 5), ...PDFJS_WASM])
    expect(problems).toHaveLength(2)
    expect(joined(problems)).toContain('Office wasm 数量是 5，期望 6')
    expect(joined(problems)).toContain('xxhash.wasm')
  })

  it('pnpm 深路径（.pnpm/<包>@<版本>/node_modules/<包>/**）→ 过，不误报', () => {
    const deepPaths = [
      ...OFFICE_WASM,
      'node_modules/.pnpm/pdfjs-dist@5.0.0/node_modules/pdfjs-dist/wasm/jbig2.wasm',
      'node_modules/.pnpm/pdfjs-dist@5.0.0/node_modules/pdfjs-dist/wasm/openjpeg.wasm',
      'node_modules/.pnpm/pdfjs-dist@5.0.0/node_modules/pdfjs-dist/wasm/qcms_bg.wasm',
      'node_modules/.pnpm/pdfjs-dist@5.0.0/node_modules/pdfjs-dist/wasm/quickjs-eval.wasm',
      'node_modules/.pnpm/xxhash-wasm@1.0.2/node_modules/xxhash-wasm/workerd/xxhash.wasm'
    ]
    expect(wasmGateProblems(deepPaths)).toEqual([])
  })

  it('同名 basename 在别的包下 → 不算命中（R2-06① 重名洞）', () => {
    const problems = wasmGateProblems([
      ...OFFICE_WASM,
      ...PDFJS_WASM.filter((path) => !path.endsWith('/openjpeg.wasm')),
      'node_modules/some-other-dep/wasm/openjpeg.wasm',
      XXHASH_WASM
    ])
    expect(problems).toHaveLength(1)
    expect(joined(problems)).toContain('node_modules/pdfjs-dist/**/openjpeg.wasm')
    // 失败信息要给出"实际找到的同名文件在哪"
    expect(joined(problems)).toContain('实际找到同名文件：node_modules/some-other-dep/wasm/openjpeg.wasm')
  })

  it('依赖 wasm 被收进 out/renderer（node_modules 里仍在）→ 不把 Office 计数顶成 7（R2-06②）', () => {
    const problems = wasmGateProblems([
      ...REAL_BASELINE,
      'out/renderer/assets/openjpeg.wasm',
      'out/renderer/assets/qcms_bg.wasm'
    ])
    expect(problems).toEqual([])
  })

  it('依赖 wasm 只出现在 out/renderer（node_modules 没有）→ 依赖侧报缺、Office 计数仍 6', () => {
    const problems = wasmGateProblems([
      ...OFFICE_WASM,
      ...PDFJS_WASM.filter((path) => !path.endsWith('/jbig2.wasm')),
      'out/renderer/assets/jbig2.wasm',
      XXHASH_WASM
    ])
    expect(problems).toHaveLength(1)
    const text = joined(problems)
    expect(text).toContain('node_modules/pdfjs-dist/**/jbig2.wasm')
    expect(text).toContain('out/renderer/assets/jbig2.wasm')
    // 关键：没有"Office wasm 数量是 7"这条误报
    expect(text).not.toContain('数量是 7')
  })

  it('hoisted 的 xxhash 直接在包根下（node_modules/xxhash-wasm/xxhash.wasm）→ 也算命中', () => {
    const problems = wasmGateProblems([
      ...OFFICE_WASM,
      ...PDFJS_WASM,
      'node_modules/xxhash-wasm/xxhash.wasm'
    ])
    expect(problems).toEqual([])
  })
})
