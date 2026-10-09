import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, type Settings } from './shared/contracts.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const source = fileURLToPath(new URL('../migrations/', import.meta.url));
    const directory = existsSync(source) ? source : join(process.cwd(), 'migrations');
    const pending = readdirSync(directory).filter(v => v.endsWith('.sql')).sort()
      .filter(v => !this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(v));
    if (pending.length && this.db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get()) {
      this.db.exec(`VACUUM INTO '${`${path}.before-migration-${Date.now()}`.replaceAll("'", "''")}'`);
    }
    // SQLite table rebuilds require this outside the transaction. Check every
    // reference before committing, then restore enforcement before serving work.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (const version of pending) this.transaction(() => {
        this.db.exec(readFileSync(join(directory, version), 'utf8'));
        if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('MIGRATION_FOREIGN_KEY');
        this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(version, new Date().toISOString());
      });
    } catch (error) { this.db.close(); throw error; }
    finally { if (this.db.isOpen) this.db.exec('PRAGMA foreign_keys = ON'); }
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify(DEFAULT_SETTINGS));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settings(): Settings {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id = 1').get()!.value as string) } as Settings;
  }
  saveSettings(value: Settings): void {
    this.db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(value));
  }
  close(): void { this.db.close(); }
}
