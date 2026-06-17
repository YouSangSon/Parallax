#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix, resolve as resolveFsPath } from 'node:path';
import { pathToFileURL } from 'node:url';

function gitFiles(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

let trackedSet = new Set();
let untrackedSet = new Set();
let markdownSet = new Set();

const violations = [];
const report = (file, reason) => violations.push(`docs-lint: ${file}: ${reason}`);

// --- Forbidden content (local metadata / secret-like strings) ---

const forbidden = [
  { label: 'local machine path', pattern: /\/Users\/[^\s)]+/ },
  { label: 'local .gstack metadata', pattern: /\.gstack/ },
  { label: 'restore-point metadata', pattern: /restore point/i },
  { label: 'OpenAI API key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { label: 'Stripe key', pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { label: 'GitHub gh token', pattern: /gh[opsru]_[A-Za-z0-9_]+/ },
  { label: 'GitHub fine-grained PAT', pattern: /github_pat_[A-Za-z0-9_]+/ },
  { label: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { label: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  {
    label: 'AWS secret access key assignment',
    pattern: /AWS_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+=]{32,}/
  },
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { label: 'npm token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { label: 'JWT', pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { label: 'Bearer token', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/ },
  {
    label: 'database URL with credentials',
    pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/
  },
  {
    label: 'private key',
    pattern: /BEGIN (?:(?:RSA|OPENSSH|EC|DSA) )?PRIVATE KEY|BEGIN (?:RSA|OPENSSH) KEY/
  }
];

function checkForbidden(file, content) {
  for (const { label, pattern } of forbidden) {
    if (pattern.test(content)) {
      report(file, `forbidden local metadata or secret-like content: ${label}`);
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

function isRootReadmeVariant(file) {
  return ['README.md', 'README.ko.md', 'README.zh.md'].includes(file);
}

function isPackageVisibleMarkdown(file) {
  return isRootReadmeVariant(file) || (file.startsWith('docs/') && !file.startsWith('docs/assets/'));
}

function isPackageSurfaceMarkdownTarget(file) {
  return isRootReadmeVariant(file) || (file.startsWith('docs/') && !file.startsWith('docs/assets/'));
}

const LANG_SUFFIXES = ['.ko.md', '.zh.md'];

function normalizeRepoPath(repoPath) {
  return repoPath.replace(/\\/g, '/');
}

// Returns { base, lang } where base strips the .ko/.zh infix before .md.
// Canonical "X.md" -> { base: "X.md", lang: "" }
// "X.ko.md"        -> { base: "X.md", lang: "ko" }
export function parseVariant(file) {
  file = normalizeRepoPath(file);
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
export function siblingPaths(base) {
  base = normalizeRepoPath(base);
  const dir = posix.dirname(base);
  const stem = posix.basename(base, '.md');
  const make = (suffix) => (dir === '.' ? `${stem}${suffix}` : posix.join(dir, `${stem}${suffix}`));
  return {
    canonical: make('.md'),
    ko: make('.ko.md'),
    zh: make('.zh.md')
  };
}

// --- (a) Trilingual parity ---

function checkRequiredTrackedVariant(file, variantPath, missingReason) {
  if (trackedSet.has(variantPath)) return;
  const variantName = posix.basename(variantPath);
  if (untrackedSet.has(variantPath)) {
    report(file, `trilingual variant ${variantName} exists only as untracked and must be staged/tracked`);
    return;
  }
  report(file, missingReason);
}

function checkParity(zoneFiles) {
  for (const file of zoneFiles) {
    const { base } = parseVariant(file);
    const { canonical, ko, zh } = siblingPaths(base);
    checkRequiredTrackedVariant(file, canonical, `orphan translation: canonical ${posix.basename(canonical)} is missing`);
    checkRequiredTrackedVariant(file, ko, `missing trilingual variant ${posix.basename(ko)}`);
    checkRequiredTrackedVariant(file, zh, `missing trilingual variant ${posix.basename(zh)}`);
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
    targets.add(posix.basename(target));
  }
  // The file must link to its other two language variants (need not link to itself).
  const required = [canonical, ko, zh].filter((p) => p !== file);
  for (const sibling of required) {
    if (!targets.has(posix.basename(sibling))) {
      report(file, `missing switcher link to ${posix.basename(sibling)}`);
    }
  }
}

// --- (c) Same-language internal links ---

export function resolveRepoMarkdownTarget(file, target) {
  file = normalizeRepoPath(file);
  target = normalizeRepoPath(target);
  return posix.normalize(posix.join(posix.dirname(file), target));
}

function checkSameLanguageLinks(file, content) {
  const { base: ownBase, lang } = parseVariant(file);
  if (!lang) return; // canonical files are not checked
  const own = siblingPaths(ownBase);
  // The file's own switcher links (English canonical + the other-language twin)
  // are always allowed; they are how a reader hops languages.
  const ownSiblings = new Set([own.canonical, own.ko, own.zh]);

  for (const { isImage, target } of iterLinks(content)) {
    if (isImage) continue;
    if (!target.endsWith('.md')) continue;

    // Resolve the target relative to the linking file's own directory.
    const resolved = resolveRepoMarkdownTarget(file, target);
    if (ownSiblings.has(resolved)) continue;

    // The same-language variant the link *should* point to for this target.
    const { base: targetBase } = parseVariant(resolved);
    const sameLangVariant = siblingPaths(targetBase)[lang];
    // Only enforce when a same-language twin actually exists for that target.
    if (!markdownSet.has(sameLangVariant)) continue;
    // Correct already: the link points at the same-language variant.
    if (resolved === sameLangVariant) continue;
    // Otherwise it leaks to a different language (canonical or the wrong language).
    report(
      file,
      `cross-language link leak: links to ${target} but same-language ${posix.basename(sameLangVariant)} exists`
    );
  }
}

function checkMarkdownLinkTargets(file, content) {
  for (const { isImage, target } of iterLinks(content)) {
    if (isImage) continue;
    if (!target.endsWith('.md')) continue;

    const resolved = resolveRepoMarkdownTarget(file, target);
    if (!markdownSet.has(resolved) && !existsSync(resolved)) {
      report(file, `missing markdown link target ${target}`);
    }
  }
}

function checkPackageSurfaceLinks(file, content) {
  if (!isPackageVisibleMarkdown(file)) return;
  for (const { isImage, target } of iterLinks(content)) {
    if (isImage) continue;
    if (!target.endsWith('.md')) continue;
    const resolved = resolveRepoMarkdownTarget(file, target);
    if (!isPackageSurfaceMarkdownTarget(resolved)) {
      report(file, `package-visible Markdown links to unpackaged target ${target}`);
    }
  }
}

// --- Run all checks ---

function loadMarkdownFileSets() {
  const trackedFiles = gitFiles(['ls-files', '*.md']);
  const untrackedFiles = gitFiles(['ls-files', '--others', '--exclude-standard', '*.md']);
  const files = [...new Set([...trackedFiles, ...untrackedFiles])];
  return {
    files,
    trackedFiles,
    untrackedFiles
  };
}

function run() {
  const { files, trackedFiles, untrackedFiles } = loadMarkdownFileSets();
  trackedSet = new Set(trackedFiles);
  untrackedSet = new Set(untrackedFiles);
  markdownSet = new Set(files);
  violations.length = 0;

  const trackedZoneFiles = trackedFiles.filter(inTrilingualZone);

  checkParity(trackedZoneFiles);

  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    checkForbidden(file, content);
    checkMarkdownLinkTargets(file, content);
    checkPackageSurfaceLinks(file, content);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolveFsPath(process.argv[1])).href) {
  run();
}
