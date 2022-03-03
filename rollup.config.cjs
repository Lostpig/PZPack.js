const rollupTs = require('@rollup/plugin-typescript')
const path = require('path')

const esmConfig = {
  input: 'src/index.ts',
  output: {
    file: 'dist/esm.mjs',
    format: 'esm'
  },
  plugins: [rollupTs({
    tsconfig: "./tsconfig.json",
    compilerOptions: {
      module: 'esnext',
      outDir: 'dist',
      declaration: true,
      declarationDir: './types'
    }
  })]
}
const cjsConfig = {
  input: 'src/index.ts',
  output: {
    file: 'dist/cjs.js',
    format: 'cjs'
  },
  plugins: [rollupTs({
    tsconfig: "./tsconfig.json",
    compilerOptions: {
      module: 'esnext',
      declaration: false
    }
  })]
}

module.exports = [esmConfig, cjsConfig]