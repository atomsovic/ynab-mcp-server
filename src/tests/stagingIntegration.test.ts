import { afterEach, describe, it, expect, vi } from 'vitest';
import { snapshotApi, attachStagingMetadata, persistSuggestionReviews } from '../staging/integration.js';
import type { StagingSnapshot, PlanStaging } from '../staging/types.js';
afterEach(()=>vi.unstubAllEnvs());
const snapshot = { revision: 4, synced_at: '2026-10-04T00:00:00Z', history_since: '2025-10-04', server_knowledge: { transactions: 8, accounts: 2, payees: 3, categories: 4 }, transactions: [
 {id:'a',date:'2026-09-01',approved:false,category_id:null,account_id:'account',payee_id:'payee',amount:-1000,subtransactions:[],deleted:false},
 {id:'b',date:'2026-09-02',approved:true,category_id:'cat',account_id:'account',payee_id:'payee',amount:-2000,subtransactions:[],deleted:false}], accounts:[],payees:[],category_groups:[] } as unknown as StagingSnapshot;
describe('snapshot read integration',()=>{
 it('serves one revision without consulting live collections and enforces plan scope',async()=>{
  const live={transactions:{getTransactions:vi.fn()}} as any;
  const api=snapshotApi(live,snapshot,'plan');
  expect((await api.transactions.getTransactions('plan',undefined,undefined,'unapproved' as any)).data.transactions.map(t=>t.id)).toEqual(['a']);
  expect((await api.transactions.getTransactionsByAccount('plan','account')).data.transactions).toHaveLength(2);
  expect(live.transactions.getTransactions).not.toHaveBeenCalled();
  await expect(api.transactions.getTransactions('other')).rejects.toThrow('plan');
  await expect(api.transactions.getTransactions('plan','2024-01-01')).rejects.toThrow('retained');
 });
 it('returns split children for category and payee filters with parent approval',async()=>{
  const split={...snapshot.transactions[0],id:'split',category_id:'split-category',subtransactions:[{id:'child',transaction_id:'split',amount:-300,category_id:'cat',payee_id:'child-payee',deleted:false},{id:'deleted',category_id:'cat',deleted:true}]};
  const api=snapshotApi({} as any,{...snapshot,transactions:[split as any]},'plan');
  const byCategory=await api.transactions.getTransactionsByCategory('plan','cat');
  expect(byCategory.data.transactions).toHaveLength(1);
  expect(byCategory.data.transactions[0]).toMatchObject({id:'child',parent_transaction_id:'split',type:'subtransaction',amount:-300,approved:false});
  expect((await api.transactions.getTransactionsByPayee('plan','child-payee')).data.transactions).toHaveLength(1);
  expect((await api.transactions.getTransactionsByPayee('plan','payee')).data.transactions).toHaveLength(0);
 });
 it('reports review persistence failure without exposing storage errors',async()=>{
  const stage={saveReviews:vi.fn().mockRejectedValue(new Error('private-storage-payload'))} as any;
  const r={content:[{type:'text',text:JSON.stringify({success:true,transactions:[{transaction_id:'a',content_fingerprint:'sha256:'+'a'.repeat(64),status:'uncertain',proposed_category:null}]})}]};
  const output=await persistSuggestionReviews(stage,snapshot,r);
  expect(JSON.parse(output.content[0].text).review_persistence.saved).toBe(false);
  expect(output.content[0].text).not.toContain('private-storage-payload');
 });
 it('clones returned rows so tool mutation cannot change the snapshot',async()=>{
  const api=snapshotApi({} as any,snapshot,'plan');
  const a=await api.transactions.getTransactionById('plan','a');a.data.transaction.amount=7;
  expect((await api.transactions.getTransactionById('plan','a')).data.transaction.amount).toBe(-1000);
 });
 it('never forwards writes through the read adapter',async()=>{
  const update=vi.fn();const api=snapshotApi({transactions:{updateTransactions:update}} as any,snapshot,'plan');
  await expect(api.transactions.updateTransactions('plan',{transactions:[]})).rejects.toThrow('read-only');
  expect(update).not.toHaveBeenCalled();
 });
 it('adds explicit revision and retention metadata',()=>{
  const r=attachStagingMetadata({content:[{type:'text',text:JSON.stringify({success:true})}]},snapshot);
  expect(JSON.parse(r.content[0].text)).toMatchObject({staging:{revision:4,history_since:'2025-10-04'}});
 });
 it('persists only bounded proposal evidence, never the full result or provider payload',async()=>{
  const saveReviews=vi.fn();const stage={saveReviews} as unknown as PlanStaging;
  const r={content:[{type:'text',text:JSON.stringify({success:true,transactions:[{transaction_id:'a',content_fingerprint:'sha256:'+'a'.repeat(64),status:'suggested',proposed_category:{id:'cat',name:'Synthetic',group_name:'Synthetic'},model_confidence:.9,winning_probability:.9,history:{sample_size:4,match:'payee'},provider_payload:'private-provider-payload',transaction:{memo:'private-transaction-text'}}]})}]};
  await persistSuggestionReviews(stage,snapshot,r);
  expect(saveReviews).toHaveBeenCalledTimes(1);expect(saveReviews.mock.calls[0][0]).toBe(4);
  expect(JSON.stringify(saveReviews.mock.calls[0])).not.toContain('private-');
 });
});

describe('registry staging boundary',()=>{
 async function setup(options: any = {}) {
  const {registerAll}=await import('../registry.js');
  const callbacks=new Map<string,any>();
  const api={transactions:{getTransactions:vi.fn(),getTransactionById:vi.fn().mockResolvedValue({data:{transaction:snapshot.transactions[0]}}),updateTransactions:vi.fn()},categories:{getCategories:vi.fn().mockResolvedValue({data:{category_groups:[]}})}} as any;
  const staging={snapshot:vi.fn().mockResolvedValue(snapshot),saveReviews:vi.fn(),status:vi.fn().mockResolvedValue({revision:4}),reviews:vi.fn().mockResolvedValue([]),clear:vi.fn()} as any;
  registerAll({registerTool(name,config,callback){callbacks.set(name,{config,callback});}},api,{allowedPlanId:'plan',staging,...options});
  return {api,staging,callbacks};
 }
 it('blocks a different plan before accessing private staging',async()=>{
  const {staging,callbacks}=await setup();
  const result=await callbacks.get('ynab_get_transactions').callback({planId:'other'});
  expect(result.isError).toBe(true);expect(staging.snapshot).not.toHaveBeenCalled();
 });
 it('returns read results with one revision and no live calls',async()=>{
  const {api,staging,callbacks}=await setup();
  const result=await callbacks.get('ynab_get_transactions').callback({});
  expect(JSON.parse(result.content[0].text).staging.revision).toBe(4);
  expect(staging.snapshot).toHaveBeenCalledTimes(1);expect(api.transactions.getTransactions).not.toHaveBeenCalled();
 });
 it('uses a bounded live operation for explicit rows outside retention and does not save a mixed review',async()=>{
  vi.stubEnv('YNAB_AI_CATEGORIZATION','true');vi.stubEnv('TYPESAFE_API_KEY','synthetic-key');
  const {api,staging,callbacks}=await setup();
  api.transactions.getTransactions.mockResolvedValue({data:{transactions:[...snapshot.transactions,{...snapshot.transactions[1],id:'old',date:'2020-01-01'}]}});
  api.payees={getPayees:vi.fn().mockResolvedValue({data:{payees:[]}})};
  api.accounts={getAccounts:vi.fn().mockResolvedValue({data:{accounts:[]}})};
  const output=await callbacks.get('ynab_suggest_categories').callback({transactionIds:['old','b']});
  const body=JSON.parse(output.content[0].text);
  expect(body.staging).toMatchObject({source:'live_explicit_fallback',revision:null});
  expect(body.review_persistence.saved).toBe(false);
  expect(body.transactions.map((row:any)=>row.transaction_id)).toEqual(['old','b']);
  expect(api.transactions.getTransactions).toHaveBeenCalledTimes(2);
  expect(api.transactions.getTransactionById).not.toHaveBeenCalled();
  expect(staging.saveReviews).not.toHaveBeenCalled();
 });
 it('does not stampede upstream when staging sync fails',async()=>{
  const {api,staging,callbacks}=await setup();staging.snapshot.mockRejectedValue(new Error('Staging cooling down'));
  expect((await callbacks.get('ynab_get_transactions').callback({})).isError).toBe(true);
  expect(api.transactions.getTransactions).not.toHaveBeenCalled();
 });
 it('keeps apply on live refetch and rejects stale fingerprints',async()=>{
  const {api,staging,callbacks}=await setup();
  const result=await callbacks.get('ynab_apply_category_suggestions').callback({dry_run:true,suggestions:[{transaction_id:'a',category_id:'cat',expected_content_fingerprint:'sha256:'+'0'.repeat(64)}]});
  expect(JSON.parse(result.content[0].text).rows[0]).toMatchObject({status:'rejected',reason:'fingerprint_mismatch'});
  expect(api.transactions.getTransactionById).toHaveBeenCalled();expect(staging.snapshot).not.toHaveBeenCalled();expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
 });
 it('keeps YNAB writes hidden in read-only mode and describes local mutations honestly',async()=>{
  const {callbacks}=await setup({readOnly:true});
  expect(callbacks.has('ynab_apply_category_suggestions')).toBe(false);
  expect(callbacks.get('ynab_sync_plan').config.annotations.readOnlyHint).toBe(false);
  expect(callbacks.get('ynab_category_review_queue').config.annotations.readOnlyHint).toBe(false);
  expect(callbacks.get('ynab_staging_status').config.annotations.readOnlyHint).toBe(true);
 });
 it('requires explicit clear confirmation and does not touch the live API',async()=>{
  const {staging,callbacks,api}=await setup();
  expect((await callbacks.get('ynab_clear_staging').callback({confirm:false})).isError).toBe(true);
  expect(staging.clear).not.toHaveBeenCalled();
  const output=await callbacks.get('ynab_clear_staging').callback({confirm:true});
  expect(JSON.parse(output.content[0].text).ynab_changed).toBe(false);expect(staging.clear).toHaveBeenCalledTimes(1);expect(api.transactions.updateTransactions).not.toHaveBeenCalled();
 });
});
