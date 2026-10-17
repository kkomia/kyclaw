// @vitest-environment node
/**
 * 文件工具测试的共用脚手架：真临时目录里造"工作区 + 工作区外"，组装一份用真 fs 的 ToolContext。
 * 每个 spec 自己 beforeEach 造、afterEach 拆；不做全局状态。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { classifyToolCall } from '../../../main/permission/classify'
import type { PermissionRule, Workspace, WorkspaceMode } from '../../../shared/settings'
import { createToolContext, type ToolContext, type ToolFs, type TrustedReadRoots } from '../guard'

export interface TestBed {
  /** 本用例独占的临时目录（工作区与"工作区外"都在它下面） */
  tmp: string
  /** 工作区根（realpath 归一后） */
  root: string
  /** 工作区外的目录（逃逸用例的目标） */
  outside: string
  /** 授权列表（可原地改：切 mode、清空） */
  roots: Workspace[]
  /** "永久允许"规则表（可原地改：加规则、清空） */
  rules: PermissionRule[]
  ctx: ToolContext
  dispose(): void
}

export function createBed(
  options: {
    mode?: WorkspaceMode
    fs?: ToolFs
    rules?: PermissionRule[]
    /** 「工作区之外」那一档（round 75；缺省 = 缺省档 ask，与落盘缺省一致） */
    outsideMode?: WorkspaceMode
    /** 011：已注册技能的只读信任根（缺省 = 没有技能） */
    trustedReadRoots?: TrustedReadRoots
  } = {}
): TestBed {
  const tmp = mkdtempSync(join(tmpdir(), 'kyclaw-tools-'))
  const rootRaw = join(tmp, 'ws')
  const outsideRaw = join(tmp, 'outside')
  mkdirSync(rootRaw, { recursive: true })
  mkdirSync(outsideRaw, { recursive: true })

  const root = realpathSync.native(rootRaw)
  const outside = realpathSync.native(outsideRaw)
  const roots: Workspace[] = [{ path: root, mode: options.mode ?? 'ask' }]
  const rules: PermissionRule[] = options.rules ?? []
  const outsideMode = options.outsideMode ?? 'ask'
  const ctx = createToolContext({
    roots,
    classify: classifyToolCall,
    fs: options.fs,
    permissionRules: () => rules,
    // 显式注入：不依赖 main/permission 的模块级注册表（用例之间互不影响）
    outsideMode: () => outsideMode,
    trustedReadRoots: options.trustedReadRoots
  })

  return {
    tmp,
    root,
    outside,
    roots,
    rules,
    ctx,
    dispose() {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // Windows 上句柄偶尔延迟释放；删不掉交给系统清理（与既有 node 用例同口径）
      }
    }
  }
}

/** 工具 execute 的调用器：会话上下文走 context.agent.threadId（与真实 agent 循环里一致） */
export async function callTool(tool: unknown, input: unknown, session?: string): Promise<unknown> {
  const callable = tool as { execute(input: unknown, context: unknown): Promise<unknown> }
  return await callable.execute(input, { agent: { threadId: session ?? 'session-1' } })
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text)
}

/** 平台无关地把绝对路径折成相对 root 的正斜杠写法（断言用，避免大小写/分隔符噪音） */
export function under(root: string, absolute: string): string {
  return relative(root, absolute).split('\\').join('/')
}
