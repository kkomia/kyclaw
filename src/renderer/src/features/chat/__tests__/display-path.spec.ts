import { describe, expect, it } from 'vitest'
import { displayPath } from '@renderer/features/chat/display-path'

/**
 * 路径的展示口径（round 85，用户实报 013）：会话根内 → 工作区相对路径（正斜杠，与文件树 / @ 引用
 * 同口径）；根外 / 判不出根 / 不是路径 → 原样。这里钉的是"展示转换"本身（组件调用点在
 * tool-card.spec 里）。
 */
describe('displayPath · 绝对路径 → 工作区相对路径（只用于展示）', () => {
  it('根内：Windows 绝对路径 → 正斜杠相对路径（含子目录）', () => {
    expect(displayPath('D:\\ws\\docs\\a.md', 'D:\\ws')).toBe('docs/a.md')
    expect(displayPath('D:\\ws\\src\\features\\chat\\Composer.tsx', 'D:\\ws')).toBe(
      'src/features/chat/Composer.tsx'
    )
  })

  it('大小写不敏感、尾分隔符先去掉（Windows 的 D:\\ws 与 d:\\WS 是同一个目录）', () => {
    expect(displayPath('d:/WS/Docs/A.md', 'D:\\ws')).toBe('Docs/A.md')
    expect(displayPath('D:\\ws\\a.md', 'D:\\ws\\')).toBe('a.md')
  })

  it('POSIX 根同样成立', () => {
    expect(displayPath('/home/me/ws/docs/a.md', '/home/me/ws')).toBe('docs/a.md')
  })

  it('根外 / 根自己 / 判不出根 / 空串：一律原样（不猜、不硬凑）', () => {
    expect(displayPath('E:\\other\\a.md', 'D:\\ws')).toBe('E:\\other\\a.md')
    expect(displayPath('C:\\Users\\me\\Downloads\\a.png', 'D:\\ws')).toBe(
      'C:\\Users\\me\\Downloads\\a.png'
    )
    // 前缀相同但不是自家文件（按路径段边界比，不是字符串前缀）
    expect(displayPath('D:\\ws2\\a.md', 'D:\\ws')).toBe('D:\\ws2\\a.md')
    // 根自己不是"文件"，不给空串（那会被读成"根下没有名字的东西"）
    expect(displayPath('D:\\ws', 'D:\\ws')).toBe('D:\\ws')
    expect(displayPath('D:\\ws\\a.md', null)).toBe('D:\\ws\\a.md')
    expect(displayPath('D:\\ws\\a.md', undefined)).toBe('D:\\ws\\a.md')
    expect(displayPath('D:\\ws\\a.md', '')).toBe('D:\\ws\\a.md')
  })

  it('本来就不是路径（grep 的 pattern / query、bash 命令、fetch 的 URL）：原样', () => {
    expect(displayPath('**/*.ts', 'D:\\ws')).toBe('**/*.ts')
    expect(displayPath('TodoWrite', 'D:\\ws')).toBe('TodoWrite')
    expect(displayPath('', 'D:\\ws')).toBe('')
  })

  /**
   * 013 的边界（独立审查补）：`relativeInRoot` 是纯词法比较、不解析 `.` / `..`，
   * 于是 `D:\ws\..\secret\a.txt` 字符串上以 `D:\ws\` 开头、会被相对化成 `../secret/a.txt`
   * —— 一个**根外**文件看起来像在工作区里。展示层不替用户归一化（真解析在主进程），
   * 遇到点段就保守地原样显示绝对路径。
   */
  it('含 `.` / `..` 段的路径：不做相对化，原样显示绝对路径', () => {
    expect(displayPath('D:\\ws\\..\\secret\\a.txt', 'D:\\ws')).toBe('D:\\ws\\..\\secret\\a.txt')
    expect(displayPath('D:\\ws\\.\\a.md', 'D:\\ws')).toBe('D:\\ws\\.\\a.md')
    expect(displayPath('D:\\ws\\..', 'D:\\ws')).toBe('D:\\ws\\..')
    expect(displayPath('D:/ws/../ws2/a.md', 'D:/ws')).toBe('D:/ws/../ws2/a.md')
    const posix = '/home/me/ws/../etc/passwd'
    expect(displayPath(posix, '/home/me/ws')).toBe(posix)
    // 跨盘 + 点段：同样不猜（两个理由各管一段）
    expect(displayPath('E:\\ws\\..\\a.md', 'D:\\ws')).toBe('E:\\ws\\..\\a.md')
    // 名字里带点不是"点段"（按段判，不按子串）：照常相对化
    expect(displayPath('D:\\ws\\..hidden\\a.md', 'D:\\ws')).toBe('..hidden/a.md')
    expect(displayPath('D:\\ws\\a..md', 'D:\\ws')).toBe('a..md')
  })
})
