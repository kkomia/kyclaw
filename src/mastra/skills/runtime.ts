/**
 * **本部署事实**（round 68）：`use_skill` 加载一份技能时，在**全文末尾**拼上的一段运行时段。
 *
 * 为什么要有它（做法照 DeepSeek Harness 的 office 技能：同一份 SKILL.md，在不同部署下加载出来的
 * 提示词内容不同）：
 *   - 技能正文是**知识**（怎么做对），它不该写任何"本机有什么"——写死了就会随机器失真；
 *   - 而"本机这台机器能不能把 .pptx 导成图""当前模型能不能读图"是**部署事实**，只有运行期知道，
 *     而且它直接决定自检该怎么收尾（能看图就该逐页看图；看不了就该如实声明"没做视觉检查"）。
 *
 * 注入形状（**可测**：注入什么就拼出什么）：
 *   - `SkillRuntimeFacts` 两个字段都是**三态**（可用 / 不可用 / 没探到）；`null` 表示整段都不知道；
 *   - 取值函数由**调用方注入**（`createUseSkillTool` 的第三个参数，生产由 main 侧算好经
 *     `createKyclawMastra` 装进下面的注册表）—— 本模块**不 import 任何硬件探测**（探测属于 main）；
 *   - 拿不到结论时**不编造**：写"未知"，并给出"按实际收到的内容为准"的收尾口径。
 *
 * 拼出来的形状（固定小节标题，模型与 spec 都按它认）：
 *
 *   ## 本部署事实（加载时注入，不在技能文件里）
 *
 *   - 页图渲染：可用 / 不可用 / 未知（一句话说清它意味着什么）
 *   - 当前模型读图：支持 / 不支持 / 未知（同上）
 *   - <跟着两条事实走的那一段"自检怎么收尾">
 *
 * 注册表为什么是模块级：`use_skill` 的构造在 `mastra/agents/kyclaw.ts`（本轮由另一个改动持有），
 * 不动它就能接上的通道只有这一条。取值**现读**（每次 use_skill 调一次），所以换模型、装/卸
 * PowerPoint 之后下一轮就是新结论；要换成显式选项，只需在 kyclaw 的 toolOptions 上加一个字段、
 * 把这里换成它的默认值即可（见 MASTRA 侧 createKyclawMastra 的 skillRuntimeFacts 选项）。
 */

import type { PptRenderer } from '../tools/render-ppt'

/** 一台机器（本部署）的能力事实；每一项都允许"不知道"（null） */
export interface SkillRuntimeFacts {
  /**
   * `render_ppt` 能不能真把 .pptx 逐页导成 PNG：
   * `'libreoffice'`（**随包**的渲染器，不依赖 Office）/ `'powerpoint'`（本机装的 Office）可用 /
   * `'none'` 不可用（只会回逐页文字结构）/ `null` 没探到结论。
   * 字面量与 `render-ppt.ts` 的 `PptRenderer` 是**同一个类型**（那边是唯一的真来源，
   * 免得两处各写一份枚举、悄悄分叉）。
   */
  pptRenderer: PptRenderer | null
  /**
   * 当前模型能不能读图：`true` 能 / `false` 不能 / `null` 不知道（本机没有探测结论）。
   * `false` 时按 dsh 那条口径办：**不要**为了让模型"看一眼"去反复渲染、重试或换模型。
   */
  vision: boolean | null
}

/** 事实来源：**现读**取值函数（拿不到 → null） */
export type SkillRuntimeFactsSource = () => SkillRuntimeFacts | null

/** 那一段的固定标题（spec 与技能正文都按它认） */
export const SKILL_RUNTIME_FACTS_HEADING = '## 本部署事实（加载时注入，不在技能文件里）'

const RENDER_TEXT: Record<PptRenderer | 'unknown', string> = {
  libreoffice:
    '可用 —— 本机**随包**了 LibreOffice 渲染器（**不需要你装 Office**、也不需要联网），' +
    '`render_ppt` 能把 .pptx 逐页导成 PNG 并附给你看',
  powerpoint: '可用 —— 本机有 PowerPoint，`render_ppt` 能把 .pptx 逐页导成 PNG 并附给你看',
  none: '不可用 —— 本机**既没有随包渲染器、也没有 PowerPoint**，`render_ppt` 只会回**逐页文字结构**，看不到图',
  unknown: '未知 —— 本机这次没探到渲染器结论'
}

const VISION_TEXT: Record<'yes' | 'no' | 'unknown', string> = {
  yes: '支持 —— `render_ppt` 附上的页图你确实看得到，按图核',
  no: '不支持 —— 页图不会附到你的上下文里，别指望它',
  unknown: '未知 —— 以你实际收到的内容为准：图到了就看，没到就按"未做视觉检查"收尾'
}

/**
 * 跟着事实走的那一段（**自检怎么收尾**）。都是可判定的操作指令：
 * 渲染可用且能看图 → 逐页看图；渲染可用但看不到图 → 别为一个看不到的东西反复渲染；
 * 渲染不可用 → 退到文字档并**写明没做视觉检查**，且不许去找/装别的渲染器、不许换模型。
 * 两种"渲染可用"（随包 LibreOffice / 本机 PowerPoint）走**同一套**收尾口径 —— 对模型来说
 * 差别只在页图是从哪台引擎出来的，操作上没区别。
 */
function directives(facts: SkillRuntimeFacts): string {
  if (facts.pptRenderer === 'none') {
    return (
      '自检怎么收尾：**视觉检查这一档在本机做不了** —— 随包的渲染器没装上、本机也没有 PowerPoint，' +
      '`render_ppt` 只回逐页文字结构，就按它把措辞、占位值、来源、页数逐页核一遍，' +
      '并在交付时写明「只做了结构与内容校验，未做视觉检查」。' +
      '**不要**去找系统的 LibreOffice / `soffice`、不要 `npx`、不要装渲染器、不要为此换模型 —— ' +
      '本机就这两条路，绕道只会白花时间和钱。'
    )
  }
  if (facts.pptRenderer === null) {
    return (
      '自检怎么收尾：渲染器有没有**还不知道** —— 先按技能正文走（`render_ppt` 自己会说能不能渲），' +
      '别自己去装或找渲染器。看到图就逐页看图核；只拿到文字就按"未做视觉检查"收尾。'
    )
  }
  if (facts.vision === false) {
    return (
      '自检怎么收尾：渲染可用、**但你看不到图** —— 别为了"看一眼"反复调用 `render_ppt`（页图到不了你的上下文），' +
      '也别为此重试、换模型或另找渲染器；按结构与内容校验收尾，并写明「未做视觉检查」。'
    )
  }
  if (facts.vision === true) {
    return (
      '自检怎么收尾：渲染可用、你也能看图 —— 改过源文件之后重新渲染一次，逐页看图核；' +
      '**同一份没改动过的源不要重复渲染**（页图一次就够）。'
    )
  }
  return (
    '自检怎么收尾：渲染可用，但**你能不能读图没有结论** —— 改过源文件之后重新渲染一次；' +
    '页图附到了就直接看，只拿到文字就按"未做视觉检查"收尾，不要重试、不要换模型。'
  )
}

/**
 * 拼那一段（纯函数）：`facts === null`（整段都不知道）也照样给一段 —— 缺省安全、
 * 不编造，并把"没结论时怎么办"写清楚。
 */
export function skillRuntimeFactsText(facts: SkillRuntimeFacts | null): string {
  const render =
    facts === null || facts.pptRenderer === null
      ? RENDER_TEXT.unknown
      : RENDER_TEXT[facts.pptRenderer]
  const vision =
    facts === null || facts.vision === null
      ? VISION_TEXT.unknown
      : facts.vision
        ? VISION_TEXT.yes
        : VISION_TEXT.no

  const tail =
    facts === null
      ? '自检怎么收尾：本机这次**没给出**部署结论 —— 按技能正文走，' +
        '只在真的看过页图时才说"看过"；页面版式没看过就写明「未做视觉检查」，' +
        '不要为此去找渲染器、装依赖或换模型。'
      : directives(facts)

  return [
    '',
    '---',
    '',
    SKILL_RUNTIME_FACTS_HEADING,
    '',
    '这一段由本机在**加载这份技能时**拼上，技能文件里没有；与正文里的"应然"说法冲突时以它为准。',
    '',
    `- 页图渲染：${render}`,
    `- 当前模型读图：${vision}`,
    `- ${tail}`,
    ''
  ].join('\n')
}

/** 模块级注册表（见文件头注：接不上 kyclaw 的 toolOptions 时的注入通道） */
let factsSource: SkillRuntimeFactsSource | null = null

/** 装上事实来源（生产由 `createKyclawMastra` 在装配时调用一次） */
export function setSkillRuntimeFactsSource(source: SkillRuntimeFactsSource | null): void {
  factsSource = source
}

/** 现读事实：**取值函数抛错只 warn 后当"没有结论"** —— 自检事实拿不到不该让 use_skill 失败 */
export function currentSkillRuntimeFacts(): SkillRuntimeFacts | null {
  if (factsSource === null) return null
  try {
    return factsSource()
  } catch (error) {
    console.warn('[kyclaw] 本部署事实取不到（这次加载技能按"未知"处理）', error)
    return null
  }
}

/** 清掉注册表（测试用；免得一个用例的事实串到下一个用例） */
export function resetSkillRuntimeFactsSource(): void {
  factsSource = null
}
