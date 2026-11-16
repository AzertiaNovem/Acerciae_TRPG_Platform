import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../../gm-agent/src/api.mjs';
const base=process.env.API_BASE||'http://localhost:18081';
test('inventory and message HTTP routes isolate private data and serialize cancellation against publication',async()=>{
  const gm=new Api(base),player=new Api(base),tag=crypto.randomUUID().slice(0,8);
  await gm.register('gm'+tag,'password','GM');await player.register('pl'+tag,'password','Player');
  const server=await gm.createServer('World state');
  for(const rule of ['coc7e','dnd2024','pbta']) {
    const channel=await gm.createChannel(server.id,{name:rule,rule_system:rule}),id=channel.id;
    await gm.post(`/api/channels/${id}/members`,{user_id:player.user.id,role:'player'});
    const a=await gm.createCharacter(id,{name:'NPC',kind:'npc'}),b=await player.createCharacter(id,{name:'Human'});
    await assert.rejects(player.inventory(id),{status:403});
    const items=[{name:'Key',note:'brass',qty:1}];
    const op={request_id:'gain',issued_at:Date.now(),reason:'Found it',changes:[{character_id:a.id,expected_version:0,items}]};
    const [first,second]=await Promise.all([gm.updateInventory(id,op),gm.updateInventory(id,op)]);
    assert.deepEqual(first,second);
    const card=(await gm.characterSpace(id,a.id)).character;
    await assert.rejects(gm.putCard(id,a.id,{role_card:{...card.role_card,items:[]},expected_inventory_version:0}),{status:409});
    await assert.rejects(gm.putCard(id,a.id,{role_card:{...card.role_card,items:[]}}),{status:409});
    const transfer={request_id:'transfer',issued_at:Date.now(),reason:'Handed over',changes:[{character_id:a.id,expected_version:1,items:[]},{character_id:b.id,expected_version:0,items}]};
    const [r1,r2]=await Promise.allSettled([gm.updateInventory(id,transfer),gm.updateInventory(id,{...transfer,request_id:'competing-transfer'})]);
    assert.equal([r1,r2].filter(r=>r.status==='fulfilled').length,1);
    assert.equal([r1,r2].find(r=>r.status==='rejected').reason.status,409);
    const inv=await gm.inventory(id);assert.equal(inv.characters.find(c=>c.id===b.id).items[0].qty,1);
    const window=(await gm.windows(id))[0].id;
    for(let i=0;i<5;i++) {
      const key='race-'+i,body={kind:'narration',content:'A guarded story turn.',request_id:key,request_issued_at:Date.now()};
      const [post]=await Promise.allSettled([gm.postMessage(id,window,body),gm.cancelAgentMessage(id,key)]);
      const receipt=await gm.agentMessage(id,key);
      if(receipt.cancelled){assert.equal(post.status,'rejected');await assert.rejects(gm.postMessage(id,window,body),{status:409});}
      else {assert.equal(post.status,'fulfilled');assert.equal(receipt.message.id,post.value.id);assert.equal((await gm.postMessage(id,window,body)).id,post.value.id);}
      await assert.rejects(player.agentMessage(id,key),{status:403});
    }
  }
});
