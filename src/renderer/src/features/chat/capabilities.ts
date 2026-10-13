import { FileSpreadsheet, FileText, Globe, ScrollText, type LucideIcon } from 'lucide-react'

/**
 * 初始页「能力入口」的**唯一数据源**（round 75）。
 *
 * 为什么单开一个文件：入口集合是**产品口径**（我们真能干什么），组件只负责画 ——
 * 加一条能力是改这里一行，不去动 JSX。顺带把"标签改了、提示词忘了改"这类漂移按住：
 * 组件与 spec 都从这里读同一份，不各写一遍。
 *
 * 取舍（用户口径「宁可少而准」）：只放**手上真有工具、交付物确定**的四条，
 * 每条都对着一个真工具 ——
 *   文档 → `create_docx`；表格 → `create_excel`；报告 → `create_report` + `create_pdf`；
 *   研究 → `web_search` + `fetch` 查证后收在 `create_report`。
 *   - **不放 PPT**：输入卡下方那枚 PPT 胶囊是**模板选择器**（挑主题），不是能力入口——
 *     同一排里再放一个"PPT"是重复的，用户点哪个都说不通。
 *   - **不放「构建应用」**：单一 HTML 应用的产出我们不比专门的前端工具强，摆上去只会让点了的人失望。
 *
 * `prompt` 是**可读可改的起始提示词**：点一下填进输入框（**不自动发送**，用户先读、先改、
 * 自己按回车）。每条都先给**结构化骨架**（空着的地方由用户填），末尾再写一句我们的纪律
 * （先对齐再动笔 / 先定结构 / 结论标出处）—— 用户口径："不要写成『帮我做个文档』这种空话"。
 *
 * 零 emoji（雷点 1）；雷点 4：图标一律 lucide，不引第三方图标集。
 */
export interface Capability {
  /** 稳定 id：testid 与 React key 都用它（改文案不改 id） */
  id: string
  /** 胶囊上的字（与「选择项目」「PPT」同档的短词） */
  label: string
  /** 胶囊图标（lucide） */
  icon: LucideIcon
  /** 点一下填进输入框的起始提示词（只填，不发） */
  prompt: string
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'docx',
    label: '文档',
    icon: FileText,
    prompt: `帮我写一份 Word 文档（.docx）。

主题：
给谁看：
篇幅：
必须讲清楚的几件事：

先别动笔：上面空着的先问我，再给我一份提纲过目；确认之后再生成 .docx。`
  },
  {
    id: 'xlsx',
    label: '表格',
    icon: FileSpreadsheet,
    prompt: `帮我把数据整理成一张 Excel 表（.xlsx）。

数据从哪来：
一行代表什么：
要有哪些列：

先把表头列出来给我看一眼，确认之后再生成 .xlsx。`
  },
  {
    id: 'report',
    label: '报告',
    icon: ScrollText,
    prompt: `帮我把手头的内容整理成一份能直接发出去的文档（PDF）。

主题：
给谁看：
篇幅：
要写进去的要点：

先把结构定下来给我看：分几节、每节写什么；确认之后再出 PDF。`
  },
  {
    id: 'research',
    label: '研究',
    icon: Globe,
    prompt: `帮我做一次研究，最后给我一份带来源的报告。

要查清的问题：
用在什么场合：
必须覆盖的方面：

先给我一份研究提纲（分几节、每节回答什么）再动手；结论标出处，查不到或拿不准的直接说。`
  }
]
