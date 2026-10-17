// @vitest-environment node
/**
 * 知识库存储（`src/main/knowledge.ts`）：导入复制 / 白名单 / 上限 / 二进制拒绝 / 截断 /
 * 搜索 snippet / 重命名 / 删除三清 / index 自愈。
 *
 * 全部用**真磁盘**（mkdtemp 临时目录 + 真字节夹具），不 mock fs —— 存储层的 bug 基本都在
 * 路径与编码细节上，mock 掉 fs 等于没测。每例自己建/清临时目录。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_IMPORT_MAX_FILES,
  KNOWLEDGE_TEXT_MAX
} from '../../shared/knowledge'
import {
  deleteKnowledge,
  importKnowledgeFiles,
  knowledgeDirOf,
  knowledgeFilesDir,
  knowledgeIndexPath,
  knowledgeTextDir,
  listKnowledge,
  readKnowledgeText,
  renameKnowledge,
  resolveKnowledgeReveal,
  searchKnowledge
} from '../knowledge'

let root: string
let knowledgeDir: string
let sourceDir: string

/** 造一份源文件（写进 sourceDir，返回绝对路径） */
function sourceFile(name: string, content: string | Uint8Array): string {
  const path = join(sourceDir, name)
  writeFileSync(path, content)
  return path
}

function readIndexJson(): {
  version: number
  documents: Array<{
    id: string
    title: string
    originalPath: string
    ext: string
    truncated: boolean
  }>
} {
  return JSON.parse(readFileSync(knowledgeIndexPath(knowledgeDir), 'utf8')) as ReturnType<
    typeof readIndexJson
  >
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-knowledge-'))
  knowledgeDir = knowledgeDirOf(root)
  sourceDir = join(root, 'sources')
  mkdirSync(sourceDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('导入：复制原字节 + 索引 + 抽取文本', () => {
  it('白名单文件被复制进 files/、解码进 text/、索引入 index.json（原子写不留 tmp）', () => {
    const path = sourceFile('会议纪要.md', '# 周会\n\n决定：下周上线。')
    const result = importKnowledgeFiles(knowledgeDir, [path])

    expect(result.skipped).toEqual([])
    expect(result.documents).toHaveLength(1)
    const doc = result.documents[0]
    expect(doc.title).toBe('会议纪要.md')
    expect(doc.originalPath).toBe(path)
    expect(doc.ext).toBe('md')
    expect(doc.size).toBe(statSync(path).size)
    expect(doc.charCount).toBe(14)
    expect(doc.excerpt).toBe('# 周会 决定：下周上线。')

    // 三处落盘：index / files / text（原文件不动）
    const index = readIndexJson()
    expect(index.version).toBe(1)
    expect(index.documents).toHaveLength(1)
    expect(index.documents[0].id).toBe(doc.id)
    expect(index.documents[0].truncated).toBe(false)
    expect(existsSync(join(knowledgeFilesDir(knowledgeDir), `${doc.id}.md`))).toBe(true)
    expect(readFileSync(join(knowledgeTextDir(knowledgeDir), `${doc.id}.txt`), 'utf8')).toBe(
      '# 周会\n\n决定：下周上线。'
    )
    expect(existsSync(`${knowledgeIndexPath(knowledgeDir)}.tmp`)).toBe(false)
    expect(statSync(path).isFile()).toBe(true)

    // list 走同一份索引（按加入时间倒序）
    expect(listKnowledge(knowledgeDir).map((item) => item.id)).toEqual([doc.id])
  })

  it('同一路径重复导入进 skipped（不重复复制）', () => {
    const path = sourceFile('a.txt', '内容')
    importKnowledgeFiles(knowledgeDir, [path])
    const again = importKnowledgeFiles(knowledgeDir, [path])

    expect(again.documents).toEqual([])
    expect(again.skipped).toEqual([{ name: 'a.txt', reason: '这个文件已经在知识库里了' }])
    expect(listKnowledge(knowledgeDir)).toHaveLength(1)
  })

  it('一次最多导入 20 个（多出来的这层直接不处理）', () => {
    const paths = Array.from({ length: KNOWLEDGE_IMPORT_MAX_FILES + 3 }, (_, index) =>
      sourceFile(`f${String(index)}.txt`, `内容 ${String(index)}`)
    )
    const result = importKnowledgeFiles(knowledgeDir, paths)
    expect(result.documents).toHaveLength(KNOWLEDGE_IMPORT_MAX_FILES)
    expect(listKnowledge(knowledgeDir)).toHaveLength(KNOWLEDGE_IMPORT_MAX_FILES)
  })
})

describe('导入：拒绝 + skipped 人话', () => {
  it('非白名单扩展名 / 不是文件 / 不存在的路径都进 skipped 且不落盘', () => {
    const exe = sourceFile('setup.exe', 'MZ')
    const missing = join(sourceDir, '没了.txt')
    const dirPath = sourceDir
    const result = importKnowledgeFiles(knowledgeDir, [exe, missing, dirPath])

    expect(result.documents).toEqual([])
    expect(result.skipped.map((item) => item.name)).toEqual(['setup.exe', '没了.txt', 'sources'])
    expect(result.skipped[0].reason).toContain('不支持的格式')
    expect(result.skipped[1].reason).toContain('读不了这个文件')
    expect(result.skipped[2].reason).toContain('不是普通文件')
    // 一条都没收：索引里没有文档、files/ 里没有文件（读索引时自愈可能建一个空 index，可接受）
    expect(readIndexJson().documents).toEqual([])
    expect(readdirSync(knowledgeFilesDir(knowledgeDir))).toEqual([])
  })

  it('超过 5 MB 的文件被拒（原因里带实际上限）', () => {
    const big = sourceFile('big.txt', Buffer.alloc(KNOWLEDGE_FILE_MAX_BYTES + 1, 0x61))
    const result = importKnowledgeFiles(knowledgeDir, [big])

    expect(result.documents).toEqual([])
    expect(result.skipped[0].reason).toContain('文件太大')
    expect(result.skipped[0].reason).toContain('5 MB')
  })

  it('含 NUL 的二进制文件被拒（不做"硬解出乱码"）', () => {
    const binary = sourceFile('blob.txt', Buffer.from([0x61, 0x00, 0x62]))
    const result = importKnowledgeFiles(knowledgeDir, [binary])

    expect(result.documents).toEqual([])
    expect(result.skipped[0].reason).toContain('二进制')
    expect(listKnowledge(knowledgeDir)).toEqual([])
  })

  it('非法 UTF-8 字节被拒（如实说"不是 UTF-8 文本"）', () => {
    const bad = sourceFile('gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) // GBK 的「中文」
    const result = importKnowledgeFiles(knowledgeDir, [bad])

    expect(result.documents).toEqual([])
    expect(result.skipped[0].reason).toContain('UTF-8')
  })
})

describe('readText：超过 2 MB 截断并如实标记', () => {
  it('2 MB + 一点的长文本：只存前面的，readText 回 truncated=true', () => {
    const long = sourceFile('long.txt', 'a'.repeat(KNOWLEDGE_TEXT_MAX + 2))
    const result = importKnowledgeFiles(knowledgeDir, [long])
    const doc = result.documents[0]

    expect(doc.charCount).toBe(KNOWLEDGE_TEXT_MAX)
    const read = readKnowledgeText(knowledgeDir, doc.id)
    expect(read.truncated).toBe(true)
    expect(read.text).toHaveLength(KNOWLEDGE_TEXT_MAX)
    expect(read.text.endsWith('尾巴')).toBe(false)

    // 短文本不截断
    const short = sourceFile('short.txt', '短文本')
    const shortDoc = importKnowledgeFiles(knowledgeDir, [short]).documents[0]
    expect(readKnowledgeText(knowledgeDir, shortDoc.id)).toEqual({
      text: '短文本',
      truncated: false
    })
  })
})

describe('搜索：大小写不敏感 + snippet ±60 + 上限', () => {
  it('正文命中给上下文片段（含省略号），标题命中也能搜到', () => {
    const body = `${'前'.repeat(100)}知识图谱${'后'.repeat(100)}`
    const path = sourceFile('资料.txt', body)
    const doc = importKnowledgeFiles(knowledgeDir, [path]).documents[0]
    const titled = importKnowledgeFiles(knowledgeDir, [sourceFile('深度学习笔记.md', '无关正文')])
      .documents[0]

    const hits = searchKnowledge(knowledgeDir, '知识图谱')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(doc.id)
    expect(hits[0].snippet).toContain('知识图谱')
    expect(hits[0].snippet.startsWith('…')).toBe(true)

    // 大小写不敏感 + 标题命中
    const titleHits = searchKnowledge(knowledgeDir, '深度学习')
    expect(titleHits.map((hit) => hit.id)).toEqual([titled.id])
    expect(searchKnowledge(knowledgeDir, '    ')).toEqual([])
    expect(searchKnowledge(knowledgeDir, '不存在的词')).toEqual([])
  })

  it('命中数上限 50（不会把整库都吐回来）', () => {
    for (let index = 0; index < 55; index += 1) {
      importKnowledgeFiles(knowledgeDir, [sourceFile(`f${String(index)}.txt`, '共同关键词')])
    }
    expect(searchKnowledge(knowledgeDir, '共同关键词')).toHaveLength(50)
  })
})

describe('rename / delete / reveal', () => {
  it('rename 只改标题与 updatedAt（originalPath 与库内字节不动）', () => {
    const path = sourceFile('旧名.txt', '正文')
    const doc = importKnowledgeFiles(knowledgeDir, [path]).documents[0]
    const renamed = renameKnowledge(knowledgeDir, { id: doc.id, title: '新标题' })

    expect(renamed.title).toBe('新标题')
    expect(renamed.originalPath).toBe(path)
    expect(renamed.updatedAt >= doc.updatedAt).toBe(true)
    expect(listKnowledge(knowledgeDir)[0].title).toBe('新标题')
    expect(readFileSync(join(knowledgeFilesDir(knowledgeDir), `${doc.id}.txt`), 'utf8')).toBe(
      '正文'
    )
  })

  it('delete 三处一起清；不存在的 id 给人话', () => {
    const doc = importKnowledgeFiles(knowledgeDir, [sourceFile('删.txt', 'x')]).documents[0]
    expect(resolveKnowledgeReveal(knowledgeDir, doc.id)).toContain(`${doc.id}.txt`)

    deleteKnowledge(knowledgeDir, doc.id)
    expect(listKnowledge(knowledgeDir)).toEqual([])
    expect(readIndexJson().documents).toEqual([])
    expect(existsSync(join(knowledgeFilesDir(knowledgeDir), `${doc.id}.txt`))).toBe(false)
    expect(existsSync(join(knowledgeTextDir(knowledgeDir), `${doc.id}.txt`))).toBe(false)
    expect(() => deleteKnowledge(knowledgeDir, doc.id)).toThrow('没有这条资料')
  })
})

describe('index 自愈', () => {
  it('index.json 被删：按 files/ 重建（标题退回库内文件名）且能继续搜索', () => {
    const doc = importKnowledgeFiles(knowledgeDir, [sourceFile('自愈.txt', '重建后还能搜到关键词')])
      .documents[0]

    unlinkSync(knowledgeIndexPath(knowledgeDir))
    const rebuilt = listKnowledge(knowledgeDir)
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].id).toBe(doc.id)
    expect(rebuilt[0].title).toBe(`${doc.id}.txt`)
    expect(rebuilt[0].charCount).toBe(10)
    expect(searchKnowledge(knowledgeDir, '关键词')).toHaveLength(1)
    // 自愈结果已落盘
    expect(readIndexJson().documents).toHaveLength(1)
  })

  it('index.json 坏掉（非 JSON）：同样重建，不整页失败', () => {
    importKnowledgeFiles(knowledgeDir, [sourceFile('坏索引.txt', '正文')])
    writeFileSync(knowledgeIndexPath(knowledgeDir), '{ 这不是 JSON', 'utf8')

    const rebuilt = listKnowledge(knowledgeDir)
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].excerpt).toBe('正文')
  })
})
