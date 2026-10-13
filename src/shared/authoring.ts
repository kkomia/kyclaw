import type { McpServerConfig } from './settings'

/**
 * 「让模型自己把技能 / MCP 落地」这件事的**运行时依赖**（round 65）。
 *
 * 为什么单独一个类型：这些能力（写用户技能目录、写 settings.mcpServers）都落在**主进程管着的
 * 数据面**上，而工具跑在 mastra 侧（刻意不 import electron / 不直接读写 settings.json）。
 * 所以由 main 侧把"现读 + 落盘"的实现注入一次，工具只调这些函数 —— 与 printPdf 注入同一路数，
 * 好处是写盘仍走**既有那一条路**（MCP 就是 PUT /api/mcp/servers 用的那个 saveServers），
 * 校验不会出现第二份实现。
 *
 * 缺省 = 没有注入（`null`）：工具回一句人话「这个运行环境不支持」，不抛错、不静默失败。
 */
export interface AuthoringRuntime {
  /** 用户技能目录（`<userData>/skills`）——装插件时复制的技能也落在这里 */
  skillsDir: string
  /**
   * 插件复制进来的技能目录名（`<插件 id>-<技能名>`）：**不许覆盖、不许删除**。
   * 它们由插件的安装记录管着（卸载会清），模型改写只会与插件体系打架。
   */
  pluginSkillDirs: readonly string[]
  /**
   * 内置技能名（`resources/skills/*` 的目录名，如 pptx / docx）：**不许占用同名**。
   * 内置在清单里排在前面，`use_skill` 按顺序命中 —— 用户建一个同名的，读回的会是内置那份
   * （等于白建），所以这里直接拒并让模型改名。
   */
  builtinSkillNames: readonly string[]
  /** 现读 MCP 配置（= settings.mcpServers） */
  readMcpServers: () => readonly McpServerConfig[]
  /** 整表落盘并回吐落盘后的列表（与 MCP 管理路由 PUT /api/mcp/servers 同一条路：校验 → 落盘） */
  saveMcpServers: (servers: McpServerConfig[]) => readonly McpServerConfig[]
  /**
   * 落盘成功后的通知（生产 = MCP lifecycle.refresh）：启停**当场**生效，不必等下一次对话。
   * 尽力而为——回调自己吞错，不拦工具的返回值。
   */
  onMcpServersChanged?: () => void
}
