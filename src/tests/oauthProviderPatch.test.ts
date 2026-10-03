import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyProviderPatch } from '../../scripts/patch-oauth-provider.mjs';
const manifest=JSON.parse(readFileSync('patches/oauth-provider-manifest.json','utf8'));
function fixture(run:(base:string)=>void){const dir=mkdtempSync(join(tmpdir(),'ynab-provider-patch-'));try{mkdirSync(join(dir,'dist'));writeFileSync(join(dir,'package.json'),JSON.stringify({version:manifest.version}));for(const f of manifest.files){let source=readFileSync('node_modules/@cloudflare/workers-oauth-provider/dist/'+f.file,'utf8');for(const r of f.replacements)source=source.replace(r.after,r.before);writeFileSync(join(dir,'dist',f.file),source);}run(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
describe('pinned OAuth provider security extension',()=>{
 it('rejects missing patch in check-only mode, applies without external tools, and is idempotent',()=>fixture(base=>{
  expect(()=>applyProviderPatch(base,true)).toThrow(/patch missing/);applyProviderPatch(base);expect(()=>applyProviderPatch(base,true)).not.toThrow();applyProviderPatch(base);
 }));
 it('rejects source tampering and unsupported upgrades',()=>fixture(base=>{
  const p=join(base,'dist/oauth-provider.js');writeFileSync(p,readFileSync(p,'utf8')+'\n// altered');expect(()=>applyProviderPatch(base)).toThrow(/source changed/);
  writeFileSync(join(base,'package.json'),JSON.stringify({version:'0.10.4'}));expect(()=>applyProviderPatch(base)).toThrow(/version changed/);
 }));
 it('ships the installer and patch artifacts needed by package postinstall',()=>{
  const packed=JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{encoding:'utf8',env:{...process.env,npm_config_cache:join(tmpdir(),'ynab-pack-cache')}}));
  const files=packed[0].files.map((x:{path:string})=>x.path);expect(files).toContain('scripts/patch-oauth-provider.mjs');expect(files).toContain('patches/oauth-provider-manifest.json');
 });
 it.each(['wrangler.atomsovic.jsonc','wrangler.example.jsonc'])('checks the provider before direct Worker builds in %s',file=>{
  expect(readFileSync(file,'utf8')).toMatch(/"build":\s*\{\s*"command":\s*"npm run check:oauth-provider"/);
 });
});
