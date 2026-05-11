# Impact-Trace 문서 인덱스

> *Updated 2026-05-11, UI Explorer v0, TS/JS/JVM/Spring/Python/Go/Rust spans, OpenAPI contract impact baseline, workspace catalog v0, cross-repo contract resolver v0, OpenAPI contract diff v0, and MCP workspace/contract resources v0 documented*

이 폴더에는 15개 문서가 있습니다. 현재 작업과 온보딩에 필요한 문서만 남깁니다.

---

## 가장 먼저 읽을 한 페이지

- 🌟 [`vision.ko.md`](vision.ko.md) / [`vision.md`](vision.md) — **이 프로젝트가 무엇이고, 누구를 위하고, 어디로 가는지**. 새 contributor / agent의 5분 시작점.
- 🧭 [`impact-context-layer-plan.ko.md`](impact-context-layer-plan.ko.md) — **MCP + UI + context 절감 + 코드/문서/정책/제안서 impact**를 하나의 제품 계획으로 정리한 기준 문서.
- 🔎 [`agentmemory-adoption-review.ko.md`](agentmemory-adoption-review.ko.md) — `rohitg00/agentmemory`를 분석해 **가져올 retrieval/lifecycle 패턴과 거부할 platform surface**를 정리한 적용 경계 문서.
- 🗺️ [`roadmap.md`](roadmap.md) — *두 축* (영향 분석 + agent memory) 통합 로드맵. 다음 작업이 뭔지 한 페이지로.
- 📚 [`glossary.md`](glossary.md) — branch (git vs memory), entity (impact vs memory) 같은 *겹치는 어휘* disambiguate.

---

## 5분 안에 시작하고 싶다

1. [`/README.md`](../README.md) (root) — 프로젝트 개요, CLI/MCP 사용 예시
2. [`agent-memory-cookbook.ko.md`](agent-memory-cookbook.ko.md) — 5분 시작 가이드 + agent memory 패턴 (B/C 섹션)
3. [`/skills/impact-trace/SKILL.md`](../skills/impact-trace/SKILL.md) — Claude Code 사용자용 스킬 매니페스트

---

## 깊이 있게 시스템 이해하고 싶다

설계와 결정의 *왜*가 궁금할 때:

- [`decisions.ko.md`](decisions.ko.md) — **누적 ADR 로그 (D-001..D-029)**. 모든 굳어진 결정과 거부된 대안 + 관련 commit. 가장 먼저 읽으면 좋은 *single source of truth*.
- [`impact-context-layer-plan.ko.md`](impact-context-layer-plan.ko.md) — Claude/Codex MCP context layer, local UI explorer, AI context budget 절감, 정책/제안서 impact까지 포함한 제품 계획.
- [`indexing-model.ko.md`](indexing-model.ko.md) — 코드 인덱서 모델 (entities/relations/evidence) + 회사 업무 artifact 확장.
- [`/skills/impact-trace/references/architecture.md`](../skills/impact-trace/references/architecture.md) — **깊은 architecture reference**. schema versions, recall paths, reflection pipeline, branch GC, redaction gates, LLM provider abstraction, sqlite-vec ANN. 코드 확장 시 *어디부터 볼지* 가이드 포함.

---

## 현재 설계 문서

최근/활성 설계 문서:

- 📐 [`phase6-design.ko.md`](phase6-design.ko.md) — `main`에 들어온 adapter interface/registry, regex adapter extraction, multi-adapter run attribution, adapter evidence/diagnostics observability, content-sensitive symbol hashes, relation-kind attribute mapping 기록.
- 📐 [`phase6b-ts-accuracy-plan.ko.md`](phase6b-ts-accuracy-plan.ko.md) — **현재 next work 진입점**. Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS adapter pack v0 routing, ImpactBench fixture, TS/JS parser-backed import span v0, JVM/Spring lightweight evidence span v0, Python/Go/Rust lightweight evidence span v0, OpenAPI contract impact baseline, workspace catalog v0, cross-repo contract resolver v0, OpenAPI endpoint/schema diff v0, MCP workspace/contract resources v0와 남은 nested/protobuf/GraphQL/AsyncAPI diff 계획.

---

## 진행 추적

- 📈 [`progress.ko.md`](progress.ko.md) — *날짜별 chronological log*. "어제까지 무엇이 됐고 다음에 뭘 할지" 한 페이지에 다 있음.
- 📜 [`/CHANGELOG.md`](../CHANGELOG.md) (root) — Phase별 *highlights* 한눈에 (사용자 관점).

두 문서의 차이:
- `progress.ko.md` — 개발자 관점, 매 작업 단위로 누적 (작업 로그)
- `CHANGELOG.md` — 사용자 관점, Phase별 한 묶음 (release notes)

---

## 사용법 cookbook

- 📖 [`agent-memory-cookbook.ko.md`](agent-memory-cookbook.ko.md) — 사용 예시 모음. 섹션 A는 빠른 시작, B는 패턴, C는 Phase 3+4 명령 (reflect / abandon / gc-branches / profile / repair / restore / reindex-vec).

---

## 영문 자료

- [`vision.md`](vision.md) — 외부 독자를 위한 짧은 영문 비전.

새 영문 문서가 필요하면 현재 한국어 원본에서 다시 생성합니다.

---

## 작업별 fast lookup

| 무엇을 하려고 하나? | 우선 읽을 것 |
|---|---|
| **이 프로젝트가 뭔지 5분 안에** | `vision.ko.md` → `impact-context-layer-plan.ko.md` |
| **AI context를 줄이는 제품 방향** | `impact-context-layer-plan.ko.md` |
| **agentmemory에서 무엇을 가져올지** | `agentmemory-adoption-review.ko.md` |
| **다음 작업이 뭔지** | `roadmap.md` → `phase6-design.ko.md` |
| **두 축의 어휘 헷갈림** | `glossary.md` |
| 처음 사용해본다 | `/README.md` → `agent-memory-cookbook.ko.md` 섹션 A |
| 현재 Phase 진행 (Phase 6B) | `phase6b-ts-accuracy-plan.ko.md` → `phase6-design.ko.md` |
| 결정의 *왜*가 궁금하다 | `decisions.ko.md` |
| 코드 확장한다 | `/skills/impact-trace/references/architecture.md` 마지막 섹션 |
| 보안/redaction 흐름 이해 | `decisions.ko.md` D-004 + `architecture.md` redact 섹션 |
| 신규 reflection 시도 | `agent-memory-cookbook.ko.md` 섹션 C.1 |
| 진행 상황 보고 | `progress.ko.md` |
| 사용자 관점 changelog | `/CHANGELOG.md` |

---

## 문서 작성 컨벤션

새 문서를 추가할 때:

1. **언어:** 한국어 우선 (`.ko.md`). 영문 페어 (`.en.md`)는 follow-up. *Skill 패키징은 예외* — 영문 (Claude Code skill 표준). *Vision은 양쪽 모두 first-class*.
2. **헤더:** 첫 줄에 `# 제목`, 다음 blockquote에 *상태/일자/선행 문서 링크*.
3. **제품/Phase doc 패턴:** `impact-context-layer-plan.ko.md`와 `phase6b-ts-accuracy-plan.ko.md`처럼 목표, 범위, data/MCP/UI 계약, test gate, commit plan을 같이 적는다.
4. **결정 캡처:** 새 ADR은 *반드시* `decisions.ko.md`에 D-NNN으로 추가. commit 메시지 첫 줄에 `decisions: D-NNN <slug>` 포함하면 grep 가능.
5. **인덱스 갱신:** 본 문서(`docs/README.md`), root `README.md`의 Documentation 섹션, `roadmap.md` 갱신.

---

**문서 갯수가 35+로 늘면 본 인덱스를 그룹별 sub-index로 분할 검토. 현재 규모는 single page로 충분.**
