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
test('interactive-message sentences that reach tr() through a table or a component prop are catalogued',()=>{
 // HX_TEXT and ERRORS (store/hypertext.ts) and REASONS (HypertextCard.tsx) are shown through tr(entry.error) and
 // tr(REASONS[reason]); Isolated translates its `text` prop. A string literal, or either side of a ?: of them.
 const literals=node=>{
  if(!node)return null;
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return [node.text];
  if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isJsxExpression(node))return literals(node.expression);
  if(ts.isConditionalExpression(node)){const a=literals(node.whenTrue),b=literals(node.whenFalse);return a&&b?[...a,...b]:null;}
  return null;
 };
 const tables=new Map([['store/hypertext.ts',['HX_TEXT','ERRORS']],['components/HypertextCard.tsx',['REASONS']]]);
 const sentences=[];
 for(const [file,names] of tables){
  const ast=ts.createSourceFile(file,fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),99,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const found=new Set();
  (function visit(node){
   if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&names.includes(node.name.text)){
    let init=node.initializer;while(init&&(ts.isAsExpression(init)||ts.isParenthesizedExpression(init)))init=init.expression;
    assert.ok(init&&ts.isObjectLiteralExpression(init),`${file}: ${node.name.text} is an object of sentences`);
    for(const p of init.properties){const v=ts.isPropertyAssignment(p)&&literals(p.initializer);assert.ok(v,`${file}: ${node.name.text}.${p.name?.getText(ast)} is a sentence`);sentences.push(...v.map(s=>[`${file} ${node.name.text}`,s]));}
    found.add(node.name.text);
   }
   ts.forEachChild(node,visit);
  })(ast);
  assert.deepEqual([...found].sort(),[...names].sort(),file);
 }
 const isolated=[];
 (function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else if(file.endsWith('.tsx')){
  const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true,ts.ScriptKind.TSX);
  (function visit(node){
   if((ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&node.tagName.getText(ast)==='Isolated'){
    const text=node.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='text');
    const v=text&&literals(text.initializer);assert.ok(v,`${file}: Isolated text is a literal`);
    isolated.push(...v.map(s=>[file,s]));
   }
   ts.forEachChild(node,visit);
  })(ast);
 }}})(path.join(__dirname,'../src'));
 assert.ok(isolated.length>=3,'the confirm row and the via pill');
 for(const [where,s] of [...sentences,...isolated]){
  const row=catalog[s];
  assert.ok(Array.isArray(row)&&row.length===10&&row.every(v=>typeof v==='string'&&v.trim()),`${where}: "${s}" has 10 translations in catalog.json`);
  if(/\{\w+\}/.test(s))for(const v of row)assert.deepEqual(v.match(/\{\w+\}/g).sort(),s.match(/\{\w+\}/g).sort(),`${where}: "${s}" keeps its placeholders`);
 }
});
