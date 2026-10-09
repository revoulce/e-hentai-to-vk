import { cpSync } from 'node:fs';
cpSync('migrations', 'dist/migrations', { recursive: true });
