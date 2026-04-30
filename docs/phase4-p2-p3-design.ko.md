# Phase 4 P2+P3 Design — `reflect --repair` + `branch --restore`

> **상태:** 2026-04-30 작성 · branch `feat/phase4-p2-p3-repair-restore`
> **선행:** [phase4-handoff.ko.md](phase4-handoff.ko.md) (D-015/D-016 결정), [phase3-design.ko.md](phase3-design.ko.md) (Phase doc template), [decisions.ko.md](decisions.ko.md)
> **목적:** Phase 3 invariants의 *reverse path* 두 가지를 보완. 모두 D-002 (content-addressable id) + D-005 (async outside tx) + D-011 (soft-delete only)을 그대로 유지.

---

## 0. 한 줄 요약

> "P2 = orphan summary fact 보정 sweep (Phase 3 SAVEPOINT atomicity 갭 복구). P3 = abandoned branch 되돌리기 (state + tx unarchive). 둘 다 schema 변경 없음, 신규 ADR D-015 + D-016."

---

## 1. 문제 정의

### P2: orphan summary fact

**증거 (Phase 3 architect review):**
> "remember() opens its own BEGIN/COMMIT internally. Control returns to persistReflections, where the subsequent provenanceMark.run and reflectionInsert.run execute in autocommit mode. If the process is killed between remember() returning and reflectionInsert.run finishing, you get a reflection summary fact written, but fact_provenance.kind still 'evidence' and no reflections audit row."

**현재 안전망 (Phase 3):** SAVEPOINT는 *provenance UPDATE + audit INSERT*만 atomic. summary fact 자체는 remember()가 이미 commit했음. 중간 실패 시 orphan 발생.

**Detection:** `attribute='reflection'` fact가 있는데 *모든* `fact_provenance` edge가 `kind='evidence'`이고 `reflections` audit row가 없으면 → orphan.

### P3: abandoned branch 되돌리기

**증거 (Phase 4 handoff §1):**
> "branch --restore (archived → active) — 현재는 한 방향. soft-delete의 핵심 가치(되돌릴 수 있음)를 살리려면 필요."

**현재 상태:** `abandonBranch` + `gcBranches`로 abandoned + archived 가능. 그러나 *되돌리는 path 없음*. soft-delete의 reversibility 약속이 *반쪽*.

---

## 2. 결정 사항

### D-015: `--repair` 트리거 → (a) 별도 옵션

handoff §3에서 권장한 (a) 채택.

```bash
impact-trace reflect --repair [--branch main] [--dry-run]
```

명시적 trigger. 일반 `reflect` 호출과 격리. dry-run 지원.

### D-016: `branch --restore` 의미 → (ii) state + tx unarchive

handoff §3에서 권장한 (ii) 채택.

```bash
impact-trace branch --restore <name>
```

동작:
1. `branches.state = 'active'`로 변경 (was 'abandoned')
2. `transactions.archived = 0`으로 회수 (was 1)

사용자 mental model "복구했으니 보인다"와 일치. main은 이미 abandon 불가라 protect 안 필요 (이미 abandoned 상태가 아니라 restore도 의미 없음).

---

## 3. 구현

### 3.1 P2 — `reflect --repair`

**`src/reflection.ts`에 추가:**

```typescript
export interface RepairOptions {
  branch?: string;
  dryRun?: boolean;
}

export interface RepairResult {
  branch: string;
  scanned: number;       // 검사한 reflection facts 수
  repaired: number;      // 실제 복구된 수 (dry-run이면 0)
  orphans: Array<{
    summaryFactId: string;
    entity: string;
    sourceFactCount: number;  // provenance edges 개수
  }>;
}

export async function repairReflections(
  repoRoot: string,
  options?: RepairOptions
): Promise<RepairResult>;
```

**알고리즘:**
1. Branch 스코프 SELECT — `attribute='reflection' AND op='assert'` reflection facts.
2. 각 reflection fact에 대해:
   - `reflections` audit row 있으면 정상 → skip.
   - audit row 없으면 *orphan*:
     - 모든 fact_provenance edge가 `kind='evidence'`인지 확인 (mixed면 partial-orphan, 처리 동일).
     - dry-run이면 reporting only.
     - 실제 repair: SAVEPOINT 안에서 (a) provenance kind를 'summary'로 UPDATE (b) reflections audit row INSERT.

**상태 의도성:** repair는 *passive sweep*. reflectFacts와 격리되며 SAVEPOINT atomicity로 자체 보호. 동시 reflectFacts 호출 안전 (별 commit 단위, fact id는 content-hash라 dedup).

### 3.2 P3 — `branch --restore`

**`src/branch_gc.ts`에 추가:**

```typescript
export interface RestoreBranchInput {
  name: string;
}

export interface RestoreBranchResult {
  branchId: string;
  name: string;
  state: 'active';
  unarchivedTransactions: number;
  alreadyActive: boolean;
}

export function restoreBranch(db: Db, input: RestoreBranchInput): RestoreBranchResult;
```

**알고리즘:**
1. Branch 조회 → 없으면 throw.
2. `state === 'active'` 이면 idempotent no-op (`alreadyActive=true`, `unarchivedTransactions=0`).
3. `state === 'abandoned'` 이면:
   - SAVEPOINT 시작
   - `branches.state = 'active'` UPDATE
   - `transactions.archived = 0 WHERE branch_id = ? AND archived = 1` UPDATE; rowCount 캡처
   - SAVEPOINT release
4. main은 `abandonBranch`가 거부하므로 자연히 restore할 일 없음 (방어적으로 main 호출도 idempotent no-op).

**Recall 영향:** archived=0 회수되면 recall/recallSemantic/trace가 자동으로 다시 surface. 별도 캐시/refresh 없음.

---

## 4. CLI / MCP 표면

### CLI

```bash
# P2
impact-trace reflect --repair [--branch <name>] [--dry-run]

# P3
impact-trace branch --restore <name>
```

`reflect`는 두 mode를 가짐 — *consolidation* (default) 또는 `--repair` (mutually exclusive). repair 시 `--older-than-days`, `--entity`, `--model`, `--agent`는 ignored.

`branch`는 이제 *세 mode*: `--name` (create) / `--abandon` (deprecate) / `--restore` (revive). 사용자 mental model 일관.

### MCP

```typescript
server.registerTool('impact_trace_repair_reflections', { /* readOnlyHint=false, idempotentHint=true */ });
server.registerTool('impact_trace_restore_branch', { /* readOnlyHint=false, idempotentHint=true */ });
```

둘 다 `destructiveHint=false` (data 회복 작업이라 destructive 아님).

---

## 5. test plan

| 파일 | 테스트 | 검증 |
|---|---|---|
| `tests/reflection.test.ts` | `repair finds orphan summary fact and fixes provenance kind + audit row` | orphan을 인위적으로 만들어 (audit row만 삭제), repair 후 audit row 복원 + kind='summary' |
| `tests/reflection.test.ts` | `repair --dry-run reports orphans without writing` | dry-run 후 audit row count 변화 없음 |
| `tests/reflection.test.ts` | `repair on healthy reflections is no-op` | 정상 reflection 위에서 repair 실행 → repaired=0 |
| `tests/branch_gc.test.ts` | `restore moves abandoned branch back to active and unarchives txs` | abandon → gc → restore 사이클 후 recall이 facts 다시 surface |
| `tests/branch_gc.test.ts` | `restore is idempotent on active branch` | `alreadyActive=true`, `unarchivedTransactions=0` |
| `tests/branch_gc.test.ts` | `restore on non-existent branch throws` | error message 검증 |
| `tests/impact-trace.test.ts` | `CLI: reflect --repair + branch --restore round-trip` | E2E |
| `tests/mcp.test.ts` | `MCP impact_trace_repair_reflections + impact_trace_restore_branch` | wire test |

---

## 6. NOT in scope

- ❌ Time-based auto-abandon (Phase 4 P4) — 별도 commit / branch
- ❌ sqlite-vec ANN (Phase 4 P5) — 별도 design doc 필요
- 🟡 reembed cleanup (Phase 5)

---

## 7. dual-voice consensus (self-review)

### CEO 관점
- 진짜 문제? ✅ Phase 3 review에서 *발견된* 갭. 현실 데이터에서 발생 가능.
- 작업 순서 맞나? ✅ P1 (scaling) 끝났으니 next logical step.
- 6개월 후회 risk? ⚠️ "repair sweep을 사용자가 절대 안 부르면 orphan이 안 보임" → cookbook에 권장 주기 명시.

### Eng 관점
- ALTER TABLE 필요? ❌ 모두 SELECT/UPDATE만. 완전 schema-free.
- 동시성 risk? ⚠️ 두 repair 프로세스 동시 — SAVEPOINT가 ROW-LEVEL contention만 처리. 큰 문제 아님 (idempotent INSERT OR IGNORE).
- 보안: orphan repair가 redacted fact를 노출? ❌ provenance edge는 source_fact_id만 저장. value_blob 복원 안 함.

**합의:** *no DISAGREE*. P2+P3는 schema-free, async-outside-tx 패턴 그대로, soft-delete 정책 강화.

---

## 8. commit 분할

```
Commit 1: docs/phase4-p2-p3-design.ko.md (이 문서) + decisions D-015 D-016 추가
Commit 2: P2 — repairReflections 함수 + reflectFacts CLI mode 분기 + MCP tool + 테스트
Commit 3: P3 — restoreBranch 함수 + branch --restore CLI + MCP tool + 테스트
Commit 4: 문서 업데이트 — README + cookbook + CHANGELOG + progress
```

---

## 9. Acceptance criteria

- [ ] `npm run check` 통과
- [ ] `npm test` — main baseline 76 + 신규 테스트 통과
- [ ] `npm run lint` clean
- [ ] CLI `reflect --repair` orphan 보정 동작
- [ ] CLI `branch --restore` archived tx 회수 동작
- [ ] MCP wire test 통과
- [ ] decisions.ko.md에 D-015, D-016 추가
