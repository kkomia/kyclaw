import { Hono } from 'hono'
import type { MastraMemory } from '@mastra/core/memory'
import {
  taskThreadIdSchema,
  taskWriteSchema,
  taskSnapshotSchema,
  taskHistorySchema
} from '../../shared/tasks'
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'
import { TaskValidationError, type SessionTaskStore } from '../session-tasks'

export interface TasksRouterOptions {
  memory: Pick<MastraMemory, 'getThreadById'>
  store: SessionTaskStore
}

export function createTasksRouter({ memory, store }: TasksRouterOptions): Hono {
  const router = new Hono()
  const ownership: import('hono').MiddlewareHandler = async (context, next) => {
    const parsed = taskThreadIdSchema.safeParse(context.req.param('threadId'))
    if (!parsed.success) return context.json({ error: 'invalid-input: 线程 id' }, 400)
    const thread = await memory.getThreadById({ threadId: parsed.data })
    if (!thread || thread.resourceId !== LOCAL_USER_RESOURCE_ID)
      return context.json({ error: 'not-found' }, 404)
    await next()
    return undefined
  }
  router.use('/:threadId', ownership)
  router.use('/:threadId/history', ownership)
  router.get('/:threadId/history', async (context) => {
    return context.json(
      taskHistorySchema.parse({
        revisions: await store.listRevisions(context.req.param('threadId'))
      })
    )
  })
  router.get('/:threadId', async (context) => {
    return context.json(taskSnapshotSchema.parse(await store.get(context.req.param('threadId'))))
  })
  router.put('/:threadId', async (context) => {
    const body = taskWriteSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid-input: 任务写入参数' }, 400)
    try {
      const result = await store.apply(context.req.param('threadId'), body.data, { origin: 'user' })
      if (result.status === 'conflict')
        return context.json({ error: 'revision-conflict', snapshot: result.snapshot }, 409)
      return context.json(taskSnapshotSchema.parse(result.snapshot))
    } catch (error) {
      if (error instanceof TaskValidationError)
        return context.json({ error: `invalid-input: ${error.message}` }, 400)
      throw error
    }
  })
  return router
}
