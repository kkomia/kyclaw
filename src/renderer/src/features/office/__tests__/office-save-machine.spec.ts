import { describe, expect, it, vi } from 'vitest'
import type { OfficeSaveResult } from '@shared/office-editor'
import { createOfficeSaveMachine, type OfficeSaveMachineDeps } from '../office-save-machine'

/**
 * 保存状态机（M3-S3，方案 §7.1-§7.2）：generate→write→commit / 保存期间编辑仍脏 / 失败保持 dirty /
 * 重复点只发一次 / 另存为后基线更新。纯逻辑：字节生成与 IPC 都是注入的，不需要 Electron。
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const SAVED_OK: OfficeSaveResult = {
  ok: true,
  documentId: 'doc-1',
  mtimeMs: 1_700_000_000_100,
  sha256: 'b'.repeat(64),
  size: 5,
  savedAt: 1_700_000_000_200
}

function makeMachine(
  overrides: Partial<OfficeSaveMachineDeps> = {},
  requests: { bytes: Uint8Array | null; resolve: () => void }[] = []
): {
  machine: ReturnType<typeof createOfficeSaveMachine>
  dirty: ReturnType<typeof vi.fn>
  saving: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  saveIpc: ReturnType<typeof vi.fn>
  saveAsIpc: ReturnType<typeof vi.fn>
  requests: typeof requests
} {
  const dirty = vi.fn()
  const saving = vi.fn()
  const error = vi.fn()
  const saveIpc = vi.fn(async () => SAVED_OK)
  const saveAsIpc = vi.fn(async () => ({
    ok: true as const,
    document: {
      documentId: 'doc-1',
      displayName: '另存.docx',
      displayPath: 'D:\\另存.docx',
      absolutePath: 'D:\\另存.docx',
      size: 5,
      mtimeMs: 1,
      sha256: 'c'.repeat(64),
      readOnly: false
    },
    mtimeMs: 1,
    sha256: 'c'.repeat(64),
    size: 5,
    savedAt: 1
  }))
  const machine = createOfficeSaveMachine({
    documentId: 'doc-1',
    requestSaveBytes: async () => new Uint8Array([1, 2, 3, 4, 5]),
    saveIpc,
    saveAsIpc,
    initialSha256: 'a'.repeat(64),
    onDirtyChange: dirty,
    onSavingChange: saving,
    onError: error,
    ...overrides
  })
  return { machine, dirty, saving, error, saveIpc, saveAsIpc, requests }
}

describe('office-save-machine：三阶段成功路径', () => {
  it('generate → write → commit：成功后清脏、expectedSha256 用上一次已知基线、saveIpc 只发一次', async () => {
    const { machine, dirty, saving, saveIpc } = makeMachine()

    machine.onChanged()
    expect(machine.isDirty()).toBe(true)
    expect(dirty).toHaveBeenLastCalledWith(true)

    await expect(machine.save()).resolves.toBe(true)
    expect(saveIpc).toHaveBeenCalledTimes(1)
    expect(saveIpc).toHaveBeenCalledWith({
      documentId: 'doc-1',
      expectedSha256: 'a'.repeat(64),
      bytes: new Uint8Array([1, 2, 3, 4, 5])
    })
    expect(machine.isDirty()).toBe(false)
    expect(dirty).toHaveBeenLastCalledWith(false)
    expect(saving.mock.calls).toEqual([[true], [false]])
    // 下次保存用刚写盘的 sha 作为冲突基线
    expect(machine.lastKnownSha256()).toBe('b'.repeat(64))

    machine.onChanged()
    await machine.save()
    expect(saveIpc).toHaveBeenLastCalledWith({
      documentId: 'doc-1',
      expectedSha256: 'b'.repeat(64),
      bytes: new Uint8Array([1, 2, 3, 4, 5])
    })
  })

  it('保存期间继续编辑：写盘成功也不清脏（savedSeq 只 commit 生成字节那次）', async () => {
    const generated = deferred<Uint8Array | null>()
    const { machine, saveIpc } = makeMachine({
      requestSaveBytes: () => generated.promise
    })

    machine.onChanged()
    const first = machine.save()
    // 等保存启动后编辑一次（模拟保存间隙用户继续打字）
    await Promise.resolve()
    machine.onChanged()

    generated.resolve(new Uint8Array([1, 2, 3, 4, 5]))
    await expect(first).resolves.toBe(true)
    expect(saveIpc).toHaveBeenCalledTimes(1)
    expect(machine.isDirty()).toBe(true)

    // 再保存一次（第二次覆盖最新编辑）才清脏
    const second = await machine.save()
    expect(second).toBe(true)
    expect(machine.isDirty()).toBe(false)
  })

  it('重复触发：保存中再点只复用同一次在途保存（不重复 generate / 不重复 IPC）', async () => {
    const generated = deferred<Uint8Array | null>()
    const requestSaveBytes = vi.fn(() => generated.promise)
    const { machine, saveIpc } = makeMachine({ requestSaveBytes })
    machine.onChanged()

    const first = machine.save()
    const second = machine.save()
    expect(second).toBe(first)
    generated.resolve(new Uint8Array([1, 2, 3, 4, 5]))
    await expect(first).resolves.toBe(true)
    expect(requestSaveBytes).toHaveBeenCalledTimes(1)
    expect(saveIpc).toHaveBeenCalledTimes(1)
  })
})

describe('office-save-machine：失败不丢 dirty', () => {
  it('主进程分类失败（conflict/write-locked…）：dirty 保持、错误上抛给 UI、基线不更新', async () => {
    const saveIpc = vi.fn(async (): Promise<OfficeSaveResult> => ({
      ok: false,
      code: 'write-locked',
      message: '文件被其他程序占用，可以先另存为再替换'
    }))
    const { machine, error, dirty } = makeMachine({ saveIpc })
    machine.onChanged()

    await expect(machine.save()).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith('文件被其他程序占用，可以先另存为再替换')
    expect(machine.isDirty()).toBe(true)
    expect(dirty).toHaveBeenLastCalledWith(true)
    expect(machine.lastKnownSha256()).toBe('a'.repeat(64))
  })

  it('generate 失败（面 save() 回 null）：不发 IPC、dirty 保持、错误提示', async () => {
    const saveIpc = vi.fn(async () => SAVED_OK)
    const { machine, error } = makeMachine({ saveIpc, requestSaveBytes: async () => null })
    machine.onChanged()

    await expect(machine.save()).resolves.toBe(false)
    expect(saveIpc).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('没能生成保存内容')
    expect(machine.isDirty()).toBe(true)
  })

  it('generate 抛错 / saveIpc 抛错：都收敛成失败 + 错误人话，不留下 saving=true', async () => {
    const { machine, error, saving } = makeMachine({
      requestSaveBytes: async () => {
        throw new Error('面没有响应')
      }
    })
    machine.onChanged()
    await expect(machine.save()).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith('面没有响应')
    expect(saving).toHaveBeenLastCalledWith(false)
    expect(machine.isSaving()).toBe(false)
  })
})

describe('office-save-machine：另存为', () => {
  it('另存为成功：document 重定向回调、基线换新 sha、按 seq 判脏', async () => {
    const onSavedAs = vi.fn()
    const { machine, saveAsIpc } = makeMachine({ onSavedAs })
    machine.onChanged()

    await expect(machine.saveAs()).resolves.toBe(true)
    expect(saveAsIpc).toHaveBeenCalledWith({
      documentId: 'doc-1',
      bytes: new Uint8Array([1, 2, 3, 4, 5])
    })
    expect(onSavedAs).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: '另存.docx', sha256: 'c'.repeat(64) })
    )
    expect(machine.lastKnownSha256()).toBe('c'.repeat(64))
    expect(machine.isDirty()).toBe(false)
  })

  it('另存为失败/取消：dirty 保持、错误提示、基线不动', async () => {
    const saveAsIpc = vi.fn(async () => ({
      ok: false as const,
      code: 'cancelled' as const,
      message: '已取消'
    }))
    const { machine, error } = makeMachine({ saveAsIpc })
    machine.onChanged()

    await expect(machine.saveAs()).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith('已取消')
    expect(machine.isDirty()).toBe(true)
    expect(machine.lastKnownSha256()).toBe('a'.repeat(64))
  })

  it('没有 saveAsIpc 时明确失败（不默默当成功）', async () => {
    const { machine, error } = makeMachine({ saveAsIpc: undefined })
    machine.onChanged()
    await expect(machine.saveAs()).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith('当前版本不支持另存为')
    expect(machine.isDirty()).toBe(true)
  })
})

describe('office-save-machine：重载基线', () => {
  it('noteReloaded(sha) 把当前 seq 记为已保存并更新基线（冲突后重新载入的语义）', () => {
    const { machine, dirty } = makeMachine()
    machine.onChanged()
    expect(machine.isDirty()).toBe(true)
    machine.noteReloaded('d'.repeat(64))
    expect(machine.isDirty()).toBe(false)
    expect(machine.lastKnownSha256()).toBe('d'.repeat(64))
    expect(dirty).toHaveBeenLastCalledWith(false)
  })
})
