const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/PageCitations.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(name => name === '../i18n' ? { t: s => s } : require(name), mod, mod.exports);
const Citation = mod.exports.default;
test('module and script citations render page-only legacy data without inventing quotations', () => {
  const html = renderToStaticMarkup(React.createElement(Citation, { citations: [{ page: 3 }, { page: 5, excerpt: null }], maxExcerpt: 120, onPage() {} }));
  assert.match(html, /p\.3/); assert.match(html, /p\.5/); assert.match(html, /<button/); assert.ok(!html.includes('“'));
  assert.equal(renderToStaticMarkup(React.createElement(Citation, { maxExcerpt: 120 })), '');
});
test('citation excerpts are truncated, escaped, and keep page navigation', () => {
  let page;
  const view = Citation({ citations: [{ page: 7, excerpt: '<灯塔>原文' }], maxExcerpt: 4, onPage: n => { page = n; } });
  view.props.children[0].props.children.props.onClick(); assert.equal(page, 7);
  const html = renderToStaticMarkup(view);
  assert.match(html, /&lt;灯塔&gt;/); assert.ok(!html.includes('原文'));
});
