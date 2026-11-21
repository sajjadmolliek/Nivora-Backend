/**
 * Copies the built admin dashboard into `public/`, which is the Vercel output
 * directory, so the dashboard is served as static files at /admin/ while the
 * API stays in a serverless function.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const from = path.join(root, 'admin', 'dist');
const out = path.join(root, 'public');
const to = path.join(out, 'admin');

if (!existsSync(from)) {
  console.error('[prepare-admin] admin/dist not found — build the dashboard first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log('[prepare-admin] dashboard copied to public/admin');
