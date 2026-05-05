const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** Extension host bundle (runs in Node.js) */
const extensionConfig = {
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
    },
    externals: {
        vscode: 'commonjs vscode',
        bufferutil: 'commonjs bufferutil',
        'utf-8-validate': 'commonjs utf-8-validate',
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
        rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
};

/** Webview bundle (runs in browser iframe) */
const webviewConfig = {
    target: 'web',
    mode: 'none',
    entry: './src/webview/main.ts',
    output: {
        path: path.resolve(__dirname, 'dist', 'webview'),
        filename: 'main.js',
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
        rules: [
            { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: 'src/webview/styles.css', to: 'styles.css' },
            ],
        }),
    ],
};

/** Music panel webview bundle */
const musicWebviewConfig = {
    target: 'web',
    mode: 'none',
    entry: './src/webview/music.ts',
    output: {
        path: path.resolve(__dirname, 'dist', 'webview'),
        filename: 'music.js',
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
        rules: [
            { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: 'src/webview/music.css', to: 'music.css' },
            ],
        }),
    ],
};

/** Browser panel webview bundle */
const browserWebviewConfig = {
    target: 'web',
    mode: 'none',
    entry: './src/webview/browser.ts',
    output: {
        path: path.resolve(__dirname, 'dist', 'webview'),
        filename: 'browser.js',
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
        rules: [
            { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: 'src/webview/browser.css', to: 'browser.css' },
            ],
        }),
    ],
};

module.exports = [extensionConfig, webviewConfig, musicWebviewConfig, browserWebviewConfig];
