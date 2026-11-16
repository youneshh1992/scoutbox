// The batteries are the server's behavioural specification, so they must not depend on its implementation: a file
// under e2e/ may import only Node and other files under e2e/, and may start the server only through
// support/server.mjs. `boundaryProblems(text)` lists the lines that reach outside: an import or path climbing two
// levels (out of e2e/<domain>/), or a mention of server.mjs.
//
// Pure, with no imports, so any repository that copies the batteries can run the same check.

const OUTSIDE = [
  { why: 'imports from outside e2e/', re: /(?:\bfrom\s*|\bimport\s*\(\s*)['"`]\.\.\/\.\.\// },
  { why: 'names a path outside e2e/', re: /['"`]\.\.\/\.\.(?:['"`]|\/)/ },
  { why: 'builds a path outside e2e/', re: /['"`]\.\.['"`]\s*,\s*['"`]\.\.['"`]/ },
  { why: 'starts the server itself (use support/server.mjs)', re: /\bserver\.mjs\b/ },
];

/** `[{ line, why, text }]` for every line of `text` that reaches outside e2e/. */
export function boundaryProblems(text) {
  const out = [];
  String(text)
    .split('\n')
    .forEach((line, i) => {
      for (const { why, re } of OUTSIDE) if (re.test(line)) out.push({ line: i + 1, why, text: line.trim() });
    });
  return out;
}

/** The files (relative to e2e/) the check doesn't apply to: the launcher, which a port replaces, and this file. */
export const EXEMPT = ['support/server.mjs', 'support/boundary.mjs'];
