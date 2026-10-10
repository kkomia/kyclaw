/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 出包脚本，零依赖零类型 */
/**
 * 生成品牌图标（T15）：`resources/icon.png`（512，托盘/窗口）+ `resources/icon.ico`（多尺寸，exe/安装器/快捷方式）。
 *
 * 设计（无设计稿，几何图形 + 既有 token 色系，零 emoji）：
 *   牌子蓝 --Colors-KMBlue #1783ff 的圆角方块为底（自上而下压暗一档，避免大色块发死），
 *   中间一个白色几何 K —— 三笔都朝外收尖，取 "claw"/爪痕 的意思。
 *
 * 程序化光栅化，零依赖：4× 超采样 + 圆角框 SDF / 变宽线段距离场；PNG 手写（zlib）与
 * ICO 手写（32bpp BMP 条目，不塞 PNG 条目——resedit 改 exe 图标、NSIS 装安装器图标都吃这一口最稳）。
 * 用法：`node scripts/make-icon.mjs`（改了形状/配色重跑一次即可）。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const RESOURCES_DIR = fileURLToPath(new URL('../resources/', import.meta.url))

/** 底色：顶部 / 底部（对角渐变），取自 token --Colors-KMBlue 及其压暗档 */
const GROUND_TOP = [0x2f, 0x95, 0xff]
const GROUND_BOTTOM = [0x0d, 0x6a, 0xe4]
/** K 的笔画色 */
const MARK_COLOR = [0xff, 0xff, 0xff]

/** 圆角半径（相对边长） */
const CORNER_RADIUS = 0.235

/** 超采样倍数：每边 4 个子样本（4×4 = 16/像素），够平掉锯齿 */
const SUPERSAMPLE = 4

/** 笔画：a→b 变宽线段（wa/wb 是半宽，两端圆头） */
const MARK_STROKES = [
  // 竖笔
  { ax: 0.345, ay: 0.28, bx: 0.345, by: 0.72, wa: 0.075, wb: 0.075 },
  // 上臂（向右上收尖）
  { ax: 0.37, ay: 0.5, bx: 0.7, by: 0.275, wa: 0.09, wb: 0.052 },
  // 下臂（向右下收尖）
  { ax: 0.37, ay: 0.5, bx: 0.7, by: 0.725, wa: 0.09, wb: 0.052 }
]

/** PNG 里的多尺寸；ICO 用一个正方形，出图后按尺寸缩放 */
const PNG_SIZE = 512
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** 圆角方块的 SDF：≤0 即在形状内（归一化坐标） */
function insideRoundedBox(x, y) {
  const qx = Math.abs(x - 0.5) - (0.5 - CORNER_RADIUS)
  const qy = Math.abs(y - 0.5) - (0.5 - CORNER_RADIUS)
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
  return d <= CORNER_RADIUS
}

/** 变宽线段命中判定：投影到线段上，半宽按投影参数线性插值 */
function insideStroke(x, y, stroke) {
  const abx = stroke.bx - stroke.ax
  const aby = stroke.by - stroke.ay
  const length2 = abx * abx + aby * aby
  const t = Math.min(Math.max(((x - stroke.ax) * abx + (y - stroke.ay) * aby) / length2, 0), 1)
  const half = stroke.wa + (stroke.wb - stroke.wa) * t
  return Math.hypot(x - (stroke.ax + abx * t), y - (stroke.ay + aby * t)) <= half
}

function insideMark(x, y) {
  return MARK_STROKES.some((stroke) => insideStroke(x, y, stroke))
}

function groundColor(x, y) {
  const t = Math.min(Math.max((x + y) / 2, 0), 1)
  return GROUND_TOP.map((top, index) => Math.round(top + (GROUND_BOTTOM[index] - top) * t))
}

/** 画一张 size×size 的 RGBA 图：底色块 + 白 K，透明处 alpha=0 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const step = 1 / SUPERSAMPLE
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let red = 0
      let green = 0
      let blue = 0
      let covered = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) * step) / size
          const y = (py + (sy + 0.5) * step) / size
          if (!insideRoundedBox(x, y)) continue
          const color = insideMark(x, y) ? MARK_COLOR : groundColor(x, y)
          red += color[0]
          green += color[1]
          blue += color[2]
          covered += 1
        }
      }

      if (covered === 0) continue
      const at = (py * size + px) * 4
      // 颜色按"已覆盖子样本"取均值（透明子样本不参与混色），alpha 才是覆盖比例
      pixels[at] = Math.round(red / covered)
      pixels[at + 1] = Math.round(green / covered)
      pixels[at + 2] = Math.round(blue / covered)
      pixels[at + 3] = Math.round((covered / samples) * 255)
    }
  }

  return pixels
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** 32bpp RGBA PNG（无滤波）：zlib 手写，够用且不引依赖 */
function encodePng(size, pixels) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：真彩 + alpha
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO 的一条：BITMAPINFOHEADER + 自下而上的 BGRA + 全零 AND 掩码 */
function encodeIcoEntry(size, pixels) {
  const maskStride = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // 高度写两倍：色彩位图 + 掩码两段
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4 + maskStride * size, 20)

  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const row = (size - 1 - y) * size * 4 // ICO 位图自下而上
    for (let x = 0; x < size; x++) {
      const from = row + x * 4
      const to = (y * size + x) * 4
      bitmap[to] = pixels[from + 2]
      bitmap[to + 1] = pixels[from + 1]
      bitmap[to + 2] = pixels[from]
      bitmap[to + 3] = pixels[from + 3]
    }
  }

  return Buffer.concat([header, bitmap, Buffer.alloc(maskStride * size)])
}

function encodeIco(entries) {
  const directory = Buffer.alloc(6 + 16 * entries.length)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2) // 1 = 图标
  directory.writeUInt16LE(entries.length, 4)

  let offset = directory.length
  const blobs = []
  entries.forEach(({ size, data }, index) => {
    const at = 6 + index * 16
    directory[at] = size >= 256 ? 0 : size // 256 在 ICO 里写 0
    directory[at + 1] = size >= 256 ? 0 : size
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
    blobs.push(data)
  })

  return Buffer.concat([directory, ...blobs])
}

const png = encodePng(PNG_SIZE, renderIcon(PNG_SIZE))
const ico = encodeIco(
  ICO_SIZES.map((size) => ({ size, data: encodeIcoEntry(size, renderIcon(size)) }))
)

writeFileSync(`${RESOURCES_DIR}icon.png`, png)
writeFileSync(`${RESOURCES_DIR}icon.ico`, ico)
console.log(
  `icon.png ${PNG_SIZE}x${PNG_SIZE} ${png.length} B；icon.ico ${ICO_SIZES.join('/')} ${ico.length} B`
)
