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

// Strip favicon links (the artifact host provides its own) and preloads.
html = html.replace(/<link[^>]*rel="(icon|shortcut icon|modulepreload|preload)"[^>]*>/g, '');

fs.writeFileSync(outFile, html);
console.log(outFile, Math.round(fs.statSync(outFile).size / 1024) + 'KB');
