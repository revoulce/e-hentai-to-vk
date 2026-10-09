import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/database.js';

test('VK schedule migration preserves an existing job and all foreign key references', async t => {
  const directory = await mkdtemp(join(process.cwd(), '.ehvk-test-migration-'));
  let store: Store | undefined;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const version of ['001_initial.sql','002_source_files.sql','003_vk_target.sql']) {
    legacy.exec(await readFile(join(process.cwd(), 'migrations', version), 'utf8'));
    legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(version, '2026-10-08T04:59:00Z');
  }
  legacy.exec(`
    INSERT INTO galleries VALUES ('gallery','https://example.test/','Synthetic gallery',13,'{}');
    INSERT INTO drafts VALUES ('draft','gallery',1,'{}','confirmed','now','now','later');
    INSERT INTO jobs VALUES ('job','draft','gallery','{}','queued','now','now',NULL);
    INSERT INTO posts (id,job_id,role,state,operation_key) VALUES ('post','job','public','pending','operation');
    INSERT INTO confirmation_keys VALUES ('key','job','fingerprint');
    INSERT INTO attempts VALUES ('attempt','post','publish','started','{}',NULL,'now','now');
    INSERT INTO schedule_slots VALUES ('instant','job','claimed');
  `);
  legacy.close();
  store = new Store(path);
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id = ?').get('job')!.state, 'queued');
  assert.equal(store.db.prepare('SELECT publish_at FROM posts WHERE id = ?').get('post')!.publish_at, null);
  assert.equal(store.db.prepare('SELECT job_id FROM confirmation_keys').get()!.job_id, 'job');
  assert.equal(store.db.prepare('SELECT job_id FROM schedule_slots').get()!.job_id, 'job');
  assert.equal(store.db.prepare('SELECT post_id FROM attempts').get()!.post_id, 'post');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  store.db.prepare("UPDATE jobs SET state = 'scheduled' WHERE id = ?").run('job');
});
