# Phase 6 — Adapter Foundations + Multi-language/Spring Boot Trusted Evidence Lane

> **목적:** Phase 1~4(agent-memory 축)가 완료된 시점에서, 원래 P0/P1 (Entity Graph Core, "code graph project") 중 미수입 adapter foundation과 trusted evidence 레인을 닫는다. 본 phase는 **adapter foundations + multi-language/Spring Boot trusted evidence + workspace catalog + evidence 정밀도**의 기반에 집중.
> **작성:** 2026-05-03 (사전 design doc), 2026-05-04 branch 진행 상태 반영, 2026-05-09 main 반영 상태 정리, 2026-05-11 Phase 6B 진행 상태 반영, 2026-05-12 Protobuf/GraphQL/AsyncAPI contract diff와 consumer resolver 반영
> **상태:** foundation subset은 `main`에 반영됨 (`3cba0a2`). Phase 6B에서는 multi-language/Spring/Python/Go/Rust/TS/JS spans, OpenAPI contract baseline, workspace catalog v0, cross-repo contract resolver v0, GraphQL/Protobuf/AsyncAPI consumer resolver v0, generated-client/event topology v0, contract diff topology provenance, contract topology surface v0, OpenAPI endpoint/nested schema diff v0, Protobuf contract diff v0, GraphQL contract diff v0, AsyncAPI contract diff v0, build-system/package resolver v0, MCP workspace/contract resources v0가 landed. 다음 slice는 full parser/LSP depth와 deeper package/build resolver다.
> **참고:** [decisions.ko.md](decisions.ko.md) (D-001..D-041) · [impact-trace-plan.ko.md](impact-trace-plan.ko.md) (원래 P0/P1 ledger) · [roadmap.md](roadmap.md) (A1/A5 row) · [progress.ko.md](progress.ko.md).

---

## 0. 컨텍스트

원래 plan(`impact-trace-plan.ko.md`)의 P0/P1 "Entity Graph Core" 중 main에 ship된 부분:

- ✅ `entities` / `relations` / `relation_evidence` / `adapter_runs` / `index_coverage` 정규 스키마 (`src/store.ts:187-242`)
- ✅ Multi-hop bounded traversal + cycle protection (`src/analyzer.ts:189-257`)
- ✅ Mermaid/DOT/JSON graph export (`src/graph.ts:81-118`)
- ✅ MCP report/graph/entity 리소스 (`src/mcp.ts:392-464`)
- ✅ 정규 테이블의 attribute 4종 (`imports` / `calls` / `affects` / `depends_on`) 일부 dual-write

`main`에 반영된 foundation subset:

- 🟡 Pluggable adapter interface + priority registry + `MultiLanguageRegexAdapter` extraction
- 🟡 Per-adapter `adapter_runs`, adapter-specific coverage attribution, relation `adapter_run_id`
- 🟡 Adapter failure semantics: earlier completed runs preserved, later unstarted adapters marked skipped
- 🟡 Adapter-provided relation evidence preservation + stable redacted evidence IDs + fanout dedupe for multi-evidence joins
- 🟡 Adapter diagnostics stored in coverage diagnostic rows and `adapter_runs.error_summary`, including failure preservation
- 🟡 Symbol `entity_versions.content_hash` includes containing file content hash
- 🟡 Explicit relation-kind → memory attribute mapping and static relation `attribute_defs.is_code_relation = 1` seed/promote
- 🟡 Package public exports fence

Phase 6/6B에서 반영됨:

- ✅ Multi-language + Spring Boot adapter pack v0
- ✅ Persisted source span (file:line:col + range) on `relation_evidence` and report/MCP output
- ✅ Commit SHA / dirty state on `index_runs` — snapshot-safe indexing warning 구현
- ✅ Workspace catalog v0 — `.impact-trace/workspace.json` local allowlist + `workspace init/add-repo/list` writer
- ✅ GraphQL/Protobuf/AsyncAPI consumer resolver v0 — operation document, RPC call, event address literal과 provider contract endpoint link 저장
- ✅ generated-client/event topology v0 — Connect-ES style generated client call, full Protobuf route string, common event producer/consumer call-site topology hint 저장
- ✅ contract diff topology provenance — resolved event topology hint를 impacted consumer와 breaking link provenance까지 보존
- ✅ contract topology surface v0 — topology summary, CLI human output, MCP cross-repo link top-level hint 노출
- ✅ OpenAPI contract diff v0 — latest indexed endpoint surface와 current contract file 비교, known consumer breaking link 저장
- ✅ Protobuf contract diff v0 — compact service/RPC/message field signature로 removed RPC와 response field breaking change 분류
- ✅ GraphQL contract diff v0 — compact root operation/object/input signature로 removed root field와 schema field breaking change 분류
- ✅ AsyncAPI contract diff v0 — compact operation/channel/message payload signature로 removed operation과 message payload breaking change 분류

미수입 (Phase 6 scope **외** — Phase 7 이후):

- Phase 7: richer generated-client/event topology resolver와 full parser/LSP depth
- Phase 8: deep language adapters beyond v0, .NET/native, LSP/CodeQL enrichment
- Phase 9: work-artifacts (Markdown vault → external connectors)
- DROP (이유: D-001/local-first 위반 또는 demand 부재): 별도 graph DB · web explorer · supermemory `fact_provenance.kind` 확장 · Notion/Gmail 커넥터

---

## 1. Scope (Phase 6에 포함)

| ID | 항목 | 약속 위치 | 효과 |
|---|---|---|---|
| **6.1** | Pluggable adapter interface + registry | `impact-trace-plan.ko.md` P1 전제 | 🟡 branch 구현됨 — Phase 6/7/8 모든 adapter 작업의 토대 |
| **6.2** | Multi-language + Spring Boot adapter pack v0 | `phase6b-ts-accuracy-plan.ko.md` | Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS의 선언/import/test relation과 Spring Boot endpoint/config/persistence/client relation을 source span과 함께 추출 |
| **6.3** | Source span on `relation_evidence` | `progress.ko.md:124` item #9 | line/col + range — agent가 evidence를 코드 위치로 직접 점프 |
| **6.4** | Commit SHA + dirty state on `index_runs` | `progress.ko.md:79` | stale index 경고 정밀화 (현재는 mtime heuristic) |
| **6.5** | relation-kind ↔ attribute mapping 완성 | `src/indexer.ts` | 🟡 branch 구현됨 — recall/profile에서 의미 정보 보존 |
| **6.6** | Workspace catalog loader (`workspace init`, writer) | `impact-trace-plan.ko.md:444` | Phase 7 cross-repo resolver의 prerequisite |
| **6.7** | regex-MVP를 `MultiLanguageRegexAdapter`로 추출 | 6.1 종속 | 🟡 branch 구현됨 — backward-compat 유지 + adapter pattern 검증 |

**6.1이 모든 다른 항목의 prerequisite.** 6.7은 6.1 직후 단일 PR로 진행 (regression 0 보장).

---

## 2. 결정 공간

### D-019: Adapter Interface 모양 *(landed; see decisions.ko.md D-019..D-021 for later context-resource ADR numbering)*

| ID | 후보 | 시그니처 핵심 | 적합 |
|---|---|---|---|
| **A** | minimal sync | `extract(file, ctx) → ExtractedFile` (sync) | 현재 코드 1:1 매핑, 마이그레이션 risk 최저 |
| **B** | capability-typed async | A + `capabilities: AdapterCapability[]` + `Promise<ExtractedFile>` | LSP/CodeQL/CompilerAPI(`ts.createProgram`)이 자연스럽게 들어옴, agent surface(P3)가 capabilities 노출 가능 |
| **C** | streaming events | `process(file, ctx) → AsyncIterable<IndexEvent>` | huge file/LSP push 친화, but transactional batching 복잡 |

**초기 Planner 추천:** **B**. 이유: compiler-backed adapter는 동기 구현도 가능하지만, Phase 8의 LSP/CodeQL은 비동기 외부 프로세스가 필수 — 인터페이스가 sync이면 그 시점에 깨야 함. capabilities는 약 1줄 추가지만 P3 agent surface에서 "이 adapter는 imports/exports만 안다"를 노출 가능. 스트리밍은 YAGNI.

**최종 결정(2026-05-03): C with 2 refinements.** §6의 "Decided" 블록 참고. 이 branch는 해당 형태를 구현했고 이후 `decisions.ko.md`는 D-037까지 승격된 결정을 보유한다.

**대안 시그니처 후보 (5–10줄, 사용자 picks):** §6 참조.

### D-020: Adapter Run 단위

| ID | 후보 | 채택 후보 | 이유 |
|---|---|---|---|
| (a) | per-language adapter row in `adapter_runs` | ✅ default | 이미 `adapter_runs.language_ids` 컬럼이 JSON — 1 adapter당 1 row, 다중 adapter 가능. 마이그레이션 0. |
| (b) | per-file row | ❌ | row explosion (수만 행 / index run) |
| (c) | single global row | ❌ | 정확도 추적 못 함 |

### D-021: Migration 정책

| ID | 후보 | 채택 후보 | 이유 |
|---|---|---|---|
| (i) | regex-MVP를 즉시 제거 | ❌ | 다른 언어(현재 25개 확장자) regression 위험 |
| (ii) | regex-MVP를 `MultiLanguageRegexAdapter`로 *별도 adapter*로 보존, TS만 Compiler API로 promote | ✅ default | regex MVP는 Python/Go/Rust 등 fallback으로 영구 유지 가능. TS만 더 정확한 adapter가 우선권. |
| (iii) | dual-write (regex + Compiler API 둘 다 emit) | ❌ | 의미 충돌 시 어느 게 truth? — 결정 비용 ↑ |

**채택:** (a) + (ii) + 6.1의 인터페이스(D-019 결정 후) + adapter priority 룰 (`registry.first(file => adapter.supports(file))`로 첫 매치 — language/framework-specific adapter가 regex fallback 앞에 등록).

---

## 3. 작업 분해

### 3.1 prerequisite

- [x] **6.1.0** — D-019 인터페이스 시그니처 픽: C + per-run lifecycle + relation-embedded evidence
- [x] **6.1.1** — `src/adapters/types.ts` 신규: 인터페이스 + 보조 타입 (`PendingEntity`, `PendingRelation`, `PendingEvidence`, `ExtractCtx`)
- [x] **6.1.2** — `src/adapters/registry.ts` 신규: priority-ordered registry + `pickAdapter(file)` 헬퍼

### 3.2 regex MVP 격리 (no-op refactor)

- [x] **6.7.1** — `src/indexer.ts`의 per-file extract 부분을 `src/adapters/multi-language-regex.ts`로 이동, `MultiLanguageRegexAdapter`로 export
- [x] **6.7.2** — `indexProject()`는 scan → registry.dispatch(file) → persist orchestrator 역할로 축소

### 3.3 Multi-language + Spring Boot adapter pack v0

- [x] **6.2.1** — fixture matrix: TS/JS, Java/Kotlin/Spring Boot, Python, Go, Rust의 선언/import/test/config relation을 같은 acceptance 기준으로 고정
- [x] **6.2.2** — TS/JS adapter v0: imports, re-exports, dynamic import/require, exported declarations, test imports, source span
- [x] **6.2.3** — Java/Kotlin adapter v0: package/import, class/interface/object/function-ish declarations, annotations, JUnit/Kotlin test relation
- [x] **6.2.4** — Spring Boot adapter v0: endpoint/config/persistence/test/client relation (`@RestController`, mapping annotations, `@Service`, `@Repository`, `@Configuration`, `@Bean`, config properties, JPA, Spring Data, Feign/WebClient/RestTemplate)
- [x] **6.2.5** — Python/Go/Rust adapter v0: module/package/import/declaration/test relation과 source span
- [x] **6.2.6** — registry priority: language/framework-specific adapter가 regex fallback 앞에 등록되고 adapter coverage/diagnostic을 남김
- [x] **6.2.7** — Tests: 각 언어 fixture에서 regex-MVP보다 정확한 declaration/import/test/config relation과 span을 assertion

### 3.4 Source span

- [x] **6.3.1** — `relation_evidence` 스키마 확장: `start_line`/`end_line`/`start_col`/`end_col` 컬럼 추가 (ADD-only). confidence enum은 기존 `proven | inferred | heuristic | unknown` 유지
- [x] **6.3.2** — `PendingEvidence` 타입에 span 추가. parser/annotation-backed exact span은 `proven`, regex line-only/whole-file evidence는 `heuristic`
- [x] **6.3.3** — MCP graph resource + analyze report의 evidence 직렬화에 span 노출
- [x] **6.3.4** — Tests: span 검증, 기존 evidence는 NULL span으로 backward-compat

### 3.5 Snapshot-safe indexing

- [x] **6.4.1** — `index_runs` 스키마 확장: `git_commit_sha`, `git_is_dirty BOOLEAN`, `git_branch_name TEXT` (ADD-only)
- [x] **6.4.2** — `indexProject()` 시작 시 `git rev-parse HEAD` + `git status --porcelain` (둘 다 fail-tolerant; non-git repo에서는 NULL)
- [x] **6.4.3** — `analyzer.ts` stale-index 경고를 commit SHA 기반으로 정밀화 ("현재 HEAD가 index 시점과 다름")
- [x] **6.4.4** — Tests: dirty state 감지, non-git repo no-op

### 3.6 Relation-kind mapping 완성

- [x] **6.5.1** — `relationKindToAttribute`를 explicit mapping으로 정의 (`DEPENDS_ON→imports`, `CALLS→calls`, `IMPORTS→imports`, `EXPORTS→exports`, `IMPLEMENTS→implements`, `EXTENDS→extends`, `READS→reads`, `WRITES→writes`, `RAISES→raises`, `HANDLES→handles`, `OWNS→owns`, `TESTS`/`VERIFIES→tests`, `DOCUMENTS→documents`, `CONFIGURES→configures`, `BREAKS_COMPATIBILITY_WITH→breaks_compat`, `REFERENCES→references`, `DECLARES→declares`, `GOVERNS→governs`)
- [x] **6.5.2** — static relation attribute 정의를 `attribute_defs`에 seed/promote (`is_code_relation = 1`)
- [x] **6.5.3** — Tests: static relation attributes seed/promote와 dual-write surface 확인

### 3.7 Workspace catalog loader

- [x] **6.6.1** — `src/workspace.ts` 신규: `initWorkspace(root, options)`, `addRepo(workspaceId, repoRoot)`, `listWorkspaces()` — `workspaces` + `workspace_repos` writer
- [x] **6.6.2** — `workspace init [name]` CLI command (`src/cli.ts`)
- [x] **6.6.3** — `workspace add-repo <path>` CLI command
- [x] **6.6.4** — Tests: multi-repo workspace, idempotent re-init, local path validation, CLI integration

### 3.8 ADR + 문서

- [x] **6.A.1** — `docs/decisions.ko.md`에 D-019..D-037 결정 로그 추가
- [x] **6.A.2** — `docs/progress.ko.md`에 Phase 6 foundation ledger 추가 (2026-05-04)
- [x] **6.A.3** — `docs/roadmap.md` A1/A5 status 갱신
- [x] **6.A.4** — `CHANGELOG.md` Phase 6 branch 항목

---

## 4. 마이그레이션 / 호환성

- 스키마 변화는 **모두 ADD-only** (D-002 정신). 기존 행/컬럼 변경 없음.
- regex-MVP adapter는 **영구 유지** — 모든 언어의 fallback. Phase 6B/8의 더 정확한 adapter들이 등록되면 priority로 자동 밀려남.
- 기존 `evidence` 행은 span = NULL로 남음 (backward-compat). Persisted span/range는 새 `relation_evidence` 행부터 점진 적용되며, 오래된 DB는 재index 전까지 null span을 유지할 수 있다.
- `indexer.ts`는 "scan + persist orchestrator"로 축소 — 호출자(`src/cli.ts:index`, `src/mcp.ts:analyze`)는 변경 0.

---

## 5. 테스트 ledger

| 항목 | 상태 |
|---|---|
| 6.1/6.7 foundation regression | 2026-05-04 branch 검증: 144 passing |
| 6.2 multi-language + Spring Boot fixture matrix | landed in Phase 6B; ImpactBench verifies TS/JS, JVM/Spring, Python, Go, Rust, OpenAPI baseline |
| 6.3 source span | landed for core TS/JS import/test spans, JVM/Spring spans, Python/Go/Rust declaration/test spans, OpenAPI endpoint/implementer spans |
| 6.4 commit SHA + dirty | landed with clean/dirty/non-git and stale-index warning coverage |
| 6.6 workspace loader | landed with init, add-repo, idempotent, list, validation, CLI integration tests |
| **현재 gate** | `npm run bench` score 0.9978, expected 46/46, `spanCompleteness` 0.9565; workspace focused tests pass |

---

## 6. Adapter interface 후보와 결정 기록

> 초기 후보 비교와 2026-05-03 최종 결정 기록. multi-language + Spring Boot adapter pack v0, source span persistence, snapshot metadata, workspace loader는 Phase 6B 계열에서 진행한다.

### 후보 A — minimal sync

```typescript
export interface SemanticAdapter {
  readonly id: string;          // 'multi-language-regex' | 'typescript-compiler-api' | ...
  readonly version: string;
  supports(file: ScannedFile): boolean;
  extract(file: ScannedFile, ctx: ExtractCtx): ExtractedFile;
}
```

### 후보 B — capability-typed async (planner 추천)

```typescript
export type AdapterCapability =
  | 'imports' | 'exports' | 'calls' | 'references'
  | 'types' | 'symbols' | 'docrefs' | 'tests';

export interface SemanticAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly AdapterCapability[];
  supports(file: ScannedFile): boolean;
  extract(file: ScannedFile, ctx: ExtractCtx): Promise<ExtractedFile>;
}
```

### 후보 C — streaming events

```typescript
export type IndexEvent =
  | { kind: 'entity'; entity: PendingEntity }
  | { kind: 'relation'; relation: PendingRelation }
  | { kind: 'evidence'; evidence: PendingEvidence }
  | { kind: 'diagnostic'; level: 'warn' | 'error'; message: string };

export interface SemanticAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly AdapterCapability[];
  supports(file: ScannedFile): boolean;
  process(file: ScannedFile, ctx: ExtractCtx): AsyncIterable<IndexEvent>;
}
```

**Trade-off:**

| 후보 | 마이그레이션 비용 | LSP/CodeQL 적합도 | 메모리 효율 | 코드 양 |
|---|---|---|---|---|
| A | 최저 | 시그니처 깨야 함 (Phase 8) | 중 | 최저 |
| B | 낮음 | 자연스러움 | 중 | 낮음 (+1 type) |
| C | 중간 | 자연스러움 | 최고 | 중간 (+1 union) |

**Decided (2026-05-03): C with 2 refinements.**

원래 doc은 B를 권장했으나 사용자 결정으로 C가 채택됨. 두 가지 작은 수정이 도입됨:

1. **Per-run lifecycle 분리** — `start(ctx, files): AdapterRun`이 1회 호출되어 `AdapterRun` 핸들 반환 (compiler/LSP-backed setup 같은 expensive setup을 N파일에 걸쳐 amortize). `AdapterRun.process(file)`가 파일별 events emit. `AdapterRun.dispose?()` cleanup hook.
2. **Evidence를 relation 이벤트에 임베드** — 별도 `evidence` event 제거. `relation` event가 `evidence?: readonly PendingEvidence[]` 옵션 필드로 가짐 (1:N 가능, 일반 케이스 단순화).

**Shipped:**

- `src/adapters/types.ts` — `SemanticAdapter`, `AdapterRun`, `IndexEvent`, `PendingEntity|Relation|Evidence`, `EntityDescriptor`, `ExtractCtx`, `AdapterCapability`
- `src/adapters/registry.ts` — `AdapterRegistry` (FIFO, first-match-wins)
- `tests/adapter_registry.test.ts` — priority order, no-match, dedup, classify, list coverage 포함
- `src/types.ts` — `RelationKind` (16-element union) + `ScannedFile` 공용 승격

**Trade-off 회고:** A는 LSP/CodeQL이 등장할 Phase 8에서 시그니처를 깨야 했고, B는 streaming 사례 (huge file, LSP push)에서 다시 wrap이 필요했음. C는 향후 모든 케이스를 흡수 — 비용은 orchestrator-side persist batching이 더 복잡해짐 (#3 regex MVP refactor에서 그 비용을 처음으로 짊어짐).

---

## 7. 성공 기준

Foundation subset (`main`):

- [x] Adapter interface + registry + regex adapter extraction
- [x] Per-adapter run attribution (`adapter_runs`, coverage, relation `adapter_run_id`)
- [x] Adapter-provided relation evidence preserved with stable redacted evidence IDs
- [x] Fanout analysis dedupes multi-evidence relation joins
- [x] Adapter diagnostics observable in coverage rows and adapter run error summaries, including failure preservation
- [x] Symbol version `content_hash` changes when containing file content changes
- [x] Explicit relation-kind → memory attribute mapping + static relation attributes seeded/promoted

Remaining Phase 6/6B scope:

- [x] 2026-05-09 main verification baseline: `npm test` 144 passing (prior branch verification also passed `npm run check`, `npm run docs:lint`, `npm audit --audit-level=high`)
- [x] Java/Kotlin/Spring Boot/Python/Go/Rust/TS/JS fixture에서 regex-MVP가 놓치거나 흐리게 잡는 declaration/import/test/config relation을 adapter v0가 source span과 함께 잡음
- [x] 핵심 adapter/contract relation evidence가 span(line/col/range/confidence)을 저장하고 ImpactBench `spanCompleteness` gate를 통과
- [x] dirty repo 상태에서 indexing 시 `index_runs.git_is_dirty=1` 기록 + analyzer 경고 출력
- [x] `workspace init` + `workspace add-repo` 라운드트립 — `workspaces` 테이블에 row 존재
- [x] ADR D-019..D-037 정식 승격 (`decisions.ko.md`)
- [x] cross-repo provider/consumer resolver v0
- [x] Protobuf/AsyncAPI consumer resolver v0
- [x] generated-client/event topology resolver v0
- [x] contract topology surface v0
- [x] OpenAPI endpoint-surface contract diff/breaking-change classification v0
- [x] OpenAPI nested schema/allOf/oneOf contract diff/breaking-change classification v0
- [x] Protobuf/GraphQL/AsyncAPI compact signature contract diff/breaking-change classification v0
- [x] MCP workspace/contract resources v0

---

## 8. Phase 5 후보 backlog (deferred)

Agent Memory 후보는 현재 live work가 아니다:

- **B1 MemoryBench** — `tests/bench/` + 새 CLI command
- **B2 reembed cleanup** — `src/agent_memory.ts:reembedFacts` orphan 정리
- **B3 reflect-lock** — concurrent reflection 충돌 방지

Phase 6 완료 또는 별도 우선순위 변경 후 독립 PR로 재개한다. `src/store.ts`를 만지는 항목은 Phase 6 snapshot/workspace 작업과 충돌 가능성이 있으므로 시작 전에 rebase 범위를 확인한다.

---

## 9. 다음 행동

1. full parser/LSP depth pass
2. build-system/package resolver depth
3. generated-client/event topology resolver depth

이 doc은 *사전 design에서 branch-progress doc으로 전환됨*. Phase 6 전체가 끝난 시점에는 회고 doc(`phase6-retro.ko.md`)을 추가한다.
