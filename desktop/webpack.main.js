const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  target: 'electron-main',
  entry: './src/main/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/main'),
    filename: 'main.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: { bufferutil: false, 'utf-8-validate': false },
  },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  plugins: [
    // The ported KiCad router (Emscripten glue + .wasm) is loaded at runtime via a
    // non-webpack require, so it must be copied into the build output verbatim.
    new CopyPlugin({ patterns: [{ from: 'src/main/kicad/wasm', to: 'kicad/wasm' }] }),
  ],
  externals: { electron: 'commonjs electron', ws: 'commonjs ws', 'electron-updater': 'commonjs electron-updater' },
};
