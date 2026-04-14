const Database = require('better-sqlite3-multiple-ciphers');
const keytar = require('keytar');
const path = require('path');
const os = require('os');

(async () => {
  const key = await keytar.getPassword('com.notely.desktop', 'database-encryption-key');
  const dbPath = path.join(os.homedir(), '.config/notely-desktop/data/notes.sqlite');
  const db = new Database(dbPath);
  db.pragma("key = 'x''" + key + "'''");

  console.log('=== CLIENT BINDERS ===');
  const binders = db.prepare('SELECT id, name, binder_type, remote_id, deleted, user_profile_id, is_conflicts FROM binders ORDER BY binder_type, name').all();
  binders.forEach(b => {
    console.log('  ID:', b.id);
    console.log('  Name:', b.name);
    console.log('  Type:', b.binder_type);
    console.log('  Remote ID:', b.remote_id || '(none)');
    console.log('  Deleted:', b.deleted);
    console.log('  Is Conflicts:', b.is_conflicts);
    console.log('  User Profile:', b.user_profile_id);
    console.log('');
  });

  console.log('=== CLIENT NOTES ===');
  const notes = db.prepare('SELECT id, title, binder_id, deleted FROM notes').all();
  notes.forEach(n => {
    console.log('  ID:', n.id);
    console.log('  Title:', n.title || '(untitled)');
    console.log('  Binder ID:', n.binder_id);
    console.log('  Deleted:', n.deleted);
    console.log('');
  });

  console.log('=== SYNC ITEMS (BINDERS) ===');
  const syncItems = db.prepare("SELECT * FROM sync_items WHERE entity_type = 'binders'").all();
  if (syncItems.length === 0) {
    console.log('  (none)');
  }
  syncItems.forEach(s => {
    console.log('  Entity:', s.entity_type, s.entity_id);
    console.log('  Sync Time:', s.sync_time);
    console.log('  Disabled:', s.sync_disabled);
    console.log('');
  });

  console.log('=== SYNC ITEMS (NOTES) ===');
  const notesSyncItems = db.prepare("SELECT * FROM sync_items WHERE entity_type = 'notes'").all();
  if (notesSyncItems.length === 0) {
    console.log('  (none)');
  }
  notesSyncItems.forEach(s => {
    console.log('  Entity:', s.entity_type, s.entity_id);
    console.log('  Sync Time:', s.sync_time);
    console.log('  Disabled:', s.sync_disabled);
    console.log('');
  });

  db.close();
  process.exit(0);
})();
