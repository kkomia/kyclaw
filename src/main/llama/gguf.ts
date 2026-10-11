/**
 * GGUF 头部读取（模块 3B）：**只为"自定义模型"这一路服务**。
 *
 * 用途有两件事：
 *   1. 用户自备 GGUF 时把门：不是 GGUF、版本不认识 → 立刻回人话（而不是等引擎起不来再说一句引擎错误）；
 *   2. 读元数据里声明的**池化方式**（`<arch>.pooling_type`）与架构名，落进"当前生效模型"的记录里，
 *      界面与报告据此说清这个文件的来头（池化错了召回会悄悄变差，值得记一笔）。
 *
 * 只读文件**前 1MB**（缺省）并按 GGUF v3 的顺序解析 KV：候选档的关键项（architecture / embedding_length /
 * pooling_type）都在 tokenizer 之前写完（实测四个档位都如此），所以够用；读不到就如实回 null，
 * 不猜、不编（自定义档的向量维度最终以**引擎实际输出**为准）。
 */
import { open } from 'node:fs/promises'

export type GgufPooling = 'none' | 'mean' | 'cls' | 'last' | 'rank'

export interface GgufInfo {
  version: number
  architecture: string | null
  name: string | null
  pooling: GgufPooling | null
  embeddingLength: number | null
  /** 解析成功的 KV 条数（诊断用） */
  parsedKeys: number
  /** 只读了前 N 字节（元数据比窗口还长时 true） */
  truncated: boolean
}

/** GGUF 元数据类型编号（规格里的枚举，不引 const enum——isolatedModules 下不允许） */
const TYPE_UINT8 = 0
const TYPE_INT8 = 1
const TYPE_UINT16 = 2
const TYPE_INT16 = 3
const TYPE_UINT32 = 4
const TYPE_INT32 = 5
const TYPE_FLOAT32 = 6
const TYPE_BOOL = 7
const TYPE_STRING = 8
const TYPE_ARRAY = 9
const TYPE_UINT64 = 10
const TYPE_INT64 = 11
const TYPE_FLOAT64 = 12

/** 定长类型的字节数 */
const SCALAR_SIZE: Record<number, number> = {
  [TYPE_UINT8]: 1,
  [TYPE_INT8]: 1,
  [TYPE_UINT16]: 2,
  [TYPE_INT16]: 2,
  [TYPE_UINT32]: 4,
  [TYPE_INT32]: 4,
  [TYPE_FLOAT32]: 4,
  [TYPE_BOOL]: 1,
  [TYPE_UINT64]: 8,
  [TYPE_INT64]: 8,
  [TYPE_FLOAT64]: 8
}

/** llama.cpp 的 pooling 枚举（值 → 名字） */
const POOLING_BY_VALUE: Record<number, GgufPooling> = {
  0: 'none',
  1: 'mean',
  2: 'cls',
  3: 'last',
  5: 'rank'
}

/** 读取光标：越界抛 RangeError（调用方当"元数据没读完"，不当事故） */
class Cursor {
  constructor(
    private readonly buffer: Buffer,
    public offset = 0
  ) {}

  private need(bytes: number): void {
    if (this.offset + bytes > this.buffer.length) throw new RangeError('元数据超出读取窗口')
  }

  u8(): number {
    this.need(1)
    return this.buffer.readUInt8(this.offset++)
  }

  u16(): number {
    this.need(2)
    const value = this.buffer.readUInt16LE(this.offset)
    this.offset += 2
    return value
  }

  u32(): number {
    this.need(4)
    const value = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return value
  }

  i32(): number {
    this.need(4)
    const value = this.buffer.readInt32LE(this.offset)
    this.offset += 4
    return value
  }

  u64(): bigint {
    this.need(8)
    const value = this.buffer.readBigUInt64LE(this.offset)
    this.offset += 8
    return value
  }

  i64(): bigint {
    this.need(8)
    const value = this.buffer.readBigInt64LE(this.offset)
    this.offset += 8
    return value
  }

  f32(): number {
    this.need(4)
    const value = this.buffer.readFloatLE(this.offset)
    this.offset += 4
    return value
  }

  f64(): number {
    this.need(8)
    const value = this.buffer.readDoubleLE(this.offset)
    this.offset += 8
    return value
  }

  string(): string {
    const length = Number(this.u64())
    this.need(length)
    const value = this.buffer.toString('utf8', this.offset, this.offset + length)
    this.offset += length
    return value
  }

  skip(bytes: number): void {
    this.need(bytes)
    this.offset += bytes
  }
}

/** 读一个标量 */
function readScalar(cursor: Cursor, type: number): unknown {
  switch (type) {
    case TYPE_UINT8:
      return cursor.u8()
    case TYPE_INT8:
      return (cursor.u8() << 24) >> 24
    case TYPE_UINT16:
      return cursor.u16()
    case TYPE_INT16:
      return (cursor.u16() << 16) >> 16
    case TYPE_UINT32:
      return cursor.u32()
    case TYPE_INT32:
      return cursor.i32()
    case TYPE_UINT64:
      return cursor.u64()
    case TYPE_INT64:
      return cursor.i64()
    case TYPE_FLOAT32:
      return cursor.f32()
    case TYPE_FLOAT64:
      return cursor.f64()
    case TYPE_BOOL:
      return cursor.u8() !== 0
    default:
      throw new RangeError('这个类型不是标量')
  }
}

/** 读（或跳过）一个值；数组只看长度、不做保留 */
function readValue(cursor: Cursor, type: number): unknown {
  if (type === TYPE_STRING) return cursor.string()
  if (type === TYPE_ARRAY) {
    const itemType = cursor.u32()
    const count = Number(cursor.u64())
    const size = SCALAR_SIZE[itemType]
    if (size !== undefined) {
      cursor.skip(size * count)
    } else if (itemType === TYPE_STRING) {
      for (let index = 0; index < count; index++) cursor.string()
    } else if (itemType === TYPE_ARRAY) {
      for (let index = 0; index < count; index++) readValue(cursor, TYPE_ARRAY)
    } else {
      throw new RangeError('数组元素类型不认识')
    }
    return undefined
  }
  return readScalar(cursor, type)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

/**
 * 读一个 GGUF 的头部信息。**会抛**（人话）：打不开文件、前四字节不是 `GGUF`。
 * 元数据中途读不动（窗口不够 / 类型不认识）不抛：返回已经读到的部分（`truncated: true`）。
 */
export async function readGgufInfo(
  file: string,
  options: { maxBytes?: number } = {}
): Promise<GgufInfo> {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    throw new Error(`打不开这个文件：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    if (bytesRead < 8 || buffer.subarray(0, 4).toString('ascii') !== 'GGUF') {
      throw new Error('这个文件不是 GGUF 模型（文件头不是 GGUF）')
    }
    const cursor = new Cursor(buffer.subarray(0, bytesRead))
    cursor.skip(4)
    const version = cursor.u32()
    cursor.u64() // tensor_count
    const kvCount = Number(cursor.u64())

    const info: GgufInfo = {
      version,
      architecture: null,
      name: null,
      pooling: null,
      embeddingLength: null,
      parsedKeys: 0,
      truncated: false
    }

    try {
      for (let index = 0; index < kvCount; index++) {
        const key = cursor.string()
        const type = cursor.u32()
        const value = readValue(cursor, type)
        info.parsedKeys += 1
        if (key === 'general.architecture') info.architecture = asString(value)
        else if (key === 'general.name') info.name = asString(value)
        else if (key.endsWith('.pooling_type')) {
          const raw = asNumber(value)
          if (raw !== null) info.pooling = POOLING_BY_VALUE[raw] ?? null
        } else if (key.endsWith('.embedding_length')) {
          const raw = asNumber(value)
          if (raw !== null) info.embeddingLength = raw
        }
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      info.truncated = true
    }
    return info
  } finally {
    await handle.close()
  }
}
