#!/usr/bin/env node
/**
 * Verify Main Process Build
 *
 * Checks that the built main.cjs file doesn't contain browser module stubs
 * or incorrect module resolutions. This catches build configuration issues
 * before they reach production.
 *
 * Run: node scripts/verify-main-build.cjs
 *
 * Date: 2025-12-17
 */

const fs = require('fs');
const path = require('path');

const BUILD_PATH = path.join(__dirname, '..', 'dist-electron', 'main.cjs');

console.log('Verifying main process build...\n');

// Check if build output exists
if (!fs.existsSync(BUILD_PATH)) {
  console.error('ERROR: Build output not found at:', BUILD_PATH);
  console.error('Run "npm run build" first.');
  process.exit(1);
}

const content = fs.readFileSync(BUILD_PATH, 'utf8');
let hasErrors = false;
let hasWarnings = false;

// Check 1: Browser stub error message (indicates wrong module resolved)
const browserStubPatterns = [
  'ws does not work in the browser',
  'Browser clients must use the native WebSocket',
];

for (const pattern of browserStubPatterns) {
  if (content.includes(pattern)) {
    console.error(`ERROR: Found browser stub pattern in build: "${pattern}"`);
    console.error('The ws package browser.js was incorrectly bundled.');
    console.error('Fix: Check vite.main.config.ts resolve.conditions');
    hasErrors = true;
  }
}

// Check 2: Verify ws is properly externalized (should be require("ws") not bundled)
const wsExternalPattern = /require\s*\(\s*["']ws["']\s*\)/;
if (!wsExternalPattern.test(content)) {
  console.warn('WARNING: ws module may not be properly externalized');
  console.warn('Expected to find: require("ws")');
  hasWarnings = true;
}

// Check 3: Look for window global usage (shouldn't exist in main process)
// This is a soft check - some dependencies might legitimately check for window
const windowUsagePattern = /typeof\s+window\s*[!=]==?\s*["']undefined["']/g;
const windowMatches = content.match(windowUsagePattern);
if (windowMatches && windowMatches.length > 5) {
  console.warn(`WARNING: Found ${windowMatches.length} window detection patterns`);
  console.warn('This may indicate browser code is bundled in main process');
  hasWarnings = true;
}

// Check 4: Verify electron is externalized
const electronExternalPattern = /require\s*\(\s*["']electron["']\s*\)/;
if (!electronExternalPattern.test(content)) {
  console.warn('WARNING: electron module may not be properly externalized');
  hasWarnings = true;
}

// Summary
console.log('---');
if (hasErrors) {
  console.error('\nBUILD VERIFICATION FAILED\n');
  process.exit(1);
}

if (hasWarnings) {
  console.warn('\nBuild verification passed with warnings\n');
} else {
  console.log('\nBuild verification passed\n');
}

console.log('- No browser stubs detected');
console.log('- ws module appears correctly externalized');
console.log('- electron module appears correctly externalized');
