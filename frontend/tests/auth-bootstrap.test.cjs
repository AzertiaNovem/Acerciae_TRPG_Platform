const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
function fixture() {
  let token = 'saved-session', failure, calls = 0;
  class ApiError extends Error { constructor(status, apiResponse = true) { super('upstream'); this.status = status; this.apiResponse = apiResponse; } }
  const api = {me:async()=>{calls++;if(failure)throw failure;return {id:'u',ui_language:'en'};}};
  const noop=()=>{}; const mod={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(require.resolve('../src/store/auth.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const client={api,ApiError,getToken:()=>token,setToken:t=>token=t,forgetActiveCredential:async()=>{token=null;},ensureFileToken:async()=>'',rememberDesktopAccount:async()=>{},desktopAccounts:null};
  const deps={'../api/client':client,'../api/ws':{connectSockets:noop,closeSockets:noop},'./session':{bumpEpoch:noop},'../i18n':{useLocale:{getState:()=>({setLanguage:noop})}},'./reset':{resetUserStores:noop},'../lib/assetCache':{setAssetScope:noop,scheduleSweep:noop},'../lib/chatHistory':{setHistoryScope:noop,clearHistory:async()=>{}},'../lib/platform':{apiBase:()=>'',isDesktop:false}};
  new Function('require','module','exports','setInterval',code)(name=>deps[name]??require(name),mod,mod.exports,noop);
  return {auth:mod.exports.useAuth,ApiError,fail:e=>failure=e,token:()=>token,calls:()=>calls,api,client};
}
test('temporary HTTP and transport failures retain the saved session and permit bootstrap retry',async()=>{
 for(const kind of ['503','transport']) {
  const f=fixture(); f.fail(kind==='503'?new f.ApiError(503):new TypeError('offline'));
  await Promise.all([f.auth.getState().bootstrap(),f.auth.getState().bootstrap()]);
  assert.equal(f.calls(),1);assert.equal(f.token(),'saved-session');assert.equal(f.auth.getState().user,null);
  f.fail(null);await f.auth.getState().bootstrap();assert.equal(f.auth.getState().user.id,'u');assert.equal(f.auth.getState().error,null);
 }
});
test('an explicit authentication rejection clears the saved credential',async()=>{
 const f=fixture();f.fail(new f.ApiError(401));await f.auth.getState().bootstrap();assert.equal(f.token(),null);
});

for (const row of require('../../mobile/contracts/fixtures/session-errors.json')) {
 test(`session contract: HTTP ${row.status}, API response ${row.api_response}`, async () => {
  const f=fixture();f.fail(new f.ApiError(row.status,row.api_response));await f.auth.getState().bootstrap();
  assert.equal(f.token()===null,row.clear_session);
  assert.equal(f.auth.getState().phase,row.clear_session?'anonymous':'recoverable_error');
 });
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('an old restore finishing after a new sign-in cannot replace identity or clear its credential',async()=>{
 for(const reject of [false,true]){
  const f=fixture(),old=deferred();f.api.me=async()=>{await old.promise;if(reject)throw new f.ApiError(401);return {id:'old'};};
  f.api.login=async()=>({user:{id:'new'},token:'new-session'});
  const restoring=f.auth.getState().bootstrap();await f.auth.getState().login('new','password');old.resolve();await restoring;
  assert.equal(f.auth.getState().user.id,'new');assert.equal(f.token(),'new-session');
 }
});
test('logout during file-token renewal prevents the restored account reconnecting',async()=>{
 const f=fixture(),renew=deferred();let started=false;f.client.ensureFileToken=async()=>{started=true;return renew.promise;};f.api.logout=async()=>{};
 const restoring=f.auth.getState().bootstrap();while(!started)await Promise.resolve();
 await f.auth.getState().logout();renew.resolve('file');await restoring;
 assert.equal(f.auth.getState().user,null);assert.equal(f.token(),null);assert.equal(f.auth.getState().phase,'anonymous');
});
test('two sign-ins resolving in reverse order leave the most recent account selected',async()=>{
 const f=fixture(),old=deferred();f.api.login=async name=>name==='old'?old.promise:{user:{id:'new'},token:'new-session'};
 const first=f.auth.getState().login('old','password');await f.auth.getState().login('new','password');
 old.resolve({user:{id:'old'},token:'old-session'});await first;
 assert.equal(f.auth.getState().user.id,'new');assert.equal(f.token(),'new-session');
});
