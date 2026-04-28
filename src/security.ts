import { realpathSync } from 'node:fs';
import path from 'node:path';

export function resolveInsideRoot(root: string, inputPath: string): string {
  if (!inputPath || inputPath.includes('\0')) {
    throw new Error('invalid path');
  }

  const rootReal = realpathSync(root);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootReal, inputPath);
  const parentReal = realpathSync(path.dirname(candidate));
  const resolved = path.join(parentReal, path.basename(candidate));
  const relative = path.relative(rootReal, resolved);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error(`path resolves outside repo root: ${inputPath}`);
}

const secretPatterns: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_KEY]'],
  [/gho_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_ACCESS_KEY]'],
  [/-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]']
];

export function redactSecrets(input: string, maxLength = 500): string {
  let output = input;
  for (const [pattern, replacement] of secretPatterns) {
    output = output.replace(pattern, replacement);
  }
  if (output.length > maxLength) {
    return `${output.slice(0, maxLength)}...[TRUNCATED]`;
  }
  return output;
}

export function toRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(realpathSync(repoRoot), realpathSync(absolutePath)).split(path.sep).join('/');
}
