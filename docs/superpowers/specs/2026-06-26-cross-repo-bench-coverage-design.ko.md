# Cross-Repo Bench Coverage 설계

[English](2026-06-26-cross-repo-bench-coverage-design.md) · **한국어** · [中文](2026-06-26-cross-repo-bench-coverage-design.zh.md)

**상태:** 설계 승인됨. 구현 계획은 written spec 검토 후 작성한다.

**백로그 항목:** D2, cross-repo 및 contract-diff surface의 bench coverage.

**목표:** 이미 shipped된 W1 cross-repo primary impact 경로를 deterministic `npm run bench` report에서 보이게 만든다. Provider contract break가 더 이상 `analyzeDiff`, report evidence, graph export에 expected consumer impact로 나타나지 않으면 안정적인 bench score가 낮아져야 한다.

## 사용자 결과

사용자와 agent는 W1의 핵심 약속이 unit test뿐 아니라 relation recall, affected-file recall, evidence quality, retrieval quality를 지키는 deterministic quality report에서도 추적된다는 점을 신뢰할 수 있어야 한다.

Bench는 좁은 질문 하나에 답한다: "등록된 cross-repo contract break가 여전히 expected consumer, evidence, graph edge와 함께 primary impact report까지 도달하는가?"

## 현재 상태

W1은 shipped 상태다. `analyzeDiff`는 이제 다음을 낼 수 있다:

- optional `crossRepoImpacts`;
- `web:src/client.ts` 같은 external affected consumer path;
- `BREAKS_COMPATIBILITY_WITH` relation evidence;
- persisted report JSON에서 다시 만든 report-scoped graph edge.

Focused test는 `tests/contract-diff.test.ts`에서 이 동작을 커버하고, UI test는 rendering을 커버한다. 하지만 deterministic bench는 아직 이 경로를 측정하지 않는다. `ImpactBenchReport`는 static relation recall, affected-file recall, evidence/span coverage, adapter attribution, context-pack readiness, retrieval quality를 점수화하지만 cross-repo 또는 contract-diff lane은 없다.

## 선택한 접근

W1 cross-repo primary impact용 작은 D2 bench lane을 추가한다.

이 lane은 bench temp workspace 안에 deterministic two-repo fixture를 만든다:

1. `/api/users`를 가진 OpenAPI contract가 있는 provider repo;
2. `/api/users`를 호출하는 source file이 있는 consumer repo;
3. 두 repo를 등록한 workspace catalog;
4. indexed baseline과 resolved `CONSUMES_HTTP_ENDPOINT` link;
5. `/api/users`를 제거하는 provider contract edit;
6. expected `BREAKS_COMPATIBILITY_WITH` link를 persist하는 contract-diff run;
7. provider contract에 대한 `analyzeDiff` run.

그 다음 bench는 primary report에 expected cross-repo consumer impact가 있는지, persisted report graph에 expected break edge가 있는지 점수화한다. 이렇게 하면 network access나 nondeterministic timing 없이 실제 사용자 workflow와 가까운 lane을 얻는다.

## 검토한 대안

### A. W1 cross-repo lane을 `ImpactBenchReport`에 추가 (선택)

방금 user-visible path가 된 동작을 보호한다. 작은 trend signal을 주고, D2를 한 번에 모두 구현하지 않아도 된다.

Tradeoff: bench report에 새 section이 생기므로 report formatting과 deterministic-output test를 신중히 갱신해야 한다.

### B. Focused integration test만 계속 의존

현재 test는 가치가 있고 유지해야 한다. 하지만 quality report나 PR bench delta에 반영되지 않는다. 전체 health를 판단하는 benchmark summary에서 regression이 보이지 않을 수 있다.

Tradeoff: bench schema churn은 없지만 장기 signal이 약하다.

### C. 모든 D2 feature bench를 한 번에 구현

Co-change, trace-ingest promotion, cross-repo, contract-diff metric을 한 번에 넣으면 더 완성도는 높다. 하지만 여러 fixture type이 묶이고 review가 어려워진다.

Tradeoff: coverage는 넓고, slice는 느리고 위험해진다.

## Bench Report Shape

`ImpactBenchReport`에 `crossRepoContracts` section을 추가한다:

```ts
type CrossRepoContractBench = {
  fixtureId: 'cross-repo-contract-impact-v0';
  summary: {
    passed: boolean;
    score: number;
    expectedImpacts: number;
    matchedImpacts: number;
    expectedGraphEdges: number;
    matchedGraphEdges: number;
  };
  expectedConsumerPaths: string[];
  matchedConsumerPaths: string[];
  missingConsumerPaths: string[];
  expectedEvidenceKinds: string[];
  matchedEvidenceKinds: string[];
  graphEdges: {
    expected: number;
    matched: number;
  };
};
```

이 section은 deterministic하고 path-safe해야 한다. Absolute temp path, local repo root, wall-clock timing, random ID, machine-specific data를 포함하면 안 된다. Fixture는 `web:src/client.ts` 같은 service-qualified display path를 사용할 수 있다.

Top-level `summary.score`는 기존 weighted deterministic relation/retrieval score를 유지한다. 새 cross-repo lane은 required pass gate다. 기존 weighted score가 높아도 `crossRepoContracts.summary.passed`가 false면 top-level `summary.passed`도 false다. 이렇게 하면 기존 score 해석을 바꾸지 않으면서도 W1 regression이 canonical bench status에 드러난다.

## Data Flow

Bench fixture는 row를 직접 insert하지 말고 production API를 재사용해야 한다:

- `initProject`와 `indexProject`가 두 repo를 준비한다.
- `initWorkspace`와 `addWorkspaceRepo`가 workspace를 등록한다.
- `resolveCrossRepoContracts`가 consumer link를 만든다.
- Contract edit 후 `analyzeContractDiff`가 breaking link를 persist한다.
- `analyzeDiff`가 검증 대상 primary report를 만든다.
- `exportImpactGraph`가 report-scoped graph edge를 검증한다.

이 data flow는 bench를 실제 user workflow와 맞추고, production wiring이 깨졌는데 synthetic fixture만 통과하는 상황을 피한다.

## Error Handling And Determinism

- Fixture setup failure는 조용히 0점 처리하지 말고 명확한 bench error로 throw한다.
- `analyzeContractDiff`가 edit을 breaking으로 분류하지 못하면 bench section은 matched impact 없이 fail한다.
- `analyzeDiff`가 malformed 또는 path-leaking data를 내면 deterministic-output test가 fail한다.
- Lane은 실행 후 temp repos를 정리해야 한다.
- Lane은 fixture repo 내부의 repo-local `.parallax` state 외에는 temp workspace 밖을 읽거나 쓰면 안 된다.

## Tests

구현은 다음 focused test를 추가하거나 갱신해야 한다:

1. 새 bench section이 존재하고 cross-repo fixture가 pass로 보고된다.
2. Bench output이 두 번 실행해도 deterministic하다.
3. Bench output이 temp workspace root, absolute provider repo path, absolute consumer repo path, escaped absolute path variant를 포함하지 않는다.
4. Markdown bench report가 cross-repo section을 포함하고, section fail 시 missing impact를 보여준다.
5. 기존 relation/retrieval/semantic bench assertion은 계속 통과한다.

## Documentation

다음을 갱신한다:

- `docs/verification*.md`: `npm run bench`가 deterministic cross-repo contract-impact lane을 포함한다고 설명.
- `IMPROVEMENT_OPPORTUNITIES.md`: D2 중 W1-focused 부분은 shipped 또는 partially shipped로 표시하고, co-change, trace-ingest, broader contract-diff trend metric은 open으로 유지.
- `docs/roadmap*.md`: 필요하면 cross-repo primary impact가 bench-guarded 상태임을 언급.

번역 문서를 만질 때는 English, Korean, Chinese 문서가 의미상 같아야 한다.

## Implementation Boundary

이 설계는 다음을 구현하지 않는다:

- W2 cross-repo link reconciliation 또는 workspace verification;
- W6 cross-repo MCP tools;
- co-change, trace-ingest, broader contract-diff bench lanes;
- large-repo timing baseline 또는 S4 peak-RSS work;
- 새 public report schema field.

## Verification Gate

구현 acceptance 전 다음을 실행한다:

```bash
npm run bench
npm test -- --test-name-pattern "bench|cross-repo"
npm run lint
npm run verify
```

개발 중 scoped bench와 test command를 먼저 실행할 수 있지만 final acceptance에는 `npm run verify`가 필요하다.

## Spec Self-Review

- Completeness scan: 미완성 marker, sample-only value, 열린 요구사항 없음.
- Consistency check: chosen approach, data flow, tests, documentation이 모두 같은 W1 cross-repo bench lane을 겨냥한다.
- Scope check: 단일 D2 slice다. W2, W6, S4, 다른 D2 lane은 명시적으로 out of scope다.
- Ambiguity check: top-level score semantics는 고정했다. Cross-repo lane은 `summary.passed`를 gate하지만 `summary.score`를 reweight하지 않는다.
