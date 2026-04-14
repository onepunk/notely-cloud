#!/usr/bin/env node
/**
 * Converts CHANGELOG.md to releases/notes.json for web and app consumption.
 *
 * Usage:
 *   node scripts/generate-release-notes.cjs [output-path]
 *
 * If output-path is not specified, outputs to dist/release-notes.json
 */

const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '..', 'CHANGELOG.md');
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'dist', 'release-notes.json');

function parseChangelog(content) {
  const releases = [];
  const lines = content.split('\n');

  let currentRelease = null;
  let currentSection = null;

  for (const line of lines) {
    // Match version headers: ## 0.8.8 (2025-01-21) or ### [0.8.9](link) (2026-01-21)
    const versionMatch = line.match(/^#{2,3}\s+\[?(\d+\.\d+\.\d+)\]?(?:\([^)]*\))?\s*\((\d{4}-\d{2}-\d{2})\)/);
    if (versionMatch) {
      if (currentRelease) {
        releases.push(currentRelease);
      }
      currentRelease = {
        version: versionMatch[1],
        date: versionMatch[2],
        features: [],
        fixes: [],
        performance: [],
        breaking: []
      };
      currentSection = null;
      continue;
    }

    // Match section headers: ### Features, ### Bug Fixes, etc.
    const sectionMatch = line.match(/^###\s+(.+)/);
    if (sectionMatch && currentRelease) {
      const sectionName = sectionMatch[1].toLowerCase();
      if (sectionName.includes('feature')) {
        currentSection = 'features';
      } else if (sectionName.includes('fix') || sectionName.includes('bug')) {
        currentSection = 'fixes';
      } else if (sectionName.includes('performance')) {
        currentSection = 'performance';
      } else if (sectionName.includes('breaking')) {
        currentSection = 'breaking';
      } else {
        currentSection = null;
      }
      continue;
    }

    // Match list items: - Item or * Item
    const itemMatch = line.match(/^[\s]*[-*]\s+(.+)/);
    if (itemMatch && currentRelease && currentSection) {
      const item = itemMatch[1].trim();
      // Clean up markdown and standard-version artifacts
      const cleanItem = item
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove markdown links
        .replace(/`([^`]+)`/g, '$1') // Remove inline code
        .replace(/\s*\([a-f0-9]{7,}\)/gi, '') // Remove commit hashes like (a14c641)
        .replace(/,?\s*closes?\s+#[\w]+(\s+#[\w]+)*/gi, '') // Remove "closes #xxx #yyy"
        .replace(/^\*\*[\w-]+:\*\*\s*/i, '') // Remove scope markers like **update:**
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();

      if (cleanItem && currentRelease[currentSection]) {
        currentRelease[currentSection].push(cleanItem);
      }
    }
  }

  // Don't forget the last release
  if (currentRelease) {
    releases.push(currentRelease);
  }

  return releases;
}

function main() {
  const outputPath = process.argv[2] || DEFAULT_OUTPUT;

  // Read changelog
  if (!fs.existsSync(CHANGELOG_PATH)) {
    console.error('Error: CHANGELOG.md not found at', CHANGELOG_PATH);
    process.exit(1);
  }

  const changelogContent = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const releases = parseChangelog(changelogContent);

  if (releases.length === 0) {
    console.error('Error: No releases found in CHANGELOG.md');
    process.exit(1);
  }

  // Get package version for metadata
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  const output = {
    generated: new Date().toISOString(),
    currentVersion: packageJson.version,
    releases: releases
  };

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write output
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`Generated release notes: ${outputPath}`);
  console.log(`  - Current version: ${packageJson.version}`);
  console.log(`  - Total releases: ${releases.length}`);
  console.log(`  - Latest release: ${releases[0]?.version || 'none'}`);
}

main();
