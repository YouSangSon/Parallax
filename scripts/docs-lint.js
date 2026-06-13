#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, posix } from 'node:path';

const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

const trackedSet = new Set(files);

const violations = [];
const report = (file, reason) => violations.push(`docs-lint: ${file}: ${reason}`);

// --- Forbidden content (local metadata / secret-like strings) ---

const forbidden = [
  /\/Users\/[^\s)]+/,
  /\.gstack/,
  /restore point/i,
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/,
  /github_pat_[A-Za-z0-9_]+/,
  /gho_[A-Za-z0-9_]+/,
  /sk-[A-Za-z0-9]{20,}/
];

function checkForbidden(file, content) {
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      report(file, `forbidden local metadata or secret-like content matched ${pattern}`);
    }
  }
}

// --- Trilingual zone helpers ---

// A tracked *.md is in the trilingual zone if it is a root README/CONTRIBUTING/SECURITY,
// lives under docs/ (excluding docs/assets/), or lives under skills/.
function inTrilingualZone(file) {
  const rootDocs = ['README', 'CONTRIBUTING', 'SECURITY'];
  for (const name of rootDocs) {
    if ([`${name}.md`, `${name}.ko.md`, `${name}.zh.md`].includes(file)) return true;
  }
  if (file.startsWith('docs/') && !file.startsWith('docs/assets/')) return true;
  if (file.startsWith('skills/')) return true;
  return false;
}

const LANG_SUFFIXES = ['.ko.md', '.zh.md'];

// Returns { base, lang } where base strips the .ko/.zh infix before .md.
// Canonical "X.md" -> { base: "X.md", lang: "" }
// "X.ko.md"        -> { base: "X.md", lang: "ko" }
function parseVariant(file) {
  for (const suffix of LANG_SUFFIXES) {
    if (file.endsWith(suffix)) {
      const lang = suffix.slice(1, 3); // "ko" | "zh"
      const base = `${file.slice(0, -suffix.length)}.md`;
      return { base, lang };
    }
  }
  return { base: file, lang: '' };
}

// For a base path "dir/X.md" returns the three sibling variant paths.
function siblingPaths(base) {
  const dir = dirname(base);
  const stem = basename(base, '.md');
  const make = (suffix) => (dir === '.' ? `${stem}${suffix}` : posix.join(dir, `${stem}${suffix}`));
  return {
    canonical: make('.md'),
    ko: make('.ko.md'),
    zh: make('.zh.md')
  };
}

// --- (a) Trilingual parity ---

function checkParity(zoneFiles) {
  for (const file of zoneFiles) {
    const { base } = parseVariant(file);
    const { canonical, ko, zh } = siblingPaths(base);
    if (!trackedSet.has(canonical)) {
      report(file, `orphan translation: canonical ${basename(canonical)} is missing`);
    }
    if (!trackedSet.has(ko)) {
      report(file, `missing trilingual variant ${basename(ko)}`);
    }
    if (!trackedSet.has(zh)) {
      report(file, `missing trilingual variant ${basename(zh)}`);
    }
  }
}

// --- Markdown link extraction ---

// Removes fenced code blocks (``` or ~~~) so that markdown link *examples*
// inside documentation are not mistaken for real navigation links. Forbidden-
// content scanning runs on the raw text separately, so secrets in code blocks
// are still caught.
function stripFencedCode(content) {
  const out = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

// Yields { isImage, target } for every markdown link, with anchors/urls handled.
function* iterLinks(rawContent) {
  const content = stripFencedCode(rawContent);
  const linkRe = /(!?)\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRe.exec(content)) !== null) {
    const isImage = match[1] === '!';
    let target = match[2].trim();
    if (!target) continue;
    if (/^https?:\/\//i.test(target)) continue;
    const hashIdx = target.indexOf('#');
    if (hashIdx >= 0) target = target.slice(0, hashIdx);
    if (!target) continue;
    yield { isImage, target };
  }
}

// --- (b) Switcher presence ---

function checkSwitcher(file, content) {
  const { base } = parseVariant(file);
  const { canonical, ko, zh } = siblingPaths(base);
  const targets = new Set();
  for (const { isImage, target } of iterLinks(content)) {
    if (isImage) continue;
    targets.add(basename(target));
  }
  // The file must link to its other two language variants (need not link to itself).
  const required = [canonical, ko, zh].filter((p) => p !== file);
  for (const sibling of required) {
    if (!targets.has(basename(sibling))) {
      report(file, `missing switcher link to ${basename(sibling)}`);
    }
  }
}

// --- (c) Same-language internal links ---

function checkSameLanguageLinks(file, content) {
  const { base: ownBase, lang } = parseVariant(file);
  if (!lang) return; // canonical files are not checked
  const fileDir = dirname(file);
  const own = siblingPaths(ownBase);
  // The file's own switcher links (English canonical + the other-language twin)
  // are always allowed; they are how a reader hops languages.
  const ownSiblings = new Set([own.canonical, own.ko, own.zh]);

  for (const { isImage, target } of iterLinks(content)) {
    if (isImage) continue;
    if (!target.endsWith('.md')) continue;

    // Resolve the target relative to the linking file's own directory.
    const resolved = posix.normalize(join(fileDir, target));
    if (ownSiblings.has(resolved)) continue;

    // The same-language variant the link *should* point to for this target.
    const { base: targetBase } = parseVariant(resolved);
    const sameLangVariant = siblingPaths(targetBase)[lang];
    // Only enforce when a same-language twin actually exists for that target.
    if (!trackedSet.has(sameLangVariant)) continue;
    // Correct already: the link points at the same-language variant.
    if (resolved === sameLangVariant) continue;
    // Otherwise it leaks to a different language (canonical or the wrong language).
    report(
      file,
      `cross-language link leak: links to ${target} but same-language ${basename(sameLangVariant)} exists`
    );
  }
}

// --- Run all checks ---

const zoneFiles = files.filter(inTrilingualZone);

checkParity(zoneFiles);

for (const file of files) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, 'utf8');
  checkForbidden(file, content);
  if (inTrilingualZone(file)) {
    checkSwitcher(file, content);
    checkSameLanguageLinks(file, content);
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(v);
  console.error(`\ndocs-lint: ${violations.length} violation(s) found`);
  process.exit(1);
}

console.log('docs-lint: OK');
