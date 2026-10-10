/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 冒烟脚本，零依赖零类型 */
/**
 * 本地静态更新源（T17 冒烟）：把目录当 generic provider 的根路径伺服，
 * 可选的"慢速模式"让下载进度有机会被看见（默认本机是瞬时的）。
 *
 * 用法：node scripts/serve-feed.mjs <目录> [端口=8555] [每块毫秒=0] [块字节=32768]
 * 每个请求打一行到 stdout（路径 + 状态 + 字节数），便于留证。
 * （从 T17 取证目录挪进 scripts/ 让 README 的说明可复现；不进安装包——
 *  electron-builder.yml 已排除 scripts/**）
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, normalize } from 'node:path'

const [dir, portText = '8555', delayText = '0', chunkText = '32768'] = process.argv.slice(2)
if (!dir) {
  console.error('用法：node scripts/serve-feed.mjs <目录> [端口=8555] [每块毫秒=0] [块字节=32768]')
  process.exit(1)
}
const port = Number(portText)
const delayMs = Number(delayText)
const chunkSize = Number(chunkText)

const server = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0])
  const file = join(dir, normalize(path).replace(/^([/\\])+/, ''))
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    console.log(`404 ${path}`)
    response.writeHead(404)
    response.end('not found')
    return
  }

  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(size)
  })
  if (delayMs <= 0) {
    createReadStream(file).pipe(response)
    console.log(`200 ${path} (${size} 字节)`)
    return
  }

  // 慢速模式：分块发，给"正在下载 x%"留出可截图的窗口
  const stream = createReadStream(file, { highWaterMark: chunkSize })
  console.log(`200 ${path} (${size} 字节，慢速 ${chunkSize}B/${delayMs}ms)`)
  let sent = 0
  const pump = () => {
    const chunk = stream.read()
    if (chunk === null) {
      response.end()
      console.log(`200 ${path} 发送完成（${sent} 字节）`)
      return
    }
    sent += chunk.length
    response.write(chunk)
    setTimeout(pump, delayMs)
  }
  stream.once('readable', pump)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`更新源已就绪：http://127.0.0.1:${port}/ （目录 ${dir}）`)
})
