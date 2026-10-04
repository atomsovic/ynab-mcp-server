import type * as ynab from 'ynab';
import type { StagingScope, StagingSnapshot, StagingStatus, StagedReview } from '../staging/types.js';
import { object, projectAccount, projectGroup, projectPayee, projectTransaction, historySince, retainTransaction } from '../staging/projection.js';
import { contentFingerprint, getEligibleCategories, isTransfer } from '../tools/SuggestCategoriesTool.js';

const HOUR = 3600000, DAY = 24 * HOUR, RETENTION = 30 * DAY, FRESH = 5 * 60000;
const SYNC_LIMIT = 180, MAX_ENTITIES = 50000, MAX_BYTES = 16 * 1024 * 1024;
const endpoints = ['transactions', 'accounts', 'payees', 'categories'] as const;
type Endpoint = typeof endpoints[number];
interface Metadata {
  scope: StagingScope; syncSequence: number; observedSequence: number; generation: number; revision: number; syncedAt: number | null;
  historySince: string | null; knowledge: StagingSnapshot['server_knowledge'];
  used: number; windowStarted: number; reservations: number[]; observedUsed: number; observedAt: number; retryAfter: number; leaseUntil: number;
  lastError: string | null; accessedAt: number;
}
class StagingError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); }
}
interface Env { YNAB_API_TOKEN: string; YNAB_ALLOWED_PLAN_ID: string }
const initial = (scope: StagingScope): Metadata => ({ scope, syncSequence: 0, observedSequence: 0, generation: 0, revision: 0, syncedAt: null, historySince: null, knowledge: { transactions: 0, accounts: 0, payees: 0, categories: 0 }, used: 0, windowStarted: Date.now(), reservations: [], observedUsed: 0, observedAt: 0, retryAfter: 0, leaseUntil: 0, lastError: null, accessedAt: Date.now() });
const validString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const probability = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);

/** Binding-only SQLite authority for a private, advisory local snapshot. Never performs writes to YNAB. */
export class PlanStagingStore {
  private syncing?: Promise<StagingSnapshot>;
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS staging_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS staged_entities (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id))');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS staged_reviews (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  }
  private metadata(): Metadata | undefined {
    const row = this.state.storage.sql.exec<{payload: string}>('SELECT payload FROM staging_state WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  private putMetadata(meta: Metadata) { this.state.storage.sql.exec('INSERT OR REPLACE INTO staging_state(id,payload) VALUES(1,?)', JSON.stringify(meta)); }
  private read<T>(kind: string): T[] { return this.state.storage.sql.exec<{payload: string}>('SELECT payload FROM staged_entities WHERE kind=? ORDER BY rowid', kind).toArray().map(row => JSON.parse(row.payload)); }
  private reviewRows(): StagedReview[] { return this.state.storage.sql.exec<{payload: string}>('SELECT payload FROM staged_reviews ORDER BY id').toArray().map(row => JSON.parse(row.payload)); }
  private putReview(row: StagedReview) { this.state.storage.sql.exec('INSERT OR REPLACE INTO staged_reviews(id,payload) VALUES(?,?)', row.transaction_id, JSON.stringify(row)); }
  private snapshot(meta = this.metadata()!): StagingSnapshot {
    return { revision: meta.revision, synced_at: new Date(meta.syncedAt!).toISOString(), history_since: meta.historySince!, server_knowledge: meta.knowledge, transactions: this.read('transactions'), accounts: this.read('accounts'), payees: this.read('payees'), category_groups: this.read('categories') };
  }
  private status(): StagingStatus {
    const m = this.metadata()!, now = Date.now();
    this.refreshBudget(m, now);
    return { revision: m.revision, synced_at: m.syncedAt === null ? null : new Date(m.syncedAt).toISOString(), history_since: m.historySince, stale: m.syncedAt === null || now - m.syncedAt >= FRESH, retry_after: Math.max(m.retryAfter, m.leaseUntil) > now ? new Date(Math.max(m.retryAfter, m.leaseUntil)).toISOString() : null, last_error: m.lastError, rate: { used: m.used, limit: SYNC_LIMIT, window_started_at: new Date(m.windowStarted).toISOString() } };
  }
  private purge(meta: Metadata) {
    this.state.storage.sql.exec('DELETE FROM staged_entities');
    this.state.storage.sql.exec('DELETE FROM staged_reviews');
    meta.generation++; // Invalidates a pre-clear asynchronous sync or review save.
    meta.revision++; // Never reuse a snapshot revision after deletion.
    meta.syncedAt = null; meta.historySince = null;
    meta.knowledge = { transactions: 0, accounts: 0, payees: 0, categories: 0 };
    this.putMetadata(meta); // Scope, reservation and cooldown survive all purges.
  }
  private pruneReviews(now: number) {
    for (const row of this.reviewRows()) if (Date.parse(row.updated_at) <= now - RETENTION) this.state.storage.sql.exec('DELETE FROM staged_reviews WHERE id=?', row.transaction_id);
  }
  private async touch(scope: unknown) {
    if (!object(scope) || !validString(scope.userId, 32) || !/^\d+$/.test(scope.userId) || !validString(scope.planId, 36) || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scope.planId) || scope.planId !== this.env.YNAB_ALLOWED_PLAN_ID) throw new StagingError(400, 'Invalid staging scope');
    const s = scope as unknown as StagingScope;
    this.state.storage.transactionSync(() => {
      const m = this.metadata() ?? initial(s);
      if (m.scope.userId !== s.userId || m.scope.planId !== s.planId) throw new StagingError(400, 'Staging scope mismatch');
      if (m.accessedAt <= Date.now() - RETENTION) this.purge(m);
      m.accessedAt = Date.now(); this.putMetadata(m); this.pruneReviews(Date.now());
    });
    await this.scheduleCleanup();
  }
  private async scheduleCleanup() {
    const m = this.metadata(); if (!m) return;
    const deadlines = this.reviewRows().map(r => Date.parse(r.updated_at) + RETENTION);
    await this.state.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(m.accessedAt + RETENTION, ...deadlines)));
  }
  async alarm() {
    this.state.storage.transactionSync(() => {
      const m = this.metadata(); if (!m) return;
      if (m.accessedAt <= Date.now() - RETENTION) this.purge(m);
      else this.pruneReviews(Date.now());
    });
    const m = this.metadata();
    if (m && m.accessedAt > Date.now() - RETENTION) await this.scheduleCleanup();
    else await this.state.storage.deleteAlarm();
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    try {
      const raw = await request.text();
      if (raw.length > 512 * 1024) throw new StagingError(400, 'Staging request too large');
      let input: Record<string, unknown>;
      try { const value = JSON.parse(raw); if (!object(value)) throw Error(); input = value; } catch { throw new StagingError(400, 'Invalid staging request'); }
      const path = new URL(request.url).pathname;
      if (!['/snapshot', '/sync', '/status', '/reviews/save', '/reviews/list', '/reviews/update', '/clear'].includes(path)) return new Response(null, { status: 404 });
      await this.touch(input.scope);
      if (path === '/status') return Response.json(this.status());
      if (path === '/clear') {
        this.state.storage.transactionSync(() => this.purge(this.metadata()!));
        return Response.json({});
      }
      if (path === '/reviews/list') return Response.json(this.reviewRows());
      if (path === '/reviews/save') { await this.saveReviews(input.revision, input.rows); return Response.json({}); }
      if (path === '/reviews/update') { await this.updateReview(input); return Response.json({}); }
      const meta = this.metadata()!;
      if (path === '/snapshot' && meta.syncedAt !== null && Date.now() - meta.syncedAt < FRESH) return Response.json(this.snapshot(meta));
      if (!this.syncing) {
        const promise = this.sync(); this.syncing = promise;
        // The same promise is shared by all overlapping callers, including failures.
        void promise.finally(() => { if (this.syncing === promise) this.syncing = undefined; }).catch(() => {});
      }
      return Response.json(await this.syncing);
    } catch (e) {
      const error = e instanceof StagingError ? e : new StagingError(503, 'Staging temporarily unavailable');
      return Response.json({ error: error.message, ...(error.retryAfter ? { retry_after: new Date(error.retryAfter).toISOString() } : {}) }, { status: error.status });
    }
  }
  private refreshBudget(m: Metadata, now: number) {
    m.reservations = m.reservations.filter(at => at > now - HOUR);
    if (m.observedAt <= now - HOUR) m.observedUsed = 0;
    m.used = Math.max(m.reservations.length, m.observedUsed);
    m.windowStarted = Math.min(m.reservations[0] ?? now, m.observedUsed ? m.observedAt : now);
  }
  private reserve(): Metadata {
    const reserved = this.state.storage.transactionSync(() => {
      const m = this.metadata()!, now = Date.now();
      if (Math.max(m.retryAfter, m.leaseUntil) > now) throw new StagingError(429, 'Staging sync cooling down', Math.max(m.retryAfter, m.leaseUntil));
      this.refreshBudget(m, now);
      if (m.used + 4 > SYNC_LIMIT) { m.retryAfter = Math.max(m.reservations[0] ? m.reservations[0] + HOUR : 0, m.observedUsed ? m.observedAt + HOUR : 0); this.putMetadata(m); return new StagingError(429, 'Staging request budget exhausted', m.retryAfter); }
      m.syncSequence++;
      m.reservations.push(now, now, now, now);
      if (m.observedUsed) m.observedUsed += 4;
      this.refreshBudget(m, now); m.leaseUntil = now + 60000;
      this.putMetadata(m); return m;
    });
    if (reserved instanceof StagingError) throw reserved;
    return reserved;
  }
  private recordRate(response: Response, sequence: number) {
    const header = response.headers.get('x-rate-limit'), match = header?.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!match) return;
    this.state.storage.transactionSync(() => {
      const m = this.metadata()!, used = Number(match[1]), limit = Number(match[2]);
      if (!Number.isSafeInteger(used) || !Number.isSafeInteger(limit) || limit <= 0) return;
      this.refreshBudget(m, Date.now());
      // A newer batch provides a new rolling usage observation, which may decrease.
      // Within one concurrent batch use the maximum to tolerate out-of-order replies.
      m.observedUsed = m.observedSequence === sequence ? Math.max(m.observedUsed, used) : used;
      m.observedSequence = sequence; m.observedAt = Date.now();
      this.refreshBudget(m, Date.now());
      // Respect a lower upstream allowance, while retaining a headroom of 20 calls.
      if (used + 4 > Math.min(SYNC_LIMIT, Math.max(0, limit - 20))) m.retryAfter = Math.max(m.retryAfter, Date.now() + HOUR);
      this.putMetadata(m);
    });
  }
  private async collection(endpoint: Endpoint, m: Metadata): Promise<{rows: unknown[]; marker: number}> {
    const url = new URL(`https://api.ynab.com/v1/plans/${encodeURIComponent(m.scope.planId)}/${endpoint}`);
    if (m.syncedAt !== null) url.searchParams.set('last_knowledge_of_server', String(m.knowledge[endpoint]));
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${this.env.YNAB_API_TOKEN}` }, signal: controller.signal, redirect: 'manual' });
      this.recordRate(response, m.syncSequence);
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) : NaN;
        const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : header ? Date.parse(header) : NaN;
        throw new StagingError(429, 'YNAB rate limit; sync deferred', Number.isFinite(until) && until > Date.now() ? Math.min(until, Date.now() + 24 * HOUR) : Date.now() + HOUR);
      }
      if (!response.ok || !response.body) throw new StagingError(503, 'YNAB collection unavailable');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '', size = 0;
      while (true) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new StagingError(503, 'YNAB collection exceeds staging size limit'); } text += decoder.decode(value, {stream: true}); }
      text += decoder.decode();
      const body: unknown = JSON.parse(text), key = endpoint === 'categories' ? 'category_groups' : endpoint;
      if (!object(body) || !object(body.data) || !Array.isArray(body.data[key]) || !Number.isSafeInteger(body.data.server_knowledge) || (body.data.server_knowledge as number) < m.knowledge[endpoint] || body.data[key].length > MAX_ENTITIES) throw new StagingError(503, 'Invalid YNAB collection response');
      return { rows: body.data[key], marker: body.data.server_knowledge as number };
    } catch (e) { if (e instanceof StagingError) throw e; throw new StagingError(503, 'YNAB collection unavailable'); }
    finally { clearTimeout(timeout); }
  }
  private async sync(): Promise<StagingSnapshot> {
    if (!this.env.YNAB_API_TOKEN) throw new StagingError(503, 'YNAB connection unavailable');
    const m = this.reserve();
    try {
      const outcomes = await Promise.allSettled(endpoints.map(endpoint => this.collection(endpoint, m)));
      const errors = outcomes.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map(x => x.reason);
      if (errors.length) throw errors.filter(e => e instanceof StagingError && e.status === 429).sort((a, b) => (b.retryAfter ?? 0) - (a.retryAfter ?? 0))[0] ?? errors[0];
      const data = outcomes.map(x => (x as PromiseFulfilledResult<{rows: unknown[]; marker: number}>).value);
      const old = this.snapshot(m);
      const transactions = merge(old.transactions, data[0].rows.map(projectTransaction));
      const accounts = merge(old.accounts, data[1].rows.map(projectAccount));
      const payees = merge(old.payees, data[2].rows.map(projectPayee));
      const groups = mergeGroups(old.category_groups, data[3].rows.map(projectGroup));
      const now = Date.now(), since = historySince(now), payeesById = new Map(payees.map(p => [p.id, p]));
      const retained = transactions.filter(t => retainTransaction(t, since, payeesById));
      if ([retained, accounts, payees, groups].some(rows => rows.length > MAX_ENTITIES)) throw new StagingError(503, 'Snapshot exceeds staging record limit');
      const txById = new Map(retained.map(t => [t.id, t]));
      const fingerprints = new Map<string, string>();
      // Hash only reviewed sources. Reconcile rows saved during asynchronous hashing;
      // the final empty check and the SQL commit contain no intervening await.
      for (let round = 0; ; round++) {
        const missing = this.reviewRows().filter(r => txById.has(r.transaction_id) && !fingerprints.has(r.transaction_id));
        if (!missing.length) break;
        if (round >= 8) throw new StagingError(409, 'Review queue changed repeatedly; retry sync');
        for (const [id, fingerprint] of await Promise.all(missing.map(async r => [r.transaction_id, await contentFingerprint(txById.get(r.transaction_id)!)] as const))) fingerprints.set(id, fingerprint);
      }
      this.state.storage.transactionSync(() => {
        const current = this.metadata()!;
        if (current.generation !== m.generation) throw new StagingError(409, 'Staging cleared during sync');
        this.writeEntities('transactions', retained); this.writeEntities('accounts', accounts); this.writeEntities('payees', payees); this.writeEntities('categories', groups);
        const categoryIds = new Set(getEligibleCategories(groups).map(c => c.id));
        for (const review of this.reviewRows()) {
          if (!txById.has(review.transaction_id) || Date.parse(review.updated_at) <= now - RETENTION) { this.state.storage.sql.exec('DELETE FROM staged_reviews WHERE id=?', review.transaction_id); continue; }
          const t = txById.get(review.transaction_id)!;
          if (review.content_fingerprint !== fingerprints.get(review.transaction_id) || t.approved || t.cleared === 'reconciled' || isTransfer(t, payeesById) || (review.proposed_category && !categoryIds.has(review.proposed_category.id))) this.putReview({...review, decision: 'stale'});
        }
        current.revision++; current.syncedAt = now; current.historySince = since; current.leaseUntil = 0; current.lastError = null;
        for (let i = 0; i < endpoints.length; i++) current.knowledge[endpoints[i]] = data[i].marker;
        this.putMetadata(current);
      });
      return this.snapshot();
    } catch (e) {
      const error = e instanceof StagingError ? e : new StagingError(503, 'Invalid YNAB snapshot; previous snapshot retained');
      this.state.storage.transactionSync(() => {
        const current = this.metadata()!;
        current.leaseUntil = 0; current.retryAfter = Math.max(current.retryAfter, error.retryAfter ?? Date.now() + 60000); current.lastError = error.message;
        this.putMetadata(current);
      });
      throw error;
    }
  }
  private writeEntities(kind: string, rows: {id: string}[]) {
    const old = new Map(this.state.storage.sql.exec<{id: string; payload: string}>('SELECT id,payload FROM staged_entities WHERE kind=?', kind).toArray().map(row => [row.id, row.payload]));
    for (const row of rows) {
      const json = JSON.stringify(row);
      if (old.get(row.id) !== json) this.state.storage.sql.exec('INSERT OR REPLACE INTO staged_entities(kind,id,payload) VALUES(?,?,?)', kind, row.id, json);
      old.delete(row.id);
    }
    for (const id of old.keys()) this.state.storage.sql.exec('DELETE FROM staged_entities WHERE kind=? AND id=?', kind, id);
  }
  private async saveReviews(revision: unknown, input: unknown) {
    const meta = this.metadata()!;
    if (!Number.isSafeInteger(revision) || revision !== meta.revision || meta.syncedAt === null) throw new StagingError(409, 'Snapshot revision changed');
    if (!Array.isArray(input) || input.length > 100) throw new StagingError(400, 'Invalid review batch');
    const txs = new Map(this.read<ynab.TransactionDetail>('transactions').map(t => [t.id, t]));
    const categoryIds = new Set(getEligibleCategories(this.read<ynab.CategoryGroupWithCategories>('categories')).map(c => c.id));
    const rows: StagedReview[] = [], ids = new Set<string>();
    for (const row of input) {
      if (!object(row) || !validString(row.transaction_id, 128) || !validString(row.content_fingerprint, 100) || row.snapshot_revision !== revision) throw new StagingError(400, 'Invalid review row');
      const tx = txs.get(row.transaction_id);
      if (!tx || await contentFingerprint(tx) !== row.content_fingerprint) throw new StagingError(409, 'Review source fingerprint changed');
      if (ids.has(row.transaction_id) || !validString(row.status, 64) || !probability(row.model_confidence) || !probability(row.winning_probability) || !validString(row.evidence, 4000) || !validQuestions(row.questions)) throw new StagingError(400, 'Invalid review row');
      const c = row.proposed_category;
      if (c !== null && (!object(c) || !validString(c.id, 128) || !categoryIds.has(c.id) || !validString(c.name, 300) || !validString(c.group_name, 300))) throw new StagingError(400, 'Invalid review category');
      ids.add(row.transaction_id);
      rows.push({ transaction_id: row.transaction_id, content_fingerprint: row.content_fingerprint, snapshot_revision: revision as number, proposed_category: c === null ? null : {id: c.id as string, name: c.name as string, group_name: c.group_name as string}, status: row.status, model_confidence: row.model_confidence as number | null, winning_probability: row.winning_probability as number | null, evidence: row.evidence, questions: row.questions as string[], decision: 'pending', note: '', updated_at: new Date().toISOString() });
    }
    this.state.storage.transactionSync(() => {
      const current = this.metadata()!;
      if (current.revision !== revision || current.generation !== meta.generation) throw new StagingError(409, 'Snapshot revision changed');
      const existing = new Map(this.reviewRows().map(r => [r.transaction_id, r]));
      const incomingIds = new Set(rows.map(r => r.transaction_id));
      let excess = new Set([...existing.keys(), ...incomingIds]).size - 1000;
      // Preserve dismissed notes until space is actually needed. Never evict active reviews.
      for (const prior of [...existing.values()].filter(r => r.decision === 'dismissed' && !incomingIds.has(r.transaction_id)).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))) {
        if (excess <= 0) break;
        this.state.storage.sql.exec('DELETE FROM staged_reviews WHERE id=?', prior.transaction_id);
        existing.delete(prior.transaction_id); excess--;
      }
      if (excess > 0) throw new StagingError(409, 'Review queue full; dismiss or clear old rows');
      for (const row of rows) {
        const prior = existing.get(row.transaction_id);
        // Preserve human annotations only while evidence still refers to the same content.
        if (prior?.content_fingerprint === row.content_fingerprint && prior.proposed_category?.id === row.proposed_category?.id && prior.decision !== 'stale') { row.decision = prior.decision; row.note = prior.note; row.questions = [...new Set([...prior.questions, ...row.questions])].slice(0, 10); }
        this.putReview(row);
      }
    });
    await this.scheduleCleanup();
  }
  private async updateReview(input: Record<string, unknown>) {
    if (!validString(input.transactionId, 128) || !['pending', 'reviewed', 'dismissed'].includes(String(input.decision)) || !validString(input.note, 2000) || !validQuestions(input.questions)) throw new StagingError(400, 'Invalid advisory review update');
    const row = this.reviewRows().find(r => r.transaction_id === input.transactionId);
    if (!row) throw new StagingError(409, 'Review not found');
    if (row.decision === 'stale' && input.decision !== 'dismissed') throw new StagingError(409, 'Stale proposal must be regenerated');
    const meta = this.metadata()!;
    if (input.decision !== 'dismissed') {
      const tx = this.read<ynab.TransactionDetail>('transactions').find(t => t.id === row.transaction_id);
      const categories = new Set(getEligibleCategories(this.read<ynab.CategoryGroupWithCategories>('categories')).map(c => c.id));
      const payees = new Map(this.read<ynab.Payee>('payees').map(p => [p.id, p]));
      if (!tx || await contentFingerprint(tx) !== row.content_fingerprint || tx.approved || tx.cleared === 'reconciled' || isTransfer(tx, payees) || (row.proposed_category && !categories.has(row.proposed_category.id))) throw new StagingError(409, 'Stale proposal must be regenerated');
    }
    this.state.storage.transactionSync(() => {
      const current = this.metadata()!;
      const latest = this.reviewRows().find(r => r.transaction_id === input.transactionId);
      if (current.revision !== meta.revision || current.generation !== meta.generation || JSON.stringify(latest) !== JSON.stringify(row)) throw new StagingError(409, 'Review changed concurrently');
      this.putReview({...row, decision: input.decision as StagedReview['decision'], note: input.note as string, questions: input.questions as string[], updated_at: new Date().toISOString()});
    });
  }
}
function validQuestions(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 10 && value.every(v => validString(v, 1000)); }
function merge<T extends {id: string; deleted: boolean}>(old: T[], updates: T[]): T[] {
  const map = new Map(old.map(row => [row.id, row])), seen = new Set<string>();
  for (const row of updates) { if (seen.has(row.id)) throw new StagingError(503, 'Duplicate YNAB record'); seen.add(row.id); if (row.deleted) map.delete(row.id); else map.set(row.id, row); }
  return [...map.values()];
}
function mergeGroups(old: ynab.CategoryGroupWithCategories[], updates: ynab.CategoryGroupWithCategories[]): ynab.CategoryGroupWithCategories[] {
  // Category moves must remove the old group membership even if that group has no delta.
  const changedIds = new Set(updates.flatMap(g => g.categories.map(c => c.id)));
  const original = new Map(old.map(g => [g.id, g]));
  const clean = old.map(g => ({...g, categories: g.categories.filter(c => !changedIds.has(c.id))}));
  return merge(clean, updates.map(g => ({...g, categories: merge(original.get(g.id)?.categories.filter(c => !changedIds.has(c.id)) ?? [], g.categories)})));
}
