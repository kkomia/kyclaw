import { createServer, type Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp, launchApp, waitForChat } from './harness'

/**
 * R94 · 004（插件 · Skill 注册）的**真实 Electron 验证**：导入一份技能之后，插件页能看见、
 * composer 的 `+ → 引用技能` 能引用、磁盘上真落了文件。
 *
 * 边界（都如实写在这里，不冒充全覆盖）：
 *   - **原生文件/文件夹选择器无法自动化**：`e2e` 用 `app.evaluate` 覆写主进程的
 *     `dialog.showOpenDialog`（**测试级注入**）来模拟"用户挑了这个路径"；被注入的只是"用户会选谁"，
 *     后端仍是真读真写（`userData/skills/<名字>/SKILL.md` 落盘由用例读盘核对）。
 *     真机上"点开对话框再选"这一步需要人眼一次。
 *   - 网址导入整条链是**真的**：用例起一个本机 HTTP 服务（127.0.0.1），应用里真发请求、真过出站边界；
 *     **白名单也不是预置的**：先撞拦截，再点框里的「允许访问 <host:port>」走真正的
 *     `settings:update` 写盘（用例随后读 settings.json 核对），最后自动重试成功。
 *     设置页目前还没有这一栏的 UI，所以"允许"这个动作本身就是当前唯一的界面出口。
 *   - 环回地址在真实网络里走的就是"本机"那一档；公网解析相关的判定由单测注入 DNS 覆盖。
 */
const SKILL_MD = '---\nname: r94-demo\ndescription: R94 真实导入验证用的技能\n---\n# 做法\n'

/** 一份带资源的技能（zip 形态：单一顶层包装 + 脚本资源；脚本只存不跑） */
function skillZip(): Buffer {
  return makeZipFixture([
    { name: 'r94-demo/SKILL.md', data: SKILL_MD },
    { name: 'r94-demo/reference/checklist.md', data: '# 清单\n' },
    { name: 'r94-demo/scripts/run.sh', data: 'echo hi\n' }
  ])
}

let server: Server | null = null
let servedPort = 0
let servedBytes: Buffer = Buffer.alloc(0)

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/zip' })
    response.end(servedBytes)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('服务没起来')
  servedPort = address.port
})

test.afterAll(() => {
  server?.close()
  server = null
})

async function openSkillsTab(page: Page): Promise<void> {
  await page.getByTestId('nav-plugins').click()
  await expect(page.getByTestId('plugins-page')).toBeVisible()
  await page.getByTestId('plugins-tab-skills').click()
  await expect(page.getByTestId('plugins-skills')).toBeVisible()
}

/** 覆写主进程的选择器（测试级注入）：让"用户挑了 path"这件事发生一次 */
async function stubPicker(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
  }, path)
}

/**
 * 等 ＋ 菜单**完全退场**再点下一次。
 *
 * 为什么需要：radix 的菜单在退场动画结束前仍挂在 DOM 上（`data-state="closed"` 但可见、盖在触发器
 * 上方），这段时间里对触发器的那一次 pointerdown 会被同一次事件里的"DismissableLayer 判定为外部点击"
 * 吞掉 —— 于是"点一次没反应"。真人不会在动画窗口内连点，但自动化会。菜单内容卸载（count 0）之后
 * 再点就稳。
 */
async function reopenable(page: Page): Promise<void> {
  await expect(page.getByTestId('skill-add-file')).toHaveCount(0)
  await expect(page.getByTestId('skills-add')).toHaveAttribute('aria-expanded', 'false')
}

test('从网址导入：环回默认拒（框里给出精确 host:port），点「允许访问」走真设置写盘后真落盘、列表与引用可见', async () => {
  servedBytes = skillZip()
  const href = `http://127.0.0.1:${servedPort}/r94-demo.zip`
  const entry = `127.0.0.1:${servedPort}`

  // 默认设置（白名单为空）起一个隔离实例 —— 不做任何预置
  const launched = await launchApp()
  try {
    await waitForChat(launched.page)
    await openSkillsTab(launched.page)
    await launched.page.getByTestId('skills-add').click()
    await launched.page.getByTestId('skill-add-url').click()
    await launched.page.getByTestId('skill-url-input').fill(href)
    await launched.page.getByTestId('skill-url-save').click()

    // 被拦下：框里给原因 + 作用域与取消语义 + **精确到 host:port** 的允许按钮
    const blocked = launched.page.getByTestId('skill-url-blocked')
    await expect(blocked).toContainText('本机（环回）地址')
    await expect(launched.page.getByTestId('skill-url-blocked-scope')).toContainText(
      '联网抓取等工具共用同一份设置'
    )
    await expect(launched.page.getByTestId('skill-url-allow')).toContainText(`允许访问 ${entry}`)
    // 取证（本地截图，不进仓）：框里长这样 —— 原因 / 作用域 / 精确到 host:port 的允许按钮
    await launched.page.screenshot({
      path: '.superpowers/sdd/2026-10-10-kyclaw-mvp/smoke-r94/blocked-allow.png'
    })
    // 没点允许之前：什么都没落盘、白名单也一个字没写
    const skillsDir = join(launched.userDataDir, 'skills')
    expect(existsSync(skillsDir) ? readdirSync(skillsDir) : []).toEqual([])
    expect(readAllowHosts(launched.userDataDir)).toEqual([])

    // 点「允许访问 <host:port>」：真写 settings.json（只加这一条）+ 自动重试导入
    await launched.page.getByTestId('skill-url-allow').click()

    await expect(launched.page.getByTestId('plugins-notice')).toContainText(
      '已导入技能「r94-demo」'
    )
    expect(readAllowHosts(launched.userDataDir)).toEqual([entry])

    // 列表：「我的技能」一组里出现这一条
    const mine = launched.page.getByTestId('skills-user')
    await expect(mine.getByTestId('skill-installed-r94-demo')).toContainText('r94-demo')

    // 磁盘：真文件（SKILL.md + 资源都在；脚本原样躺着，没有被执行）
    expect(readdirSync(skillsDir)).toEqual(['r94-demo'])
    expect(readFileSync(join(skillsDir, 'r94-demo', 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(readFileSync(join(skillsDir, 'r94-demo', 'reference', 'checklist.md'), 'utf8')).toBe(
      '# 清单\n'
    )
    expect(readFileSync(join(skillsDir, 'r94-demo', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')

    // composer：`+ → 引用技能` 里能引用它，点一下把 `【引用】技能：<名字>` 插进输入框
    // （composer 在对话页，先回到对话）
    await launched.page.getByTestId('new-session').click()
    await waitForChat(launched.page)
    await launched.page.getByTestId('composer-plus').click()
    await launched.page.getByTestId('composer-ref-skills').hover()
    const skillEntry = launched.page.getByTestId('composer-ref-skill-r94-demo')
    await expect(skillEntry).toBeVisible()
    await skillEntry.click()
    await expect(launched.page.getByTestId('composer-input')).toHaveValue(/r94-demo/)
  } finally {
    await closeApp(launched)
  }
})

/** 读隔离 userData 里的白名单（判断"点了允许才写"这件事） */
function readAllowHosts(userDataDir: string): string[] {
  const file = join(userDataDir, 'settings.json')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    network?: { allowLocalHosts?: string[] }
  }
  return raw.network?.allowLocalHosts ?? []
}

test('从本地文件夹导入：选择器注入 → 真复制整份目录（含资源），列表可见', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'kyclaw-r94-local-'))
  const skillDir = join(workDir, 'local-skill')
  mkdirSync(join(skillDir, 'reference'), { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: local-skill\ndescription: 本地目录导入\n---\n正文\n',
    'utf8'
  )
  writeFileSync(join(skillDir, 'reference', 'a.md'), '# 参考\n', 'utf8')

  const launched = await launchApp()
  try {
    await waitForChat(launched.page)
    await openSkillsTab(launched.page)
    await stubPicker(launched.app, skillDir)

    await launched.page.getByTestId('skills-add').click()
    await launched.page.getByTestId('skill-add-folder').click()

    await expect(launched.page.getByTestId('plugins-notice')).toContainText(
      '已导入技能「local-skill」'
    )
    await expect(
      launched.page.getByTestId('skills-user').getByTestId('skill-installed-local-skill')
    ).toBeVisible()

    const installed = join(launched.userDataDir, 'skills', 'local-skill')
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toContain('本地目录导入')
    expect(readFileSync(join(installed, 'reference', 'a.md'), 'utf8')).toBe('# 参考\n')
    // 暂存目录不留残渣
    expect(readdirSync(join(launched.userDataDir, 'skills'))).toEqual(['local-skill'])
  } finally {
    await closeApp(launched)
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('同名导入被拒（不覆盖）：第二次导入同一份技能 → 行内人话，磁盘上的原样不动', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'kyclaw-r94-dup-'))
  const file = join(workDir, 'r94-demo.md')
  writeFileSync(file, SKILL_MD, 'utf8')

  const launched = await launchApp()
  try {
    await waitForChat(launched.page)
    await openSkillsTab(launched.page)

    await stubPicker(launched.app, file)
    await launched.page.getByTestId('skills-add').click()
    await launched.page.getByTestId('skill-add-file').click()
    await expect(launched.page.getByTestId('plugins-notice')).toContainText(
      '已导入技能「r94-demo」'
    )

    // 再导一次：被拒，且界面上有人话（不是静默覆盖）
    await reopenable(launched.page)
    await stubPicker(launched.app, file)
    await launched.page.getByTestId('skills-add').click()
    await launched.page.getByTestId('skill-add-file').click()
    const error = launched.page.getByTestId('plugins-error')
    await expect(error).toContainText('已经有一个同名技能')
    expect(readFileSync(join(launched.userDataDir, 'skills', 'r94-demo', 'SKILL.md'), 'utf8')).toBe(
      SKILL_MD
    )
  } finally {
    await closeApp(launched)
    rmSync(workDir, { recursive: true, force: true })
  }
})

/** 最小 zip 构造器（store + 目录名，测试自足；不 import 源码里的测试件） */
function makeZipFixture(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const content = Buffer.from(entry.data, 'utf8')
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(content)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, content)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0x81a40000, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + content.length
  }

  const dir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, eocd])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

const TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()
