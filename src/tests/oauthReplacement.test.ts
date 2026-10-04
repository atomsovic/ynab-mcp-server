import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import worker, { createProvider } from "../worker/index.js";
import { oauthFixture } from "./helpers/oauth.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
 const { OAUTH_PROVIDER: _, ...env } = oauthFixture().env;
 env.YNAB_READ_ONLY = "true"; env.YNAB_AI_CATEGORIZATION = "true"; env.TYPESAFE_API_KEY = "synthetic";
 const data = new Map<string,string>();
 const controls: { failTokenWrite?: boolean; failGrantWrite?: boolean; tokenBarrier?: () => Promise<void>; grantBarrier?: () => Promise<void> } = {};
 env.OAUTH_KV = {
  async get(k:string,o?: string|{type?:string}) {const v=data.get(k);return v===undefined?null: (o==='json'||typeof o==='object'&&o.type==='json')?JSON.parse(v):v;},
  async put(k:string,v:string) {
   if(k.startsWith('token:')) { if(controls.tokenBarrier) await controls.tokenBarrier(); if(controls.failTokenWrite) throw Error('synthetic persistence failure'); }
   if(k.startsWith('grant:')&&controls.grantBarrier) await controls.grantBarrier();
   if(k.startsWith('grant:')&&controls.failGrantWrite) throw Error('synthetic grant failure');
   data.set(k,v);
  },
  async delete(k:string) {data.delete(k);},
  async list(o:{prefix?:string}={}) {return {keys:[...data.keys()].filter(k=>k.startsWith(o.prefix??'')).map(name=>({name})),list_complete:true,cursor:''};},
 } as unknown as KVNamespace;
 const upstream=vi.fn(async(url:string)=>{
  if(url==='https://github.com/login/oauth/access_token') return Response.json({access_token:'synthetic'});
  if(url==='https://api.github.com/user') return Response.json({id:123,login:'owner'});
  throw Error('Unexpected outbound blocked');
 });vi.stubGlobal('fetch',upstream);
 const call=(path:string,init:RequestInit={})=>worker.fetch(new Request('https://worker.example'+path,init),env,{} as ExecutionContext);
 return {env,data,controls,upstream,call};
}
const form=(body:Record<string,string>):RequestInit=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()});
async function register(f:ReturnType<typeof fixture>) {
 const r=await f.call('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none'})});expect(r.status).toBe(201);return (await r.json() as any).client_id as string;
}
async function pending(f:ReturnType<typeof fixture>,client:string) {
 const verifier='v'.repeat(43),challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
 const query=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:'https://client.example/callback',state:'synthetic',code_challenge:challenge,code_challenge_method:'S256'});
 const consent=await f.call('/authorize?'+query);expect(consent.status).toBe(200);const html=await consent.text(),cookie=consent.headers.get('set-cookie')!.split(';')[0];
 const flow=html.match(/name="flow" value="([^"]+)"/)![1],csrf=html.match(/name="csrf_token" value="([^"]+)"/)![1];
 const approve=form({flow,csrf_token:csrf,decision:'approve'});approve.headers={...approve.headers,origin:'https://worker.example',cookie};expect((await f.call('/authorize',approve)).status).toBe(302);
 const cb=await f.call('/callback?'+new URLSearchParams({state:flow,code:'synthetic'}),{headers:{cookie}});expect(cb.status).toBe(302);
 const code=new URL(cb.headers.get('location')!).searchParams.get('code')!;
 return {code,verifier,redeem:(extra={})=>f.call('/token',form({grant_type:'authorization_code',client_id:client,code,code_verifier:verifier,redirect_uri:'https://client.example/callback',...extra}))};
}
async function login(f:ReturnType<typeof fixture>,client:string) {const p=await pending(f,client);const r=await p.redeem();expect(r.status).toBe(200);return {p,t:await r.json() as {access_token:string;refresh_token:string;expires_in:number}};}
const list=(f:ReturnType<typeof fixture>,token:string)=>f.call('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
const renew=(f:ReturnType<typeof fixture>,client:string,token:string)=>f.call('/token',form({grant_type:'refresh_token',client_id:client,refresh_token:token}));

describe('deferred OAuth replacement',()=>{
 it('preserves old access on abandoned and invalid-PKCE replacement; replaces only after redemption',async()=>{
  const f=fixture(),client=await register(f),old=await login(f,client),p=await pending(f,client);
  expect((await list(f,old.t.access_token)).status).toBe(200);
  expect((await p.redeem({code_verifier:'wrong'})).status).toBe(400);expect((await list(f,old.t.access_token)).status).toBe(200);
  const r=await p.redeem();expect(r.status).toBe(200);const next=await r.json() as any;
  expect((await list(f,old.t.access_token)).status).toBe(401);expect((await renew(f,client,old.t.refresh_token)).status).toBe(400);
  const result=await list(f,next.access_token);expect(result.status).toBe(200);const body=await result.text();expect(body).toContain('"name":"ynab_suggest_categories"');expect(body).not.toContain('"name":"ynab_apply_category_suggestions"');
 });
 it.each(['failTokenWrite','failGrantWrite'] as const)('keeps prior authority when %s fails during code redemption',async failure=>{
  const f=fixture(),client=await register(f),old=await login(f,client),p=await pending(f,client);
  f.controls[failure]=true;expect((await p.redeem()).status).toBe(503);f.controls[failure]=false;
  expect((await list(f,old.t.access_token)).status).toBe(200);expect((await renew(f,client,old.t.refresh_token)).status).toBe(200);
 });
 it('rejects replay without revoking the activated winner',async()=>{
  const f=fixture(),client=await register(f),{p,t}=await login(f,client);
  expect((await p.redeem()).status).toBe(400);expect((await list(f,t.access_token)).status).toBe(200);
  expect((await renew(f,client,t.refresh_token)).status).toBe(200);
 });
 it('selects one winner among concurrent replacements',async()=>{
  const f=fixture(),client=await register(f),old=await login(f,client),a=await pending(f,client),b=await pending(f,client);
  const results=await Promise.all([a.redeem(),b.redeem()]);expect(results.map(r=>r.status).sort()).toEqual([200,400]);
  const winner=await results.find(r=>r.status===200)!.json() as any;expect((await list(f,winner.access_token)).status).toBe(200);expect((await list(f,old.t.access_token)).status).toBe(401);
 });
 it('keeps discovery valid through normal renewal without extending refresh deadline',async()=>{
  const f=fixture(),client=await register(f),{t}=await login(f,client);expect(t.expires_in).toBe(3600);
  const grant=[...f.data.entries()].find(([k])=>k.startsWith('grant:'))![0];const expiry=JSON.parse(f.data.get(grant)!).expiresAt;
  let refresh=t.refresh_token;for(let i=0;i<3;i++){const r=await renew(f,client,refresh);expect(r.status).toBe(200);const x=await r.json() as any;refresh=x.refresh_token;expect((await list(f,x.access_token)).status).toBe(200);expect(JSON.parse(f.data.get(grant)!).expiresAt).toBe(expiry);}
 });
 it('only revokes the active grant after validated refresh-token ownership',async()=>{
  const f=fixture(),client=await register(f),other=await register(f),{t}=await login(f,client);
  expect((await f.call('/token',form({client_id:other,token:t.refresh_token,token_type_hint:'refresh_token'}))).status).toBe(200);
  expect((await list(f,t.access_token)).status).toBe(200);
  expect((await f.call('/token',form({client_id:client,token:t.refresh_token,token_type_hint:'refresh_token'}))).status).toBe(200);
  expect((await list(f,t.access_token)).status).toBe(401);expect((await renew(f,client,t.refresh_token)).status).toBe(400);
 });
});

function barrier() {
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 return {started,release,wait:async()=>{entered();await blocked;}};
}
describe('OAuth replacement failure boundaries',()=>{
 it.each(['replacement','revocation'] as const)('fences an old refresh that finishes after %s',async action=>{
  const f=fixture(),client=await register(f),old=await login(f,client),p=action==='replacement'?await pending(f,client):undefined;
  const hold=barrier();f.controls.tokenBarrier=hold.wait;
  const late=renew(f,client,old.t.refresh_token);await hold.started;delete f.controls.tokenBarrier;
  if(p) expect((await p.redeem()).status).toBe(200);
  else expect((await f.call('/token',form({client_id:client,token:old.t.refresh_token,token_type_hint:'refresh_token'}))).status).toBe(200);
  hold.release();const r=await late;expect(r.status).toBe(400);expect(await r.text()).not.toContain('access_token');expect((await list(f,old.t.access_token)).status).toBe(401);
 });
 it('keeps single-access-token revocation separate from grant revocation',async()=>{
  const f=fixture(),client=await register(f),{t}=await login(f,client);
  expect((await f.call('/token',form({client_id:client,token:t.access_token,token_type_hint:'access_token'}))).status).toBe(200);
  expect((await list(f,t.access_token)).status).toBe(401);const r=await renew(f,client,t.refresh_token);expect(r.status).toBe(200);expect((await list(f,(await r.json() as any).access_token)).status).toBe(200);
 });
 it.each([false,true])('never rolls back an activation when its reply is lost (committed=%s)',async committed=>{
  const f=fixture(),client=await register(f),old=await login(f,client),p=await pending(f,client);
  const ns=f.env.OAUTH_GRANTS!;
  f.env.OAUTH_GRANTS={idFromName:(x:string)=>ns.idFromName(x),get:(id:DurableObjectId)=>({fetch:async(url:string,init:RequestInit)=>{
   if(url.endsWith('/activate')) {if(committed) await ns.get(id).fetch(url,init);throw Error('synthetic lost activation reply');}
   return ns.get(id).fetch(url,init);
  }})} as unknown as DurableObjectNamespace;
  const failed=await p.redeem();expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('access_token');f.env.OAUTH_GRANTS=ns;
  expect((await list(f,old.t.access_token)).status).toBe(committed?401:200);
  const fresh=await login(f,client);expect((await list(f,fresh.t.access_token)).status).toBe(200);
 });
 it('fails temporarily on authority outage without permitting refresh or exposing credentials',async()=>{
  const f=fixture(),client=await register(f),{t}=await login(f,client);const ns=f.env.OAUTH_GRANTS!;
  f.env.OAUTH_GRANTS={idFromName:()=> 'synthetic',get:()=>({fetch:async()=>{throw Error('private synthetic failure');}})} as unknown as DurableObjectNamespace;
  for(const r of [await list(f,t.access_token),await renew(f,client,t.refresh_token),await f.call('/token',form({client_id:client,token:t.refresh_token}))]){expect(r.status).toBe(503);expect(await r.text()).not.toContain('private synthetic failure');}
  f.env.OAUTH_GRANTS=ns;expect((await list(f,t.access_token)).status).toBe(200);
 });
 it('retains current authorization on a rejected same-code concurrent redemption',async()=>{
  const f=fixture(),client=await register(f),p=await pending(f,client);
  const responses=await Promise.all([p.redeem(),p.redeem()]);expect(responses.map(r=>r.status).sort()).toEqual([200,400]);
  const t=await responses.find(r=>r.status===200)!.json() as any;expect((await list(f,t.access_token)).status).toBe(200);
 });
 it('fails selected-plan and mode changes closed even with a valid active grant',async()=>{
  const f=fixture(),client=await register(f),{t}=await login(f,client);
  f.env.YNAB_ALLOWED_PLAN_ID='22222222-2222-4222-8222-222222222222';expect((await list(f,t.access_token)).status).toBe(403);expect((await renew(f,client,t.refresh_token)).status).toBe(400);
 });
});

describe('authenticated discovery diagnostics',()=>{
 it.each([true, false])('matches tools/list with private staging enabled (AI enabled=%s)', async aiEnabled => {
  const f=fixture(),client=await register(f),{t}=await login(f,client);
  const stagingFetch=vi.fn(async()=>{throw Error('Discovery must not access staged financial data');});
  const idFromName=vi.fn((name:string)=>name);
  f.env.PLAN_STAGING={idFromName,get:vi.fn(()=>({fetch:stagingFetch}))} as unknown as DurableObjectNamespace;
  if(!aiEnabled) delete f.env.TYPESAFE_API_KEY;
  f.upstream.mockClear();

  const diagnosticResponse=await f.call('/mcp/diagnostics',{headers:{authorization:'Bearer '+t.access_token}});
  expect(diagnosticResponse.status).toBe(200);
  const diagnostics=await diagnosticResponse.json() as {registeredToolCount:number;suggestionsRegistered:boolean};
  const listedResponse=await list(f,t.access_token);
  expect(listedResponse.status).toBe(200);
  const text=await listedResponse.text();
  const dataLine=text.split('\n').find(line=>line.startsWith('data:'));
  const listed=JSON.parse(dataLine?dataLine.slice(5).trim():text).result.tools as {name:string}[];
  expect(listed.map(tool=>tool.name)).toEqual(expect.arrayContaining([
   'ynab_staging_status','ynab_sync_plan','ynab_category_review_queue','ynab_clear_staging',
  ]));
  expect(diagnostics.registeredToolCount).toBe(listed.length);
  expect(diagnostics.suggestionsRegistered).toBe(aiEnabled);
  expect(idFromName).toHaveBeenCalledWith(JSON.stringify(['123',f.env.YNAB_ALLOWED_PLAN_ID]));
  expect(stagingFetch).not.toHaveBeenCalled();
  expect(f.upstream).not.toHaveBeenCalled();
 });
 it('reports effective gates without credentials, identities or financial data',async()=>{
  const f=fixture(),client=await register(f),{t}=await login(f,client);
  expect((await f.call('/mcp/diagnostics')).status).toBe(401);
  const get=()=>f.call('/mcp/diagnostics',{headers:{authorization:'Bearer '+t.access_token}});
  const r=await get();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');const body=await r.json();
  expect(body).toMatchObject({authorizationVersion:2,readOnly:true,toolMode:'category-only',aiOptInEnabled:true,aiKeyConfigured:true,suggestionsRegistered:true,registeredToolCount:16});
  expect(JSON.stringify(body)).not.toMatch(/synthetic|11111111|owner|access_token|refresh_token/);
  delete f.env.TYPESAFE_API_KEY;const disabled=await (await get()).json();expect(disabled).toMatchObject({aiKeyConfigured:false,suggestionsRegistered:false,registeredToolCount:15});
  expect((await f.call('/mcp/diagnostics',{method:'POST',headers:{authorization:'Bearer '+t.access_token}})).status).toBe(405);
 });
});

 it('expires abandoned candidates without expiring a still-valid prior connection',async()=>{
  vi.useFakeTimers({toFake:['Date']});const f=fixture(),client=await register(f),old=await login(f,client),p=await pending(f,client);
  vi.setSystemTime(Date.now()+600001);expect((await p.redeem()).status).toBe(400);expect((await list(f,old.t.access_token)).status).toBe(200);
 });
 it('isolates active grants and revocation across distinct OAuth clients',async()=>{
  const f=fixture(),a=await register(f),b=await register(f),first=await login(f,a),second=await login(f,b);
  expect((await list(f,first.t.access_token)).status).toBe(200);expect((await list(f,second.t.access_token)).status).toBe(200);
  expect((await f.call('/token',form({client_id:b,token:second.t.refresh_token}))).status).toBe(200);expect((await list(f,first.t.access_token)).status).toBe(200);
 });

it('never authorizes persisted credentials before durable activation',async()=>{
 const f=fixture(),client=await register(f),old=await login(f,client),p=await pending(f,client);
 const response=await createProvider(f.env).fetch(new Request('https://worker.example/token',form({grant_type:'authorization_code',client_id:client,code:p.code,code_verifier:p.verifier,redirect_uri:'https://client.example/callback'})),f.env,{} as ExecutionContext);
 expect(response.status).toBe(200);const orphan=await response.json() as any;
 expect((await list(f,orphan.access_token)).status).toBe(401);expect((await renew(f,client,orphan.refresh_token)).status).toBe(400);expect((await list(f,old.t.access_token)).status).toBe(200);
});
it('reports code-gate unavailability as temporary without replacing old authority',async()=>{
 const f=fixture(),client=await register(f),old=await login(f,client),p=await pending(f,client),ns=f.env.OAUTH_FLOWS!;
 f.env.OAUTH_FLOWS={idFromName:(x:string)=>ns.idFromName(x),get:(id:DurableObjectId)=>({fetch:async(url:string,init:RequestInit)=>url.endsWith('/consume-code')?new Response(null,{status:503}):ns.get(id).fetch(url,init)})} as unknown as DurableObjectNamespace;
 const response=await p.redeem();expect(response.status).toBe(503);expect(await response.json()).toMatchObject({error:'temporarily_unavailable'});expect((await list(f,old.t.access_token)).status).toBe(200);
});

it('keeps the revocation tombstone when a late refresh recreates the provider grant',async()=>{
 const f=fixture(),client=await register(f),{t}=await login(f,client),hold=barrier();
 f.controls.grantBarrier=hold.wait;const late=renew(f,client,t.refresh_token);await hold.started;delete f.controls.grantBarrier;
 expect((await f.call('/token',form({client_id:client,token:t.refresh_token,token_type_hint:'refresh_token'}))).status).toBe(200);
 expect([...f.data.keys()].some(k=>k.startsWith('grant:'))).toBe(false);
 hold.release();expect((await late).status).toBe(400);expect([...f.data.keys()].some(k=>k.startsWith('grant:'))).toBe(true);
 expect((await list(f,t.access_token)).status).toBe(401);
 const subsequent=await renew(f,client,t.refresh_token);expect(subsequent.status).toBe(400);expect(await subsequent.json()).toMatchObject({error:'invalid_grant',error_description:'Authorization inactive; reconnect'});
});
