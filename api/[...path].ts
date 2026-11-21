/**
 * Vercel serverless entry for the NIVORA API.
 *
 * Every /api/* request lands here. The Express app itself is unchanged: it is
 * exported from src/server.ts and simply receives the platform's request and
 * response objects. The Mongo connection is established once per warm instance
 * and reused, which keeps cold starts cheap without exhausting Atlas sockets.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { app, ensureDatabase } from '../src/server';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await ensureDatabase();
  } catch (err) {
    console.error('[db] connection failed', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Database unavailable. Please try again.', code: 'db_unavailable' }));
    return;
  }
  app(req as unknown as Parameters<typeof app>[0], res as unknown as Parameters<typeof app>[1]);
}
