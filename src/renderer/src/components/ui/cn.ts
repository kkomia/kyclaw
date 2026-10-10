import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge, validators } from 'tailwind-merge'

const { isArbitraryVariable } = validators

/**
 * 类名合并：clsx 处理条件，tailwind-merge 让后写的工具类按组覆盖前面的
 * ——组件的默认档因此可以被调用方的 className 覆写（"不留第三方默认外观"的同一件事）。
 *
 * extend 里声明的是"tailwind-merge 不认识、但我们的组件靠它覆盖"的三类名字：
 *   1. 字阶名 t1/t2/b1/b2/c1/c2：不在 Tailwind 的 t-shirt 尺寸表里，不声明的话
 *      text-b2 会落进"文字颜色"组，和 text-ink / text-(--tooltip-fg) 互相顶掉；
 *   2. 圆角名（tailwind.css 的十档映射）：不声明的话 rounded-control 覆盖不掉
 *      rounded-icon-button / rounded-(--menu-item-radius)；
 *   3. ease-main（@theme 的 --ease-main）：不声明的话覆盖不掉默认缓动。
 * 另外 Tailwind v4 的 var 简写要按用途归组：text-(--x) 是颜色、rounded-(--x) 是圆角。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['t1', 't2', 'b1', 'b2', 'c1', 'c2'] }],
      'text-color': [{ text: [isArbitraryVariable] }],
      rounded: [
        {
          rounded: [
            'badge',
            'button-sm',
            'control',
            'button-lg',
            'field',
            'panel',
            'overlay',
            'icon-button',
            'input',
            'pill',
            isArbitraryVariable
          ]
        }
      ],
      ease: [{ ease: ['main'] }]
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
