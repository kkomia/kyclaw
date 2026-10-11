// @vitest-environment node
/**
 * 模块 3B：GGUF 头部读取（自定义模型的把门与元数据）。
 *
 * 这一层只做两件事：**不是 GGUF 就当场说**（别等引擎起不来才报一句引擎错误）、
 * **把元数据里声明的池化方式读出来记上**（池化错了召回会悄悄变差，值得留证据）。
 * 测试用合成的 GGUF 头（字节由本文件拼，跟 gguf.ts 的解析逐字段对齐），
 * 真实档位的元数据在 recall-local-engine.spec.ts 里用真文件核。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readGgufInfo } from '../llama/gguf'

const dirs: string[] = []

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-gguf-'))
  dirs.push(dir)
  return dir
}

const TYPE_UINT32 = 4
const TYPE_STRING = 8

function kvUint32(key: string, value: number): Buffer {
  const name = Buffer.from(key, 'utf8')
  const head = Buffer.alloc(8 + name.length + 4 + 4)
  head.writeBigUInt64LE(BigInt(name.length), 0)
  name.copy(head, 8)
  head.writeUInt32LE(TYPE_UINT32, 8 + name.length)
  head.writeUInt32LE(value, 8 + name.length + 4)
  return head
}

function kvString(key: string, value: string): Buffer {
  const name = Buffer.from(key, 'utf8')
  const text = Buffer.from(value, 'utf8')
  const head = Buffer.alloc(8 + name.length + 4 + 8 + text.length)
  head.writeBigUInt64LE(BigInt(name.length), 0)
  name.copy(head, 8)
  let offset = 8 + name.length
  head.writeUInt32LE(TYPE_STRING, offset)
  offset += 4
  head.writeBigUInt64LE(BigInt(text.length), offset)
  text.copy(head, offset + 8)
  return head
}

/** 拼一个合成 GGUF 头（KV 之后的内容不重要：本读取器只看头） */
function syntheticGguf(pairs: Buffer[], padding = 64): Buffer {
  const head = Buffer.alloc(24)
  head.write('GGUF', 0, 'ascii')
  head.writeUInt32LE(3, 4)
  head.writeBigUInt64LE(1n, 8) // tensor_count
  head.writeBigUInt64LE(BigInt(pairs.length), 16)
  return Buffer.concat([head, ...pairs, Buffer.alloc(padding, 0)])
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('GGUF 头部读取', () => {
  it('读出架构 / 名字 / 池化 / 向量维度（池化的值按 llama.cpp 的枚举翻）', async () => {
    const file = join(workDir(), 'model.gguf')
    writeFileSync(
      file,
      syntheticGguf([
        kvString('general.architecture', 'bert'),
        kvString('general.name', 'bge-small-zh-v1.5'),
        kvUint32('bert.pooling_type', 2),
        kvUint32('bert.embedding_length', 512)
      ])
    )

    const info = await readGgufInfo(file)
    expect(info.version).toBe(3)
    expect(info.architecture).toBe('bert')
    expect(info.name).toBe('bge-small-zh-v1.5')
    expect(info.pooling).toBe('cls')
    expect(info.embeddingLength).toBe(512)
    expect(info.parsedKeys).toBe(4)
    expect(info.truncated).toBe(false)
  })

  it('last / mean / none 的枚举值都对得上（Qwen3-Embedding 是 last）', async () => {
    const cases: Array<[number, string]> = [
      [3, 'last'],
      [1, 'mean'],
      [0, 'none'],
      [5, 'rank']
    ]
    for (const [value, expected] of cases) {
      const file = join(workDir(), `pooling-${value}.gguf`)
      writeFileSync(file, syntheticGguf([kvUint32('qwen3.pooling_type', value)]))
      expect((await readGgufInfo(file)).pooling).toBe(expected)
    }
  })

  it('不是 GGUF（任意文件）：当场回人话', async () => {
    const file = join(workDir(), 'not-a-model.gguf')
    writeFileSync(file, Buffer.from('这不是模型，只是一段文本'.repeat(10), 'utf8'))
    await expect(readGgufInfo(file)).rejects.toThrow(/不是 GGUF/)
  })

  it('文件不存在：回人话（不是 ENOENT 原文）', async () => {
    await expect(readGgufInfo(join(workDir(), '没有这个文件.gguf'))).rejects.toThrow(
      /打不开这个文件/
    )
  })

  it('读取窗口不够：如实回 truncated，不抛、不猜', async () => {
    const file = join(workDir(), 'big.gguf')
    writeFileSync(
      file,
      syntheticGguf([
        kvString('general.architecture', 'bert'),
        kvUint32('bert.pooling_type', 2),
        kvString('tokenizer.ggml.model', 'x'.repeat(4096))
      ])
    )
    const info = await readGgufInfo(file, { maxBytes: 128 })
    expect(info.truncated).toBe(true)
    expect(info.architecture).toBe('bert')
    // 读不到的不编：池化那条在窗口外就给 null（调用方按"元数据没写"处理）
    expect(info.pooling === null || info.pooling === 'cls').toBe(true)
  })
})
