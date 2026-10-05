// Verify the native and portal renderers ship identical complete icon geometry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const native = JSON.parse(read('scoutbox-player/src/components/scoutbox-icons.json'));
const mapping = JSON.parse(read('design-system/icon-mapping.json'));
const portalSource = read('design-system/icons.tsx');
const portal = JSON.parse(portalSource.match(/const PATHS: Record<string, string> = (\{[\s\S]*?\});/)[1]);
assert.deepEqual(Object.keys(native).sort(), Object.keys(mapping).sort());
assert.deepEqual(Object.keys(portal).sort(), Object.keys(mapping).sort());
for (const [name, paths] of Object.entries(native)) {
  assert.ok(paths.length && paths.every((d) => typeof d === 'string' && d.startsWith('M')), name);
  assert.deepEqual([...portal[name].matchAll(/d="([^"]+)"/g)].map((m) => m[1]), paths, name);
}
assert.ok(portalSource.includes('viewBox="0 0 256 256"'));
assert.ok(read('scoutbox-player/src/components/Icon.tsx').includes('viewBox="0 0 256 256"'));
assert.ok(read('design-system/PHOSPHOR-LICENSE.txt').includes('MIT'));
console.log(`Icon parity passed: ${Object.keys(mapping).length} icons, both renderers, licence and viewBox.`);
// Player uses the same named family with intentional duotone/filled variants.
const variants = JSON.parse(read('scoutbox-player/src/components/scoutbox-icon-variants.json'));
for (const name of [...Object.keys(mapping), 'soccer-ball']) {
  for (const weight of ['duotone', 'fill']) {
    assert.ok(variants[name]?.[weight]?.length, `${name}: missing ${weight}`);
    for (const path of variants[name][weight]) {
      assert.ok(path.d.startsWith('M'), `${name}: invalid geometry`);
      assert.ok(path.opacity > 0 && path.opacity <= 1, `${name}: invalid opacity`);
    }
  }
}
assert.ok(read('scoutbox-player/src/components/Icon.tsx').includes("from './scoutbox-icon-variants.json'"));
console.log(`Player variants passed: ${Object.keys(variants).length} duotone and filled icons.`);
