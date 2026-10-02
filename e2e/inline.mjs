// Inline all local JS/CSS of a built index.html into one self-contained file
// (the artifact/demo distribution format). Usage: node inline.mjs <dist> <out>
import fs from 'node:fs';
import path from 'node:path';

const [, , distDir, outFile] = process.argv;
let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

const esc = (js) => js.replaceAll('</script', '<\\/script');

html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (m, href) => {
  const css = fs.readFileSync(path.join(distDir, href.replace(/^\//, '')), 'utf8');
  return `<style>${css}</style>`;
});

html = html.replace(/<script([^>]*)src="([^"]+)"([^>]*)><\/script>/g, (m, pre, src, post) => {
  const js = fs.readFileSync(path.join(distDir, src.replace(/^\//, '')), 'utf8');
  const isModule = /type="module"/.test(pre + post);
  return `<script${isModule ? ' type="module"' : ''}>${esc(js)}</script>`;
});

// M24A — bundled fonts. The Player export refers to its Albert Sans faces by
// asset path; a single-file demo has no /assets beside it, so each referenced
// font becomes a data: URI inside the bundle (the portals inline theirs at
// build time through Vite's assetsInlineLimit).
html = html.replace(/"(\/?assets\/[^"]+\.(ttf|woff2|otf))"/g, (m, ref, ext) => {
  const file = path.join(distDir, ref.replace(/^\//, ''));
  if (!fs.existsSync(file)) return m;
  const mime = ext === 'woff2' ? 'font/woff2' : ext === 'otf' ? 'font/otf' : 'font/ttf';
  return `"data:${mime};base64,${fs.readFileSync(file).toString('base64')}"`;
});

// M24E — the Inter variable faces (880 / 910 KB) are above Vite's inline
// limit, so the portal CSS refers to them as url(/assets/Inter-…ttf) (unquoted);
// the same data: URI treatment applies to those references.
html = html.replace(/url\((["']?)(\/?assets\/[^)"']+\.(ttf|woff2|otf))\1\)/g, (m, q, ref, ext) => {
  const file = path.join(distDir, ref.replace(/^\//, ''));
  if (!fs.existsSync(file)) return m;
  const mime = ext === 'woff2' ? 'font/woff2' : ext === 'otf' ? 'font/otf' : 'font/ttf';
  return `url("data:${mime};base64,${fs.readFileSync(file).toString('base64')}")`;
});

// Strip favicon links (the artifact host provides its own) and preloads.
html = html.replace(/<link[^>]*rel="(icon|shortcut icon|modulepreload|preload)"[^>]*>/g, '');

fs.writeFileSync(outFile, html);
console.log(outFile, Math.round(fs.statSync(outFile).size / 1024) + 'KB');
