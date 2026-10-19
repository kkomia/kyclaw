/**
 * PB-020：内核 chat 路径 `/chat/<agentId>` 的唯一常量。
 *
 * 值必须与旧 `src/mastra/agents/kyclaw.ts` 的 `KYCLAW_AGENT_ID` 一致（`kyclaw-agent`），
 * 否则 renderer 的 `agentChatUrl()` 会 POST 到不存在的路径。旧常量随 PB-011 Step 2 删除。
 */
export const KYCLAW_AGENT_ID = 'kyclaw-agent'
