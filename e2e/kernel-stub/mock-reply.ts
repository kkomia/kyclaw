/**
 * E2E stub 的默认对话文本（PB-021）——**逐字等于旧内置 mock（0.2.0 已删除）的三段原文**，
 * 这样 chat/sessions/walkthrough 里"离线模式"的断言在 0.2.0 迁移后不用改口径。
 *
 * 注意：这里只留"文本口径"，**没有**旧的写文件口令/写内容语义。旧 mock 用 `[[write:…]]` 在宿主里
 * 真执行工具；0.2.0 的工具在内核进程里跑，stub 只回放协议帧、不执行产品工具（不假装工具产出）。
 * 审批/写文件类 e2e 的迁移口径见 `.superpowers/dev-verify/20261019-0.2.0/nia/kernel-stub-contract.md` §5。
 */
export const STUB_REPLY_CHUNKS = ['（kyclaw 离线模式）', '你好，', '我是 kyclaw。'] as const

export const STUB_REPLY_FULL = STUB_REPLY_CHUNKS.join('')
