/**
 * A PostgREST-shaped in-memory Supabase, capable enough to drive the REAL
 * routers.
 *
 * The existing per-file fakes (documents / insurance / accountsSchema) each
 * implement the slice their own router needs. The pre-launch audit drives a
 * dozen routers at once against one world, so it needs one fake that speaks
 * enough of the dialect for all of them: `.or()` with real PostgREST syntax,
 * `.in`, `.neq`, `.not`, `.is`, range comparisons, `.match`, `.order`, `.limit`,
 * `.range`, `.upsert`, and insert/update/delete that return `.select()` rows.
 *
 * It is deliberately strict: an operator it cannot evaluate THROWS rather than
 * silently matching everything, because a fake that quietly returns every row
 * would turn a visibility bug into a passing test.
 */

export type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Map<string, Row[]>;
  /** Columns that must be unique, per table — the fake's stand-in for the
   *  unique indexes the real schema relies on for duplicate prevention. */
  unique: Map<string, string[][]>;
  storage: Map<string, { buffer: Buffer; contentType: string }>;
}

export const db: FakeDb = { tables: new Map(), unique: new Map(), storage: new Map() };

export function resetDb(): void {
  db.tables.clear();
  db.unique.clear();
  db.storage.clear();
}

export function table(name: string): Row[] {
  if (!db.tables.has(name)) db.tables.set(name, []);
  return db.tables.get(name)!;
}

/** Seed rows directly, bypassing the API — the world's starting state. */
export function seed(name: string, rows: Row[]): void {
  table(name).push(...rows.map(r => ({ created_at: '2026-01-01T00:00:00.000Z', ...r })));
}

export function uniqueOn(name: string, cols: string[]): void {
  const list = db.unique.get(name) ?? [];
  list.push(cols);
  db.unique.set(name, list);
}

// ── PostgREST expression evaluation ──────────────────────────────────────────

/** Split on commas at paren depth 0 — `a,and(b,c)` → ['a', 'and(b,c)']. */
function splitTop(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

const asNum = (v: unknown): number => Number(v);

/** Evaluate one PostgREST condition against a row. Throws on anything unknown. */
export function matches(row: Row, cond: string): boolean {
  const trimmed = cond.trim();
  if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
    return splitTop(trimmed.slice(4, -1)).every(c => matches(row, c));
  }
  if (trimmed.startsWith('or(') && trimmed.endsWith(')')) {
    return splitTop(trimmed.slice(3, -1)).some(c => matches(row, c));
  }
  if (trimmed.startsWith('not.')) return !matches(row, trimmed.slice(4));

  const inMatch = trimmed.match(/^([\w.]+)\.in\.\((.*)\)$/);
  if (inMatch) {
    const [, col, list] = inMatch;
    const wanted = list === '' ? [] : list.split(',').map(s => s.replace(/^"|"$/g, ''));
    return wanted.includes(String(row[col] ?? ''));
  }

  const opMatch = trimmed.match(/^([\w.]+)\.(eq|neq|gt|gte|lt|lte|is|like|ilike)\.(.*)$/);
  if (!opMatch) throw new Error(`fakeSupabase: cannot evaluate condition "${cond}"`);
  const [, col, op, rawValue] = opMatch;
  const cell = row[col];
  const value = rawValue.replace(/^"|"$/g, '');

  switch (op) {
    case 'eq': return String(cell ?? '') === value;
    case 'neq': return String(cell ?? '') !== value;
    case 'gt': return asNum(cell) > asNum(value);
    case 'gte': return asNum(cell) >= asNum(value);
    case 'lt': return asNum(cell) < asNum(value);
    case 'lte': return asNum(cell) <= asNum(value);
    case 'is':
      if (value === 'null') return cell === null || cell === undefined;
      if (value === 'true') return cell === true;
      if (value === 'false') return cell === false;
      throw new Error(`fakeSupabase: cannot evaluate is.${value}`);
    case 'like':
    case 'ilike': {
      const pattern = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
      return new RegExp(`^${pattern}$`, op === 'ilike' ? 'i' : '').test(String(cell ?? ''));
    }
    default: throw new Error(`fakeSupabase: cannot evaluate ${op}`);
  }
}

// ── Ids ──────────────────────────────────────────────────────────────────────

let counter = 0;
/** Deterministic UUID-shaped ids: the routers validate `z.string().uuid()`. */
export function nextId(): string {
  counter += 1;
  const hex = counter.toString(16).padStart(12, '0');
  return `f0000000-0000-4000-8000-${hex}`;
}
export function resetIds(): void { counter = 0; }

// ── The query builder ────────────────────────────────────────────────────────

type Filter = (row: Row) => boolean;

class FakeQuery {
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private filters: Filter[] = [];
  private payload: Row | Row[] | null = null;
  private wantsRows = false;
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitTo: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private onConflict: string[] = [];
  private countMode: string | null = null;

  constructor(private name: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op !== 'select') this.wantsRows = true;
    if (opts?.count) this.countMode = opts.count;
    return this;
  }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = 'upsert'; this.payload = rows;
    this.onConflict = opts?.onConflict ? opts.onConflict.split(',').map(s => s.trim()) : [];
    return this;
  }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }

  eq(col: string, val: unknown) { this.filters.push(r => String(r[col] ?? '') === String(val ?? '')); return this; }
  neq(col: string, val: unknown) { this.filters.push(r => String(r[col] ?? '') !== String(val ?? '')); return this; }
  in(col: string, vals: unknown[]) {
    const set = new Set(vals.map(v => String(v)));
    this.filters.push(r => set.has(String(r[col] ?? '')));
    return this;
  }
  gt(col: string, val: unknown) { this.filters.push(r => cmp(r[col], val) > 0); return this; }
  gte(col: string, val: unknown) { this.filters.push(r => cmp(r[col], val) >= 0); return this; }
  lt(col: string, val: unknown) { this.filters.push(r => cmp(r[col], val) < 0); return this; }
  lte(col: string, val: unknown) { this.filters.push(r => cmp(r[col], val) <= 0); return this; }
  is(col: string, val: unknown) {
    this.filters.push(r => val === null ? (r[col] === null || r[col] === undefined) : r[col] === val);
    return this;
  }
  ilike(col: string, pattern: string) {
    const rx = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
    this.filters.push(r => rx.test(String(r[col] ?? '')));
    return this;
  }
  not(col: string, op: string, val: unknown) {
    this.filters.push(r => !matches(r, `${col}.${op}.${val === null ? 'null' : String(val)}`));
    return this;
  }
  match(spec: Row) {
    this.filters.push(r => Object.entries(spec).every(([c, v]) => String(r[c] ?? '') === String(v ?? '')));
    return this;
  }
  or(expr: string) {
    const parts = splitTop(expr);
    this.filters.push(r => parts.some(c => matches(r, c)));
    return this;
  }
  filter(col: string, op: string, val: unknown) {
    this.filters.push(r => matches(r, `${col}.${op}.${String(val)}`));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) { this.limitTo = n; return this; }
  range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this; }

  private matching(): Row[] {
    return table(this.name).filter(r => this.filters.every(f => f(r)));
  }

  private sorted(rows: Row[]): Row[] {
    if (!this.orderBy.length) return rows;
    const out = [...rows];
    out.sort((a, b) => {
      for (const { col, asc } of this.orderBy) {
        const c = cmp(a[col], b[col]);
        if (c !== 0) return asc ? c : -c;
      }
      return 0;
    });
    return out;
  }

  private violatesUnique(candidate: Row, ignore: Row[]): boolean {
    const specs = db.unique.get(this.name) ?? [];
    if (!specs.length) return false;
    const existing = table(this.name).filter(r => !ignore.includes(r));
    return specs.some(cols =>
      cols.every(c => candidate[c] !== undefined && candidate[c] !== null) &&
      existing.some(r => cols.every(c => String(r[c] ?? '') === String(candidate[c] ?? ''))));
  }

  private run(): { data: unknown; error: unknown; count?: number } {
    const stamp = '2026-08-25T00:00:00.000Z';

    if (this.op === 'insert' || this.op === 'upsert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const written: Row[] = [];
      for (const r of rows) {
        const full: Row = { id: r.id ?? nextId(), created_at: stamp, updated_at: stamp, ...r };
        if (full.id === undefined || full.id === null) full.id = nextId();

        if (this.op === 'upsert' && this.onConflict.length) {
          const hit = table(this.name).find(x =>
            this.onConflict.every(c => String(x[c] ?? '') === String(full[c] ?? '')));
          if (hit) { Object.assign(hit, r, { updated_at: stamp }); written.push(hit); continue; }
        }
        if (this.violatesUnique(full, [])) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        table(this.name).push(full);
        written.push(full);
      }
      return { data: written, error: null };
    }

    if (this.op === 'update') {
      const hit = this.matching();
      for (const r of hit) Object.assign(r, this.payload);
      return { data: hit, error: null };
    }

    if (this.op === 'delete') {
      const hit = new Set(this.matching());
      db.tables.set(this.name, table(this.name).filter(r => !hit.has(r)));
      return { data: [...hit], error: null };
    }

    let rows = this.sorted(this.matching());
    const count = rows.length;
    if (this.rangeFrom !== null) rows = rows.slice(this.rangeFrom, (this.rangeTo ?? rows.length - 1) + 1);
    if (this.limitTo !== null) rows = rows.slice(0, this.limitTo);
    return { data: rows.map(r => ({ ...r })), error: null, count };
  }

  async single() {
    const { data, error, count } = this.run();
    if (error) return { data: null, error, count };
    const rows = data as Row[] | null;
    if (!rows || rows.length === 0) {
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, count };
    }
    return { data: rows[0], error: null, count };
  }

  async maybeSingle() {
    const { data, error, count } = this.run();
    if (error) return { data: null, error, count };
    return { data: (data as Row[] | null)?.[0] ?? null, error: null, count };
  }

  // Thenable, so `await supabase.from(x).select()` resolves like PostgREST.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve?: ((v: any) => void) | null, reject?: ((e: unknown) => void) | null): any {
    try {
      const out = this.run();
      // A write with no `.select()` returns no rows, exactly like PostgREST.
      if ((this.op === 'insert' || this.op === 'update' || this.op === 'upsert' || this.op === 'delete')
        && !this.wantsRows) {
        resolve?.({ data: null, error: out.error });
        return;
      }
      resolve?.(out);
    } catch (err) { if (reject) reject(err); else throw err; }
  }
}

function cmp(a: unknown, b: unknown): number {
  const an = Number(a), bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && a !== null && b !== null && a !== '' && b !== '') {
    return an === bn ? 0 : an < bn ? -1 : 1;
  }
  const as = String(a ?? ''), bs = String(b ?? '');
  return as === bs ? 0 : as < bs ? -1 : 1;
}

// ── The module surface the app imports ───────────────────────────────────────

export const fakeSupabase = {
  from: (name: string) => new FakeQuery(name),
  storage: {
    createBucket: async () => ({ error: null }),
    listBuckets: async () => ({ data: [{ name: 'documents' }], error: null }),
    from: () => ({
      upload: async (path: string, buffer: Buffer, opts?: { contentType?: string }) => {
        if (db.storage.has(path)) return { data: null, error: { message: 'The resource already exists' } };
        db.storage.set(path, { buffer, contentType: opts?.contentType ?? 'application/octet-stream' });
        return { data: { path }, error: null };
      },
      download: async (path: string) => {
        const hit = db.storage.get(path);
        if (!hit) return { data: null, error: { message: 'Object not found' } };
        const ab = hit.buffer.buffer.slice(hit.buffer.byteOffset, hit.buffer.byteOffset + hit.buffer.byteLength);
        return { data: { arrayBuffer: async () => ab }, error: null };
      },
      remove: async (paths: string[]) => { paths.forEach(p => db.storage.delete(p)); return { data: null, error: null }; },
    }),
  },
};

export async function upsertTolerant(name: string, rows: Row | Row[], opts?: { onConflict?: string }) {
  const q = new FakeQuery(name).upsert(rows, opts).select();
  const { data, error } = await q.maybeSingle();
  return { data, error, dropped: [] as string[] };
}
