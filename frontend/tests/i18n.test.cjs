const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const catalog = require('../src/i18n/catalog.json');
const moduleSource = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/i18n/index.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2020, esModuleInterop:true}}).outputText;
const stored = new Map();
global.localStorage = {getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)};
global.document = {documentElement:{lang:'en'}};
const result = {exports:{}};
new Function('require','module','exports',moduleSource)(name => name==='./catalog.json' ? catalog : require(name),result,result.exports);
const {t,LOCALES,useLocale} = result.exports;
test('all eleven server languages have complete catalog rows and actual personal settings translations',()=>{
 assert.deepEqual(LOCALES,['en','zh-CN','zh-TW','ja','ko','es','fr','de','ru','pt','it']);
 for(const [key,values]of Object.entries(catalog)) {assert.equal(values.length,10,key);assert.ok(values.every(v=>typeof v==='string'&&v.trim()),key);}
 for(const locale of LOCALES){useLocale.getState().setLanguage(locale);assert.equal(document.documentElement.lang,locale);assert.equal(stored.get('acerciae.ui-language'),locale);if(locale!=='en')assert.notEqual(t('User settings'),'User settings');}
 useLocale.getState().setLanguage('zh-CN');assert.equal(t('Save'),'保存');assert.equal(t(' Save '),' 保存 ');assert.equal(t('Characters'),'角色');
 assert.equal(t('A new unknown label'),'A new unknown label');assert.equal(t('Scene {n}',{n:3}),'Scene 3');
 useLocale.getState().setLanguage('invalid');assert.equal(useLocale.getState().language,'en');
});
test('static UI copy is catalogued; technical literals stay literal',()=>{
 const known=new Set(Object.keys(catalog).map(k=>k.toLowerCase()));
 const literal=new Set(['(NPC)','(v','.ra hard spot hidden','.ra research','.sc 1/1d6','.st hp-2','.st str60 dex50 research53','Acerciae','BGM','English','GM','HTML','ID:','JSON','KB','LLM','NPC','NPC (GM)','OOC','PC','PDF','PDF →','SealDice TXT','TXT','cps','gm','https://api.openai.com/v1','https://…','reasoning_effort','v','{attr}','{level}','{name}','{roll}','{target}','· v','— v']);
 function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else if(file.endsWith('.tsx')){
 const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true,ts.ScriptKind.TSX);
 function visit(node){if(ts.isCallExpression(node)&&['tr','t'].includes(node.expression.getText(ast))&&node.arguments.length&&ts.isStringLiteral(node.arguments[0])){
 const key=node.arguments[0].text.trim();assert.ok(known.has(key.toLowerCase())||literal.has(key),file+': '+key);
 }
 if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='option') {
 const translates=node.children.some(c=>ts.isJsxExpression(c)&&c.expression?.getText(ast).startsWith('tr('));
 if(translates)assert.ok(node.openingElement.attributes.properties.some(a=>a.name?.text==='value'),'Translated option must keep an explicit stable value: '+file);
 }
 ts.forEachChild(node,visit);}visit(ast);
 }}}walk(path.join(__dirname,'../src'));
});
