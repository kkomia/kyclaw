import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { Project } from '../shared/projects'
import {
  PROJECT_RULES_DIRECTORY,
  PROJECT_RULES_FILENAME,
  RULES_SCOPE_MAX_BYTES,
  rulesTextProblem,
  validateRulesForSave,
  type RulesDiagnostic,
  type RulesReadResult,
  type RulesSaveResult
} from '../shared/rules'

class UnsafeRulesPath extends Error {}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function validateResolvedNode(path: string): Promise<void> {
  const canonical = await realpath(path)
  const original = await lstat(path, { bigint: true })
  const resolved = await lstat(canonical, { bigint: true })
  if (
    original.isSymbolicLink() ||
    resolved.isSymbolicLink() ||
    original.dev !== resolved.dev ||
    original.ino !== resolved.ino
  ) {
    throw new UnsafeRulesPath()
  }
}

export function projectRulesPath(project: Project): string {
  return join(project.path, PROJECT_RULES_DIRECTORY, PROJECT_RULES_FILENAME)
}

async function validatePath(project: Project): Promise<{ directory: string; file: string }> {
  if (!isAbsolute(project.path)) throw new UnsafeRulesPath()
  const root = resolve(project.path)
  const volume = parse(root).root
  let current = volume
  const rootParts = relative(volume, root).split(sep).filter(Boolean)
  for (const part of ['', ...rootParts]) {
    if (part !== '') current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeRulesPath()
    await validateResolvedNode(current)
  }
  const directory = join(root, PROJECT_RULES_DIRECTORY)
  const file = join(directory, PROJECT_RULES_FILENAME)
  for (const [path, isDirectory] of [
    [directory, true],
    [file, false]
  ] as const) {
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) {
        throw new UnsafeRulesPath()
      }
      await validateResolvedNode(path)
    } catch (error) {
      if (!missing(error)) throw error
      break
    }
  }
  return { directory, file }
}

function diagnostic(error: unknown, operation: 'read' | 'save'): RulesDiagnostic {
  const unsafe = error instanceof UnsafeRulesPath
  return {
    scope: 'project',
    code: unsafe ? 'unsafe-path' : operation === 'read' ? 'read-failed' : 'save-failed',
    message: unsafe
      ? '项目约束路径不安全：不允许符号链接、junction 或非预期文件类型。'
      : operation === 'read'
        ? '无法读取项目约束，本轮未加载。'
        : '无法保存项目约束。'
  }
}

export async function readProjectRules(project: Project): Promise<RulesReadResult> {
  try {
    const { file } = await validatePath(project)
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if (missing(error)) return { text: '', diagnostics: [] }
      throw error
    }
    try {
      await validatePath(project)
      const stat = await handle.stat()
      const pathStat = await lstat(file)
      if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
        throw new UnsafeRulesPath()
      }
      const bytes = Buffer.alloc(RULES_SCOPE_MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length)
        if (result.bytesRead === 0) break
        length += result.bytesRead
      }
      await validatePath(project)
      if (length > RULES_SCOPE_MAX_BYTES) {
        return {
          text: '',
          diagnostics: [
            { scope: 'project', code: 'too-large', message: '项目约束超过 16 KiB，整份未加载。' }
          ]
        }
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, length)
        )
      } catch {
        return {
          text: '',
          diagnostics: [
            {
              scope: 'project',
              code: 'invalid-text',
              message: '项目约束不是合法 UTF-8 文本，整份未加载。'
            }
          ]
        }
      }
      const problem = rulesTextProblem(text, 'project')
      return problem === null ? { text, diagnostics: [] } : { text: '', diagnostics: [problem] }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { text: '', diagnostics: [diagnostic(error, 'read')] }
  }
}

export async function saveProjectRules(
  project: Project,
  text: string,
  options: { canCommit?: () => boolean } = {}
): Promise<RulesSaveResult> {
  const validation = validateRulesForSave(text, 'project')
  if (!validation.ok) return validation
  let temporary: string | undefined
  try {
    const { directory, file } = await validatePath(project)
    await mkdir(directory, { recursive: false }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    })
    await validatePath(project)
    temporary = join(directory, `.rules-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await validatePath(project)
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await validatePath(project)
    if (options.canCommit !== undefined && !options.canCommit()) {
      return {
        ok: false,
        diagnostics: [
          {
            scope: 'project',
            code: 'project-unavailable',
            message: '项目已删除或路径已改变，项目约束未保存。'
          }
        ]
      }
    }
    await rename(temporary, file)
    temporary = undefined
    return { ok: true }
  } catch (error) {
    return { ok: false, diagnostics: [diagnostic(error, 'save')] }
  } finally {
    if (temporary !== undefined) {
      try {
        await validatePath(project)
        await unlink(temporary)
      } catch {
        // Unsafe paths must not be traversed even to clean up a temporary file.
      }
    }
  }
}
