/**
 * 文件类型图标（**语义层**）：预览标签的 tab 图标、预览头部那个图标块、文件树行、搜索结果行、
 * 交付卡都从这张表取（各处各画一份迟早会走散）。
 *
 * 分工：
 *   - 数据层 `./file-type-icons.tsx`：round 56 从阿里巴巴矢量图标库（iconfont.cn）**收藏集 233548**
 *     里选型生成的扁平彩色 glyph，按 `kind` 出图（生成文件，别手改）；
 *   - 本文件：**后缀 → 档的语义映射**（`EXTENSION_KINDS` 一张直映射表，它本身就是"哪个后缀算
 *     哪类文件"的口径）与 **档 → 组件的静态表**（`FILE_ICONS`，表项是模块级常量，引用稳定）。
 *
 * 判据与 `modes.ts` 的 `previewModeOf` 同一套（那边是"用哪条通道渲染"，这边是"画哪个图标"）：
 * 先查直映射表，查不到再按预览分组回退（pdf / image / table / office / markdown / code / html / text），
 * 最后落到 `generic`（认不出的后缀、没有后缀）。旧版 Office 三件（.doc/.xls/.ppt）在直映射表里
 * 就按各家的文档细分 —— 它们与 .docx/.xlsx/.pptx 是同一类东西（预览方式也同一档了：
 * 办公四件走页式预览、表格四种走原始字节，见 modes.ts）。
 *
 * 零 emoji（UI 雷点 1，见 docs/reference/UI-设计雷点-v1.md）。
 */
import { createElement, type AriaAttributes, type ComponentType } from 'react'
import { FileTypeIcon, type FileTypeIconKind } from './file-type-icons'
import { extensionOf, previewModeOf, type PreviewMode } from './modes'

/** 语义档就是数据层的 kind（不另起一套名字，免得两边对不上） */
export type FileIconKind = FileTypeIconKind

/**
 * 表里每个图标组件的入参：`className` 定尺寸 / 缩放；`aria-hidden` 只收下不往下传
 * （数据层的根 svg 自带 `aria-hidden="true"`）—— 两种写法都要收：JSX 的 `aria-hidden="true"`
 * 与 `createElement` 里的 `true`。
 */
export type FileIconComponent = ComponentType<{
  className?: string
  'aria-hidden'?: AriaAttributes['aria-hidden']
}>

/** 后缀 → 档（小写、不带点）。认不出的后缀走下面的 `FALLBACK_KINDS` */
const EXTENSION_KINDS: Readonly<Record<string, FileIconKind>> = {
  // 办公三件（旧版二进制的 .doc/.xls/.ppt 与新版同档：都是各家的文档）
  doc: 'word',
  docx: 'word',
  xls: 'excel',
  xlsx: 'excel',
  ppt: 'ppt',
  pptx: 'ppt',
  pdf: 'pdf',
  // 纯文本 / 日志 / 字幕；markdown 单列（写给人看的文档）
  txt: 'txt',
  log: 'txt',
  srt: 'txt',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  // 图片（gif 是动图、svg 是矢量，各是各的图）
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  tiff: 'image',
  tif: 'image',
  gif: 'gif',
  svg: 'svg',
  svgz: 'svg',
  // 视频 / 音频（wav 单列：波形图的辨识度比通用喇叭高）
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  m4v: 'video',
  flv: 'video',
  wmv: 'video',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
  opus: 'audio',
  wma: 'audio',
  wav: 'wav',
  // 压缩包（rar 单列，其余都算通用压缩包）
  zip: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  whl: 'archive',
  rar: 'rar',
  // 前端三件套
  html: 'html',
  htm: 'html',
  vue: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  sass: 'css',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',
  ts: 'js',
  tsx: 'js',
  // 数据交换 / 结构描述（xml 家族共用那张尖括号图；svgz 是压缩后的 svg，算图不算数据）
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  map: 'json',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  // 表格（csv/tsv 在后端也是"一张表"的形状）
  csv: 'csv',
  tsv: 'csv',
  // 脚本 / 配置 / 其它语言：共用一个代码图标
  bat: 'code',
  cmd: 'code',
  ps1: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  yml: 'code',
  yaml: 'code',
  toml: 'code',
  ini: 'code',
  conf: 'code',
  env: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  php: 'code',
  rb: 'code',
  swift: 'code',
  kt: 'code',
  dart: 'code',
  lua: 'code',
  r: 'code',
  sql: 'code',
  gradle: 'code',
  groovy: 'code',
  // Python 单列（logo 的辨识度足够高）
  py: 'python',
  pyc: 'python',
  pyo: 'python',
  ipynb: 'python',
  // 可执行 / 安装包 / 设计稿
  exe: 'exe',
  msi: 'exe',
  dmg: 'dmg',
  pkg: 'dmg',
  iso: 'dmg',
  apk: 'apk',
  aab: 'apk',
  psd: 'psd',
  ai: 'psd',
  fig: 'psd',
  sketch: 'psd',
  xd: 'psd'
}

/**
 * 直映射表认不出时按预览分组回退：能走到这里的后缀都还没分档
 * （`.doc/.docx/.xls/.xlsx/.ppt/.pptx` 都在直映射表里，`office` 这一档是为"以后新增的办公后缀"留的，
 * 按最像的那一档给图标）。
 * `html` 是本轮新开的预览分组（`.html/.htm` 有真渲染器了）—— 它的直映射表项本来就在（→ 'html'），
 * 这一档是为"以后新增的 HTML 家族后缀"留的。
 */
const FALLBACK_KINDS: Readonly<Record<PreviewMode, FileIconKind>> = {
  text: 'generic',
  markdown: 'markdown',
  code: 'code',
  html: 'html',
  image: 'image',
  pdf: 'pdf',
  table: 'excel',
  office: 'word'
}

/**
 * 档 → 组件（**静态表**）：表项都是模块级常量，同一档每次拿到的都是同一个引用 —— 在函数里
 * 现造组件会让 React 每帧重挂子树（调用方在渲染里查表，见 fileIconOf 的说明）。
 */
const FILE_ICONS: Readonly<Record<FileIconKind, FileIconComponent>> = {
  pdf: (props) => createElement(FileTypeIcon, { kind: 'pdf', ...props }),
  word: (props) => createElement(FileTypeIcon, { kind: 'word', ...props }),
  excel: (props) => createElement(FileTypeIcon, { kind: 'excel', ...props }),
  ppt: (props) => createElement(FileTypeIcon, { kind: 'ppt', ...props }),
  txt: (props) => createElement(FileTypeIcon, { kind: 'txt', ...props }),
  markdown: (props) => createElement(FileTypeIcon, { kind: 'markdown', ...props }),
  image: (props) => createElement(FileTypeIcon, { kind: 'image', ...props }),
  gif: (props) => createElement(FileTypeIcon, { kind: 'gif', ...props }),
  svg: (props) => createElement(FileTypeIcon, { kind: 'svg', ...props }),
  video: (props) => createElement(FileTypeIcon, { kind: 'video', ...props }),
  audio: (props) => createElement(FileTypeIcon, { kind: 'audio', ...props }),
  wav: (props) => createElement(FileTypeIcon, { kind: 'wav', ...props }),
  archive: (props) => createElement(FileTypeIcon, { kind: 'archive', ...props }),
  rar: (props) => createElement(FileTypeIcon, { kind: 'rar', ...props }),
  html: (props) => createElement(FileTypeIcon, { kind: 'html', ...props }),
  css: (props) => createElement(FileTypeIcon, { kind: 'css', ...props }),
  js: (props) => createElement(FileTypeIcon, { kind: 'js', ...props }),
  json: (props) => createElement(FileTypeIcon, { kind: 'json', ...props }),
  python: (props) => createElement(FileTypeIcon, { kind: 'python', ...props }),
  csv: (props) => createElement(FileTypeIcon, { kind: 'csv', ...props }),
  xml: (props) => createElement(FileTypeIcon, { kind: 'xml', ...props }),
  exe: (props) => createElement(FileTypeIcon, { kind: 'exe', ...props }),
  dmg: (props) => createElement(FileTypeIcon, { kind: 'dmg', ...props }),
  apk: (props) => createElement(FileTypeIcon, { kind: 'apk', ...props }),
  psd: (props) => createElement(FileTypeIcon, { kind: 'psd', ...props }),
  code: (props) => createElement(FileTypeIcon, { kind: 'code', ...props }),
  generic: (props) => createElement(FileTypeIcon, { kind: 'generic', ...props })
}

/** 后缀 → 档（先查直映射表，查不到按预览分组回退，最后落到 `generic`） */
export function fileIconKindOf(relative: string): FileIconKind {
  return EXTENSION_KINDS[extensionOf(relative)] ?? FALLBACK_KINDS[previewModeOf(relative)]
}

/**
 * 后缀 → 图标组件。**引用稳定**（同一档永远是同一个引用），所以调用方在渲染里可以放心
 * `createElement(fileIconOf(relative), { className })`：`createElement` 传的是元素类型，
 * 不是渲染中现造的组件（直接 `const Icon = fileIconOf(...)` 会被 React 编译器的
 * `react-hooks/static-components` 判成"渲染中造组件"）。
 */
export function fileIconOf(relative: string): FileIconComponent {
  return FILE_ICONS[fileIconKindOf(relative)]
}
