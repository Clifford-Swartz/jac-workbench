// Renders assets/icon.svg → assets/icon.png (1024px) + assets/icon.ico + assets/tray-icon.png
// Run via: set ELECTRON_RUN_AS_NODE=& electron scripts/render-icon.js
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');

const ROOT   = path.join(__dirname, '..');
const SVG    = path.join(ROOT, 'assets', 'icon.svg');
const OUT_PNG = path.join(ROOT, 'assets', 'icon.png');
const OUT_ICO = path.join(ROOT, 'assets', 'icon.ico');
const OUT_TRAY = path.join(ROOT, 'assets', 'tray-icon.png');

// Write a minimal ICO from an array of {size, pngBuffer}
function buildIco(images) {
    const count = images.length;
    const dirSize = 6 + 16 * count;
    const bufs = [];
    let offset = dirSize;
    const entries = [];
    for (const { size, pngBuffer } of images) {
        entries.push({ size, len: pngBuffer.length, offset });
        bufs.push(pngBuffer);
        offset += pngBuffer.length;
    }
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0,  0); // reserved
    header.writeUInt16LE(1,  2); // type: icon
    header.writeUInt16LE(count, 4);
    const dir = [];
    for (const { size, len, offset: off } of entries) {
        const e = Buffer.alloc(16);
        e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
        e.writeUInt8(size >= 256 ? 0 : size, 1); // height
        e.writeUInt8(0, 2); // color count
        e.writeUInt8(0, 3); // reserved
        e.writeUInt16LE(1, 4); // planes
        e.writeUInt16LE(32, 6); // bit count
        e.writeUInt32LE(len, 8);
        e.writeUInt32LE(off, 12);
        dir.push(e);
    }
    return Buffer.concat([header, ...dir, ...bufs]);
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1024, height: 1024,
        show: false,
        transparent: true,
        backgroundColor: '#00000000',
        webPreferences: { offscreen: true },
    });

    const html = `<!DOCTYPE html>
<html><head>
<style>*{margin:0;padding:0;} html,body{width:1024px;height:1024px;overflow:hidden;background:transparent;}</style>
</head><body>
<img src="${SVG.replace(/\\/g,'/')}" width="1024" height="1024" style="display:block;"/>
</body></html>`;

    const tmp = path.join(ROOT, 'scripts', '_icon_render.html');
    fs.writeFileSync(tmp, html);
    win.loadFile(tmp);

    win.webContents.on('did-finish-load', async () => {
        await new Promise(r => setTimeout(r, 300));

        const capture = async (sz) => {
            const img = await win.webContents.capturePage({ x:0, y:0, width:1024, height:1024 });
            const resized = img.resize({ width: sz, height: sz, quality: 'best' });
            return resized.toPNG();
        };

        // 1024px master PNG
        const png1024 = await capture(1024);
        fs.writeFileSync(OUT_PNG, png1024);
        console.log('Wrote', OUT_PNG);

        // Tray icon at 32px
        const png32 = await capture(32);
        fs.writeFileSync(OUT_TRAY, png32);
        console.log('Wrote', OUT_TRAY);

        // ICO with 4 sizes
        const sizes = [256, 48, 32, 16];
        const icoImages = await Promise.all(sizes.map(async sz => ({
            size: sz,
            pngBuffer: await capture(sz),
        })));
        fs.writeFileSync(OUT_ICO, buildIco(icoImages));
        console.log('Wrote', OUT_ICO);

        fs.unlinkSync(tmp);
        app.quit();
    });
});
