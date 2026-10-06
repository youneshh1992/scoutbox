// Verify visual summaries preserve records and distinguish empty from loading.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../scoutbox-grassroots/package.json'));
const ts = req('typescript');
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const source = fs.readFileSync(path.resolve(__dirname, '../scoutbox-grassroots/src/ScoutVisuals.tsx'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exportsObject = {};
const presentationSource = fs.readFileSync(path.resolve(__dirname, '../scoutbox-grassroots/src/presentation.ts'), 'utf8');
const presentation = {};
vm.runInNewContext(ts.transpileModule(presentationSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: presentation });
vm.runInNewContext(output, { exports: exportsObject, require: name => name === '../../design-system/icons' ? { Icon: () => null } : name === './presentation' ? presentation : req(name) });
const { countBy, CountChart } = exportsObject;
const render = props => renderToStaticMarkup(React.createElement(CountChart, { title: 'Queue', note: 'Loaded records only.', unit: 'records', ...props }));

test('grouped counts conserve records, including missing status', () => {
  const rows = [{state:'open'},{state:'closed'},{state:'open'},{state:null},{state:''}];
  const result = countBy(rows, r => r.state);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{label:'open',value:2},{label:'closed',value:1},{label:'Not recorded',value:2}]);
  assert.equal(result.reduce((n,r)=>n+r.value,0),rows.length);
});
test('loading and empty results are distinct and do not invent chart marks', () => {
  const loading = render({items:null});
  const empty = render({items:[]});
  assert.match(loading,/aria-busy="true"/);
  assert.match(loading,/Loading records/);
  assert.match(empty,/No records recorded yet/);
  assert.doesNotMatch(empty,/scout-chart-track/);
});
test('zero categories remain visible alongside populated categories', () => {
  const html=render({items:[{label:'GK',value:0},{label:'DEF',value:2}]});
  assert.match(html,/GK: 0 records/);
  assert.match(html,/DEF: 2 records/);
  assert.match(html,/--chart-size:0%/);
  assert.match(html,/--chart-size:100%/);
  assert.doesNotMatch(html,/NaN|Infinity/);
});
test('ring control is offered only for a declared distribution', () => {
  const items=[{label:'Open',value:2}];
  assert.doesNotMatch(render({items}),/Ring chart/);
  assert.match(render({items,distribution:true}),/Ring chart/);
});

test('presentation labels use sentence case without changing names or acronyms', () => {
  assert.equal(presentation.sentenceCase('under_review'), 'Under review');
  assert.equal(presentation.sentenceCase('UEFA licence'), 'UEFA licence');
  assert.equal(presentation.sentenceCase('Dee Mensah'), 'Dee Mensah');
  assert.equal(presentation.sentenceCase(null), 'Not recorded');
});
