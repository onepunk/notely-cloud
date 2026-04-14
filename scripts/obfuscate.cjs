/**
 * Post-build JavaScript obfuscation script
 *
 * Obfuscates all built JS files in dist-electron/ and dist/renderer/ using
 * javascript-obfuscator with two profiles:
 * - Node profile: main.cjs, preload.cjs (and chunks) - target 'node'
 * - Browser profile: renderer JS chunks - target 'browser'
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const DIST_ELECTRON = path.join(ROOT, 'dist-electron');
const DIST_RENDERER = path.join(ROOT, 'dist', 'renderer');

/**
 * Node profile for main process and preload scripts.
 * More aggressive obfuscation since performance is less critical.
 */
const NODE_OPTIONS = {
  target: 'node',
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.95,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.5,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  transformObjectKeys: false, // Preserves IPC channel names
  renameGlobals: false, // CJS compatibility
  renameProperties: false,
  selfDefending: false, // Must stay false for Node.js/bytecode compatibility
  debugProtection: false, // Must stay false for Node.js/bytecode compatibility
  domainLock: [],
  log: false,
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 5,
  unicodeEscapeSequence: false,
};

/**
 * Preload profile — maximum string protection since the preload script
 * is the complete IPC API surface map. Cannot use selfDefending or
 * debugProtection (Electron sandbox / bytecode incompatibility).
 */
const PRELOAD_OPTIONS = {
  target: 'node',
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 1.0,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  transformObjectKeys: false,
  renameGlobals: false,
  renameProperties: false,
  selfDefending: false,
  debugProtection: false,
  domainLock: [],
  log: false,
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 5,
  unicodeEscapeSequence: true,
};

/**
 * Browser profile for renderer chunks.
 * selfDefending and debugProtection are disabled — they break React DOM
 * reconciliation and Lexical's selection destructuring at runtime.
 * controlFlowFlattening kept low to avoid reordering complex closures.
 * String obfuscation (stringArray + deadCodeInjection) provides the IP protection.
 */
const BROWSER_OPTIONS = {
  target: 'browser',
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.85,
  transformObjectKeys: false,
  renameGlobals: false,
  renameProperties: false,
  selfDefending: false,
  debugProtection: false,
  domainLock: [],
  log: false,
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 7,
  unicodeEscapeSequence: false,
};

/**
 * Recursively find all .js and .cjs files in a directory
 */
function findJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsFiles(fullPath));
    } else if (entry.isFile() && /\.(js|cjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Obfuscate a single file in place
 */
function obfuscateFile(filePath, options) {
  const code = fs.readFileSync(filePath, 'utf-8');

  // Skip empty or very small files
  if (code.trim().length < 50) {
    console.log(`  SKIP (too small): ${path.relative(ROOT, filePath)}`);
    return;
  }

  try {
    const result = JavaScriptObfuscator.obfuscate(code, options);
    fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf-8');

    const originalSize = Buffer.byteLength(code, 'utf-8');
    const obfuscatedSize = Buffer.byteLength(result.getObfuscatedCode(), 'utf-8');
    const ratio = (obfuscatedSize / originalSize).toFixed(2);
    console.log(
      `  OK: ${path.relative(ROOT, filePath)} (${(originalSize / 1024).toFixed(0)}KB -> ${(obfuscatedSize / 1024).toFixed(0)}KB, ${ratio}x)`
    );
  } catch (error) {
    console.error(`  FAIL: ${path.relative(ROOT, filePath)} - ${error.message}`);
    process.exit(1);
  }
}

// Main
console.log('=== JavaScript Obfuscation ===\n');

// Phase 1: Obfuscate dist-electron (Node profile)
console.log('Obfuscating main process files (Node profile):');
const electronFiles = findJsFiles(DIST_ELECTRON);
if (electronFiles.length === 0) {
  console.error('ERROR: No JS files found in dist-electron/. Run vite build first.');
  process.exit(1);
}
for (const file of electronFiles) {
  const isPreload = path.basename(file).startsWith('preload');
  obfuscateFile(file, isPreload ? PRELOAD_OPTIONS : NODE_OPTIONS);
}

// Phase 2: Obfuscate dist/renderer (Browser profile)
console.log('\nObfuscating renderer files (Browser profile):');
const rendererFiles = findJsFiles(DIST_RENDERER);
if (rendererFiles.length === 0) {
  console.warn('WARNING: No JS files found in dist/renderer/. Skipping renderer obfuscation.');
} else {
  for (const file of rendererFiles) {
    obfuscateFile(file, BROWSER_OPTIONS);
  }
}

console.log('\n=== Obfuscation Complete ===');
