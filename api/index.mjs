/**
 * Vercel serverless entry for the NIVORA API.
 *
 * Every /api/* request lands here. Plain ESM (not TypeScript) on purpose: the
 * Express app is compiled by `npm run build` into dist/server.js, which the
 * platform then bundles with this file — no second typecheck, no rootDir
 * conflict with the API sources.
 *
 * The Mongo connection is established once per warm instance and reused, which
 * keeps cold starts cheap without exhausting Atlas sockets.
 */
import { app, ensureDatabase } from '../dist/server.js';

export default async function handler(req, res) {
  try {
    await ensureDatabase();
  } catch (err) {
    console.error('[db] connection failed', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Database unavailable. Please try again.', code: 'db_unavailable' }));
    return;
  }
  app(req, res);
}
