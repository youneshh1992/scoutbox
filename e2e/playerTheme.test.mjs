import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../scoutbox-player/node_modules/typescript/lib/typescript.js';

const script = fs.readFileSync(new URL('../design-system/player-theme/theme.js', import.meta.url), 'utf8');
const themeSource = fs.readFileSync(new URL('../scoutbox-player/src/theme.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(themeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

// Exercise both the reusable web bootstrap and the real application's provider.
// Old preferences, OS appearance and inaccessible storage must never restore light mode.
for (const saved of [null, 'light', 'dark']) for (const systemDark of [false, true]) for (const blocked of [false, true]) {
  const root = { dataset: {}, style: {}, classes: new Set(['light']), classList: { toggle(name, on) { on ? root.classes.add(name) : root.classes.delete(name); } }, setAttribute(name, value) { this[name] = value; } };
  const document = { documentElement: root, body: { style: {} } };
  const localStorage = { getItem() { if (blocked) throw Error('Blocked storage'); return saved; } };
  const window = { matchMedia: () => ({ matches: systemDark }) };
  vm.runInNewContext(script, { document, localStorage, window });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
  assert.ok(root.classes.has('dark') && !root.classes.has('light'));
  assert.equal(window.ScoutBoxTheme.getPreference(), 'dark');
  assert.equal(window.ScoutBoxTheme.set, undefined);

  for (const platform of ['web', 'ios', 'android']) {
    const exports = {};
    const react = {
      createContext: value => ({ value, Provider: 'provider' }),
      createElement: (type, props, children) => ({ type, props, children }),
      useContext: context => context.value,
      useEffect: effect => effect(),
      useMemo: factory => factory(),
    };
    vm.runInNewContext(compiled, { exports, document, localStorage, window, require(name) {
      if (name === 'react') return react;
      if (name === 'react-native') return { Platform: { OS: platform }, StyleSheet: { create: value => value } };
      throw Error(`Unexpected dependency: ${name}`);
    } });
    const rendered = exports.ThemeProvider({ children: 'content' });
    assert.equal(rendered.props.value.scheme, 'dark');
    assert.equal(rendered.props.value.colors, exports.palettes.dark);
    assert.equal(exports.useTheme().scheme, 'dark');
    assert.equal(exports.palettes.light, undefined);
    assert.equal(rendered.props.value.toggle, undefined);
    assert.equal(rendered.props.value.set, undefined);
    if (platform === 'web') {
      assert.equal(root['data-theme'], 'dark');
      assert.equal(document.body.style.backgroundColor, exports.palettes.dark.frame);
    }
  }
}
const config = JSON.parse(fs.readFileSync(new URL('../scoutbox-player/app.json', import.meta.url), 'utf8'));
assert.equal(config.expo.userInterfaceStyle, 'dark');
const rgb=h=>h.match(/\w\w/g).map(v=>parseInt(v,16)/255);
const lum=c=>c.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
for(let i=0;i<=100;i++){
  const bg=rgb('00e676').map((v,j)=>(v+(rgb('12161a')[j]-v)*i/100)*.45);
  const a=lum(bg),b=lum(rgb('ffffff'));
  assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`dark gradient contrast at ${i}%`);
}
console.log('Dark-only theme checks passed: real provider on web/iOS/Android, old preferences, OS modes, blocked storage, bootstrap, native config and contrast.');
