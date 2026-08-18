import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // This module intentionally co-locates the message presentation components
    // with their pure branch/search transformations so the rendering contract
    // remains reviewable in one place. Non-component exports only affect HMR.
    files: ['src/archive/standard/UniversalArchivePresenter.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
