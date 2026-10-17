/**
 * 壳侧的**保存状态机**（M3-S3，方案 §7.1–§7.2）：generate → write → commit。
 *
 * 真相口径：
 *   - `editSeq !== savedSeq` 才是 dirty 的真相（store 的 `dirty` 只是 UI 投影，由本机回调同步）；
 *   - `editSeq` 由面 `doc:changed` 推进（**撤销不回退**：保守地继续算脏，宁可多提示不可少提示）；
 *   - `savedSeq` 只在**写盘成功**后 = 那次保存发起时（生成字节那一刻）的 seq；
 *   - 保存期间又有编辑 → 写盘成功也不清脏（`savedSeq` 停在旧 seq）；
 *   - 失败（生成失败 / IPC 分类失败 / 抛错）→ **保持 dirty**，把错误交给 UI（可重试/另存），
 *     只有成功才清。
 *
 * 三阶段里的 generate 由 `requestSaveBytes()` 注入（壳 → 面 `doc:save` → 面 flush+save →
 * 回字节），write 由 `saveIpc` / `saveAsIpc` 注入（preload 的 office.save / saveAs）。
 * 不 import React / zustand：纯逻辑，单测直接驱动（`office-save-machine.spec.ts`）。
 */
import type {
  OfficeDocumentInfo,
  OfficeSaveAsResult,
  OfficeSaveResult
} from '@shared/office-editor'

/** 一次保存的输入输出面（壳里由 OfficeWorkspace 注入真实实现） */
export interface OfficeSaveMachineDeps {
  documentId: string
  /** 生成当前文档字节（面内 flush + save）；失败回 null */
  requestSaveBytes: () => Promise<Uint8Array | null>
  /** 写回原文件（preload office.save） */
  saveIpc: (input: {
    documentId: string
    expectedSha256?: string
    bytes: Uint8Array
  }) => Promise<OfficeSaveResult>
  /** 另存为（preload office.saveAs；可选，缺省 = 不支持） */
  saveAsIpc?: (input: {
    documentId: string
    bytes: Uint8Array
    suggestedName?: string
  }) => Promise<OfficeSaveAsResult>
  /** 首版磁盘 sha（打开时读到的）；之后由每次成功写盘更新 */
  initialSha256?: string
  /** 建议的另存文件名（一般 = 当前 displayName） */
  suggestedName?: string
  /** dirty 投影变化（壳 markDirty/markSaved） */
  onDirtyChange: (dirty: boolean) => void
  /** 保存中投影变化（按钮 loading / 徽标「保存中」） */
  onSavingChange: (saving: boolean) => void
  /** 保存失败人话（壳错误条；dirty 保持） */
  onError: (message: string) => void
  /** 保存成功（壳可更新自己的基线/提示） */
  onSaved?: (result: { sha256: string; size: number; mtimeMs: number }) => void
  /**
   * A4.5：保存结果回执（壳把它转成 `doc:save-result` 回给面内 QAT）。
   *   - `save()` 成功/失败都调（失败带壳的分类 `code` 与可直接显示的人话）；
   *   - `saveAs()` 只在**成功**与非取消失败时调（用户主动取消另存为不算错误，不改 QAT 保存态）。
   */
  onSaveResult?: (result: { ok: boolean; code?: string; message?: string }) => void
  /** 另存为成功（新路径/名字/版本；壳据此更新标签展示） */
  onSavedAs?: (document: OfficeDocumentInfo) => void
  /** savedAt 时钟（单测注入固定值，缺省 Date.now） */
  now?: () => number
}

export interface OfficeSaveMachine {
  /** 面报告一次用户编辑（doc:changed）：editSeq++，dirty 投影置真 */
  onChanged(): void
  /** 当前是否脏（真相 = editSeq !== savedSeq） */
  isDirty(): boolean
  /** 当前是否保存中 */
  isSaving(): boolean
  /** 最近一次已知的磁盘 sha（下次保存的 expectedSha256） */
  lastKnownSha256(): string | undefined
  /** 三阶段保存；重复点击时复用同一次在途保存（不重复发 IPC / 不重复 generate） */
  save(): Promise<boolean>
  /** 另存为（用户选了"保存失败 → 另存"或显式入口）；成功后同样按 seq 判脏 */
  saveAs(): Promise<boolean>
  /** 冲突后从磁盘重载成功：以磁盘字节为新基线（dirty 由壳另外复位） */
  noteReloaded(sha256: string): void
}

export function createOfficeSaveMachine(deps: OfficeSaveMachineDeps): OfficeSaveMachine {
  let editSeq = 0
  let savedSeq = 0
  let saving = false
  let lastKnownSha256 = deps.initialSha256
  let inFlight: Promise<boolean> | null = null

  const dirty = (): boolean => editSeq !== savedSeq
  const publishDirty = (): void => {
    deps.onDirtyChange(dirty())
  }
  /** A4.5：把写盘结果回执出去（回执失败不影响写盘本身的结果） */
  const publishSaveResult = (result: { ok: boolean; code?: string; message?: string }): void => {
    try {
      deps.onSaveResult?.(result)
    } catch {
      // 回执只是"告知面内 QAT"，出问题不能反噬保存链路
    }
  }

  const onChanged = (): void => {
    editSeq += 1
    publishDirty()
  }

  /** 写盘成功后的 commit：只把"生成字节那次"的 seq 记为已保存；期间有新编辑就仍是脏 */
  const commit = (seqAtSave: number, sha256: string): void => {
    lastKnownSha256 = sha256
    savedSeq = seqAtSave
    publishDirty()
  }

  const finish = (): void => {
    saving = false
    inFlight = null
    deps.onSavingChange(false)
  }

  const generate = async (): Promise<Uint8Array | null> => {
    try {
      return await deps.requestSaveBytes()
    } catch (error) {
      deps.onError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const save = (): Promise<boolean> => {
    if (saving) return inFlight ?? Promise.resolve(false)
    saving = true
    deps.onSavingChange(true)
    // 关键：seq 在**生成字节之前**就定下（这次保存覆盖的内容就是这一刻的状态）
    const seqAtSave = editSeq
    const run = async (): Promise<boolean> => {
      try {
        const bytes = await generate()
        if (bytes === null || bytes.byteLength === 0) {
          deps.onError('没能生成保存内容')
          publishSaveResult({ ok: false, code: 'save-failed', message: '没能生成保存内容' })
          return false
        }
        const result = await deps.saveIpc({
          documentId: deps.documentId,
          bytes,
          ...(lastKnownSha256 === undefined ? {} : { expectedSha256: lastKnownSha256 })
        })
        if (!result.ok) {
          deps.onError(result.message)
          // 失败分类原样回给面内 QAT（write-locked / conflict / no-space / write-failed …）
          publishSaveResult({ ok: false, code: result.code, message: result.message })
          return false
        }
        commit(seqAtSave, result.sha256)
        deps.onSaved?.({ sha256: result.sha256, size: result.size, mtimeMs: result.mtimeMs })
        publishSaveResult({ ok: true })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.onError(message)
        publishSaveResult({ ok: false, code: 'write-failed', message })
        return false
      } finally {
        finish()
      }
    }
    inFlight = run()
    return inFlight
  }

  const saveAs = (): Promise<boolean> => {
    if (saving) return inFlight ?? Promise.resolve(false)
    if (deps.saveAsIpc === undefined) {
      deps.onError('当前版本不支持另存为')
      publishSaveResult({ ok: false, code: 'save-failed', message: '当前版本不支持另存为' })
      return Promise.resolve(false)
    }
    saving = true
    deps.onSavingChange(true)
    const seqAtSave = editSeq
    const run = async (): Promise<boolean> => {
      try {
        const bytes = await generate()
        if (bytes === null || bytes.byteLength === 0) {
          deps.onError('没能生成保存内容')
          publishSaveResult({ ok: false, code: 'save-failed', message: '没能生成保存内容' })
          return false
        }
        const result = await deps.saveAsIpc?.({
          documentId: deps.documentId,
          bytes,
          ...(deps.suggestedName === undefined ? {} : { suggestedName: deps.suggestedName })
        })
        if (result === undefined) {
          deps.onError('当前版本不支持另存为')
          publishSaveResult({ ok: false, code: 'save-failed', message: '当前版本不支持另存为' })
          return false
        }
        if (!result.ok) {
          deps.onError(result.message)
          // 用户主动取消另存为（cancelled）不是错误：不回执，面内 QAT 保持原状态
          if (result.code !== 'cancelled') {
            publishSaveResult({ ok: false, code: result.code, message: result.message })
          }
          return false
        }
        commit(seqAtSave, result.document.sha256)
        deps.onSavedAs?.(result.document)
        deps.onSaved?.({
          sha256: result.document.sha256,
          size: result.document.size,
          mtimeMs: result.document.mtimeMs
        })
        // 另存为成功 = 内容已落盘：面内 QAT 也进「已保存」
        publishSaveResult({ ok: true })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.onError(message)
        publishSaveResult({ ok: false, code: 'write-failed', message })
        return false
      } finally {
        finish()
      }
    }
    inFlight = run()
    return inFlight
  }

  return {
    onChanged,
    isDirty: dirty,
    isSaving: () => saving,
    lastKnownSha256: () => lastKnownSha256,
    save,
    saveAs,
    noteReloaded: (sha256: string) => {
      lastKnownSha256 = sha256
      savedSeq = editSeq
      publishDirty()
    }
  }
}
