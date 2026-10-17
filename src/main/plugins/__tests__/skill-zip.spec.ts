// @vitest-environment node
/**
 * 技能 zip 读入（round 94）：**只读、只在内存里解**，每个拒绝面一条用例。
 *
 * 为什么自己写一份 zip 读（而不是再用 artifact-check 的 `readZipEntries`）：那份是 OOXML 结构自检的
 * 读侧，条目表是 `Map<string, Buffer>`，**拿不到 unix mode / 目录位**——而技能导入恰恰要靠这些位
 * 挡 symlink 条目与目录。这里的最小读法只服务"把一份技能包安全地读进内存"这一件事。
 *
 * 钉住的形状（全部拒绝，且都给人话）：`..` / 绝对路径 / 反斜杠穿越、Windows 危险名与段尾点空格、
 * 大小写仅差一档的重名、symlink 条目、加密、zip64、非常规压缩方式、声明超限、**声明撒谎的炸弹包**
 * （实际解压超限；靠 `maxOutputLength` 而不是先解出来再判）、CRC 不符、局部头与中央目录对不上。
 */
import { deflateRawSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readSkillZip, type SkillZipLimits } from '../skill-zip'
import { crc32, makeZip } from './zip-fixture'

const LIMITS: SkillZipLimits = {
  maxFiles: 200,
  maxEntryBytes: 2 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024
}

const text = (value: string): Buffer => Buffer.from(value, 'utf8')
const skill = '---\nname: demo\n---\n正文\n'

describe('readSkillZip：能读的包', () => {
  it('store 与 deflate 都读；目录条目跳过；路径归一到正斜杠', () => {
    const bytes = makeZip([
      { name: 'demo/', data: '', unixMode: 0x41ed },
      { name: 'demo/SKILL.md', data: skill, method: 8 },
      { name: './demo/reference/a.md', data: text('# 参考') },
      { name: 'demo/scripts\\run.sh', data: text('echo hi') }
    ])
    const files = readSkillZip(bytes, LIMITS)
    expect(files.map((file) => file.path)).toEqual([
      'demo/SKILL.md',
      'demo/reference/a.md',
      'demo/scripts/run.sh'
    ])
    expect(files[0]?.data.toString('utf8')).toBe(skill)
    expect(files[2]?.data.toString('utf8')).toBe('echo hi')
  })
})

describe('readSkillZip：条目名', () => {
  it('`..` 段 / 绝对路径 / 盘符 / 反斜杠穿越一律拒', () => {
    for (const name of [
      '../evil.md',
      'demo/../../evil.md',
      '/etc/evil.md',
      'C:\\Windows\\evil.md',
      '..\\evil.md'
    ]) {
      expect(() => readSkillZip(makeZip([{ name, data: 'x' }]), LIMITS), name).toThrow(
        /越出包根|绝对路径|带盘符|不合法/
      )
    }
  })

  it('Windows 危险名（设备名 / 段尾点空格 / 冒号）拒', () => {
    for (const name of [
      'con',
      'demo/con.md',
      'demo/nul.txt',
      'demo/AUX',
      'com1.md',
      'demo/lpt9',
      'demo/x.',
      'demo/x ',
      'demo/c:ads.md'
    ]) {
      expect(() => readSkillZip(makeZip([{ name, data: 'x' }]), LIMITS), name).toThrow(
        /Windows|名字不合法|带盘符|冒号/
      )
    }
  })

  it('Windows 保留字符与控制符（* ? " < > | 与 0x00-0x1f）拒', () => {
    for (const name of [
      'demo/a*b.md',
      'demo/a?b.md',
      'demo/a"b.md',
      'demo/a<b.md',
      'demo/a>b.md',
      'demo/a|b.md',
      `demo/a${String.fromCharCode(7)}b.md`
    ]) {
      expect(() => readSkillZip(makeZip([{ name, data: 'x' }]), LIMITS), name).toThrow(
        /不接受的字符|控制字符/
      )
    }
  })

  it('大小写只差一档的重名拒（Windows/macOS 落盘会撞同一个文件）', () => {
    const bytes = makeZip([
      { name: 'demo/SKILL.md', data: skill },
      { name: 'demo/skill.md', data: 'x' }
    ])
    expect(() => readSkillZip(bytes, LIMITS)).toThrow(/大小写/)
  })
})

describe('readSkillZip：条目属性', () => {
  it('symlink 条目拒', () => {
    const bytes = makeZip([
      { name: 'demo/SKILL.md', data: skill },
      { name: 'demo/link', data: '/etc/passwd', unixMode: 0xa1ff }
    ])
    expect(() => readSkillZip(bytes, LIMITS)).toThrow(/符号链接/)
  })

  it('加密 / 非常规压缩方式 / zip64 拒', () => {
    expect(() => readSkillZip(makeZip([{ name: 'a.md', data: 'x', flags: 1 }]), LIMITS)).toThrow(
      /加密/
    )
    expect(() => readSkillZip(makeZip([{ name: 'a.md', data: 'x', method: 12 }]), LIMITS)).toThrow(
      /压缩方式不支持/
    )
    // zip64 哨兵（EOCD 记 0xffff 条）
    expect(() =>
      readSkillZip(makeZip([{ name: 'a.md', data: 'x' }], { count: 0xffff }), LIMITS)
    ).toThrow(/zip64|条数/)
  })
})

describe('readSkillZip：上限与炸弹', () => {
  it('条数 / 单条声明 / 合计声明超限拒', () => {
    const many = makeZip(
      Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.md`, data: 'x' }))
    )
    expect(() => readSkillZip(many, { ...LIMITS, maxFiles: 4 })).toThrow(/文件数/)

    const big = makeZip([{ name: 'a.md', data: 'x', declaredSize: 3 * 1024 * 1024 }])
    expect(() => readSkillZip(big, LIMITS)).toThrow(/单条上限/)

    const wide = makeZip([
      { name: 'a.md', data: 'x', declaredSize: 6 * 1024 * 1024 },
      { name: 'b.md', data: 'y', declaredSize: 6 * 1024 * 1024 }
    ])
    expect(() => readSkillZip(wide, LIMITS)).toThrow(/合计|单条上限/)
  })

  it('声明撒谎的炸弹包：声明 1KB、实际解出 4MiB → 拒（不先解出来再判）', () => {
    const bomb = makeZip([
      { name: 'SKILL.md', data: skill },
      {
        name: 'big.bin',
        raw: deflateRawSync(Buffer.alloc(4 * 1024 * 1024, 7)),
        declaredSize: 1024
      }
    ])
    expect(() => readSkillZip(bomb, LIMITS)).toThrow(/声明不可信|超过/)
  })

  it('压缩数据本身就超 compressBound：碰 zlib 之前就拒（同步 inflate 的工作量有界）', () => {
    const wide = makeZip([
      { name: 'SKILL.md', data: skill },
      { name: 'wide.bin', raw: Buffer.alloc(3 * 1024 * 1024, 3), method: 8, declaredSize: 16 }
    ])
    expect(() => readSkillZip(wide, LIMITS)).toThrow(/compressBound/)
  })

  it('正好贴着单条上限的**不可压缩** deflate 数据：照收（deflate 会略微变大，闸门留了余量）', () => {
    // 2MiB 随机字节：deflate 走 stored 块，压缩后比原数据大一点点（约 +170 字节），
    // 旧的"压缩后不得大于 n"会把这种合法数据误拒
    const random = randomBytes(LIMITS.maxEntryBytes)
    const bytes = makeZip([
      { name: 'SKILL.md', data: skill },
      { name: 'noise.bin', data: random, method: 8 }
    ])
    const files = readSkillZip(bytes, LIMITS)
    expect(files.map((file) => file.path)).toEqual(['SKILL.md', 'noise.bin'])
    expect(files[1]?.data.length).toBe(LIMITS.maxEntryBytes)
  })

  it('解压后大小与声明不符 / CRC 不符 / 局部头对不上：拒', () => {
    const lying = makeZip([{ name: 'a.md', data: 'abcdef', declaredSize: 3 }])
    expect(() => readSkillZip(lying, LIMITS)).toThrow(/与声明不符|CRC/)
    const badCrc = makeZip([{ name: 'a.md', data: 'abcdef', declaredCrc: crc32(text('abcdeg')) }])
    expect(() => readSkillZip(badCrc, LIMITS)).toThrow(/CRC32/)

    const mismatch = makeZip([{ name: 'a.md', data: 'x', localName: 'b.md' }])
    expect(() => readSkillZip(mismatch, LIMITS)).toThrow(/局部头与中央目录不一致/)
  })

  it('不是 zip 的字节：拒（人话）', () => {
    expect(() => readSkillZip(text('就是一个 md 文件'), LIMITS)).toThrow(/不是一个 zip/)
  })
})
