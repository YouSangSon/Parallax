# Codex 탐색 가이드

[English](CODEX-NAVIGATION-GUIDE.md) · **한국어** · [中文](CODEX-NAVIGATION-GUIDE.zh.md)

## 시작 순서

`goal.md` → `PLAN.md` → `GATES.md` → `CONTEXT.md` → `DESIGN.md` 순서로 읽는다. 활성 계획이 가리키는 심볼과 테스트만 `rg`로 따라간다. 오래된 `.superpowers/sdd/CLAUDE_HANDOFF.md`는 기록된 SHA를 `HEAD`와 비교하기 전까지 현재 상태로 간주하지 않는다.

## 영역 소유권

- `src/indexer.ts`, `src/index_delta.ts`, `src/adapters/`: 스캔, delta, adapter, persistence 계약
- `src/store.ts`: additive SQLite schema와 migration invariant
- `src/ui*.ts`, `src/ui/`: 로컬 report workbench
- `tests/`: 결정적 correctness와 regression gate
- `bench/`: 결정적 quality bench와 advisory performance measurement
- `docs/`: 공개 EN/KO/ZH 제품·운영·검증 계약
- `PLAN.md`, `GATES.md`: 현재 순서와 증거; `IMPROVEMENT_OPPORTUNITIES.md`: 상세 backlog

## 변경 탐색

공유 함수를 수정하기 전에 모든 caller와 관련 테스트를 확인한다. 기존 계약과 helper를 우선 재사용하고, 외부 작업은 read-only로 유지하며, untracked/user-owned 파일을 보존한다. index 변경은 full-index oracle과 비교하고 ignored file, resource limit, adapter content 의미를 명시적으로 검증한다.

## Diff Packet

Review packet에는 base/head SHA, `git diff --stat`, 범위 전체 diff, exit code와 count가 포함된 명령 결과, 알려진 fallback, cleanup 증거를 넣는다. local green, commit, push, deployment 증거를 서로 분리한다.
