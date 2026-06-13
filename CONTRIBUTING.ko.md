# Contributing to Parallax

[English](CONTRIBUTING.md) · **한국어** · [中文](CONTRIBUTING.zh.md)

기여를 환영합니다. Parallax는 에이전트 코딩 도구가 코드를 바꾸기 전에
영향 범위와 테스트 후보를 더 정확히 볼 수 있게 만드는 local-first 도구입니다.

## 개발 환경

필요한 것:

- Node.js `>=24.0.0`
- npm

시작:

```bash
npm install
npm run build
npm test
```

## 작업 방식

변경 전에는 이 범위를 먼저 확인해 주세요.

- MVP는 `init`, `index`, `analyze`, read-only MCP에 집중합니다.
- Obsidian write sync, graph DB, CodeQL adapter는 아직 deferred scope입니다.
- MCP write tool은 기본으로 추가하지 않습니다.
- file input은 repo root containment check를 거쳐야 합니다.
- evidence는 저장 또는 출력 전에 redaction되어야 합니다.

## Pull Request 체크리스트

PR을 올리기 전에 아래 명령을 실행해 주세요.

```bash
npm run lint
npm test
npm run test:security
npm run test:mcp
npm run test:install-smoke
npm audit --audit-level=high
```

문서만 바꾼 경우에도 최소한 아래는 실행해 주세요.

```bash
npm run docs:lint
```

## 테스트 원칙

- 새 기능은 테스트를 먼저 추가합니다.
- security boundary를 바꾸면 `tests/security.test.ts`에 회귀 테스트를 추가합니다.
- MCP surface를 바꾸면 `tests/mcp.test.ts`에 contract test를 추가합니다.
- impact 분석 결과를 바꾸면 fixture 기반 테스트를 추가합니다.

## 커밋 메시지

권장 형식:

```text
feat: add diff parser
fix: reject symlink escapes
docs: update MCP usage
test: cover redaction edge cases
```

