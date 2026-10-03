import { describe, it, expect, vi, afterEach } from "vitest";
import { OAuthGrantStore } from "../worker/oauth-grants.js";
import { memoryNamespace } from "./helpers/durable.js";
afterEach(() => vi.useRealTimers());
const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
function fixture() {
 const ns = memoryNamespace(OAuthGrantStore);
 const call = (action: string, authorizationId = a, extra = {}) => ns.get("synthetic").fetch(`https://grants.internal/${action}`, {method:"POST",body:JSON.stringify({authorizationId,...extra})});
 const begin = (id = a) => call("begin",id,{expiresAt:Date.now()+600000});
 const activate = (id = a) => call("activate",id,{grantId:id.slice(0,16),expiresAt:Date.now()+604800000});
 const check = (id = a) => call("check",id,{grantId:id.slice(0,16)});
 return {ns,call,begin,activate,check};
}
describe("durable active grant authority",()=>{
 it("denies pending grants, preserves active grant, then atomically replaces it",async()=>{
  const f=fixture();expect((await f.check()).status).toBe(401);
  await f.begin();expect((await f.check()).status).toBe(401);expect((await f.activate()).status).toBe(200);
  await f.begin(b);expect((await f.check()).status).toBe(200);expect((await f.check(b)).status).toBe(401);
  await f.activate(b);expect((await f.check()).status).toBe(401);expect((await f.check(b)).status).toBe(200);
 });
 it("allows exactly one concurrent replacement based on the same generation",async()=>{
  const f=fixture();await f.begin();await f.activate();await f.begin(b);await f.begin(c);
  const r=await Promise.all([f.activate(b),f.activate(c)]);expect(r.map(x=>x.status).sort()).toEqual([200,409]);
  expect((await f.check()).status).toBe(401);expect([(await f.check(b)).status,(await f.check(c)).status].sort()).toEqual([200,401]);
 });
 it("retains winner and tombstone across restart; repeated activation cannot resurrect a revoked grant",async()=>{
  const f=fixture();await f.begin();await f.activate();f.ns.restart();expect((await f.check()).status).toBe(200);
  expect((await f.activate()).status).toBe(200);
  await f.call("revoke",a,{grantId:a.slice(0,16)});f.ns.restart();expect((await f.check()).status).toBe(401);expect((await f.activate()).status).toBe(409);
 });
 it("revocation fences pending candidates; revoking another grant does not revoke the winner",async()=>{
  const f=fixture();await f.begin();await f.activate();await f.begin(b);
  await f.call("revoke",b,{grantId:b.slice(0,16)});expect((await f.check()).status).toBe(200);
  await f.call("revoke",a,{grantId:a.slice(0,16)});expect((await f.activate(b)).status).toBe(409);
 });
 it("expires pending and active records without adopting missing or expired credentials",async()=>{
  vi.useFakeTimers();const f=fixture();await f.begin();vi.advanceTimersByTime(600001);expect((await f.activate()).status).toBe(409);
  await f.begin(b);await f.activate(b);vi.advanceTimersByTime(604800001);expect((await f.check(b)).status).toBe(401);expect((await f.activate(b)).status).toBe(409);
 });
});

it('cleans pending records on alarms while preserving active authority across restart',async()=>{
 vi.useFakeTimers();const f=fixture();await f.begin();await f.activate();await f.begin(b);vi.advanceTimersByTime(600001);await f.ns.alarm('synthetic');f.ns.restart();expect((await f.check()).status).toBe(200);expect((await f.activate(b)).status).toBe(409);
});
it('bounds pending candidates and rejects malformed internal requests',async()=>{
 const f=fixture();for(let i=0;i<16;i++)expect((await f.begin(i.toString(16).padStart(64,'0'))).status).toBe(200);
 expect((await f.begin('f'.repeat(64))).status).toBe(429);
 expect((await f.call('begin','bad',{expiresAt:Date.now()+600000})).status).toBe(400);
 expect((await f.call('activate',a,{grantId:'x',expiresAt:Date.now()+604860000})).status).toBe(400);
});
