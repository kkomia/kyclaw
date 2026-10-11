/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 测试替身，保持零依赖零类型 */
/**
 * 假 llama-server（测试脚手架，模块 3B）：冒充引擎二进制的形状，用来打**真进程**的生命周期。
 *
 * 它照抄 pinned 版 llama.cpp 的那几个接口（都是实测过的行为）：
 *   - `GET /health` → 200 `{"status":"ok"}`（模型没加载完时回 503 —— 用 `STUB_HEALTH_DELAY_MS` 模拟）；
 *   - `POST /v1/embeddings` → OpenAI 兼容回包（`object: "list"`、`data[].embedding`、`usage`），
 *     向量 L2 归一（与 `--embd-normalize 2` 的实测输出同口径）；
 *   - 要求 `Authorization: Bearer <--api-key>`（真引擎用 `--api-key` 起，网关转发时带上）。
 *
 * 环境变量（只有测试用得到）：
 *   - `STUB_HEALTH_DELAY_MS`：启动后这么久之内回 503（模拟"模型还在加载"）；
 *   - `STUB_CRASH_ONCE=<文件路径>`：该文件不存在时创建它并 exit(1) —— **只崩一次**，
 *     用来验证主进程的"崩溃自动重拉一次"；
 *   - `STUB_LOG_FILE`：把每次嵌入请求追加一行（测试断言"引擎被真的用到了 / 被重启后又活了"）。
 *
 * 用法（引擎侧靠 `extraArgs`）：`node fixtures/llama-server-stub.mjs -m <模型路径> --port N --api-key K`
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

function valueOf(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const port = Number(valueOf('--port') ?? 0)
const apiKey = valueOf('--api-key')
const modelPath = valueOf('-m') ?? ''
const startedAt = Date.now()
const healthDelayMs = Number(process.env.STUB_HEALTH_DELAY_MS ?? 0)
const crashOnceFile = process.env.STUB_CRASH_ONCE
const logFile = process.env.STUB_LOG_FILE

if (crashOnceFile !== undefined && !existsSync(crashOnceFile)) {
  writeFileSync(crashOnceFile, 'crashed\n', 'utf8')
  console.error('stub llama-server: 引擎崩了（模拟第一次启动失败）')
  process.exit(1)
}

function log(line) {
  if (logFile !== undefined) appendFileSync(logFile, `${line}\n`, 'utf8')
}

/** 文本 → 8 维单位向量（确定性；够测"网关把回包原样带回来"） */
function vectorOf(text) {
  let seed = 7
  for (const char of String(text)) seed = (seed * 31 + char.codePointAt(0)) % 2147483647
  const raw = Array.from({ length: 8 }, (_, index) => Math.abs(Math.sin(seed + index)))
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1
  return raw.map((value) => value / norm)
}

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  if (request.method === 'GET' && url === '/health') {
    if (Date.now() - startedAt < healthDelayMs) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Loading model' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'POST' && url.startsWith('/v1/embeddings')) {
    if (apiKey !== undefined && request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unauthorized' } }))
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      log(`embed model=${modelPath} inputs=${inputs.length}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          object: 'list',
          model: parsed.model ?? 'stub',
          data: inputs.map((input, index) => ({
            object: 'embedding',
            index,
            embedding: vectorOf(input)
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length }
        })
      )
    })
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: `not found: ${url}` } }))
})

server.listen(port, '127.0.0.1', () => {
  log(`listening port=${port}`)
  console.log(`stub llama-server listening on 127.0.0.1:${port}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    process.exit(0)
  })
}
