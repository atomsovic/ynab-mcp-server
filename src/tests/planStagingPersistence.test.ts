import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentFingerprint } from '../tools/SuggestCategoriesTool.js';

const scope = { userId: '123', planId: '11111111-1111-4111-8111-111111111111' };
const transaction = (id = 'tx', extra: Record<string, unknown> = {}) => ({
  id, date: '2026-09-01', amount: -1000, memo: 'food', account_id: 'acct', account_name: 'Checking',
  payee_id: 'payee', payee_name: 'Shop', category_id: null, approved: false, cleared: 'uncleared',
  deleted: false, subtransactions: [], ...extra,
});
const initialData = () => ({
  transactions: [transaction()],
  accounts: [{ id: 'acct', name: 'Checking', closed: false, deleted: false }],
  payees: [{ id: 'payee', name: 'Shop', deleted: false }],
  category_groups: [{ id: 'group', name: 'Living', hidden: false, deleted: false, categories: [
    { id: 'cat', name: 'Food', category_group_id: 'group', hidden: false, deleted: false },
  ] }],
});
let script: string, dir: string, runtime: Miniflare | undefined;
let data: ReturnType<typeof initialData>, marker: number, calls: URL[];
let failure: { endpoint: string; status: number } | undefined;
let upstreamGate: Promise<void> | undefined;
beforeAll(async () => {
  script = (await build({
    stdin: { contents: `
      import { PlanStagingStore } from './src/worker/plan-staging.ts';
      export { PlanStagingStore };
      export default { fetch(request, env) {
        return env.PLAN.get(env.PLAN.idFromName('synthetic-private-plan')).fetch(request);
      } };
    `, resolveDir: process.cwd(), sourcefile: 'staging-persistence-fixture.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
  })).outputFiles[0].text;
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ynab-staging-runtime-'));
  data = initialData(); marker = 10; calls = []; failure = undefined; upstreamGate = undefined;
});
afterEach(async () => {
  await runtime?.dispose(); runtime = undefined;
  await rm(dir, { recursive: true, force: true });
});
async function start() {
  runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true, script, compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
      bindings: { YNAB_ALLOWED_PLAN_ID: scope.planId, YNAB_API_TOKEN: 'synthetic-only' },
      durableObjects: { PLAN: { className: 'PlanStagingStore', useSQLite: true } },
      async outboundService(request) {
        const url = new URL(request.url);
        if (url.origin !== 'https://api.ynab.com' || !url.pathname.startsWith(`/v1/plans/${scope.planId}/`)) {
          throw new Error('Unexpected outbound request blocked');
        }
        expect(request.method).toBe('GET');
        calls.push(url);
        await upstreamGate;
        const endpoint = url.pathname.split('/').at(-1)!;
        if (failure?.endpoint === endpoint) return new Response('synthetic upstream private error', {
          status: failure.status, headers: { 'retry-after': '600' },
        });
        const key = endpoint === 'categories' ? 'category_groups' : endpoint;
        if (!(key in data)) throw new Error('Unexpected collection blocked');
        return Response.json({ data: { [key]: data[key as keyof typeof data], server_knowledge: marker } });
      },
    }),
    resourcePersistencePath: dir,
  });
  await runtime.ready;
}
async function restart() { await runtime!.dispose(); runtime = undefined; await start(); }
function call(path: string, body: object = {}) {
  return runtime!.dispatchFetch(`https://staging.test${path}`, {
    method: 'POST', body: JSON.stringify({ scope, ...body }),
  });
}
async function json(path: string, body: object = {}) {
  const response = await call(path, body);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

describe('SQLite plan staging in real workerd', () => {
  it('retains snapshot, delta markers and reviews across restarts; applies deletions after restart', async () => {
    await start();
    const snapshot = await json('/sync');
    const review = {
      transaction_id: 'tx', content_fingerprint: await contentFingerprint(transaction() as any),
      snapshot_revision: snapshot.revision, proposed_category: { id: 'cat', name: 'Food', group_name: 'Living' },
      status: 'suggested', model_confidence: 0.9, winning_probability: 0.9,
      evidence: 'Synthetic matched history', questions: ['Confirm category?'],
    };
    await json('/reviews/save', { revision: snapshot.revision, rows: [review] });
    await json('/reviews/update', { transactionId: 'tx', decision: 'reviewed', note: 'Synthetic note', questions: [] });
    await restart();
    expect(await json('/snapshot')).toEqual(snapshot);
    expect((await json('/reviews/list'))[0]).toMatchObject({ decision: 'reviewed', note: 'Synthetic note' });
    expect(calls).toHaveLength(4);
    data.transactions = [transaction('tx', { deleted: true }), transaction('new')];
    data.accounts = []; data.payees = []; data.category_groups = []; marker = 20;
    const delta = await json('/sync');
    expect(delta.transactions.map((tx: any) => tx.id)).toEqual(['new']);
    expect(delta.accounts).toHaveLength(1);
    expect(Object.values(delta.server_knowledge)).toEqual([20, 20, 20, 20]);
    expect(calls.slice(4).every(url => url.searchParams.get('last_knowledge_of_server') === '10')).toBe(true);
    expect(await json('/reviews/list')).toEqual([]);
    await restart();
    expect(await json('/snapshot')).toEqual(delta);
    expect(calls).toHaveLength(8);
  }, 20000);

  it('coalesces overlapping syncs into one four-collection request set', async () => {
    await start();
    let release!: () => void;
    upstreamGate = new Promise<void>(resolve => { release = resolve; });
    const requests = [call('/sync'), call('/sync'), call('/snapshot')];
    try {
      await expect.poll(() => calls.length).toBe(4);
      release();
      const responses = await Promise.all(requests);
      expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
      const snapshots = await Promise.all(responses.map(response => response.json() as Promise<any>));
      expect(snapshots.map(snapshot => snapshot.revision)).toEqual([1, 1, 1]);
      expect(calls).toHaveLength(4);
    } finally { release(); }
  }, 20000);

  it('retains the committed snapshot and markers after partial failure and restart', async () => {
    await start();
    const original = await json('/sync');
    data.transactions = [transaction('changed')]; marker = 20;
    failure = { endpoint: 'payees', status: 500 };
    expect((await call('/sync')).status).toBe(503);
    await restart();
    expect(await json('/snapshot')).toEqual(original);
    const status = await json('/status');
    expect(status.revision).toBe(original.revision);
    expect(status.last_error).not.toContain('private error');
    expect((await call('/sync')).status).toBe(429);
    expect(calls).toHaveLength(8);
  }, 20000);

  it('preserves upstream 429 cooldown across restart and clear without another upstream request', async () => {
    await start();
    failure = { endpoint: 'transactions', status: 429 };
    expect((await call('/sync')).status).toBe(429);
    const status = await json('/status');
    expect(Date.parse(status.retry_after)).toBeGreaterThan(Date.now() + 590000);
    await restart();
    expect((await json('/status')).retry_after).toBe(status.retry_after);
    await json('/clear');
    await restart();
    expect((await call('/sync')).status).toBe(429);
    expect((await json('/status')).retry_after).toBe(status.retry_after);
    expect(await json('/reviews/list')).toEqual([]);
    expect(calls).toHaveLength(4);
  }, 20000);
});
