import {test} from 'node:test';
import assert from 'node:assert/strict';
const base=process.env.API_BASE||'http://localhost:18081';
async function call(token,method,path,body) {
  const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw Object.assign(Error(JSON.stringify(data)),{status:r.status});return data;
}
test('atmosphere: both opt-ins, four generated variants, personal/GM permissions and published asset review', async()=>{
 const suffix=Math.random().toString(36).slice(2);
 const register=(name)=>call('', 'POST','/api/auth/register',{username:name+suffix,password:'password',display_name:name});
 const gm=await register('atmGM'),pl=await register('atmPL'),outsider=await register('atmOut');
 const server=await call(gm.token,'POST','/api/servers',{name:'Atmosphere test'});
 const ch=(await call(gm.token,'POST',`/api/servers/${server.id}/channels`,{name:'Courtyard'})).id;
 await call(gm.token,'POST',`/api/channels/${ch}/members`,{username:'atmPL'+suffix,role:'player'});
 const main=(await call(gm.token,'GET',`/api/channels/${ch}/windows`))[0].id;
 const settings=`/api/servers/${server.id}/settings`,root=`/api/channels/${ch}/atmosphere`;
 assert.equal((await call(gm.token,'GET',settings)).features.atmosphere,false);
 assert.equal((await call(pl.token,'GET','/api/auth/me')).atmosphere_enabled,false);
 await assert.rejects(call(pl.token,'PUT',settings,{features:{atmosphere:true}}),e=>e.status===403);
 await call(gm.token,'PUT',settings,{features:{atmosphere:true},image:{provider:'mock'}});
 await assert.rejects(call(pl.token,'PUT','/api/auth/me',{atmosphere_enabled:'true'}),e=>e.status===400);
 const say=(content,visibility='window')=>call(gm.token,'POST',`/api/channels/${ch}/windows/${main}/messages`,{content,kind:'narration',visibility});
 await say('PRIVATE monster behind the courtyard wall','gm_only');
 await say('A stone courtyard lined with ivy.');
 await say('Rain falls gently over the old walls.');
 await say('[Atmosphere] Ivy courtyard in the rain');
 const observe=()=>call(gm.token,'POST',`/api/channels/${ch}/ai/observe-now`);
 await observe();assert.equal((await call(gm.token,'GET',root+'/history')).length,0);
 await call(pl.token,'PUT','/api/auth/me',{atmosphere_enabled:true});
 await say('The courtyard is quiet, with cold grey stone.');await observe();
 let current;
 for(let i=0;i<80;i++){
   current=await call(pl.token,'GET',root);if(Object.keys(current.assets||{}).length===4)break;
   await new Promise(r=>setTimeout(r,250));
 }
 assert.deepEqual(Object.keys(current.assets||{}).sort(),['day_landscape','day_portrait','night_landscape','night_portrait']);
 assert.equal(current.mock,true);assert.equal(current.time_of_day,undefined);
 const history=await call(gm.token,'GET',root+'/history');assert.equal(history.length,1);
 assert.equal(history[0].variants.length,4);assert.ok(!JSON.stringify(history).includes('PRIVATE'));
 for(const [variant,id] of Object.entries(current.assets)){
   const r=await fetch(base+root+'/assets/'+id,{headers:{Authorization:`Bearer ${pl.token}`}});
   assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
   assert.match(r.headers.get('cache-control'),/no-store/);
   const bytes=Buffer.from(await r.arrayBuffer());assert.equal(bytes.readUInt32BE(20)>bytes.readUInt32BE(16),variant.endsWith('portrait'));
 }
 await assert.rejects(call(pl.token,'GET',root+'/history'),e=>e.status===403);
 await assert.rejects(call(outsider.token,'GET',root),e=>e.status===403);
 await say('[Atmosphere] New harbour');await observe();
 assert.equal((await call(gm.token,'GET',root+'/history')).length,1,'cooldown retains one set');
 const id=current.assets.day_landscape;
 await call(pl.token,'PUT','/api/auth/me',{atmosphere_enabled:false});
 assert.equal((await call(pl.token,'GET',root)).enabled,false);
 assert.equal((await fetch(base+root+'/assets/'+id,{headers:{Authorization:`Bearer ${pl.token}`}})).status,404);
 await call(pl.token,'PUT','/api/auth/me',{atmosphere_enabled:true});
 await call(gm.token,'PUT',settings,{features:{atmosphere:false}});
 assert.equal((await call(pl.token,'GET',root)).enabled,false);
});
