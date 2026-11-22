// The chat line (MessageList.tsx MessageRow) rendered on its own: interactive messages and the lines they caused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const user={id:'alice',display_name:'Alice'};
let characters=[{id:'pc',user_id:'alice'}];
const fake={
  '../i18n':{t:s=>s,currentLocale:()=> 'en',useLocale:f=>f({language:'en'})},
  '../store/auth':{useAuth:fn=>fn({user})},
  '../store/nav':{useNav:fn=>fn({characters})},
  '../store/chat':{useChat:fn=>fn({references:[],recallDrafts:{}}),recallDeadline:()=>null},
  '../store/reminders':{useReminders:fn=>fn({list:[]})},
  '../store/ui':{useUi:fn=>fn({})},
  '../store/typing':{useTyping:fn=>fn({byCharacter:{}})},
  '../api/client':{api:{}},
  '../lib/platform':{isDesktop:()=>false},
  './ChatReference':{default:()=>null}, './CachedImg':{CachedImg:()=>null},
  // Interactive messages: the card itself is tested on its own (hypertext-*.test.cjs and the browser suite).
  './HypertextCard':{HypertextBody:({m})=>React.createElement('div',{className:'hx-card-stub'},m.id),Isolated:({text,values})=>text.replace(/\{(\w+)\}/g,(_,k)=>values[k])},
  '../store/hypertext':{useHypertext:{getState:()=>({track(){}})}},
};
function load(file) {
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const mod={exports:{}}; new Function('require','module','exports',code)(name=>fake[name]??require(name),mod,mod.exports); return mod.exports;
}
fake['./messageKind']=load('messageKind.ts');
const {MessageRow}=load('MessageList.tsx');
const line={id:'line',character_id:'pc',character_name:'Alice',author_id:'gm',author_name:'Host',author_role:'gm',kind:'ooc',visibility:'window',created_at:'2020-01-01',content:'Let me think.'};
test('a line from before stand-ins were removed reads as the GM account\'s, and only its author may recall it',()=>{
  const html=renderToStaticMarkup(React.createElement(MessageRow,{m:{...line,stand_in:true},jumped:false}));
  assert.ok(!html.includes('stand-in')); assert.ok(!html.includes('>Recall<'));
});
test('an interactive message keeps its frame with the "Interactive message" pill and no Pin; its lines say where they came from',()=>{
  const card={...line,id:'card',character_id:null,character_name:null,kind:'hypertext',content:'Roll\n[Roll]',hypertext:{v:1,body:[]}};
  const html=renderToStaticMarkup(React.createElement(MessageRow,{m:card,jumped:false}));
  assert.match(html,/class="message hypertext window"/); assert.match(html,/>Host \(GM\)</);
  assert.match(html,/<span class="pill hx-pill">Interactive message<\/span>/); assert.ok(!html.includes('>hypertext<'));
  assert.match(html,/hx-card-stub">card</); assert.ok(!html.includes('>Pin<'),'a card cannot be pinned'); assert.match(html,/>Quote as reference</);
  const roll={...line,id:'roll',author_id:'bob',author_name:'Bob',author_role:'player',kind:'ic',content:'.ra Spot Hidden',via_hypertext_id:'card',via_user_id:'bob',via_user_name:'Bob'};
  const said=renderToStaticMarkup(React.createElement(MessageRow,{m:roll,jumped:false}));
  assert.match(said,/pill hx-via/); assert.match(said,/via interactive message/); assert.ok(!said.includes('answering'),'the clicker is the author');
  const reply={...line,id:'reply',character_id:null,character_name:null,kind:'narration',content:'The door opens.',via_hypertext_id:'card',via_user_id:'alice',via_user_name:'Alice'};
  assert.match(renderToStaticMarkup(React.createElement(MessageRow,{m:reply,jumped:false})),/via interactive message · answering Alice/);
  assert.ok(!renderToStaticMarkup(React.createElement(MessageRow,{m:line,jumped:false})).includes('hx-via'));
});
