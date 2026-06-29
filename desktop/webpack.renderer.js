const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  target: 'web',
  entry: {
    renderer: './src/renderer/renderer.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: '[name].js',
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/renderer/index.html', to: 'index.html' },
        { from: 'src/renderer/workflow.html', to: 'workflow.html' },
        { from: 'src/renderer/models.html', to: 'models.html' },
        { from: 'src/renderer/music.html', to: 'music.html' },
        { from: 'assets/seti.woff', to: 'seti.woff' },
        { from: '../extension/src/webview/styles.css', to: 'styles.css' },
        { from: '../extension/dist/webview/main.js', to: 'main.js' },
        { from: '../extension/dist/webview/music.js', to: 'music.js' },
        { from: '../extension/dist/webview/music.css', to: 'music.css' },
        { from: '../extension/dist/webview/three.min.js', to: 'three.min.js' },
        { from: '../extension/dist/webview/GLTFLoader.js', to: 'GLTFLoader.js' },
        { from: '../extension/dist/webview/OrbitControls.js', to: 'OrbitControls.js' },
        { from: '../extension/dist/webview/TransformControls.js', to: 'TransformControls.js' },
      ],
    }),
  ],
};
