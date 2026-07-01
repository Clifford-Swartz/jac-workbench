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
        { from: 'src/renderer/mcp.html', to: 'mcp.html' },
        { from: 'src/renderer/pcb.html', to: 'pcb.html' },
        { from: 'src/renderer/cad.html', to: 'cad.html' },
        { from: 'assets/seti.woff', to: 'seti.woff' },
        { from: '../extension/src/webview/styles.css', to: 'styles.css' },
        { from: '../extension/dist/webview/main.js', to: 'main.js', noErrorOnMissing: true },
        { from: '../extension/dist/webview/music.js', to: 'music.js', noErrorOnMissing: true },
        { from: '../extension/dist/webview/music.css', to: 'music.css', noErrorOnMissing: true },
        { from: 'node_modules/three/build/three.min.js', to: 'three.min.js' },
        { from: 'node_modules/three/examples/js/loaders/GLTFLoader.js', to: 'GLTFLoader.js' },
        { from: 'node_modules/three/examples/js/controls/OrbitControls.js', to: 'OrbitControls.js' },
        { from: 'node_modules/three/examples/js/controls/TransformControls.js', to: 'TransformControls.js' },
      ],
    }),
  ],
};
