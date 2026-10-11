// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listWorkspaceFiles,
  WORKSPACE_FILE_SKIP_DIRS,
  WORKSPACE_LIST_LIMIT,
  WORKSPACE_LIST_MAX_DEPTH
} from '../workspace-files'

/**
 * 工作区文件清单（round 15，`@` 引用用）：有界 + 只列文件 + 不跟链接。
 * 默认档（1500 条 / 深度 8）是产品口径；用例里用注入的小参数覆盖边界，另断言默认值本身。
 */
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-wsfiles-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relative: string, content = 'x'): void {
  const file = join(root, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

it('默认档：1500 条 / 深度 8 / 黑名单目录集合（产品口径的锚点）', () => {
  expect(WORKSPACE_LIST_LIMIT).toBe(1500)
  expect(WORKSPACE_LIST_MAX_DEPTH).toBe(8)
  for (const name of ['node_modules', 'dist', 'out', '__pycache__']) {
    expect(WORKSPACE_FILE_SKIP_DIRS.has(name)).toBe(true)
  }
})

describe('listWorkspaceFiles', () => {
  it('相对路径正斜杠 + 只列文件 + 黑名单/点目录跳过；顺序稳定（按名字）', () => {
    write('a.txt')
    write('子目录/b.md')
    write('node_modules/dep/index.js')
    write('.git/config')
    write('.env')
    mkdirSync(join(root, '空目录'), { recursive: true })

    expect(listWorkspaceFiles(root)).toEqual(['.env', 'a.txt', '子目录/b.md'])
  })

  it('深度上限：第 8 层文件在内、第 9 层在外（根的子项算第 1 层）', () => {
    const eight = Array.from({ length: 7 }, (_, index) => `l${index + 1}`).join('/')
    write(`${eight}/deep.txt`)
    write(`${eight}/l8/deeper.txt`)

    expect(listWorkspaceFiles(root)).toEqual([`${eight}/deep.txt`])
  })

  it('条目上限：到量即停（注入小额度看边界）', () => {
    for (let index = 0; index < 10; index += 1) {
      write(`f${String(index).padStart(2, '0')}.txt`)
    }

    expect(listWorkspaceFiles(root, 5)).toEqual([
      'f00.txt',
      'f01.txt',
      'f02.txt',
      'f03.txt',
      'f04.txt'
    ])
  })

  it('符号链接不进清单（指外/指内都不收）', () => {
    write('real.txt')
    const outside = join(root, '..', `kyclaw-wsfiles-out-${Date.now()}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'x')
    try {
      symlinkSync(outside, join(root, 'link-dir'), 'junction')
      symlinkSync(join(root, 'real.txt'), join(root, 'link-file.txt'), 'file')
    } catch {
      rmSync(outside, { recursive: true, force: true })
      return // 环境造不出链接：跳过
    }
    try {
      expect(listWorkspaceFiles(root)).toEqual(['real.txt'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('根不存在：抛人话（不是静默空表）', () => {
    expect(() => listWorkspaceFiles(join(root, '不存在'))).toThrow(/不存在/)
  })
})
