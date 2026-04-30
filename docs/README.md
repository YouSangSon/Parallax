# Impact-Trace 문서 인덱스

> *Updated 2026-04-30, end-of-Phase-4 + supermemory selective adoption*

이 폴더에는 18개 문서가 있습니다. *어떤 문서를 언제 읽을지* 한눈에 정리한 navigation guide입니다.

---

## 5분 안에 시작하고 싶다

1. [`/README.md`](../README.md) (root) — 프로젝트 개요, CLI/MCP 사용 예시
2. [`agent-memory-cookbook.ko.md`](agent-memory-cookbook.ko.md) — 5분 시작 가이드 + agent memory 패턴 (B/C 섹션)
3. [`/skills/impact-trace/SKILL.md`](../skills/impact-trace/SKILL.md) — Claude Code 사용자용 스킬 매니페스트

---

## 깊이 있게 시스템 이해하고 싶다

설계와 결정의 *왜*가 궁금할 때:

- [`decisions.ko.md`](decisions.ko.md) — **누적 ADR 로그 (D-001..D-014)**. 모든 굳어진 결정과 거부된 대안 + 관련 commit. 가장 먼저 읽으면 좋은 *single source of truth*.
- [`agent-db-exploration.ko.md`](agent-db-exploration.ko.md) — agent memory 레이어 도입 시 큰 그림 + ER 다이어그램 + 의도된 trade-off.
- [`indexing-model.ko.md`](indexing-model.ko.md) — 코드 인덱서 모델 (entities/relations/evidence) + 회사 업무 artifact 확장.
- [`/skills/impact-trace/references/architecture.md`](../skills/impact-trace/references/architecture.md) — **깊은 architecture reference**. schema versions, recall paths, reflection pipeline, branch GC, redaction gates, LLM provider abstraction. 코드 확장 시 *어디부터 볼지* 가이드 포함.

---

## Phase별 설계 문서 (시간순)

각 Phase는 *설계 문서 → 핸드오프 → 다음 Phase 핸드오프* 순서로 묶임.

### Phase 1+2 (2026-04-28 ~ 04-29 초)

`agent-db-exploration.ko.md`가 사실상 Phase 1 설계 노트 역할. Phase 2는 Phase 3 핸드오프에서 회고로 정리됨 (별도 design doc 없음 — *작은 incremental 작업*이라 정당화).

### Phase 3 — Reflective Consolidation + Speculative Branch GC

- 📐 [`phase3-design.ko.md`](phase3-design.ko.md) — *현행 design doc 패턴의 정본*. CEO/Eng dual-voice consensus, DX scorecard, failure modes registry, 4 design decisions D-013..D-016, NOT-in-scope.
- 🤝 [`phase3-handoff.ko.md`](phase3-handoff.ko.md) — Phase 3 시작 시 *fresh-session pickup* 핸드오프 (참고용; 작업은 끝남)

### Phase 4 — Scaling cap + supermemory adoption

- 🤝 [`phase4-handoff.ko.md`](phase4-handoff.ko.md) — *현재 next-session 진입점*. 9개 후보 ranked priority, D-013..D-016 설계 결정.
- 🧪 [`supermemory-adoption.ko.md`](supermemory-adoption.ko.md) — supermemoryai/supermemory에서 *어떤 것을 채택하고 어떤 것을 거부했는지* 4-perspective 평가. P1/P4 거부 근거가 ADR D-002/D-005/D-010 인용.

---

## 진행 추적

- 📈 [`progress.ko.md`](progress.ko.md) — *날짜별 chronological log*. "어제까지 무엇이 됐고 다음에 뭘 할지" 한 페이지에 다 있음.
- 📜 [`/CHANGELOG.md`](../CHANGELOG.md) (root) — Phase별 *highlights* 한눈에 (사용자 관점).

두 문서의 차이:
- `progress.ko.md` — 개발자 관점, 매 작업 단위로 누적 (작업 로그)
- `CHANGELOG.md` — 사용자 관점, Phase별 한 묶음 (release notes)

---

## 사용법 cookbook

- 📖 [`agent-memory-cookbook.ko.md`](agent-memory-cookbook.ko.md) — 사용 예시 모음. 섹션 A는 빠른 시작, B는 패턴, C는 Phase 3+4 명령 (reflect / abandon / gc-branches / profile).

---

## 영문 자료

| 문서 | 영문 페어 |
|---|---|
| `impact-trace-plan.ko.md` | [`impact-trace-plan.en.md`](impact-trace-plan.en.md) |
| `impact-trace-test-plan.ko.md` | [`impact-trace-test-plan.en.md`](impact-trace-test-plan.en.md) |
| `indexing-model.ko.md` | [`indexing-model.en.md`](indexing-model.en.md) |

Phase 3+4 신규 문서 (`phase3-design`, `phase3-handoff`, `phase4-handoff`, `decisions`, `agent-db-exploration`, `agent-memory-cookbook`, `supermemory-adoption`) 는 *현재 한국어 우선*. 영문 페어가 필요하면 follow-up. `/skills/impact-trace/SKILL.md`와 `references/architecture.md`는 영문 (Claude Code skill 표준).

---

## 작업별 fast lookup

| 무엇을 하려고 하나? | 우선 읽을 것 |
|---|---|
| 처음 사용해본다 | `/README.md` → `agent-memory-cookbook.ko.md` 섹션 A |
| 다음 Phase 시작 | `phase4-handoff.ko.md` (영구적, frozen) |
| 결정의 *왜*가 궁금하다 | `decisions.ko.md` |
| 코드 확장한다 | `/skills/impact-trace/references/architecture.md` 마지막 섹션 |
| 보안/redaction 흐름 이해 | `decisions.ko.md` D-004 + `architecture.md` redact 섹션 |
| 신규 reflection 시도 | `agent-memory-cookbook.ko.md` 섹션 C.1 |
| 새 패턴 채택 결정 | `supermemory-adoption.ko.md` (4-agent review consensus 패턴) |
| 진행 상황 보고 | `progress.ko.md` |
| 사용자 관점 changelog | `/CHANGELOG.md` |

---

## 문서 작성 컨벤션

새 문서를 추가할 때:

1. **언어:** 한국어 우선 (`.ko.md`). 영문 페어 (`.en.md`)는 follow-up. *Skill 패키징은 예외* — 영문 (Claude Code skill 표준).
2. **헤더:** 첫 줄에 `# 제목`, 다음 blockquote에 *상태/일자/선행 문서 링크*.
3. **Phase doc 패턴:** `phase3-design.ko.md`을 정본으로 따른다 — 0(요약) / 1(문제) / 2(결정) / 3(설계) / 8(self-review) / 9(test) / 11(failure modes) / 12(commit 분할) / 13(NOT in scope) / 15(다음 단계).
4. **결정 캡처:** 새 ADR은 *반드시* `decisions.ko.md`에 D-NNN으로 추가. commit 메시지 첫 줄에 `decisions: D-NNN <slug>` 포함하면 grep 가능.
5. **인덱스 갱신:** 본 문서(`docs/README.md`)와 root `README.md`의 Documentation 섹션 갱신.

---

**문서 갯수가 18개 → 20개로 늘면 본 인덱스를 그룹별 sub-index로 분할 검토. 현재 규모는 single page로 충분.**
