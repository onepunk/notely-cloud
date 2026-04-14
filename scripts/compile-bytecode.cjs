/**
 * V8 Bytecode Compilation Orchestrator
 *
 * Compiles main process .cjs files to V8 bytecode (.jsc) for source code protection.
 * Must use Electron's own Node.js (not system Node) to ensure V8 version compatibility.
 *
 * Only main.cjs and its chunks are compiled. preload.cjs is intentionally skipped
 * because it runs in Electron's sandboxed preload context where only built-in modules
 * (electron, events, timers, url) can be required — bytenode cannot be loaded there.
 *
 * Flow:
 * 1. Read main.cjs and discover its chunk requires
 * 2. Spawn Electron to run compile-bytecode-worker.cjs (uses Electron's V8)
 * 3. Worker compiles each file to .jsc via bytenode
 * 4. Replace original .cjs with thin loader that loads the .jsc at runtime
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_ELECTRON = path.join(ROOT, 'dist-electron');
const WORKER_SCRIPT = path.join(__dirname, 'compile-bytecode-worker.cjs');

// Find Electron executable
function findElectronBinary() {
  try {
    const electronPath = require('electron');
    if (typeof electronPath === 'string') return electronPath;
  } catch {
    // Fall through
  }

  // Try node_modules/.bin
  const binPath =
    process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
      : path.join(ROOT, 'node_modules', '.bin', 'electron');

  if (fs.existsSync(binPath)) return binPath;

  console.error('ERROR: Cannot find Electron binary. Is electron installed?');
  process.exit(1);
}

/**
 * Generate a thin loader script that loads the .jsc bytecode at runtime
 */
function generateLoader(jscFilename) {
  return `'use strict';
require('bytenode');
require('./${jscFilename}');
`;
}

// Main
console.log('=== V8 Bytecode Compilation ===\n');

// Only compile main.cjs and its chunks (skip preload.cjs — it runs in
// Electron's sandboxed preload context where require('bytenode') is forbidden).
const ENTRY = 'main.cjs';
const entryPath = path.join(DIST_ELECTRON, ENTRY);

if (!fs.existsSync(entryPath)) {
  console.error('ERROR: main.cjs not found in dist-electron/. Run vite build first.');
  process.exit(1);
}

const entryContent = fs.readFileSync(entryPath, 'utf-8');

// Find all local chunk requires in main.cjs (e.g. require("./index-C1C8t2Zp.cjs"))
const chunkPattern = /require\("\.\/([^"]+\.cjs)"\)/g;
const mainChunks = [...entryContent.matchAll(chunkPattern)].map((m) => m[1]);

const filesToCompile = [ENTRY, ...mainChunks];
const cjsFiles = filesToCompile
  .map((f) => path.join(DIST_ELECTRON, f))
  .filter((f) => fs.existsSync(f));

if (cjsFiles.length === 0) {
  console.error('ERROR: No files resolved for compilation.');
  process.exit(1);
}

// Log what we're compiling and what we're skipping
const allCjsFiles = fs.readdirSync(DIST_ELECTRON).filter((f) => f.endsWith('.cjs'));
const compiledNames = new Set(filesToCompile);
const skippedFiles = allCjsFiles.filter((f) => !compiledNames.has(f));

console.log(`Found ${cjsFiles.length} file(s) to compile (main process):`);
for (const f of cjsFiles) {
  console.log(`  ${path.basename(f)}`);
}
if (skippedFiles.length > 0) {
  console.log(`\nSkipping ${skippedFiles.length} file(s) (preload, stays as JS for sandbox compatibility):`);
  for (const f of skippedFiles) {
    console.log(`  ${f}`);
  }
}

// Spawn Electron to compile each file
const electronBin = findElectronBinary();
console.log(`\nUsing Electron at: ${electronBin}`);

for (const cjsFile of cjsFiles) {
  const basename = path.basename(cjsFile, '.cjs');
  const jscFile = path.join(DIST_ELECTRON, `${basename}.jsc`);

  console.log(`\nCompiling: ${path.basename(cjsFile)} -> ${basename}.jsc`);

  try {
    // Spawn Electron to run the worker script with the file to compile
    execFileSync(electronBin, [WORKER_SCRIPT, cjsFile, jscFile], {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 120000, // 2 minute timeout per file
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1', // Run as Node.js, not as Electron GUI
      },
    });

    // Verify .jsc was created
    if (!fs.existsSync(jscFile)) {
      console.error(`ERROR: ${basename}.jsc was not created`);
      process.exit(1);
    }

    const jscSize = fs.statSync(jscFile).size;
    const originalSize = fs.statSync(cjsFile).size;
    console.log(
      `  Compiled: ${(originalSize / 1024).toFixed(0)}KB -> ${(jscSize / 1024).toFixed(0)}KB`
    );

    // Replace the original .cjs with a thin loader
    const loader = generateLoader(`${basename}.jsc`);
    fs.writeFileSync(cjsFile, loader, 'utf-8');
    console.log(`  Replaced ${path.basename(cjsFile)} with bytecode loader`);
  } catch (error) {
    console.error(`ERROR: Failed to compile ${path.basename(cjsFile)}: ${error.message}`);
    process.exit(1);
  }
}

console.log('\n=== Bytecode Compilation Complete ===');
