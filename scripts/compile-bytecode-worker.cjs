/**
 * Bytecode Compilation Worker
 *
 * This script runs inside Electron's V8 (via ELECTRON_RUN_AS_NODE=1)
 * to ensure the compiled bytecode matches Electron's V8 version.
 *
 * Usage: electron compile-bytecode-worker.cjs <input.cjs> <output.jsc>
 */

'use strict';

const bytenode = require('bytenode');
const path = require('path');

const [, , inputFile, outputFile] = process.argv;

if (!inputFile || !outputFile) {
  console.error('Usage: electron compile-bytecode-worker.cjs <input.cjs> <output.jsc>');
  process.exit(1);
}

console.log(`  Worker: Compiling ${path.basename(inputFile)}`);
console.log(`  Worker: V8 version: ${process.versions.v8}`);
console.log(`  Worker: Node version: ${process.versions.node}`);

try {
  bytenode.compileFile({
    filename: inputFile,
    output: outputFile,
    compileAsModule: true,
  });
  console.log(`  Worker: Successfully compiled to ${path.basename(outputFile)}`);
} catch (error) {
  console.error(`  Worker: Compilation failed: ${error.message}`);
  process.exit(1);
}
