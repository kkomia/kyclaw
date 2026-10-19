/**
 * PB-018（0.2.0 B3.3 renderer 半端）：内核命令平面的 renderer HTTP/SSE 客户端。
 *
 * 只做三件事（没有第二份命令清单、没有本地解析）：
 *   - 探活/目录：`GET /api/kernel/status`、`GET /api/kernel/catalog`（唯一命令来源是内核 `commands/list`）；
 *   - 只读投影：`GET /api/kernel/projection`（goal 六行 + plan 双形态，main 已投影成展示形状）；
 *   - 执行：`POST /api/kernel/command` 读 `command/run` → `command/done` 的 SSE 帧。
 *
 * 命令不产生模型消息：这里从不调用 chat transport；调用方拿到 done 后只更新结果卡/dock。
 * 内核 token/cookie 不下发 renderer（ADR-1）——鉴权仍是我们自己的本地 HTTP token。
 */
import type {
  KernelCommandFrame,
  KernelCommandSummary,
  KernelProjectionSnapshot
} from '@shared/kernel-ui'

async function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl, token } = await window.kyclaw.agent.endpoint()
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers
    }
  })
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      message?: string
    } | null
    const error = new Error(body?.message ?? `内核命令服务返回 ${response.status}`)
    ;(error as Error & { code?: string }).code = body?.error
    throw error
  }
  return response.json()
}

/** 内核是否启用（flag 关 → false；探活失败一律当关，不挡旧路径） */
export async function kernelEnabled(): Promise<boolean> {
  try {
    const body = (await readJson(await authorized('/api/kernel/status'))) as {
      enabled?: unknown
    }
    return body.enabled === true
  } catch {
    return false
  }
}

/** 命令目录（菜单唯一来源；内核加命令 / 删命令，前端不用改） */
export async function fetchKernelCatalog(): Promise<KernelCommandSummary[]> {
  const body = (await readJson(await authorized('/api/kernel/catalog'))) as {
    commands?: unknown
  }
  if (!Array.isArray(body.commands)) return []
  return body.commands.flatMap((entry): KernelCommandSummary[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const command = entry as { name?: unknown; description?: unknown }
    if (typeof command.name !== 'string' || command.name.trim() === '') return []
    return [
      {
        name: command.name,
        ...(typeof command.description === 'string' ? { description: command.description } : {})
      }
    ]
  })
}

/** goal 六行 + plan 投影（只读；两种 plan 形态原样带回，调用方用 kernelPlanActive 判定） */
export async function fetchKernelProjection(threadId: string): Promise<KernelProjectionSnapshot> {
  const body = (await readJson(
    await authorized(`/api/kernel/projection?threadId=${encodeURIComponent(threadId)}`)
  )) as Partial<KernelProjectionSnapshot>
  return {
    goal: body.goal ?? null,
    plan: body.plan ?? null
  }
}

/** 从 SSE 文本里取完整事件（`data: <json>`，事件之间空行分隔） */
function takeFrames(buffer: string): { frames: unknown[]; rest: string } {
  const normalized = buffer.replace(/\r\n/gu, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const frames: unknown[] = []
  for (const part of parts) {
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (data === '') continue
    try {
      frames.push(JSON.parse(data) as unknown)
    } catch {
      // 半截/坏帧丢弃：不把解析错误当成命令结果
    }
  }
  return { frames, rest }
}

function isFrame(value: unknown): value is KernelCommandFrame {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === 'command/run' || type === 'command/done'
}

/**
 * 执行一条命令并逐帧回调。返回 = 流结束（不代表成功，成功看 `command/done.result.kind`）。
 * 非 2xx / 网络错误直接抛，调用方把 message 放结果卡错误行。
 */
export async function runKernelCommand(
  threadId: string,
  line: string,
  onFrame: (frame: KernelCommandFrame) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await authorized('/api/kernel/command', {
    method: 'POST',
    body: JSON.stringify({ threadId, line }),
    ...(signal === undefined ? {} : { signal })
  })
  if (!response.ok) {
    await readJson(response)
    return
  }
  if (response.body === null) throw new Error('命令执行失败：响应没有数据流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const taken = takeFrames(buffer)
    buffer = taken.rest
    for (const frame of taken.frames) {
      if (isFrame(frame)) onFrame(frame)
    }
  }
  buffer += decoder.decode()
  const tail = takeFrames(`${buffer}\n\n`)
  for (const frame of tail.frames) {
    if (isFrame(frame)) onFrame(frame)
  }
}
