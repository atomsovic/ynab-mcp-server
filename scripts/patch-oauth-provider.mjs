import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'patches/oauth-provider-manifest.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');

/** Pure Node, version/hash-pinned, idempotent extension; no network or shell tools. */
export function applyProviderPatch(base, checkOnly = false) {
 if (JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8')).version !== manifest.version) throw Error('OAuth provider version changed: review the local security extension');
 // Validate every file before writing any of them.
 const writes = [];
 for (const entry of manifest.files) {
  const file = resolve(base, 'dist', entry.file), data = readFileSync(file, 'utf8');
  if (hash(data) === entry.after) continue;
  if (checkOnly || hash(data) !== entry.before) throw Error('OAuth provider patch missing or source changed: run postinstall and review before building');
  let patched = data;
  for (const replacement of entry.replacements) {
   if (patched.split(replacement.before).length !== 2) throw Error('OAuth provider patch context changed');
   patched = patched.replace(replacement.before, replacement.after);
  }
  if (hash(patched) !== entry.after) throw Error('OAuth provider patch verification failed');
  writes.push([file, patched]);
 }
 for (const [file, patched] of writes) writeFileSync(file, patched);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const require = createRequire(import.meta.url);
 applyProviderPatch(dirname(require.resolve('@cloudflare/workers-oauth-provider/package.json')), process.argv.includes('--check'));
}
