import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PlanStagingStore } from '../worker/plan-staging.js';
import { contentFingerprint } from '../tools/SuggestCategoriesTool.js';
const scope={userId:'123',planId:'11111111-1111-4111-8111-111111111111'};
const env={YNAB_ALLOWED_PLAN_ID:scope.planId,YNAB_API_TOKEN:'synthetic-secret'};
const tx=(id='tx',extra:Record<string,unknown>={})=>({id,date:'2026-09-01',amount:-1000,memo:'food',account_id:'acct',account_name:'Checking',payee_id:'payee',payee_name:'Shop',category_id:null,approved:false,cleared:'uncleared',deleted:false,subtransactions:[],...extra});
const data=()=>({transactions:[tx()],accounts:[{id:'acct',name:'Checking',closed:false,deleted:false}],payees:[{id:'payee',name:'Shop',deleted:false}],category_groups:[{id:'group',name:'Living',hidden:false,deleted:false,categories:[{id:'cat',name:'Food',category_group_id:'group',hidden:false,deleted:false}]}]});
let db:DatabaseSync, state:any, store:PlanStagingStore, calls:URL[], payload:ReturnType<typeof data>, knowledge:number;
function makeState(){
 db=new DatabaseSync(':memory:');
 const sql={exec:(query:string,...args:any[])=>{const statement=db.prepare(query); const values=statement.all(...args);return {toArray:()=>values,[Symbol.iterator]:()=>values[Symbol.iterator]()};}};
 state={storage:{sql,transactionSync:(fn:()=>unknown)=>{db.exec('BEGIN');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}},setAlarm:vi.fn(async()=>{}),deleteAlarm:vi.fn(async()=>{})}};
 store=new PlanStagingStore(state,env);
}
async function request(path:string,body:object={},otherScope=scope){return store.fetch(new Request('https://staging.internal'+path,{method:'POST',body:JSON.stringify({scope:otherScope,...body})}));}
async function get(path:string,body:object={}){const r=await request(path,body);expect(r.status).toBe(200);return r.json() as Promise<any>;}
function upstream(url:string|URL|Request){const u=new URL(typeof url==='string'?url:url instanceof URL?url.toString():url.url);calls.push(u);const endpoint=u.pathname.split('/').at(-1)!;const key=endpoint==='categories'?'category_groups':endpoint;return Response.json({data:{[key]:(payload as any)[key],server_knowledge:knowledge}});}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-04T01:00:00Z'));makeState();calls=[];payload=data();knowledge=10;vi.stubGlobal('fetch',vi.fn(upstream));});
afterEach(()=>{db.close();vi.unstubAllGlobals();vi.useRealTimers();});
describe('private plan staging',()=>{
 it('loads four collections once and serves a fresh snapshot without upstream calls',async()=>{const s=await get('/snapshot');expect(s.revision).toBe(1);expect(s.transactions[0].id).toBe('tx');expect(calls).toHaveLength(4);expect((await get('/snapshot')).revision).toBe(1);expect(calls).toHaveLength(4);expect(calls.every(u=>!u.searchParams.has('last_knowledge_of_server'))).toBe(true);});
 it('merges delta updates/deletions atomically and advances independent markers',async()=>{await get('/sync');payload.transactions=[tx('new'),tx('tx',{deleted:true})];payload.accounts=[];payload.payees=[];payload.category_groups=[{...data().category_groups[0],categories:[{...data().category_groups[0].categories[0],deleted:true}]}];knowledge=20;const s=await get('/sync');expect(s.transactions.map((t:any)=>t.id)).toEqual(['new']);expect(s.accounts).toHaveLength(1);expect(s.category_groups[0].categories).toEqual([]);expect(s.server_knowledge.transactions).toBe(20);expect(calls.slice(4).every(u=>u.searchParams.get('last_knowledge_of_server')==='10')).toBe(true);});
 it('keeps snapshot and markers unchanged on partial failure with sanitized persistent cooldown',async()=>{const old=await get('/sync');vi.stubGlobal('fetch',vi.fn((u:any)=>String(u).endsWith('/payees?last_knowledge_of_server=10')?new Response('secret upstream',{status:500}):upstream(u)));payload.transactions=[tx('different')];expect((await request('/sync')).status).toBe(503);const status=await get('/status');expect(status.revision).toBe(old.revision);expect(status.last_error).not.toContain('secret');store=new PlanStagingStore(state,env);expect((await request('/sync')).status).toBe(429);expect((await get('/snapshot')).transactions[0].id).toBe('tx');});
 it('coalesces overlapping syncs and refuses another immutable user scope',async()=>{const results=await Promise.all([get('/sync'),get('/sync'),get('/snapshot')]);expect(results.map(s=>s.revision)).toEqual([1,1,1]);expect(calls).toHaveLength(4);expect((await request('/snapshot',{}, {...scope,userId:'456'})).status).toBe(400);expect(calls).toHaveLength(4);});
 it('honors 429 Retry-After after restart and clear without persisting payloads or keys',async()=>{vi.stubGlobal('fetch',vi.fn(()=>new Response('secret',{status:429,headers:{'retry-after':'600'}})));expect((await request('/sync')).status).toBe(429);await get('/clear');store=new PlanStagingStore(state,env);expect((await request('/sync')).status).toBe(429);const status=await get('/status');expect(status.retry_after).toBe('2026-10-04T01:10:00.000Z');expect(JSON.stringify(db.prepare("SELECT * FROM staging_state").all())).not.toContain('synthetic-secret');});
 it('retains 12-month history and old unresolved ordinary outflows, prunes unrelated fields',async()=>{payload.transactions=[tx('recent',{rogue_secret:'must-not-store'}),tx('old-pending',{date:'2020-01-01'}),tx('old-approved',{date:'2020-01-01',approved:true}),tx('old-transfer',{date:'2020-01-01',transfer_account_id:'other'})];const s=await get('/sync');expect(s.transactions.map((t:any)=>t.id)).toEqual(['recent','old-pending']);expect(s.transactions[0].rogue_secret).toBeUndefined();});
 it('persists bounded reviews, rejects mismatched fingerprints, and marks changed source stale',async()=>{const s=await get('/sync');const row={transaction_id:'tx',content_fingerprint:await contentFingerprint(tx() as any),snapshot_revision:s.revision,proposed_category:{id:'cat',name:'Food',group_name:'Living'},status:'suggested',model_confidence:.9,winning_probability:.9,evidence:'Matched history',questions:[],decision:'pending',note:'',updated_at:new Date().toISOString()};await get('/reviews/save',{revision:s.revision,rows:[row]});store=new PlanStagingStore(state,env);expect((await get('/reviews/list'))[0].transaction_id).toBe('tx');expect((await request('/reviews/save',{revision:s.revision,rows:[{...row,content_fingerprint:'sha256:bad'}]})).status).toBe(409);payload.transactions=[tx('tx',{amount:-2000})];await get('/sync');expect((await get('/reviews/list'))[0].decision).toBe('stale');expect((await request('/reviews/update',{transactionId:'tx',decision:'reviewed',note:'',questions:[]})).status).toBe(409);});
});
it('clear during an upstream request cannot resurrect financial data and does not reset request reservations',async()=>{
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 vi.stubGlobal('fetch',vi.fn(async(u:any)=>{started();await barrier;return upstream(u);}));
 const syncing=request('/sync');await ready;await get('/clear');release();expect((await syncing).status).toBe(409);
 const status=await get('/status');expect(status.synced_at).toBeNull();expect(status.rate.used).toBe(4);expect(db.prepare('SELECT * FROM staged_entities').all()).toEqual([]);
});
it('purges inactive data and review rows with cleanup-only alarms while preserving immutable scope',async()=>{
 await get('/sync');const count=calls.length;vi.advanceTimersByTime(31*86400000);await store.alarm();expect(calls).toHaveLength(count);expect((await get('/status')).synced_at).toBeNull();expect(db.prepare('SELECT * FROM staged_entities').all()).toEqual([]);expect((await request('/status',{}, {...scope,userId:'456'})).status).toBe(400);
});
it('bounds sync requests across instance restarts and data clears',async()=>{
 for(let i=0;i<45;i++){await get('/sync');await get('/clear');store=new PlanStagingStore(state,env);}
 expect(calls).toHaveLength(180);expect((await request('/sync')).status).toBe(429);expect(calls).toHaveLength(180);expect((await get('/status')).retry_after).toBe('2026-10-04T02:00:00.000Z');
 vi.advanceTimersByTime(3600000);expect((await request('/sync')).status).toBe(200);expect(calls).toHaveLength(184);
});
it('deletes category groups and accounts/payees, moves categories without duplicate membership',async()=>{
 await get('/sync');payload.transactions=[];payload.accounts=[{...payload.accounts[0],deleted:true}];payload.payees=[{...payload.payees[0],deleted:true}];payload.category_groups=[{...payload.category_groups[0],id:'new-group',categories:[{...payload.category_groups[0].categories[0],category_group_id:'new-group'}]}];let s=await get('/sync');expect(s.accounts).toEqual([]);expect(s.payees).toEqual([]);expect(s.category_groups.find((g:any)=>g.id==='group').categories).toEqual([]);expect(s.category_groups.find((g:any)=>g.id==='new-group').categories).toHaveLength(1);
 payload.category_groups=[{...payload.category_groups[0],deleted:true}];s=await get('/sync');expect(s.category_groups.map((g:any)=>g.id)).toEqual(['group']);
});
it('refuses malformed delta rows and regressing server markers without partially advancing snapshot',async()=>{
 await get('/sync');payload.transactions=[tx('bad',{amount:'wrong'}) as any];expect((await request('/sync')).status).toBe(503);expect((await get('/snapshot')).server_knowledge.transactions).toBe(10);vi.advanceTimersByTime(60001);payload=data();knowledge=9;expect((await request('/sync')).status).toBe(503);expect((await get('/snapshot')).revision).toBe(1);
});
it('honors the longest concurrent Retry-After and upstream shared-token rate header',async()=>{
 vi.stubGlobal('fetch',vi.fn((u:any)=>new Response(null,{status:429,headers:{'retry-after':String(u).includes('payees')?'1200':'600','x-rate-limit':'200/200'}})));
 expect((await request('/sync')).status).toBe(429);expect((await get('/status')).retry_after).toBe('2026-10-04T02:00:00.000Z');expect((await get('/status')).rate.used).toBe(200);
});
it('marks a proposal stale when a category group becomes hidden or payee becomes a transfer',async()=>{
 const s=await get('/sync');const row={transaction_id:'tx',content_fingerprint:await contentFingerprint(tx() as any),snapshot_revision:s.revision,proposed_category:{id:'cat',name:'Food',group_name:'Living'},status:'suggested',model_confidence:.9,winning_probability:.9,evidence:'Evidence',questions:[],decision:'pending',note:'',updated_at:new Date().toISOString()};
 await get('/reviews/save',{revision:s.revision,rows:[row]});payload.transactions=[];payload.category_groups=[{...payload.category_groups[0],hidden:true}];await get('/sync');expect((await get('/reviews/list'))[0].decision).toBe('stale');
});
it('rejects malformed JSON/scope and review amplification without exposing secrets',async()=>{
 expect((await store.fetch(new Request('https://staging.internal/sync',{method:'POST',body:'{'}))).status).toBe(400);
 expect((await request('/sync',{}, {...scope,planId:'22222222-2222-4222-8222-222222222222'})).status).toBe(400);expect(calls).toHaveLength(0);
 const s=await get('/sync');expect((await request('/reviews/save',{revision:s.revision,rows:new Array(101).fill({})})).status).toBe(400);
});
it('does not let dismissing a stale review make it current again',async()=>{
 const s=await get('/sync');const row={transaction_id:'tx',content_fingerprint:await contentFingerprint(tx() as any),snapshot_revision:s.revision,proposed_category:{id:'cat',name:'Food',group_name:'Living'},status:'suggested',model_confidence:.9,winning_probability:.9,evidence:'Evidence',questions:[],decision:'pending',note:'',updated_at:new Date().toISOString()};
 await get('/reviews/save',{revision:s.revision,rows:[row]});payload.transactions=[tx('tx',{amount:-2000})];await get('/sync');await get('/reviews/update',{transactionId:'tx',decision:'dismissed',note:'old',questions:[]});expect((await request('/reviews/update',{transactionId:'tx',decision:'reviewed',note:'',questions:[]})).status).toBe(409);
});
it('rolls back all entities and markers if SQLite fails halfway through commit',async()=>{
 await get('/sync');const exec=state.storage.sql.exec;let failed=false;
 state.storage.sql.exec=(q:string,...args:any[])=>{if(!failed&&q.startsWith('INSERT OR REPLACE INTO staged_entities')&&args[0]==='accounts'){failed=true;throw Error('synthetic disk fault');}return exec(q,...args);};
 payload.transactions=[tx('tx',{amount:-2000})];payload.accounts=[{...payload.accounts[0],name:'Changed'}];knowledge=20;expect((await request('/sync')).status).toBe(503);
 const snapshot=await get('/snapshot');expect(snapshot.transactions[0].amount).toBe(-1000);expect(snapshot.accounts[0].name).toBe('Checking');expect(snapshot.server_knowledge.accounts).toBe(10);expect(snapshot.revision).toBe(1);
});
it('aborts slow collection requests and persists a failure cooldown without fetching again',async()=>{
 let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
 vi.stubGlobal('fetch',vi.fn((_url:any,options:any)=>new Promise((_resolve,reject)=>{started();options.signal.addEventListener('abort',()=>reject(Error('contains private data')));})));const syncing=request('/sync');await ready;await vi.advanceTimersByTimeAsync(15001);expect((await syncing).status).toBe(503);const status=await get('/status');expect(status.last_error).toBe('YNAB collection unavailable');expect(status.synced_at).toBeNull();expect((await request('/sync')).status).toBe(429);
});
it('expires reviews after 30 days even while snapshot status is accessed',async()=>{
 const s=await get('/sync');const row={transaction_id:'tx',content_fingerprint:await contentFingerprint(tx() as any),snapshot_revision:s.revision,proposed_category:null,status:'uncertain',model_confidence:.3,winning_probability:.3,evidence:'Needs review',questions:['Which category?'],decision:'pending',note:'',updated_at:new Date().toISOString()};await get('/reviews/save',{revision:s.revision,rows:[row]});vi.advanceTimersByTime(15*86400000);await get('/status');vi.advanceTimersByTime(16*86400000);await store.alarm();expect(await get('/reviews/list')).toEqual([]);expect((await get('/status')).synced_at).not.toBeNull();
});
it('uses a rolling hour reservation budget rather than allowing a boundary burst',async()=>{
 await get('/sync');vi.advanceTimersByTime(59*60000);for(let i=0;i<44;i++)await get('/sync');expect(calls).toHaveLength(180);
 vi.advanceTimersByTime(2*60000);expect((await request('/sync')).status).toBe(200);expect((await request('/sync')).status).toBe(429);expect(calls).toHaveLength(184);
});
it('accepts decreasing upstream rolling usage instead of accumulating observations indefinitely',async()=>{
 vi.stubGlobal('fetch',vi.fn((u:any)=>{const r=upstream(u);return new Response(r.body,{headers:{'x-rate-limit':'48/200'}});}));
 for(let i=0;i<50;i++){expect((await request('/sync')).status).toBe(200);vi.advanceTimersByTime(5*60000);}
 expect(calls).toHaveLength(200);expect((await get('/status')).rate.used).toBeLessThanOrEqual(48);
});
it('retains dismissed notes until queue pressure then evicts dismissed entries to allow new proposals',async()=>{
 payload.transactions=Array.from({length:1001},(_,i)=>tx('tx'+i));const s=await get('/sync'), fingerprint=await contentFingerprint(tx() as any);
 const row=(id:string)=>({transaction_id:id,content_fingerprint:fingerprint,snapshot_revision:s.revision,proposed_category:null,status:'uncertain',model_confidence:.3,winning_probability:.3,evidence:'Needs review',questions:[],decision:'pending',note:'',updated_at:new Date().toISOString()});
 for(let i=0;i<10;i++)await get('/reviews/save',{revision:s.revision,rows:Array.from({length:100},(_,j)=>row('tx'+(100*i+j)))});
 expect((await request('/reviews/save',{revision:s.revision,rows:[row('tx1000')]})).status).toBe(409);
 await get('/reviews/update',{transactionId:'tx0',decision:'dismissed',note:'Keep until pressure',questions:[]});expect((await get('/reviews/list')).find((r:any)=>r.transaction_id==='tx0').note).toBe('Keep until pressure');
 await get('/reviews/save',{revision:s.revision,rows:[row('tx1000')]});const reviews=await get('/reviews/list');expect(reviews).toHaveLength(1000);expect(reviews.some((r:any)=>r.transaction_id==='tx0')).toBe(false);expect(reviews.some((r:any)=>r.transaction_id==='tx1000')).toBe(true);
});
it('preserves an unchanged proposal saved while sync is awaiting existing review fingerprints',async()=>{
 payload.transactions=[tx('tx1'),tx('tx2',{amount:-5000})];const s=await get('/sync');
 const row=async(id:string,amount:number)=>({transaction_id:id,content_fingerprint:await contentFingerprint(tx(id,{amount}) as any),snapshot_revision:s.revision,proposed_category:null,status:'uncertain',model_confidence:.3,winning_probability:.3,evidence:'Needs review',questions:[],decision:'pending',note:'',updated_at:new Date().toISOString()});
 await get('/reviews/save',{revision:s.revision,rows:[await row('tx1',-1000)]});const newRow=await row('tx2',-5000);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});
 const digest=crypto.subtle.digest.bind(crypto.subtle);const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(algorithm,bytes)=>{if(new TextDecoder().decode(bytes as ArrayBuffer).includes('"amount":-2000')){started();await gate;}return digest(algorithm,bytes);});
 try{payload.transactions=[tx('tx1',{amount:-2000})];const syncing=request('/sync');await ready;await get('/reviews/save',{revision:s.revision,rows:[newRow]});release();expect((await syncing).status).toBe(200);expect((await get('/reviews/list')).find((r:any)=>r.transaction_id==='tx2').decision).toBe('pending');}finally{release();spy.mockRestore();}
});
