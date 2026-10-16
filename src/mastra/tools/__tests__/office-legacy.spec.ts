// @vitest-environment node
/**
 * `convertLegacyOffice`（旧版 Office → OOXML）的聚焦用例 + 真夹具探针。
 *
 * 这个文件分两段，**别把两段混着说**：
 *   - **单测段**（默认跑）：子进程与临时目录**全是注入的假件** —— 一个真进程都不起、不碰随包引擎。
 *     钉住的是本模块自己的口径：两条输入闸（扩展名 + OLE 头）、原件一个字节都不动、副本落在自建目录、
 *     参数形状（kit 的 `convert` 四件套 + 超时/上限）、失败一律人话、**成功路径也要真的校验产出**
 *     （PK 头 + `[Content_Types].xml` 的主部件类型 + 主部件在包内）、自建目录无论成败都被收干净。
 *   - **真夹具段**（gated：`KYCLAW_OFFICE_LEGACY_REAL=1`）：真起随包引擎、真转真文件。判据是
 *     "三格式全覆盖（6 个无宏主例）+ 含宏件能转"，**门开着而夹具/引擎缺就直接失败**，不静默跳过；
 *     没开门时整段 skip（夹具是二进制、不入库）。夹具来源与哈希见文件尾。
 *
 * 为什么单测里输入只是"有 OLE 头的假文件"：单测要证的是**我们的闸与形状**，不是引擎能不能解析它；
 * 引擎那条路只有真夹具能证（伪造的 OLE 或改名文件都不算数），两件事分开摆才不会互相冒充。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readZipEntries } from '../artifact-check'
import {
  LEGACY_CONVERT_TIMEOUT_MS,
  LEGACY_INPUT_MAX_BYTES,
  LEGACY_OUTPUT_MAX_BYTES,
  LEGACY_RUN_GRACE_MS,
  convertLegacyOffice,
  legacyConverterAvailable,
  type LegacyOfficeFormat,
  type LegacyOfficeKind,
  type LegacyRunSpec,
  type LegacyRunner
} from '../office-legacy'

/** 只造一份"头对、其余是填充"的输入（单测专用；真夹具见文件尾） */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

function fakeOle(size = 256): Buffer {
  const bytes = Buffer.alloc(size, 0x41)
  OLE_HEAD.copy(bytes, 0)
  return bytes
}

/** 注入用的假 kit CLI 路径（真路径由 `resolveKitCli()` 找，单测不许跟着开发机变） */
const KIT = 'C:/fake/libreoffice-kit/cli.js'

/** 单测里期望的主部件/主类型（与模块里的判据表故意分开写一份：改了那边这里会红） */
const EXPECTED: Readonly<Record<LegacyOfficeFormat, { type: string; part: string }>> = {
  docx: {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    part: 'word/document.xml'
  },
  xlsx: {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    part: 'xl/workbook.xml'
  },
  pptx: {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    part: 'ppt/presentation.xml'
  }
}

const TARGET: Readonly<Record<LegacyOfficeKind, LegacyOfficeFormat>> = {
  doc: 'docx',
  xls: 'xlsx',
  ppt: 'pptx'
}

interface ZipEntrySpec {
  name: string
  body: string
  deflate?: boolean
}

/**
 * 造一份 zip32（store 或 deflate 两种都支持）。
 * 只填我们校验器真正读的字段：**CRC 一律写 0**（那一层不查 CRC，包完整性由下游抽取器负责），
 * 但方法/长度/局部头偏移必须是真的 —— 否则测的就不是"能读通"而是"读不通"。
 */
function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = Buffer.from(entry.body, 'utf8')
    const packed = entry.deflate === true ? deflateRawSync(raw) : raw
    const method = entry.deflate === true ? 8 : 0
    const name = Buffer.from(entry.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, packed)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0, 8)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt32LE(0, 12)
    directory.writeUInt32LE(0, 16)
    directory.writeUInt32LE(packed.length, 20)
    directory.writeUInt32LE(raw.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt16LE(0, 30)
    directory.writeUInt16LE(0, 32)
    directory.writeUInt16LE(0, 34)
    directory.writeUInt16LE(0, 36)
    directory.writeUInt32LE(0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)

    offset += local.length + name.length + packed.length
  }

  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)

  return Buffer.concat([localPart, centralPart, eocd])
}

/** 一份最小但**结构上真的** OOXML 包（content-types 声明主类型 + 主部件在包内） */
function ooxmlPackage(format: LegacyOfficeFormat, options: { deflated?: boolean } = {}): Buffer {
  const spec = EXPECTED[format]
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/${spec.part}" ContentType="${spec.type}"/>` +
    '</Types>'
  return buildZip([
    { name: '[Content_Types].xml', body: contentTypes, deflate: options.deflated === true },
    { name: spec.part, body: '<?xml version="1.0"?><root/>', deflate: options.deflated === true }
  ])
}

/** 取注入 spec 里某个 flag 的值（断言与伪造产出都靠它） */
function flagOf(spec: LegacyRunSpec, flag: string): string {
  const index = spec.args.indexOf(flag)
  return index < 0 ? '' : (spec.args[index + 1] ?? '')
}

interface Recorded {
  spec: LegacyRunSpec
  /** 引擎那一刻读到的输入副本（目录随后就被删了，所以必须当场抄下来） */
  input: Buffer
}

/** 成功件：把一份真 OOXML 写到 `--output`，并把 spec 与输入副本记下来 */
function okRunner(
  format: LegacyOfficeFormat,
  options: { deflated?: boolean; record?: Recorded[] } = {}
): LegacyRunner {
  return async (spec) => {
    if (options.record !== undefined) {
      options.record.push({ spec, input: await readFile(flagOf(spec, '--input')) })
    }
    await writeFile(flagOf(spec, '--output'), ooxmlPackage(format, options))
    return {
      spawnError: null,
      aborted: false,
      timedOut: false,
      exitCode: 0,
      text: '{"backend":"native","missingFonts":[],"outputPath":""}\n'
    }
  }
}

/** 失败件：退出码非零 + kit 那行 JSON（真 CLI 把失败写在 stderr，runProcess 会并进同一份 text） */
function failingRunner(code: string, error = '引擎原话'): LegacyRunner {
  return async () => ({
    spawnError: null,
    aborted: false,
    timedOut: false,
    exitCode: 1,
    text: `some noise\n{"code":"${code}","error":"${error}"}\n`
  })
}

/** 谁也不许调到的 runner（用它断言"这一支在起进程之前就该被拦住"） */
const neverRun: LegacyRunner = async () => {
  throw new Error('不该起进程')
}

async function exists(path: string): Promise<boolean> {
  return await stat(path)
    .then(() => true)
    .catch(() => false)
}

/** 把抛出来的东西整理成 `Error`（断言 message/name 用） */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof Error) return cause
    throw new Error(`抛出来的不是 Error：${String(cause)}`)
  }
  throw new Error('没有抛错（预期这里必须抛）')
}

describe('convertLegacyOffice（单测：子进程与临时目录都是注入的）', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kyclaw-office-legacy-spec-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  })

  /** 写一份原件（默认：只有 OLE 头的假文件） */
  async function writeSource(kind: LegacyOfficeKind, bytes: Buffer = fakeOle()): Promise<string> {
    const path = join(workspace, `原件.${kind}`)
    await writeFile(path, bytes)
    return path
  }

  /** 注入的临时目录工厂：建在测试自己的工作区里，并记下建过哪些（用来断言"收干净了"） */
  function tempFactory(): { created: string[]; make: () => Promise<string> } {
    const created: string[] = []
    return {
      created,
      make: async () => {
        const dir = join(workspace, `tmp-${created.length}`)
        await mkdir(dir)
        created.push(dir)
        return dir
      }
    }
  }

  for (const kind of ['doc', 'xls', 'ppt'] as const) {
    it(`${kind} → ${TARGET[kind]}：跑 convert、副本进自建目录、产出校验通过、原件一个字节没动`, async () => {
      const source = await writeSource(kind)
      const sourceBytes = await readFile(source)
      const sourceStat = await stat(source)
      const temp = tempFactory()
      const record: Recorded[] = []

      const result = await convertLegacyOffice(source, kind, undefined, {
        kitCli: KIT,
        makeTempDir: temp.make,
        // 两个格式各盖一条压缩路径：store（xls）+ deflate（doc/ppt）
        run: okRunner(TARGET[kind], { deflated: kind !== 'xls', record })
      })

      expect(result.format).toBe(TARGET[kind])
      expect(result.bytes.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04')

      expect(record).toHaveLength(1)
      const { spec, input } = record[0]
      expect(spec.command).toBe(process.execPath)
      expect(spec.args.slice(0, 2)).toEqual([KIT, 'convert'])
      expect(spec.args).toContain('--output')
      expect(flagOf(spec, '--timeout-ms')).toBe(String(LEGACY_CONVERT_TIMEOUT_MS))
      expect(flagOf(spec, '--max-input-bytes')).toBe(String(LEGACY_INPUT_MAX_BYTES))
      expect(flagOf(spec, '--max-output-bytes')).toBe(String(LEGACY_OUTPUT_MAX_BYTES))
      expect(spec.timeoutMs).toBe(LEGACY_CONVERT_TIMEOUT_MS + LEGACY_RUN_GRACE_MS)
      // 与 render_ppt 同一条跑法：Electron 自带的 Node 模式跑 kit 的 CLI
      expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')

      // 引擎读到的是**副本**：在自建目录里、扩展名钉死成 .<kind>、内容与原件逐字节相同
      const inputCopy = flagOf(spec, '--input')
      expect(dirname(inputCopy)).toBe(temp.created[0])
      expect(inputCopy.endsWith(`input.${kind}`)).toBe(true)
      expect(input.equals(sourceBytes)).toBe(true)
      expect(flagOf(spec, '--output').startsWith(temp.created[0])).toBe(true)
      expect(spec.cwd).toBe(temp.created[0])

      // 原件三个维度都没动，而且自建目录已经收掉
      const after = await stat(source)
      expect((await readFile(source)).equals(sourceBytes)).toBe(true)
      expect(after.size).toBe(sourceStat.size)
      expect(after.mtimeMs).toBe(sourceStat.mtimeMs)
      expect(await exists(temp.created[0])).toBe(false)
    })
  }

  it('失败路径同样收掉自建目录（失败不留垃圾）', async () => {
    const source = await writeSource('doc')
    const temp = tempFactory()
    await expect(
      convertLegacyOffice(source, 'doc', undefined, {
        kitCli: KIT,
        makeTempDir: temp.make,
        run: failingRunner('invalid-document')
      })
    ).rejects.toThrow(/引擎读不出这份 \.doc/)
    expect(temp.created).toHaveLength(1)
    expect(await exists(temp.created[0])).toBe(false)
  })

  it('不认识的 kind：直接拒，不起进程也不建目录', async () => {
    const source = await writeSource('doc')
    const temp = tempFactory()
    // 运行时入参可能来自 JS（这里刻意用 string 走到 cast，模拟"调错了"那种）
    const bogusKind: string = 'wri'
    const error = await rejectionOf(
      convertLegacyOffice(source, bogusKind as LegacyOfficeKind, undefined, {
        kitCli: KIT,
        makeTempDir: temp.make,
        run: neverRun
      })
    )
    expect(error.message).toMatch(/不认识的 kind=wri/)
    expect(temp.created).toHaveLength(0)
  })

  it('相对路径：直接拒（路径授权与归一是调用方的事）', async () => {
    const error = await rejectionOf(
      convertLegacyOffice('相对路径.doc', 'doc', undefined, { kitCli: KIT, run: neverRun })
    )
    expect(error.message).toMatch(/只认绝对路径/)
  })

  it('扩展名与 kind 对不上：拒，不硬按 kind 转', async () => {
    const source = await writeSource('xls')
    const temp = tempFactory()
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, {
        kitCli: KIT,
        makeTempDir: temp.make,
        run: neverRun
      })
    )
    expect(error.message).toMatch(/扩展名是 \.xls，与 kind='doc' 对不上/)
    expect(temp.created).toHaveLength(0)
  })

  it('文件不存在 / 不是文件：人话', async () => {
    const error = await rejectionOf(
      convertLegacyOffice(join(workspace, '没有这份.doc'), 'doc', undefined, {
        kitCli: KIT,
        run: neverRun
      })
    )
    expect(error.message).toMatch(/不存在或不是文件/)
  })

  it('文件头不是 OLE：拒（改过扩展名的文本不会被当成旧版 Word）', async () => {
    const source = await writeSource('doc', Buffer.from('这其实是一份文本，只是叫 .doc', 'utf8'))
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run: neverRun })
    )
    expect(error.message).toMatch(/文件头不是旧版 Office 二进制（OLE）/)
  })

  it('输入超上限：如实拒并报真实大小（上限可注入，免得单测真写 64MB）', async () => {
    const source = await writeSource('xls')
    const error = await rejectionOf(
      convertLegacyOffice(source, 'xls', undefined, {
        kitCli: KIT,
        run: neverRun,
        inputMaxBytes: 8
      })
    )
    expect(error.message).toMatch(/超过单份 8 字节的上限/)
  })

  it('没装随包引擎：一句人话 + 下一步，且不建目录不起进程', async () => {
    const source = await writeSource('ppt')
    const temp = tempFactory()
    const error = await rejectionOf(
      convertLegacyOffice(source, 'ppt', undefined, {
        kitCli: null,
        makeTempDir: temp.make,
        run: neverRun
      })
    )
    expect(error.message).toMatch(/随包的 LibreOffice 没装上/)
    expect(temp.created).toHaveLength(0)
  })

  it('停止键已经响了：一个副作用都不留（不建目录、不复制、不起进程）', async () => {
    const source = await writeSource('doc')
    const temp = tempFactory()
    const controller = new AbortController()
    controller.abort()

    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', controller.signal, {
        kitCli: KIT,
        makeTempDir: temp.make,
        run: neverRun
      })
    )
    expect(error.name).toBe('AbortError')
    expect(error.message).toMatch(/已被用户中止/)
    expect(temp.created).toHaveLength(0)
  })

  it('进程收到中止：报"已被用户中止"（不是"转不了"）', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async () => ({
      spawnError: null,
      aborted: true,
      timedOut: false,
      exitCode: null,
      text: ''
    })
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.name).toBe('AbortError')
    expect(error.message).toMatch(/已被用户中止/)
  })

  it('进程超时：报超时（与中止分开）', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async () => ({
      spawnError: null,
      aborted: false,
      timedOut: true,
      exitCode: null,
      text: ''
    })
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run, timeoutMs: 1000 })
    )
    expect(error.name).not.toBe('AbortError')
    expect(error.message).toMatch(/转换超时（超过 31 秒）/)
  })

  it('起不了引擎（spawn 失败）：带出真实原因', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async () => ({
      spawnError: new Error('ENOENT'),
      aborted: false,
      timedOut: false,
      exitCode: null,
      text: ''
    })
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/起不了随包的 LibreOffice/)
    expect(error.message).toContain('ENOENT')
  })

  const failureCases: ReadonlyArray<{ code: string; pattern: RegExp }> = [
    { code: 'invalid-document', pattern: /引擎读不出这份 \.doc/ },
    { code: 'unsupported-format', pattern: /不支持这个转换方向/ },
    { code: 'input-too-large', pattern: /超过引擎的单份上限/ },
    { code: 'output-too-large', pattern: /超过单份/ },
    { code: 'timeout', pattern: /转换超时/ },
    { code: 'unavailable', pattern: /随包 LibreOffice 起不来/ },
    { code: 'failed', pattern: /转换 原件\.doc 时出错/ }
  ]

  for (const failure of failureCases) {
    it(`引擎报 ${failure.code}：按档回人话，并带上引擎原话`, async () => {
      const source = await writeSource('doc')
      const error = await rejectionOf(
        convertLegacyOffice(source, 'doc', undefined, {
          kitCli: KIT,
          run: failingRunner(failure.code)
        })
      )
      expect(error.message).toMatch(failure.pattern)
      expect(error.message).toContain('引擎原话')
    })
  }

  it('失败输出里没有那行 JSON：退回输出尾部（不编原因）', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async () => ({
      spawnError: null,
      aborted: false,
      timedOut: false,
      exitCode: 1,
      text: 'boom: engine exploded\n'
    })
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/随包 LibreOffice 报错（boom/)
  })

  it('退出码 0 但没产出：判失败，不假装成功', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async () => ({
      spawnError: null,
      aborted: false,
      timedOut: false,
      exitCode: 0,
      text: ''
    })
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/没有拿到 \.docx 产出/)
  })

  it('产出是空文件：判失败', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async (spec) => {
      await writeFile(flagOf(spec, '--output'), Buffer.alloc(0))
      return { spawnError: null, aborted: false, timedOut: false, exitCode: 0, text: '' }
    }
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/是空文件/)
  })

  it('产出超上限：判失败（上限可注入）', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async (spec) => {
      await writeFile(flagOf(spec, '--output'), ooxmlPackage('docx'))
      return { spawnError: null, aborted: false, timedOut: false, exitCode: 0, text: '' }
    }
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run, outputMaxBytes: 16 })
    )
    expect(error.message).toMatch(/超过单份 16 字节的上限/)
  })

  it('产出不是 PK（比如引擎吐了一份 PDF）：拦下，不给出去', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async (spec) => {
      await writeFile(flagOf(spec, '--output'), Buffer.from('%PDF-1.7\n假装是 docx', 'utf8'))
      return { spawnError: null, aborted: false, timedOut: false, exitCode: 0, text: '' }
    }
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/不是真正的 \.docx/)
    expect(error.message).toMatch(/文件头不是 PK/)
  })

  it('产出是 zip，但主类型声明的是另一种格式：拦下', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async (spec) => {
      await writeFile(flagOf(spec, '--output'), ooxmlPackage('xlsx'))
      return { spawnError: null, aborted: false, timedOut: false, exitCode: 0, text: '' }
    }
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/没有声明 \.docx 的主部件类型/)
  })

  it('产出缺主部件（只有 content-types）：拦下', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async (spec) => {
      const spec0 = EXPECTED.docx
      const contentTypes =
        '<?xml version="1.0" encoding="UTF-8"?><Types' +
        ' xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        `<Override PartName="/${spec0.part}" ContentType="${spec0.type}"/></Types>`
      await writeFile(
        flagOf(spec, '--output'),
        buildZip([{ name: '[Content_Types].xml', body: contentTypes }])
      )
      return { spawnError: null, aborted: false, timedOut: false, exitCode: 0, text: '' }
    }
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/包内没有主部件 word\/document\.xml/)
  })

  it('产出不是 zip（连中央目录都没有）：拦下', async () => {
    const source = await writeSource('doc')
    const run: LegacyRunner = async (spec) => {
      await writeFile(flagOf(spec, '--output'), Buffer.from('PK\x03\x04截断的 zip', 'latin1'))
      return { spawnError: null, aborted: false, timedOut: false, exitCode: 0, text: '' }
    }
    const error = await rejectionOf(
      convertLegacyOffice(source, 'doc', undefined, { kitCli: KIT, run })
    )
    expect(error.message).toMatch(/读不出 zip 中央目录/)
  })

  it('本机随包引擎的探测结果是个布尔（给调用方做退化说明用）', () => {
    expect(typeof legacyConverterAvailable()).toBe('boolean')
  })
})

/**
 * 真夹具段（gated：`KYCLAW_OFFICE_LEGACY_REAL=1`）—— **三格式全覆盖，缺一不算通过**。
 *
 * 夹具**已经在案**：Apache POI 的 `test-data`（Apache-2.0），**锁定 commit
 * `df7d70faa13003593f272259c7fe8ed787f507df`**，9 个文件逐字节核过（size + git blob SHA-1 +
 * SHA-256 + OLE 目录结构 + 标记命中）；来源、哈希与标记表见夹具目录里的
 * `.superpowers/office-legacy-fixtures/SOURCES.md` 与 `sources.json`。跑法：
 *
 *   KYCLAW_OFFICE_LEGACY_REAL=1 KYCLAW_OFFICE_FIXTURES=<夹具目录> \
 *     pnpm exec vitest run src/mastra/tools/__tests__/office-legacy.spec.ts
 *
 * **门开着却跑不了 → 直接失败**（不静默跳过：静默跳过会被读成"验过了"）。没开门时整段 skip
 * （夹具是二进制、不入库，别人 clone 下来本来就没有）。
 *
 * **宏那件事**：`SimpleMacro.doc` / `SimpleMacro.xls` / `WithMacros.ppt` 是**静态**证据（OLE 目录里
 * 确实有 VBA 工程 / 压缩的宏载荷）；本段对它们只证"**能**转出正确的 OOXML"，**不证**"宏没有执行"
 * —— 那条运行时证据仍缺（需要一个 AutoOpen / Document_Open 且副作用可观测的真文件，见 SOURCES.md），
 * 别拿这条用例冒充宏安全。
 */
const FIXTURE_DIR =
  process.env.KYCLAW_OFFICE_FIXTURES ?? join(repoRootOf(), '.superpowers', 'office-legacy-fixtures')

/** 真夹具：主例（**无宏**，两两覆盖三格式）与含宏件（只作"能转"的额外安全例） */
interface RealCase {
  file: string
  kind: LegacyOfficeKind
}

const REAL_PRIMARY: readonly RealCase[] = [
  { file: 'simple.doc', kind: 'doc' },
  { file: 'SampleDoc.doc', kind: 'doc' },
  { file: 'SampleSS.xls', kind: 'xls' },
  { file: 'chinese-provinces.xls', kind: 'xls' },
  { file: 'basic_test_ppt_file.ppt', kind: 'ppt' },
  { file: 'next_test_ppt_file.ppt', kind: 'ppt' }
]

const REAL_MACRO: readonly RealCase[] = [
  { file: 'SimpleMacro.doc', kind: 'doc' },
  { file: 'SimpleMacro.xls', kind: 'xls' },
  { file: 'WithMacros.ppt', kind: 'ppt' }
]

function repoRootOf(): string {
  return resolve(__dirname, '..', '..', '..', '..')
}

const realEnabled = process.env.KYCLAW_OFFICE_LEGACY_REAL === '1'
const missingFixtures = [...REAL_PRIMARY, ...REAL_MACRO]
  .filter((item) => !existsSync(join(FIXTURE_DIR, item.file)))
  .map((item) => item.file)
const canRunReal = realEnabled && missingFixtures.length === 0 && legacyConverterAvailable()

if (realEnabled && !canRunReal) {
  // 门开着就必须跑：缺夹具/缺引擎都是**失败**，不是"跳过"（跳过会被读成验过了）
  throw new Error(
    '[office-legacy] 门开着但前置不满足：' +
      (missingFixtures.length > 0
        ? `缺夹具 ${missingFixtures.join('、')}（找 ${FIXTURE_DIR}）`
        : '') +
      (legacyConverterAvailable() ? '' : ' 本机没有随包的 LibreOffice（resources/libreoffice-kit）')
  )
}

describe.skipIf(!canRunReal)('真夹具 + 真引擎（三格式全覆盖；缺一不算通过）', () => {
  for (const item of REAL_PRIMARY) {
    it(
      `${item.file}（${item.kind} → ${TARGET[item.kind]}）：真转一遍，产出是真 OOXML，原件没被动过`,
      { timeout: 120_000 },
      async () => {
        const fixture = join(FIXTURE_DIR, item.file)
        const before = await readFile(fixture)
        const result = await convertLegacyOffice(fixture, item.kind)
        const format = TARGET[item.kind]

        expect(result.format).toBe(format)
        // 用**共享的**包解析器读回来（不与模块内部那套最小校验自证）
        const entries = readZipEntries(result.bytes)
        const contentTypes = entries.get('[Content_Types].xml')?.toString('utf8') ?? ''
        expect(contentTypes).toContain(EXPECTED[format].type)
        expect(entries.has(EXPECTED[format].part)).toBe(true)
        // 原件逐字节没动
        expect((await readFile(fixture)).equals(before)).toBe(true)
      }
    )
  }

  it(
    '含宏件（SimpleMacro.doc / SimpleMacro.xls / WithMacros.ppt）：能转出正确的 OOXML —— **不是**宏执行安全的证据',
    { timeout: 180_000 },
    async () => {
      for (const item of REAL_MACRO) {
        const fixture = join(FIXTURE_DIR, item.file)
        const before = await readFile(fixture)
        const result = await convertLegacyOffice(fixture, item.kind)
        const format = TARGET[item.kind]

        expect(result.format).toBe(format)
        const entries = readZipEntries(result.bytes)
        expect(entries.has(EXPECTED[format].part)).toBe(true)
        expect((await readFile(fixture)).equals(before)).toBe(true)
      }
    }
  )
})
