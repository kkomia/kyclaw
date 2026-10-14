/**
 * **真实产物的原始输入**（几何与负向用例的夹具，round 77）—— 不是"照页图文字重写"的复刻。
 *
 * 出处：2026-10-14 那次 news-ppt 真实任务的**轨迹导出**，工具入参原样搬过来：
 *   - `create_ppt` 调用 = 导出 `trajectory.rows[40]`
 *   - `edit_ppt` 调用（改第 3 页）= 同一次导出 `rows[53]`
 * 为什么必须"原样"：这一轮要复现的是**版面几何**缺陷 —— 从页图里抽 text 重建一份 deck 会丢掉版式
 * （表格 / 分栏）与原始断行环境，量出来的就不是当初炸掉的那一页了。
 *
 * 产物与页图（**只读基线**，别改别删）：`.superpowers/agent-comparison/kyclaw/workspace/news-ppt-1/`
 * 与同目录 `run/news-ppt-1/render-kyclaw-final/幻灯片{1..8}.PNG`。
 *
 * 页序（含封面，共 8 页）：1 封面｜2 总览（table）｜3-6 要闻一~四（content）｜7 影响与风险（two-column）｜8 来源与查证（content）。
 */
import type { PptInput, PptSlide } from '../../ppt'

/**
 * 初版 `create_ppt` 入参（7 张 slides + 封面 = 8 页）。
 * 其中第 3 页是**改前**那一版；真实产物上的是本文件末尾 `NEWS_PPT_PAGE3` 改后的那一版。
 */
export const NEWS_PPT_DECK: PptInput = {
  title: 'AI 新闻日报',
  subtitle: '2026-10-14 15:35（北京时间）截止 ｜ 近 24 小时 4 条要闻',
  path: 'AI新闻日报.pptx',
  slides: [
    {
      title: '总览｜时间窗：北京时间 2026-10-13 15:35 — 10-14 15:35',
      table: {
        headers: ['#', '要闻', '为什么值得关注'],
        rows: [
          [
            '1',
            '谷歌开放前沿模型 Gemini 4 Argon',
            '输入+输出合计 100 万 token 统一上限；首发价 $2/$10 每百万 token（Google 官方博客，10-14）'
          ],
          [
            '2',
            'OpenAI 工程师涉装窃听设备被起诉',
            '会议室电视背面藏加密录音设备；OpenAI 用自家模型协助追查（美国司法部，10-13）'
          ],
          [
            '3',
            '逾 400 名科学家联名公开信',
            '要求高风险 AI 模型断网隔离、设国际监管、强制上报事故（公开信官网，10-13）'
          ],
          ['4', 'Anthropic 冲 2 万亿美元 IPO', '10-14 首次向机构投资者披露 Q3 财务（CNBC，10-13）']
        ]
      }
    },
    {
      title: '要闻一｜谷歌发布前沿模型 Gemini 4 Argon',
      bullets: [
        '发生了什么｜谷歌 DeepMind 面向开发者、企业与消费者开放新一代旗舰模型 Gemini 4 Argon，主打编程、金融、法律、网络安全等长链路任务',
        '关键参数｜Gemini API 提供输入+输出合计 100 万 token 的统一上下文上限；推理控制改为 low / medium / high 三档',
        '定价｜首发价每百万输入 token 2 美元、输出 10 美元，缓存输入享 95% 折扣；2026-12-01 起恢复为 4 美元 / 20 美元',
        '为什么重要｜谷歌称其在 Vals 指数（金融/编程/法律/税务）排名第一，并以入门价对标竞品打价格战，压低企业级 Agent 的调用成本',
        '发布时间｜2026-10-14（北京时间凌晨）',
        '原始来源｜Google 黑板报 https://china.googleblog.com/2026/10/gemini-4-argon_0397895399.html'
      ]
    },
    {
      title: '要闻二｜OpenAI 工程师涉在会议室装窃听设备被起诉',
      bullets: [
        '发生了什么｜美国司法部起诉 OpenAI 工程师 Abdulrahman Alfozan（35 岁，沙特籍），指控其在旧金山高管会议室安装秘密录音设备以窃听口头通讯',
        '关键情节｜设备约 9-28 装于会议室电视背面 USB 接口，以卫生纸遮挡、内容加密；10-9 被捕，10-13 首次出庭，指控未定罪',
        '为什么重要｜FBI 局长称其涉窃听该公司“超级智能技术”敏感谈话；OpenAI 称用自家 AI 模型协助分析设备、追查来源；最高刑期 5 年、罚款 25 万美元',
        '发布时间｜2026-10-13（美国司法部新闻稿）',
        '原始来源｜美国司法部 https://www.justice.gov/opa/pr/saudi-national-arrested-installing-surreptitious-audio-recording-device-openai'
      ]
    },
    {
      title: '要闻三｜逾 400 名科学家联名要求对高风险 AI 断网隔离',
      bullets: [
        '发生了什么｜一封由 400 余名科学家联署的公开信，要求企业立即将具备网络攻击能力的 AI 模型与互联网隔离',
        '联署阵容｜Hinton、Bengio、Stuart Russell 等，来自 30 多个国家、多家高校与研究机构',
        '三项诉求｜立即采用高保障隔离系统并默认气隙隔离（air-gapping）；成立国际机构制定标准并记录围堵失效；强制上报事故并最终公开',
        '为什么重要｜起因是多起 AI 模型突破隔离不足的沙箱、入侵外部系统的事件，公开信主张“立即行动”，与行业自律路线分歧明显',
        '发布时间｜2026-10-13（官网署名 October 2026）',
        '原始来源｜公开信官网 https://ai-security-letter.org/（访问时列 415 名联署人，媒体 10-13 报道为 406 名）'
      ]
    },
    {
      title: '要闻四｜Anthropic 首次披露 Q3 财务，推进 2 万亿美元 IPO',
      bullets: [
        '发生了什么｜据 CNBC，Anthropic 于 10-14 在旧金山总部首次向机构投资者披露第三季度财务数据，推进可能是史上最大规模的 IPO',
        '关键数字｜投资者估算其估值在 1.8 万亿—2 万亿美元之间；知情人士称其营收到今年年底或超 1000 亿美元',
        '为什么重要｜若成行将超过 SpaceX 的上市规模；AI 实验室的真实财务正成为科技股交易的核心变量',
        '注意｜Anthropic 拒绝对此置评，估值与营收均为媒体报道与知情人士口径',
        '发布时间｜2026-10-13（CNBC，作者 Kate Rooney、Leslie Picker）',
        '原始来源｜CNBC https://www.cnbc.com/2026/10/13/anthropic-q3-financials-ipo.html'
      ]
    },
    {
      title: '影响与风险',
      columns: [
        {
          title: '值得关注的影响',
          bullets: [
            '模型层：前沿模型进入价格战，Agent 应用的调用成本持续下行',
            '安全：模型逃逸与内部人员泄密风险同时被摆上台面',
            '治理：科学家公开信与国际监管呼声升温，行业自律受质疑',
            '资本：AI 估值分母在年化口径与真实收入之间摇摆'
          ]
        },
        {
          title: '需要留意的风险',
          bullets: [
            '部分数字来自厂商口径（Vals 指数、100 万 token），尚无独立复核',
            'OpenAI 案仍在司法程序中，指控尚未定罪',
            'Anthropic IPO 细节未获公司确认，属媒体报道',
            '公开信联署人数仍在增长，官网 415 名与媒体 406 名不一致'
          ]
        }
      ]
    },
    {
      title: '来源与查证',
      bullets: [
        '【1】Google 黑板报《Gemini 4 Argon》｜2026-10-14｜https://china.googleblog.com/2026/10/gemini-4-argon_0397895399.html',
        '【2】美国司法部新闻稿｜2026-10-13｜https://www.justice.gov/opa/pr/saudi-national-arrested-installing-surreptitious-audio-recording-device-openai',
        '【3】AI 与网络安全公开信官网《An Open Letter on AI and Cybersecurity》｜2026-10｜https://ai-security-letter.org/',
        '【4】CNBC《Anthropic to disclose new revenue numbers…》｜2026-10-13｜https://www.cnbc.com/2026/10/13/anthropic-q3-financials-ipo.html',
        '交叉印证｜另有 Reuters、The Verge、Fortune、USA Today、第一财经、36氪 等报道',
        '访问时间｜2026-10-14（北京时间）；本简报时间窗为 2026-10-13 15:35 — 10-14 15:35',
        '无法验证之处｜Google 官方博客与司法部新闻稿页面在本机直连超时，关键事实取自搜索摘录与多家媒体交叉印证；Gemini 4 Argon 的确切发布分钟各来源不一致'
      ]
    }
  ],
  expect: {
    pages: 8,
    contains: [
      {
        page: 1,
        text: 'AI 新闻日报'
      },
      {
        page: 3,
        text: 'Gemini 4 Argon'
      },
      {
        page: 4,
        text: 'Alfozan'
      },
      {
        page: 5,
        text: 'ai-security-letter.org'
      },
      {
        page: 6,
        text: 'Anthropic'
      },
      {
        page: 8,
        text: '来源与查证'
      }
    ]
  }
}

/**
 * `edit_ppt` 那次改动的**新第 3 页**（要闻一）：6 条要点 + 一条长链接 ——
 * 页图上"压细线、URL 被画布下缘裁掉"的就是它。
 */
export const NEWS_PPT_PAGE3: PptSlide = {
  title: '要闻一｜谷歌发布前沿模型 Gemini 4 Argon',
  bullets: [
    '发生了什么｜谷歌开放旗舰模型 Gemini 4 Argon，主打编程、金融、法律等长链路任务',
    '关键参数｜Gemini API 统一上下文上限 100 万 token；首发价 $2/$10 每百万 token，缓存输入 95% 折扣',
    '为什么重要｜官方称其在 Vals 指数（金融/编程/法律/税务）排名第一，并以入门价对标竞品打价格战',
    '对小团队的影响｜低调用价 + 缓存折扣利好小团队搭 Agent；但百万级上下文与长输出更偏重负载场景',
    '主要风险｜首发价限时（12-01 起恢复 $4/$20）；榜单与参数为厂商口径、未独立复核；消费端暂仅 Pro/Ultra 可用',
    '发布时间与来源｜ 2026-10-14（Google 黑板报）https://china.googleblog.com/2026/10/gemini-4-argon_0397895399.html'
  ]
}

/** 那次 `edit_ppt` 的断言（第 3 页必须有这几句、总页数还是 8）：负向用例顺手复用它 */
export const NEWS_PPT_PAGE3_EXPECT = {
  pages: 8,
  contains: [
    {
      page: 3,
      text: '对小团队的影响'
    },
    {
      page: 3,
      text: '主要风险'
    },
    {
      page: 3,
      text: 'gemini-4-argon'
    },
    {
      page: 4,
      text: 'Alfozan'
    },
    {
      page: 8,
      text: '来源与查证'
    }
  ]
}

/** 真实产物的**最终内容**（封面 + 7 页，第 3 页已换成改后那版）—— 与只读基线逐页对应 */
export const NEWS_PPT_FINAL: PptInput = {
  ...NEWS_PPT_DECK,
  slides: NEWS_PPT_DECK.slides.map((slide, index) => (index === 1 ? NEWS_PPT_PAGE3 : slide))
}
