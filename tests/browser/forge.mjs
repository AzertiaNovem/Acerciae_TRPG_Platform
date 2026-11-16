import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Api } from '../../gm-agent/src/api.mjs';
import { newSession } from '../../gm-agent/src/forge/state.mjs';
import { questionCard } from '../../gm-agent/src/forge/cards.mjs';
const site=process.env.WEB_BASE||'http://127.0.0.1:5197';
const gm=new Api(site),player=new Api(site),tag=crypto.randomUUID().slice(0,8);
await gm.register('gm'+tag,'password','GM');await player.register('pl'+tag,'password','Player');
const server=await gm.createServer('Forge UI'),ch=await gm.createChannel(server.id,{name:'Unwritten'});
await gm.post(`/api/channels/${ch.id}/members`,{user_id:player.user.id,role:'player'});
const w=await gm.createWindow(ch.id,{name:'开局共创 · Forge',purpose:'forge',kind:'group',members:[{user_id:player.user.id}]});
const s=newSession({rule:'coc7e'}),card=await gm.postHypertext(ch.id,w.id,questionCard(s,{id:'Q1',text:'你希望角色从什么生活开始？',options:['经营海边书店','作为失踪船员的家属调查']}));
const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(token=>localStorage.setItem('acerciae.token',token),player.token);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(site);
  await page.getByText('开局共创 · Forge',{exact:true}).first().click();
  const row=page.locator('#msg-'+card.id);await row.getByText('你希望角色从什么生活开始？',{exact:true}).waitFor();
  await row.getByLabel('经营海边书店').check();
  await row.getByRole('textbox').fill('我想让这家店是姐姐留下来的。');
  await row.getByRole('button',{name:'提交回答',exact:true}).click();
  let answer;
  for(let i=0;i<40;i++){answer=(await gm.messages(ch.id,w.id,100)).find(x=>x.via_hypertext_id===card.id);if(answer)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(answer);assert.equal(answer.author_id,player.user.id);assert.equal(answer.character_id,null);assert.equal(answer.kind,'ooc');assert.match(answer.content,/经营海边书店.*姐姐留下来的/);assert.equal(answer.scene_id,null);
  await row.screenshot({path:'/tmp/forge-question-card.png'});assert.deepEqual(errors,[]);
  console.log('Forge native question card: rendered, selected, custom text submitted without a character; no page errors.');
} finally {await browser.close();}
