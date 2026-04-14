/**
 * test-update-install.js
 *
 * Debug script for testing auto-update installation commands in isolation
 * (without full Electron app context). Use this to verify that spawn commands
 * work correctly on each platform.
 *
 * Usage:
 *   # Test pkexec on Linux (with echo first)
 *   node scripts/test-update-install.js
 *
 *   # Test with actual .deb package
 *   node scripts/test-update-install.js /tmp/notely-desktop_0.8.15_amd64.deb
 *
 *   # Test with actual .exe installer on Windows
 *   node scripts/test-update-install.js C:\temp\notely-setup.exe
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const platform = process.platform;
const installerPath = process.argv[2];

console.log(`Platform: ${platform}`);
console.log(`Node.js version: ${process.version}`);
console.log(`Installer path: ${installerPath || '(none provided)'}`);
console.log('');

/**
 * Test Linux pkexec installation
 */
function testLinux() {
  console.log('=== Linux Auto-Update Install Test ===\n');

  // First, test pkexec with a harmless command
  console.log('Step 1: Testing pkexec with echo command...');
  console.log('  (You should see a password dialog - enter your password or cancel)');
  console.log('');

  const echoTest = spawn('pkexec', ['echo', 'pkexec authentication successful!'], {
    stdio: 'inherit',
  });

  echoTest.on('error', (err) => {
    console.error(`Error spawning pkexec: ${err.message}`);
    console.log('\nPossible issues:');
    console.log('  - pkexec is not installed (install policykit-1)');
    console.log('  - No polkit agent running (need a desktop session)');
    process.exit(1);
  });

  echoTest.on('close', (code) => {
    console.log(`\npkexec echo test exited with code: ${code}`);

    if (code === 0) {
      console.log('  SUCCESS: pkexec works correctly\n');

      // If installer path provided and exists, test with actual .deb
      if (installerPath) {
        if (!fs.existsSync(installerPath)) {
          console.error(`Error: Installer file not found: ${installerPath}`);
          process.exit(1);
        }

        console.log('Step 2: Testing dpkg install...');
        console.log(`  Package: ${installerPath}`);
        console.log('  (You should see a password dialog again)');
        console.log('');

        // Test the actual implementation - using detached with ignore
        // This matches the fixed implementation
        const installer = spawn('pkexec', ['dpkg', '-i', installerPath], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        installer.stdout?.on('data', (data) => {
          console.log(`stdout: ${data}`);
        });

        installer.stderr?.on('data', (data) => {
          console.log(`stderr: ${data}`);
        });

        installer.on('error', (err) => {
          console.error(`Error spawning dpkg: ${err.message}`);
        });

        installer.on('close', (dpkgCode) => {
          console.log(`\ndpkg install exited with code: ${dpkgCode}`);
          if (dpkgCode === 0) {
            console.log('  SUCCESS: Package installed successfully');
          } else if (dpkgCode === 126 || dpkgCode === 127) {
            console.log('  CANCELLED: User cancelled authentication');
          } else {
            console.log('  FAILED: Installation failed');
          }
        });

        installer.unref();
      } else {
        console.log('No installer path provided. To test with a .deb package:');
        console.log('  node scripts/test-update-install.js /path/to/package.deb');
      }
    } else if (code === 126) {
      console.log('  CANCELLED: User dismissed the dialog');
      console.log('  (This is expected behavior if you clicked Cancel)');
    } else if (code === 127) {
      console.log('  ERROR: pkexec command not found');
    } else {
      console.log(`  ERROR: pkexec returned unexpected code: ${code}`);
    }
  });
}

/**
 * Test Windows silent installer
 */
function testWindows() {
  console.log('=== Windows Auto-Update Install Test ===\n');

  if (!installerPath) {
    console.log('No installer path provided.');
    console.log('Usage: node scripts/test-update-install.js C:\\path\\to\\notely-setup.exe');
    console.log('\nTo create a test, you can use the built installer from dist/');
    return;
  }

  if (!fs.existsSync(installerPath)) {
    console.error(`Error: Installer file not found: ${installerPath}`);
    process.exit(1);
  }

  console.log(`Installer: ${installerPath}`);
  console.log('');
  console.log('Testing silent install with /S flag...');
  console.log('  (Spawning as detached process)');
  console.log('');

  // This matches the fixed implementation
  const installer = spawn(installerPath, ['/S'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  installer.on('error', (err) => {
    console.error(`Error spawning installer: ${err.message}`);
    console.log('\nPossible issues:');
    console.log('  - Installer file is corrupted');
    console.log('  - Windows SmartScreen blocking execution');
    console.log('  - Need to run as administrator');
  });

  // Unref immediately - this is the key fix
  installer.unref();

  console.log('Installer spawned and detached.');
  console.log('The installer should be running in the background.');
  console.log('');
  console.log('In the real app, we would call app.quit() immediately after this.');
  console.log('This allows the installer to complete after the app closes.');
}

/**
 * Test macOS DMG installation
 */
function testMacOS() {
  console.log('=== macOS Auto-Update Install Test ===\n');

  if (!installerPath) {
    console.log('No DMG path provided.');
    console.log('Usage: node scripts/test-update-install.js /path/to/Notely.dmg');
    return;
  }

  if (!fs.existsSync(installerPath)) {
    console.error(`Error: DMG file not found: ${installerPath}`);
    process.exit(1);
  }

  console.log(`DMG: ${installerPath}`);
  console.log('');
  console.log('Step 1: Mounting DMG...');

  const mountProcess = spawn('hdiutil', ['attach', installerPath, '-nobrowse', '-quiet']);

  let mountOutput = '';
  mountProcess.stdout?.on('data', (data) => {
    mountOutput += data.toString();
    console.log(`  Mount output: ${data.toString().trim()}`);
  });

  mountProcess.stderr?.on('data', (data) => {
    console.log(`  Mount stderr: ${data.toString().trim()}`);
  });

  mountProcess.on('close', (mountCode) => {
    if (mountCode !== 0) {
      console.error(`Error: Failed to mount DMG (code: ${mountCode})`);
      return;
    }

    // Parse mount point
    const lines = mountOutput.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const mountPoint = lastLine.split('\t').pop()?.trim();

    if (!mountPoint) {
      console.error('Error: Could not determine mount point');
      return;
    }

    console.log(`  Mounted at: ${mountPoint}`);
    console.log('');

    // List contents
    console.log('Step 2: Listing DMG contents...');
    const lsProcess = spawn('ls', ['-la', mountPoint]);

    lsProcess.stdout?.on('data', (data) => {
      console.log(data.toString());
    });

    lsProcess.on('close', () => {
      // Unmount
      console.log('Step 3: Unmounting DMG...');
      const unmount = spawn('hdiutil', ['detach', mountPoint, '-quiet']);

      unmount.on('close', (unmountCode) => {
        if (unmountCode === 0) {
          console.log('  SUCCESS: DMG unmounted');
        } else {
          console.log(`  Warning: Unmount returned code ${unmountCode}`);
        }
        console.log('');
        console.log('Test complete. In real usage, we would copy the .app to /Applications');
      });
    });
  });
}

// Run platform-specific test
if (platform === 'linux') {
  testLinux();
} else if (platform === 'win32') {
  testWindows();
} else if (platform === 'darwin') {
  testMacOS();
} else {
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}
