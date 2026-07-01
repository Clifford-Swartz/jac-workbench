const path = require('path');

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
  externals: { electron: 'commonjs electron', ws: 'commonjs ws', 'electron-updater': 'commonjs electron-updater' },
};
