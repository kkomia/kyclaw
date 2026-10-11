/**
 * xterm 的主题（接现有 token）。
 *
 * 现读 `<html>` 上的计算值：换主题/换字号后**新开的**终端跟得上；已经开着的终端保留创建时的
 * 主题（xterm 不做运行时换肤），重启一次即刷新。读不到（浏览器 / 单测环境）用一组中性兜底色。
 * 单独一个文件：组件文件只导出组件（react-refresh 的约束）。
 */
import type { ITheme } from '@xterm/xterm'

export function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  const foreground = read('--text-primary', '#1a1a1a')
  const background = read('--bg-primary', '#ffffff')
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: read('--selection', 'rgba(0,0,0,0.12)'),
    black: read('--text-tertiary', '#666666'),
    red: read('--danger', '#d93f3f'),
    green: read('--positive', '#2f9e44'),
    yellow: read('--warning', '#e08a1e'),
    blue: read('--accent', '#0065dd'),
    magenta: read('--accent', '#0065dd'),
    cyan: read('--positive', '#2f9e44'),
    white: read('--text-secondary', '#444444'),
    brightBlack: read('--text-quaternary', '#888888'),
    brightRed: read('--danger', '#d93f3f'),
    brightGreen: read('--positive', '#2f9e44'),
    brightYellow: read('--warning', '#e08a1e'),
    brightBlue: read('--accent', '#0065dd'),
    brightMagenta: read('--accent', '#0065dd'),
    brightCyan: read('--positive', '#2f9e44'),
    brightWhite: foreground
  }
}
