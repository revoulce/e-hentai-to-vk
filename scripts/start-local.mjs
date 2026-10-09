import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultTokenFile = join(root, 'secrets', 'api-token.txt');
const tokenFile = process.env.API_TOKEN_FILE ? resolve(process.env.API_TOKEN_FILE) : defaultTokenFile;
try { await access(tokenFile); }
catch {
  if (tokenFile !== defaultTokenFile) throw new Error('Файл API_TOKEN_FILE недоступен. Проверьте путь или уберите эту переменную для локального запуска.');
  await mkdir(dirname(tokenFile), { recursive: true });
  try { await writeFile(tokenFile, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
process.env.API_TOKEN_FILE = tokenFile;
process.env.HOST = '127.0.0.1';
process.env.PORT ??= '3000';
process.env.DATA_DIR ??= join(root, 'data');
console.log(`Адрес в расширении: http://127.0.0.1:${process.env.PORT}`);
console.log(`Файл API-токена: ${tokenFile}`);
await import('../src/main.ts');
