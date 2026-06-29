const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
    const appOutDir = context.appOutDir;
    const platform = context.electronPlatformName;
    if (platform !== 'darwin') return;

    const appPath = path.join(appOutDir, 'JAC.app');
    const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');

    if (!fs.existsSync(asarPath)) return;

    // Compute actual SHA256 of the ASAR
    const hash = execSync(`shasum -a 256 "${asarPath}"`).toString().split(' ')[0].trim();
    console.log(`[fix-asar-hash] Updating ASAR hash: ${hash}`);

    // Update Info.plist
    execSync(`/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}" "${plistPath}"`);
};
