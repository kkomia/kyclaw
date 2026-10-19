import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // .superpowers（取证脚本/证据簿）与 .prettierignore 同口径：不进门禁
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/.superpowers'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // e2e/kernel-stub 是 **JS 测试夹具**（非产品代码、不进打包）：不套产品 TS 的显式返回类型契约。
    // 只在文件级关这一条，其它规则照旧；见 nia/kernel-stub-contract.md。
    files: ['e2e/kernel-stub/**/*.cjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      // .cjs 就是 CJS：require 是正确写法，不是 TS 里的"require 风格 import"
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  eslintConfigPrettier
)
