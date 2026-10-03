import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let current:string,legacy:string,dir:string,runtime:Miniflare|undefined;
beforeAll(async()=>{
 const options={entryPoints:['src/worker/index.ts'],bundle:true,write:false,format:'esm' as const,platform:'browser' as const,external:['cloudflare:workers']};
 current=(await build(options)).outputFiles[0].text;
 // Test-only issuance fixture: produce cryptographically valid v1 credentials.
 // New production code never permits legacy grants; no production test switches.
 legacy=(await build({...options,plugins:[{name:'synthetic-legacy-issuance',setup(b){b.onLoad({filter: /src\/worker\/(github-handler|security)\.ts$/},async args=>{
  let contents=await readFile(args.path,'utf8');
  if(args.path.endsWith('github-handler.ts')) contents=contents.replace('version: 2, userId:', 'version: 1, userId:');
  else contents=contents.replace('p.version === 2','p.version === 1');
  return {contents,loader:'ts'};
 });}}]})).outputFiles[0].text;
});
afterEach(async()=>{await runtime?.dispose();runtime=undefined;if(dir)await rm(dir,{recursive:true,force:true});});
async function start(script=current){
 if(!dir)dir=await mkdtemp(join(tmpdir(),'ynab-grant-runtime-'));
 runtime=new Miniflare({...convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],
  bindings:{PUBLIC_ORIGIN:'https://worker.example',YNAB_ALLOWED_PLAN_ID:'11111111-1111-4111-8111-111111111111',YNAB_API_TOKEN:'synthetic',YNAB_READ_ONLY:'true',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',ALLOWED_GITHUB_LOGIN:'owner',OAUTH_ALLOWED_REDIRECT_URIS:'["https://client.example/callback"]'},
  kvNamespaces:['OAUTH_KV'],durableObjects:{OAUTH_FLOWS:{className:'OAuthFlowStore',useSQLite:true},OAUTH_GRANTS:{className:'OAuthGrantStore',useSQLite:true}},
  outboundService(r){if(r.url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'synthetic'});if(r.url==='https://api.github.com/user')return Response.json({id:123,login:'owner'});throw Error('Unexpected outbound blocked');},
 }),resourcePersistencePath:dir});await runtime.ready;
}
const form=(v:Record<string,string>)=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(v).toString()});
const call=(p:string,init:RequestInit={})=>runtime!.dispatchFetch('https://worker.example'+p,{...init,redirect:'manual'});
async function register(){const r=await call('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none'})});expect(r.status).toBe(201);return (await r.json() as any).client_id;}
async function pending(client:string){
 const verifier='v'.repeat(43),challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
 const query=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:'https://client.example/callback',code_challenge:challenge,code_challenge_method:'S256'});
 const consent=await call('/authorize?'+query);expect(consent.status).toBe(200);const html=await consent.text(),cookie=consent.headers.get('set-cookie')!.split(';')[0];
 const flow=html.match(/name="flow" value="([^"]+)"/)![1],csrf=html.match(/name="csrf_token" value="([^"]+)"/)![1];
 const approve=form({flow,csrf_token:csrf,decision:'approve'});approve.headers={...approve.headers,origin:'https://worker.example',cookie} as any;expect((await call('/authorize',approve)).status).toBe(302);
 const cb=await call('/callback?'+new URLSearchParams({state:flow,code:'synthetic'}),{headers:{cookie}});expect(cb.status).toBe(302);const code=new URL(cb.headers.get('location')!).searchParams.get('code')!;
 return ()=>call('/token',form({grant_type:'authorization_code',client_id:client,code,code_verifier:verifier,redirect_uri:'https://client.example/callback'}));
}
const list=(t:string)=>call('/mcp',{method:'POST',headers:{authorization:'Bearer '+t,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
const renew=(c:string,t:string)=>call('/token',form({grant_type:'refresh_token',client_id:c,refresh_token:t}));
async function restart(script=current){await runtime!.dispose();runtime=undefined;await start(script);}
describe('workerd durable replacement and migration',()=>{
 it('retains pending/active generations through process restart and never revives replaced/revoked grants',async()=>{
  dir='';await start();const client=await register(),first=await pending(client),old=await (await first()).json() as any;
  const replacement=await pending(client);await restart();expect((await list(old.access_token)).status).toBe(200);
  const nextResponse=await replacement();expect(nextResponse.status).toBe(200);const next=await nextResponse.json() as any;
  await restart();expect((await list(old.access_token)).status).toBe(401);expect((await renew(client,old.refresh_token)).status).toBe(400);expect((await list(next.access_token)).status).toBe(200);
  expect((await call('/token',form({client_id:client,token:next.refresh_token,token_type_hint:'refresh_token'}))).status).toBe(200);
  await restart();expect((await list(next.access_token)).status).toBe(401);expect((await renew(client,next.refresh_token)).status).toBe(400);
 },20000);
 it('requires the planned reconnect for valid version-1 tokens and permits a new version-2 connection',async()=>{
  dir='';await start(legacy);const client=await register(),p=await pending(client),r=await p();expect(r.status).toBe(200);const old=await r.json() as any;
  await restart();const denied=await list(old.access_token);expect(denied.status).toBe(401);expect(denied.headers.get('www-authenticate')).toContain('invalid_token');expect((await renew(client,old.refresh_token)).status).toBe(400);
  const fresh=await pending(client),tokens=await (await fresh()).json() as any;expect((await list(tokens.access_token)).status).toBe(200);
 },20000);
});

it('serializes concurrent replacement activations in actual workerd',async()=>{
 dir='';await start();const client=await register(),a=await pending(client),b=await pending(client);
 const result=await Promise.all([a(),b()]);expect(result.map(r=>r.status).sort()).toEqual([200,400]);const winner=await result.find(r=>r.status===200)!.json() as any;
 await restart();expect((await list(winner.access_token)).status).toBe(200);expect((await renew(client,winner.refresh_token)).status).toBe(200);
},20000);
