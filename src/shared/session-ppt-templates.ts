/**
 * 会话↔PPT 模板映射（round 66）：**哪条会话固定了哪套 PPT 模板**。
 *
 * 与「会话↔项目映射」（shared/projects.ts + mastra/session-projects.ts）同一套路数：
 * 选择是**会话级**的 —— 模板清单那一侧（哪十套、什么颜色）在 shared/ppt-templates.ts，
 * 这里只管"哪条会话选了哪一套"，落 libsql 的 `session_ppt_templates` 表（与会话本体同库同寿命，
 * 见 mastra/session-ppt-templates.ts 头注）。
 *
 * 为什么不再是全局设置：round 63 把选择落在 `settings.pptTemplate`，于是它对**所有会话**生效 ——
 * 新开的对话照样预选着上一次挑的模板，agent 每轮还据此往指令里注入"用户已固定模板：X"。
 * round 66 用户实报后改成会话级：新会话（草稿）= 没选，选择跟着会话走、只影响它自己。
 *
 * 形状约束（与项目映射同一分工）：模板名的**业务**判定（认不认得、是不是注册表里的那十套之一）
 * 在写入侧（mastra/routes/session-ppt-templates.ts 用 lookupTemplate 拦），这里只管跨边界形状。
 */
import { z } from './zod'

/**
 * 写一条（PUT /api/ppt/templates 的入参）：`template` 空串 = 这条会话清回"自动挑"
 * （与 projects 的 `projectId: null` 同一个语义位置）。
 */
export const sessionPptTemplateRequestSchema = z.strictObject({
  threadId: z.string().min(1),
  /** 模板名（shared/ppt-templates 的 PPT_TEMPLATE_NAMES 之一）；空串 = 清回自动 */
  template: z.string()
})

export type SessionPptTemplateRequest = z.infer<typeof sessionPptTemplateRequestSchema>

/** 映射的一条（GET /api/ppt/templates 的回包元素；空值不存在，清掉就是没有这一行） */
export const sessionPptTemplateEntrySchema = z.strictObject({
  threadId: z.string().min(1),
  template: z.string().min(1)
})

export type SessionPptTemplateEntry = z.infer<typeof sessionPptTemplateEntrySchema>

/** GET /api/ppt/templates 的回包 */
export const sessionPptTemplateListSchema = z.strictObject({
  sessions: z.array(sessionPptTemplateEntrySchema)
})

export type SessionPptTemplateList = z.infer<typeof sessionPptTemplateListSchema>
