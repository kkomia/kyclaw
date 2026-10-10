/**
 * 窗口状态落盘（唯一一份持久化：userData/window-state.json）。
 * 只存窗口自己的状态（几何 + 最大化）——设置系统是 T5 的事，别混进来。
 *
 * 读写都不抛：文件坏了当没写过（回默认值），窗口还能照常起；
 * 路径由调用方给（main/window.ts 传 app.getPath('userData')），所以这里是纯函数、可单测。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const WINDOW_STATE_FILE = 'window-state.json'

/** 落盘结构：宽高/位置 + 最大化标记（x/y 为 null = 没记过位置，交给系统摆） */
export const persistedWindowStateSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  x: z.number().int().nullable(),
  y: z.number().int().nullable(),
  maximized: z.boolean()
})

export type PersistedWindowState = z.infer<typeof persistedWindowStateSchema>

/** 首启动尺寸：三栏骨架（侧栏 240 + 工作台 400）留得下主列，1280×800 是桌面常规档 */
export const DEFAULT_WINDOW_STATE: PersistedWindowState = {
  width: 1280,
  height: 800,
  x: null,
  y: null,
  maximized: false
}

export function windowStatePath(userDataDir: string): string {
  return join(userDataDir, WINDOW_STATE_FILE)
}

/** 读：文件不存在 / 不是 JSON / 过不了 schema → 默认值（新对象，调用方随便改） */
export function readWindowState(file: string): PersistedWindowState {
  try {
    const parsed = persistedWindowStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : { ...DEFAULT_WINDOW_STATE }
  } catch {
    return { ...DEFAULT_WINDOW_STATE }
  }
}

/** 写：目录不存在就建（userData 首次创建），同步写——窗口关闭时也要来得及落盘 */
export function writeWindowState(file: string, state: PersistedWindowState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
