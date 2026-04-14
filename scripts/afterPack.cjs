const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * electron-builder afterPack hook.
 *
 * Applies Electron fuses (security hardening) before signing begins.
 * Fuses are applied here instead of via electron-builder's electronFuses config
 * so they run at a controlled point in the build lifecycle.
 */
exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;

  let electronBinary;
  if (platform === 'darwin') {
    electronBinary = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  } else if (platform === 'win32') {
    electronBinary = path.join(context.appOutDir, `${productFilename}.exe`);
  } else {
    electronBinary = path.join(context.appOutDir, context.packager.executableName);
  }

  console.log(`  \u2022 applying electron fuses (${platform})`);
  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  });

  console.log(`  \u2022 fuses applied`);
};
