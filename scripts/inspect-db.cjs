#!/usr/bin/env node
/**
 * Database Inspection Script for Notely Desktop v3
 *
 * Inspects the encrypted SQLite database and outputs schema/data information.
 * Must be run with Electron due to native module compilation.
 *
 * Usage: npx electron scripts/inspect-db.cjs [--tables] [--schema] [--counts] [--settings] [--all]
 *
 * Options:
 *   --tables   List all tables
 *   --schema   Show schema for key tables
 *   --counts   Show row counts
 *   --settings Show settings values
 *   --indexes  Show all indexes
 *   --all      Show everything (default if no options)
 */

const Database = require('better-sqlite3-multiple-ciphers');
const keytar = require('keytar');
const path = require('path');
const os = require('os');

const SERVICE_NAME = 'com.notely.desktop';
const DB_KEY_ACCOUNT = 'database-encryption-key';

const args = process.argv.slice(2);
const showTables = args.includes('--tables') || args.includes('--all') || args.length === 0;
const showSchema = args.includes('--schema') || args.includes('--all') || args.length === 0;
const showCounts = args.includes('--counts') || args.includes('--all') || args.length === 0;
const showSettings = args.includes('--settings') || args.includes('--all') || args.length === 0;
const showIndexes = args.includes('--indexes') || args.includes('--all') || args.length === 0;

async function main() {
  try {
    // Get encryption key from OS keystore
    const key = await keytar.getPassword(SERVICE_NAME, DB_KEY_ACCOUNT);
    if (!key) {
      console.error('ERROR: No encryption key found in keystore');
      console.error('The database encryption key is missing from the OS keystore.');
      console.error('This could mean:');
      console.error('  - The app has never been run');
      console.error('  - The keystore was cleared');
      console.error('  - Password protection is enabled (key is encrypted)');
      process.exit(1);
    }

    // Check for password protection
    const configPath = path.join(os.homedir(), '.config/notely-desktop/config/password-protection.json');
    const fs = require('fs');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.enabled) {
        console.error('ERROR: Password protection is enabled');
        console.error('The database key is encrypted with a user password.');
        console.error('Run the app and unlock it first, or use the recovery key.');
        process.exit(1);
      }
    }

    // Open database
    const dbPath = path.join(os.homedir(), '.config/notely-desktop/data/notes.sqlite');
    if (!fs.existsSync(dbPath)) {
      console.error('ERROR: Database file not found at:', dbPath);
      process.exit(1);
    }

    console.log('Database:', dbPath);
    const db = new Database(dbPath);

    // Apply encryption key
    db.pragma("key = 'x''" + key + "'''");

    // Verify decryption
    try {
      db.prepare('SELECT 1').get();
    } catch (err) {
      console.error('ERROR: Failed to decrypt database');
      console.error('The encryption key may be incorrect or the database may be corrupted.');
      process.exit(1);
    }

    // Get schema version
    const versionRow = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get();
    console.log('Schema Version:', versionRow ? versionRow.value : 'NOT SET');

    // Database status
    const journalMode = db.pragma('journal_mode', { simple: true });
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    console.log('Journal Mode:', journalMode);
    console.log('Foreign Keys:', foreignKeys ? 'ON' : 'OFF');
    console.log('');

    // Tables
    if (showTables) {
      console.log('=== TABLES ===');
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();
      tables.forEach(function(t) { console.log('  ' + t.name); });
      console.log('');
    }

    // Row counts
    if (showCounts) {
      console.log('=== ROW COUNTS ===');
      const countTables = [
        'binders', 'notes', 'note_revisions', 'note_content_head',
        'transcription_sessions', 'transcription_segments', 'audio_recordings',
        'summaries', 'tags', 'note_tags', 'calendar_events',
        'user_profiles', 'settings', 'sync_config', 'sync_items', 'sync_log'
      ];
      for (var i = 0; i < countTables.length; i++) {
        var tbl = countTables[i];
        try {
          var count = db.prepare('SELECT COUNT(*) as cnt FROM ' + tbl).get();
          console.log('  ' + tbl + ': ' + count.cnt);
        } catch (err) {
          console.log('  ' + tbl + ': [not found]');
        }
      }
      console.log('');
    }

    // Schema for key tables
    if (showSchema) {
      var keyTables = ['binders', 'notes', 'sync_items', 'sync_config', 'user_profiles'];
      keyTables.forEach(function(tbl) {
        console.log('=== ' + tbl.toUpperCase() + ' SCHEMA ===');
        try {
          var schema = db.prepare('PRAGMA table_info(' + tbl + ')').all();
          schema.forEach(function(col) {
            var flags = [];
            if (col.pk) flags.push('PK');
            if (col.notnull) flags.push('NOT NULL');
            if (col.dflt_value !== null) flags.push('DEFAULT ' + col.dflt_value);
            console.log('  ' + col.name + ' (' + col.type + ')' + (flags.length ? ' ' + flags.join(' ') : ''));
          });
        } catch (e) {
          console.log('  [table not found]');
        }
        console.log('');
      });
    }

    // Indexes
    if (showIndexes) {
      console.log('=== INDEXES ===');
      var indexes = db.prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name"
      ).all();
      indexes.forEach(function(idx) {
        console.log('  ' + idx.name + ' ON ' + idx.tbl_name);
      });
      console.log('');
    }

    // Settings
    if (showSettings) {
      console.log('=== SETTINGS ===');
      var settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
      settings.forEach(function(s) {
        var val = s.value;
        // Redact sensitive values
        if (s.key.toLowerCase().includes('token') || s.key.toLowerCase().includes('secret')) {
          val = '[REDACTED]';
        }
        // Truncate long values
        if (val && val.length > 60) {
          val = val.substring(0, 60) + '...';
        }
        console.log('  ' + s.key + ': ' + val);
      });
      console.log('');
    }

    db.close();
    console.log('Inspection complete.');
    process.exit(0);

  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
}

main();
