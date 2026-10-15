import { ipcMain } from 'electron'
import { noArgsSchema, parseIpcArgs } from '../../shared/ipc'
import type { Project } from '../../shared/projects'
import { combineRules } from '../../shared/rules'
import {
  RULES_IPC_CHANNELS,
  projectRulesReadArgsSchema,
  projectRulesSaveArgsSchema,
  type ProjectRulesView
} from '../../shared/rules-ipc'
import { projectRulesPath, readProjectRules, saveProjectRules } from '../project-rules'
import { readSettings, settingsPath } from '../settings'

export interface RulesIpcHooks {
  processorRegistered?: () => boolean
}

export function registerRulesIpc(userDataDir: string, hooks: RulesIpcHooks = {}): void {
  const file = settingsPath(userDataDir)
  ipcMain.handle(RULES_IPC_CHANNELS.status, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, RULES_IPC_CHANNELS.status)
    return { processorRegistered: hooks.processorRegistered?.() ?? false }
  })
  const find = (id: string): Project => {
    const project = readSettings(file).projects.find((candidate) => candidate.id === id)
    if (project === undefined) throw new Error('这个项目不在列表里（可能已被删除）')
    return project
  }
  const view = async (projectId: string): Promise<ProjectRulesView> => {
    const project = find(projectId)
    const result = await readProjectRules(project)
    const current = readSettings(file)
    if (!current.projects.some((entry) => entry.id === project.id && entry.path === project.path)) {
      result.diagnostics.push({
        scope: 'project',
        code: 'project-unavailable',
        message: '项目已删除或路径已改变，不再加载这份项目约束。'
      })
    }
    const combined = combineRules({ text: current.globalRules, diagnostics: [] }, result)
    return {
      projectId,
      source: projectRulesPath(project),
      text: result.text,
      diagnostics: combined.diagnostics,
      processorRegistered: hooks.processorRegistered?.() ?? false,
      projectIncluded: result.diagnostics.length === 0 && combined.project === result.text
    }
  }
  ipcMain.handle(RULES_IPC_CHANNELS.read, async (_event, ...args) => {
    const [id] = parseIpcArgs(projectRulesReadArgsSchema, args, RULES_IPC_CHANNELS.read)
    return view(id)
  })
  ipcMain.handle(RULES_IPC_CHANNELS.save, async (_event, ...args) => {
    const [input] = parseIpcArgs(projectRulesSaveArgsSchema, args, RULES_IPC_CHANNELS.save)
    const target = find(input.projectId)
    const stillExists = (): boolean =>
      readSettings(file).projects.some(
        (project) => project.id === target.id && project.path === target.path
      )
    const result = await saveProjectRules(target, input.text, { canCommit: stillExists })
    if (!result.ok) return result
    if (!stillExists()) {
      return {
        ok: true,
        view: {
          projectId: target.id,
          source: projectRulesPath(target),
          text: input.text,
          diagnostics: [
            {
              scope: 'project',
              code: 'project-unavailable',
              message: '约束文件已保存，但项目随后已删除或路径已改变，不再对该项目生效。'
            }
          ],
          processorRegistered: hooks.processorRegistered?.() ?? false,
          projectIncluded: false
        }
      }
    }
    return { ok: true, view: await view(input.projectId) }
  })
}
