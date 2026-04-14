#!/usr/bin/env node
/**
 * Query note content for debugging export
 */

const Database = require('better-sqlite3-multiple-ciphers');
const keytar = require('keytar');
const path = require('path');
const os = require('os');

const SERVICE_NAME = 'com.notely.desktop';
const DB_KEY_ACCOUNT = 'database-encryption-key';

async function main() {
  try {
    const key = await keytar.getPassword(SERVICE_NAME, DB_KEY_ACCOUNT);
    if (!key) {
      console.error('ERROR: No encryption key found');
      process.exit(1);
    }

    const dbPath = path.join(os.homedir(), '.config/notely-desktop/data/notes.sqlite');
    const db = new Database(dbPath, { readonly: true });
    db.pragma("key = 'x''" + key + "'''");

    // Get notes with content
    const notes = db.prepare(`
      SELECT n.id, n.title, n.binder_id, r.plaintext, r.lexical_json
      FROM notes n
      JOIN note_content_head h ON h.note_id = n.id
      JOIN note_revisions r ON r.revision_id = h.revision_id
      WHERE n.deleted = 0
    `).all();

    console.log('=== NOTES WITH CONTENT ===');
    for (const note of notes) {
      console.log(`\nNote ID: ${note.id}`);
      console.log(`Title: "${note.title}"`);
      console.log(`Plaintext length: ${note.plaintext?.length || 0}`);
      console.log(`Plaintext: "${note.plaintext?.substring(0, 200)}${note.plaintext?.length > 200 ? '...' : ''}"`);
      console.log(`Lexical JSON length: ${note.lexical_json?.length || 0}`);
      console.log(`Lexical JSON: ${note.lexical_json}`);
    }

    // Get transcriptions
    const transcriptions = db.prepare(`
      SELECT id, note_id, status, full_text, char_count, word_count
      FROM transcription_sessions
      WHERE deleted = 0
    `).all();

    console.log('\n=== TRANSCRIPTIONS ===');
    console.log(`Count: ${transcriptions.length}`);
    for (const t of transcriptions) {
      console.log(`\nTranscription ID: ${t.id}`);
      console.log(`Note ID: ${t.note_id}`);
      console.log(`Status: ${t.status}`);
      console.log(`Full text length: ${t.full_text?.length || 0}`);
    }

    db.close();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
