import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for the supabase query chain the helper uses:
// .from(t).select('*').eq(...).eq(...).maybeSingle()
const maybeSingle = vi.fn();
vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle })),
        })),
      })),
    })),
  },
}));

import { clientIdOf, beginIdempotentCreate, recoverIdempotentRace } from './idempotentCreate';

const CID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => { maybeSingle.mockReset(); });

describe('clientIdOf', () => {
  it('accepts a uuid and rejects everything else', () => {
    expect(clientIdOf({ client_id: CID })).toBe(CID);
    expect(clientIdOf({ client_id: 'not-a-uuid' })).toBeNull();
    expect(clientIdOf({ client_id: 42 })).toBeNull();
    expect(clientIdOf({})).toBeNull();
    expect(clientIdOf(null)).toBeNull();
  });
});

describe('beginIdempotentCreate', () => {
  it('returns the existing row for a replay — no insert happens', async () => {
    const existing = { id: 'srv-1', client_id: CID };
    maybeSingle.mockResolvedValue({ data: existing, error: null });
    const fields: Record<string, unknown> = { name: 'x' };
    const replay = await beginIdempotentCreate('bills', 'u1', { client_id: CID }, fields);
    expect(replay).toEqual(existing);
    expect(fields.client_id).toBeUndefined(); // never stamped on a replay
  });

  it('stamps client_id into fields for a first-time create', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const fields: Record<string, unknown> = { name: 'x' };
    const replay = await beginIdempotentCreate('bills', 'u1', { client_id: CID }, fields);
    expect(replay).toBeNull();
    expect(fields.client_id).toBe(CID);
  });

  it('degrades to a plain create when the column is not migrated', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { code: '42703', message: 'column does not exist' } });
    const fields: Record<string, unknown> = { name: 'x' };
    const replay = await beginIdempotentCreate('bills', 'u1', { client_id: CID }, fields);
    expect(replay).toBeNull();
    expect(fields.client_id).toBeUndefined(); // must not reach the insert
  });

  it('strips a client_id that leaked into fields via a body spread', async () => {
    // No valid client_id in the body — but a spread put SOMETHING in fields.
    const fields: Record<string, unknown> = { name: 'x', client_id: 'garbage' };
    const replay = await beginIdempotentCreate('bills', 'u1', { client_id: 'garbage' }, fields);
    expect(replay).toBeNull();
    expect(fields.client_id).toBeUndefined();
    expect(maybeSingle).not.toHaveBeenCalled(); // invalid key → no lookup
  });
});

describe('recoverIdempotentRace', () => {
  it('returns the existing row on a 23505 with a client_id', async () => {
    const existing = { id: 'srv-1', client_id: CID };
    maybeSingle.mockResolvedValue({ data: existing, error: null });
    const raced = await recoverIdempotentRace('bills', 'u1', { client_id: CID }, { code: '23505' });
    expect(raced).toEqual(existing);
  });

  it('falls through for any other error code', async () => {
    const raced = await recoverIdempotentRace('bills', 'u1', { client_id: CID }, { code: '22P02' });
    expect(raced).toBeNull();
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it('falls through when the 23505 came from a different unique constraint', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const raced = await recoverIdempotentRace('bills', 'u1', { client_id: CID }, { code: '23505' });
    expect(raced).toBeNull();
  });
});
