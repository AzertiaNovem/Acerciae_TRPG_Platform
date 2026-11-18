const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
function cache() {
  const disk = new Map(), mod = {exports:{}};
  const js=ts.transpileModule(fs.readFileSync(require.resolve('../src/lib/viewCache.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  new Function('require','exports',js)(()=>({snapshots:{get:async k=>disk.get(k),put:async(k,v)=>v?disk.set(k,v):disk.delete(k)}}),mod.exports);
  return new mod.exports.ViewCache();
}
const fresh=(value,tag)=>({unchanged:false,value,tag});
test('opens from memory while one hash check runs; only the changed version replaces it',async()=>{
  const c=cache(), old=await c.read('role',async()=>fresh({hp:9},'v1'));
  let resolve, calls=0;
  const fetch=async tag=>{calls++;assert.equal(tag,'v1');return new Promise(r=>resolve=r);};
  let shown;const a=c.read('role',fetch,{cached:x=>shown=x}), b=c.read('role',fetch);
  assert.equal(shown,old);
  await Promise.resolve();resolve({unchanged:true});assert.equal(await a,old);assert.equal(await b,old);assert.equal(calls,1);
  const newer=await c.read('role',async()=>fresh({hp:8},'v2'));assert.equal(newer.hp,8);
  assert.equal(await c.read('role',()=>assert.fail('warm pass should skip fresh view'),{maxAge:1000}),newer);
});
test('persistent candidates wait for authorization; resets discard late replies and another account sees no candidate',async()=>{
  const c=cache();c.setAccount('account-A');
  await c.read('role',async()=>fresh({name:'A'},'secret-hash'));
  c.clear();let painted=false, reject;
  const read=c.read('role',async tag=>{assert.equal(tag,'secret-hash');return new Promise((_,r)=>reject=r);},{cached:()=>{painted=true;}});
  await new Promise(r=>setImmediate(r));assert.equal(painted,false);
  reject(Object.assign(Error('revoked'),{status:403}));await assert.rejects(read,/revoked/);
  let resolve;const late=c.read('role',async tag=>{assert.equal(tag,'');return new Promise(r=>resolve=r);});
  await new Promise(r=>setImmediate(r));c.setAccount('account-B');resolve(fresh({name:'old'},'stale'));
  await assert.rejects(late,{name:'AbortError'});
  await c.read('role',async tag=>{assert.equal(tag,'');return fresh({name:'B'},'new');},{cached:()=>assert.fail('crossed accounts')});
});
