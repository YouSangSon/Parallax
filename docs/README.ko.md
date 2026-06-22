# Parallax — 문서

[English](README.md) · **한국어** · [中文](README.zh.md)

Parallax는 local-first 코드 impact 분석 계층이다 — 단일 SQLite 저장소가 CLI, 코딩 에이전트용 MCP 서버, UI explorer를 구동한다. 이 인덱스는 `docs/`에 포함된 주요 packaged guide를 링크한다.

## 시작하기

| 문서 | 내용 |
| :--- | :--- |
| [`getting-started.ko.md`](getting-started.ko.md) | init, index, analyze, UI, MCP, CI guardrail까지 포함한 첫 실행 튜토리얼 |

## 개념과 방향

| 문서 | 내용 |
| :--- | :--- |
| [`vision.ko.md`](vision.ko.md) | 프로젝트 비전 |
| [`value-proposition.ko.md`](value-proposition.ko.md) | 가치 제안과 차별성 |
| [`roadmap.ko.md`](roadmap.ko.md) | 현재 backlog와 다음 슬라이스 |
| [`invariants.ko.md`](invariants.ko.md) | local-first, redaction, 권한 모델 같은 불변 원칙 |
| [`glossary.ko.md`](glossary.ko.md) | 용어집 |
| [`architecture.ko.md`](architecture.ko.md) | Runtime architecture와 확장 맵 |

## 레퍼런스

| 문서 | 내용 |
| :--- | :--- |
| [`mcp.ko.md`](mcp.ko.md) | MCP 서버, tool, resource |
| [`cli-reference.ko.md`](cli-reference.ko.md) | 모든 CLI 명령, 플래그, exit code |
| [`report-schema.ko.md`](report-schema.ko.md) | `analyze --json` 출력의 발행된 JSON Schema |
| [`extending-adapters.ko.md`](extending-adapters.ko.md) | semantic adapter 작성 |
| [`verification.ko.md`](verification.ko.md) | 검증 계층, 테스트 script, dogfood guard |
| [`operations.ko.md`](operations.ko.md) | Troubleshooting과 운영 runbook |
| [`release-checklist.ko.md`](release-checklist.ko.md) | Release, CI, audit, package smoke 체크리스트 |

## Source checkout 참고

Repository checkout에는 TypeScript source file, test, benchmark fixture, Claude Code / Codex 사용자용 Parallax skill이 `skills/` 아래에 있다. npm package는 build된 CLI, public docs, 그리고 `schemas/` 아래의 발행된 report schema를 싣지만 skill directory는 싣지 않으므로, packaged docs에서는 `skills/`로 링크하지 않는다. Architecture와 release checklist 같은 maintainer 문서는 source checkout이 필요한 경우를 본문에서 명시한다.

프로젝트 랜딩 페이지는 [루트 README](../README.ko.md)를 참고하자.
