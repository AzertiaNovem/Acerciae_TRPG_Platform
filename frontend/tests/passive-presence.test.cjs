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
  '../i18n':{t:s=>s,currentLocale:()=> 'en'},
  '../store/auth':{useAuth:fn=>fn({user})},
  '../store/nav':{useNav:fn=>fn({characters})},
  '../store/chat':{useChat:fn=>fn({references:[],recallDrafts:{}}),recallDeadline:()=>null},
  '../store/reminders':{useReminders:fn=>fn({list:[]})},
  '../store/ui':{useUi:fn=>fn({})},
  '../store/typing':{useTyping:fn=>fn({byCharacter:{}})},
  '../api/client':{api:{}},
  '../lib/platform':{isDesktop:()=>false},
  './ChatReference':{default:()=>null}, './CachedImg':{CachedImg:()=>null},
};
function load(file) {
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const mod={exports:{}}; new Function('require','module','exports',code)(name=>fake[name]??require(name),mod,mod.exports); return mod.exports;
}
const {MessageRow}=load('MessageList.tsx'), {PassiveMark}=load('CharacterStatus.tsx');
const line={id:'line',character_id:'pc',character_name:'Alice',author_id:'gm',author_name:'Host',author_role:'gm',kind:'ooc',visibility:'window',created_at:'2020-01-01',content:'Let me think.',stand_in:true};
test('a stand-in uses the character identity and lets its owner recall an expired line',()=>{
  const html=renderToStaticMarkup(React.createElement(MessageRow,{m:line,jumped:false}));
  assert.match(html,/stand-in/); assert.match(html,/>Alice</); assert.ok(!html.includes('(GM)')); assert.match(html,/>Recall</);
  characters=[{id:'pc',user_id:'bob'}];
  assert.ok(!renderToStaticMarkup(React.createElement(MessageRow,{m:line,jumped:false})).includes('>Recall<'));
  characters=[{id:'pc',user_id:'alice'}];
  assert.ok(!renderToStaticMarkup(React.createElement(MessageRow,{m:line,jumped:false,readOnly:true})).includes('>Recall<'));
});
test('passive presence is visible with an explanation; old servers show nothing',()=>{
  assert.equal(renderToStaticMarkup(React.createElement(PassiveMark,{})),'');
  assert.match(renderToStaticMarkup(React.createElement(PassiveMark,{since:'2026-11-12'})),/Player away: passively present/);
});
