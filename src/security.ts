import { realpathSync } from 'node:fs';
import path from 'node:path';

export function normalizeRepoRoot(repoRoot: string): string {
  return realpathSync(path.resolve(repoRoot));
}

export function resolveInsideRoot(root: string, inputPath: string): string {
  if (!inputPath || inputPath.includes('\0')) {
    throw new Error('invalid path');
  }

  const rootReal = normalizeRepoRoot(root);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootReal, inputPath);
  const lexicalRelative = path.relative(rootReal, candidate);
  if (lexicalRelative !== '' && (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative))) {
    throw new Error(`path resolves outside repo root: ${inputPath}`);
  }
  const resolved = realpathSync(candidate);
  const relative = path.relative(rootReal, resolved);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error(`path resolves outside repo root: ${inputPath}`);
}

const secretPatterns: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_KEY]'],
  // Stripe live and test keys use underscores. Match before any other
  // pattern so sk_live_ / sk_test_ are caught even when surrounded by quotes.
  [/sk_(?:live|test)_[A-Za-z0-9]{20,}/g, '[REDACTED_STRIPE_KEY]'],
  [/rk_(?:live|test)_[A-Za-z0-9]{20,}/g, '[REDACTED_STRIPE_KEY]'],
  [/gh[opsru]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/xox[baprs]-[A-Za-z0-9-]{20,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_ACCESS_KEY]'],
  [/AWS_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+=]{32,}/g, 'AWS_SECRET_ACCESS_KEY=[REDACTED_AWS_SECRET_ACCESS_KEY]'],
  // Google API keys (39 chars total: AIzaSy + 33 char-class).
  [/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED_GOOGLE_API_KEY]'],
  // npm tokens (npm_ + 36 alnum).
  [/npm_[A-Za-z0-9]{36}/g, '[REDACTED_NPM_TOKEN]'],
  // Bare JWTs (three base64url-ish segments separated by dots). Match
  // before the Bearer pattern so a header-less JWT is still caught.
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g, 'Bearer [REDACTED_BEARER_TOKEN]'],
  // Database connection strings with embedded credentials. Covers postgres,
  // postgresql, mysql, mongodb, mongodb+srv, redis, amqp protocols.
  [
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/g,
    '[REDACTED_DB_URL]'
  ],
  [/-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]']
];

export function redactSecrets(input: string, maxLength = 500): string {
  let output = input;
  for (const [pattern, replacement] of secretPatterns) {
    output = output.replace(pattern, replacement);
  }
  if (output.length > maxLength) {
    let snippet = output.slice(0, maxLength);
    const redactionStart = snippet.lastIndexOf('[REDACTED_');
    if (redactionStart >= 0 && !snippet.slice(redactionStart).includes(']')) {
      const redactionEnd = output.indexOf(']', redactionStart);
      if (redactionEnd >= 0) {
        snippet = output.slice(0, redactionEnd + 1);
      }
    }
    return `${snippet}...[TRUNCATED]`;
  }
  return output;
}

export function toRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(normalizeRepoRoot(repoRoot), realpathSync(absolutePath)).split(path.sep).join('/');
}
