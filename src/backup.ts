import { DatabaseSync, backup } from 'node:sqlite';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';

// Run only while the application is stopped so file cleanup cannot race the snapshot.
async function main() {
  const source = resolve(process.env.DATA_DIR ?? 'data');
  const target = resolve(process.argv[2] ?? `backups/${new Date().toISOString().replaceAll(':', '-')}`);
  const destination = relative(source, target);
  if (!destination || (!destination.startsWith('..') && !isAbsolute(destination))) throw new Error('Invalid destination');
  await mkdir(target, { recursive: false });
  const db = new DatabaseSync(join(source, 'state.sqlite'), { readOnly: true });
  try {
    await backup(db, join(target, 'state.sqlite'));
    await cp(join(source, 'images'), join(target, 'images'), { recursive: true });
    const files = await readdir(join(target, 'images'));
    process.stdout.write(`Резервная копия: ${target}; файлов: ${files.length}\n`);
  } finally { db.close(); }
}
main().catch(() => { process.stderr.write('Резервная копия не создана. Остановите сервер и проверьте пути.\n'); process.exitCode = 1; });
