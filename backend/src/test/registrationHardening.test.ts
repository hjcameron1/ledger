import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { registerSchema, loginSchema } from '../routes/auth';
import { jsonBodyErrorHandler } from '../utils/jsonErrorHandler';
import { reapUnverifiedUsers } from '../services/unverifiedReaper';
import { seed, resetDb, fakeSupabase, table } from './fakeSupabase';

// D1 — malformed JSON body → 400, not 500
describe('D1: malformed JSON body', () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(jsonBodyErrorHandler);
  app.post('/x', (_req, res) => res.status(201).json({ ok: true }));
  app.use((_err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: 'Internal server error' }));
  let base = '';
  const server = app.listen(0);
  const addr = server.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  it('returns 400 for unparseable JSON', async () => {
    const r = await fetch(base + '/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json' });
    expect(r.status).toBe(400);
    server.close();
  });
});

// D2 — registration/login field length caps
describe('D2: registration field limits', () => {
  it('rejects an over-long email', () => {
    expect(registerSchema.safeParse({ email: 'a'.repeat(100000) + '@x.com', password: 'password1', name: 'A' }).success).toBe(false);
  });
  it('rejects an over-long password', () => {
    expect(registerSchema.safeParse({ email: 'a@x.com', password: 'p'.repeat(5000), name: 'A' }).success).toBe(false);
  });
  it('rejects an over-long name', () => {
    expect(registerSchema.safeParse({ email: 'a@x.com', password: 'password1', name: 'X'.repeat(500) }).success).toBe(false);
  });
  it('accepts a sane registration', () => {
    expect(registerSchema.safeParse({ email: 'good@x.com', password: 'password1', name: 'Real User' }).success).toBe(true);
  });
  it('caps login fields too', () => {
    expect(loginSchema.safeParse({ email: 'a'.repeat(300) + '@x.com', password: 'x' }).success).toBe(false);
  });
});

// D3 — reaper deletes only aged unverified rows
describe('D3: unverified reaper', () => {
  beforeEach(() => resetDb());
  const now = Date.now();
  const iso = (d: number) => new Date(now - d * 24 * 3600 * 1000).toISOString();

  it('reaps aged unverified rows, spares recent and verified', async () => {
    seed('users', [
      { id: 'old-unverified',    email_verified: false, created_at: iso(30) },
      { id: 'recent-unverified', email_verified: false, created_at: iso(2)  },
      { id: 'old-verified',      email_verified: true,  created_at: iso(30) },
    ]);
    const reaped = await reapUnverifiedUsers(fakeSupabase, 7, now);
    expect(reaped).toBe(1);
    expect(table('users').map((r: any) => r.id).sort()).toEqual(['old-verified', 'recent-unverified']);
  });

  it('is a no-op when nothing is aged', async () => {
    seed('users', [{ id: 'fresh', email_verified: false, created_at: iso(1) }]);
    expect(await reapUnverifiedUsers(fakeSupabase, 7, now)).toBe(0);
    expect(table('users').length).toBe(1);
  });
});
