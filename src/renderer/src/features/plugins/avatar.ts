/**
 * 字母头像的纯逻辑（round 23）：名称 → 稳定底色档 + 首字母。
 *
 * 底色用现有 Fills 三档（中性灰；深浅由名称哈希定，同名永远同色、跨会话稳定）——
 * 不引第三方图标库、不发明新颜色。首字母：中文取首字、英文取首字母大写；
 * 空名字给 `?`（不假装有名字）。
 */
export const AVATAR_TONES = ['bg-hover', 'bg-selected', 'bg-active'] as const

export type AvatarTone = (typeof AVATAR_TONES)[number]

/** 首字母（Unicode 安全：按码点切，emoji/汉字不会切坏） */
export function avatarInitialOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return first.toUpperCase()
}

/** 名称 → 底色档（FNV 风格的简单哈希；同名为稳定值） */
export function avatarToneOf(name: string): AvatarTone {
  let hash = 0
  for (const char of name.trim()) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? 'bg-selected'
}
