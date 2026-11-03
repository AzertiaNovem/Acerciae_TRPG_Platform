import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({ TextDecoder, TextEncoder, atob, btoa, structuredClone, console });
vm.runInContext(fs.readFileSync(new URL('../contracts/openstudio/studio-engine.js',import.meta.url),'utf8'),context);
async function call(input) { const r=JSON.parse(await context.MobileStudio.run(JSON.stringify(input))); assert.equal(r.ok,true,r.error); return r.value; }
const text='Keeper(1234567) 2026/10/02 21:41:06\n夜色笼罩港口。\nHarvey(7654321) 2026/10/02 21:43:45\n我举起提灯。';
const files=[{name:'night.txt',data:Buffer.from(text).toString('base64')}];
test('bundled engine imports logs, strips platform IDs, appends once and restores portable backup',async()=>{
 const {project}=await call({action:'import',files}); assert.equal(project.events.length,2); assert.equal(project.characters.length,2); assert.ok(!JSON.stringify(project).includes('1234567'));
 const appended=await call({action:'import',files,project}); assert.equal(appended.project.events.length,2);
 const backup=await call({action:'archive',project}); const restored=await call({action:'import',files:[{name:'backup.json',data:Buffer.from(backup.text).toString('base64')}]});
 assert.notEqual(restored.project.id,project.id); assert.equal(restored.project.events[0].content,project.events[0].content);
});
test('preview, PDF source and VN are offline and preserve local image data',async()=>{
 const {project}=await call({action:'import',files});
 const path='assets/test.jpg',image='data:image/jpeg;base64,YQ=='; project.characters[1].portrait=path;
 for(const action of ['html','pdf','vn']) { const result=await call({action,project,assets:{[path]:image},language:'zh-CN'}); assert.ok(result.html.includes('夜色')); assert.ok(result.html.includes("connect-src 'none'")); assert.ok(!result.html.includes('StudioNative')); if(action==='pdf'||action==='vn') assert.ok(result.html.includes(image),action); }
});
test('secret messages stay out of every shareable format unless included; backups retain them',async()=>{
 const {project}=await call({action:'import',files}); project.events[0].type='secret'; project.events[0].content='PRIVATE_MARKER';
 for(const action of ['html','pdf','vn','text','native']) { const result=await call({action,project}); assert.ok(!JSON.stringify(result).includes('PRIVATE_MARKER'),action); }
 assert.ok((await call({action:'archive',project})).text.includes('PRIVATE_MARKER'));
 for(const action of ['html','pdf','vn','text','native']) assert.ok(JSON.stringify(await call({action,project,secret:true})).includes('PRIVATE_MARKER'),action);
 project.events[0].type='ooc'; project.events[0].content='OOC_MARKER';
 for(const action of ['html','pdf','vn','text','native']) assert.ok(JSON.stringify(await call({action,project,ooc:true})).includes('OOC_MARKER'),action);
});
test('untrusted paths and markup cannot escape the project or become executable',async()=>{
 const {project}=await call({action:'import',files}); project.events[0].content='<script>EVIL()</script>';
 const html=(await call({action:'html',project})).html; assert.ok(!html.includes('<script>EVIL()'));
 const bad=JSON.parse(await context.MobileStudio.run(JSON.stringify({action:'archive',project,assets:{'../escape.jpg':'data:image/jpeg;base64,YQ=='}}))); assert.equal(bad.ok,false);
});
