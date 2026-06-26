# Cross-Repo Link Verification And Agent Query Design

[English](2026-06-26-cross-repo-link-verification-agent-query-design.md) · **한국어** · [中文](2026-06-26-cross-repo-link-verification-agent-query-design.zh.md)

**상태:** 구현 승인. 구현 계획: `docs/superpowers/plans/2026-06-26-cross-repo-link-verification-agent-query.md`.

**Backlog 항목:** W2, bidirectional cross-repo link consistency; W6, cross-repo resolve 및 reverse-consumer MCP tools.

**목표:** workspace cross-repo graph를 신뢰 가능하고 바로 질의 가능하게 만든다. 사용자는 저장된 provider/consumer link가 아직 유효한지 검증할 수 있어야 하고, agent는 source file을 수정하지 않고도 "provider X를 누가 소비하나?"를 묻거나 cross-repo resolution을 preview할 수 있어야 한다.

## 사용자 결과

등록된 workspace에서 작업하는 사용자는 세 가지 질문에 바로 답을 얻어야 한다.

- 저장된 cross-repo link graph가 내부적으로 일관적인가?
- 이 provider contract 또는 endpoint를 소비하는 consumer는 무엇인가?
- 이 consumer file 또는 service가 의존하는 provider는 무엇인가?

Agent도 MCP를 통해 같은 답을 compact resource link와 함께 받아야 한다. Provider contract가 바뀌어 W1이 cross-repo impact를 보여줄 때, stale 또는 orphan workspace link는 report가 조용히 비어 보이게 만드는 대신 진단 가능해야 한다.

## 현재 상태

Parallax에는 이미 storage와 첫 workflow가 있다.

- `resolveCrossRepoContracts`는 등록된 local workspace repo를 스캔해 `CONSUMES_HTTP_ENDPOINT` row를 `cross_repo_links`에 저장한다.
- `analyzeContractDiff`는 breaking provider contract change에 영향을 받는 consumer에 대해 `BREAKS_COMPATIBILITY_WITH` row를 저장한다.
- `parallax://workspaces/{name}/cross-repo-links`는 저장된 link를 노출한다.
- W1은 저장된 `BREAKS_COMPATIBILITY_WITH` row를 primary `analyzeDiff` report, graph export, MCP payload, UI에 노출한다.
- D2-W1은 이제 `npm run bench`에서 그 W1 path를 guard한다.

빠진 부분은 consistency와 queryability다. Link는 consumer에서 provider로 가는 방향성 row로 저장된다. `BREAKS_COMPATIBILITY_WITH` row를 부모 `CONSUMES_HTTP_ENDPOINT` row와 reconcile하거나, workspace catalog에서 빠진 repo를 가리키는 link를 flag하거나, provider-to-consumer 질문을 위한 stable reverse index를 제공하는 shared read model이 없다.

## 선택한 접근

Shared cross-repo link read model과 read-only verification/query surface를 추가한다.

Read model은 `src/cross_repo_links.ts` 같은 focused module에 둔다. 이 module은 `cross_repo_links`를 읽고 provenance를 parse하며 workspace membership을 join하고, normalized record와 diagnostics를 반환한다. 기존 producer는 canonical directional row를 계속 쓴다. 새 layer는 redundant inverse row를 저장하지 않고도 그 row들을 양방향으로 탐색 가능하게 만든다.

여기서 정의가 중요하다. "Bidirectional consistency"는 하나의 canonical link를 helper를 통해 provider-to-consumer와 consumer-to-provider 양쪽으로 질의할 수 있다는 뜻이다. 중복 inverse row를 쓴다는 뜻이 아니다. 중복 inverse storage는 두 번째 staleness 문제를 만들고 repair를 더 어렵게 한다.

## 고려한 대안

### A. Verification과 reverse index를 가진 shared read model (선택)

Write는 단순하게 유지하고, SQL/provenance 중복을 줄이며, CLI/MCP/UI/future analyzer가 같은 답을 쓰게 한다. Local-first SQLite model에도 맞고 schema migration이 필요 없다.

Tradeoff: current inner join이 숨기는 잘못된 link를 드러내기 위해 malformed legacy provenance와 stale membership row를 조심스럽게 모델링해야 한다.

### B. 명시적 inverse row 쓰기

Reverse lookup은 query 시점에 단순해 보이지만 truth를 복제한다. 모든 resolver, diff, repair, future migration이 두 row를 동기화해야 한다.

Tradeoff: read는 단순하지만 correctness와 cleanup risk가 커진다.

### C. 기존 SQL 위에 MCP tool만 추가

좁은 agent query surface는 만족하지만 CLI와 UI에는 신뢰할 만한 consistency check가 남지 않고, 앞으로 parsing logic이 또 복제될 가능성이 높다.

Tradeoff: 더 작은 slice지만 foundation이 약하다.

## Read Model

다음에 가까운 shared API를 도입한다.

```ts
type CrossRepoLinkKind = 'CONSUMES_HTTP_ENDPOINT' | 'BREAKS_COMPATIBILITY_WITH';

type CrossRepoLinkRecord = {
  id: string;
  workspace: string;
  kind: CrossRepoLinkKind;
  confidence: Confidence;
  source: {
    serviceName?: string;
    repoPath?: string;
    path?: string;
    inWorkspace: boolean;
  };
  target: {
    serviceName?: string;
    repoPath?: string;
    contractPath?: string;
    inWorkspace: boolean;
  };
  endpoint?: {
    method: string;
    path: string;
  };
  provenance: unknown;
};

type CrossRepoLinkDiagnostics = {
  malformedLinks: CrossRepoDiagnostic[];
  staleWorkspaceLinks: CrossRepoDiagnostic[];
  orphanBreakingLinks: CrossRepoDiagnostic[];
};
```

정확한 type 이름은 구현 중 바뀔 수 있지만 boundary는 유지해야 한다.

- workspace 하나에 대해 row를 normalize하는 loader 하나;
- diagnostics와 count를 반환하는 verifier 하나;
- provider service, contract, endpoint, route 기준 consumer를 반환하는 `consumersOf(...)`;
- consumer service, file, endpoint evidence 기준 provider를 반환하는 `providersFor(...)`.

Module은 integrity verification에서 `LEFT JOIN`을 사용해야 한다. 그래야 stale link가 보인다. 현재 join된 link만 보여주는 resource reader는 tighter join을 유지해도 되지만, verification은 broken reference를 숨기면 안 된다.

## Consistency Rules

Verification은 다음 case를 deterministic하게 분류해야 한다.

- **Malformed link:** provenance가 valid JSON이 아니거나 kind에 필요한 provider, consumer, endpoint, change, evidence field가 없다.
- **Stale workspace link:** `source_repo_id` 또는 `target_repo_id`가 link workspace의 현재 `workspace_repos` row로 매핑되지 않거나, provenance repo path가 현재 catalog member path와 충돌한다.
- **Orphan breaking link:** 같은 workspace 안에서 동일 consumer repo/path, provider repo/contract, method/path에 대한 부모 `CONSUMES_HTTP_ENDPOINT` 없이 `BREAKS_COMPATIBILITY_WITH` row가 있다.

Contract baseline freshness는 이 slice의 범위 밖이다. Provider contract가 바뀌었지만 `workspace resolve-contracts` 또는 `workspace contract-diff`를 다시 실행하지 않았을 수 있다. Verifier는 graph consistency를 보고해야지, 모든 repo가 가능한 최신 분석을 갖고 있음을 증명하지 않는다.

## CLI Surface

Read-only workspace command를 추가한다.

```bash
parallax workspace verify [--name <name>] [--json]
parallax workspace consumers --provider <service> [--contract <path>] [--method <method>] [--path <route>] [--name <name>] [--json]
parallax workspace providers --consumer <service> [--file <path>] [--name <name>] [--json]
```

`workspace verify`는 compact human summary를 출력하고 malformed, stale, orphan link가 있으면 non-zero로 종료한다. JSON output은 machine use를 위해 같은 count, diagnostic row, `resources` object를 반환한다.

`workspace consumers`와 `workspace providers`는 같은 read model을 쓴다. Resolution이나 contract diff를 실행하지 않는다. Matching row가 없으면 empty result와 함께 persisted link refresh가 필요할 수 있다는 warning을 반환한다.

## MCP Surface

Read-only agent query tool을 추가한다.

- `parallax_cross_repo_consumers`
- `parallax_cross_repo_providers`
- `parallax_resolve_cross_repo_contracts`

`parallax_cross_repo_consumers`와 `parallax_cross_repo_providers`는 저장된 link를 질의하고 `readOnlyHint: true`를 설정한다.

`parallax_resolve_cross_repo_contracts`는 CLI와 같은 write path가 아니라 preview tool이어야 한다. `resolveCrossRepoContracts`를 refactor해 `persist?: boolean` option을 받게 한다. 기존 CLI는 default write mode로 호출해 현재 persisted behavior를 유지한다. MCP preview는 `persist: false`로 호출하고, proposed link와 warning을 반환하며, `cross_repo_links` row를 clear하거나 insert하면 안 된다.

이는 invariant I-8을 지킨다. Read-only로 표시된 MCP tool은 source file이나 workspace link table을 수정하지 않는다. 이미 `docs/mcp.md`에 문서화된 local telemetry row는 허용된다. 나중에 cross-repo resolution을 persist하는 MCP write tool이 필요하면 별도 이름, `readOnlyHint: false`, 명시적 write surface 문서가 필요하다.

## Error Handling

- Workspace 없음: 기존 workspace command와 일관된 typed error를 반환한다.
- Empty workspace: verify는 link 0개와 warning으로 성공한다.
- Malformed provenance: bulk verification에서 throw하지 않고 deterministic diagnostics에 포함한다.
- Query filter match 없음: error가 아니라 empty list와 resource link를 반환한다.
- Route filter는 method case를 normalize하되 route path text는 보존한다.
- Absolute local path는 workspace catalog에 이미 존재하는 경우 local CLI JSON에 나타날 수 있지만, MCP compact result는 service name, contract path, consumer path, `parallax://` resource를 우선 사용한다.

## Tests

구현은 focused coverage를 추가해야 한다.

1. `workspace verify`가 matching `CONSUMES_HTTP_ENDPOINT`와 `BREAKS_COMPATIBILITY_WITH` row를 가진 workspace에서 success를 보고한다.
2. Parent consume link가 제거된 뒤 `workspace verify`가 orphan `BREAKS_COMPATIBILITY_WITH` row를 flag한다.
3. Workspace catalog에서 더 이상 없는 repo를 참조하는 stale link를 `workspace verify`가 flag한다.
4. Malformed provenance가 verifier crash 없이 count된다.
5. `consumersOf`가 provider service, contract, method, route filter에 맞는 consumer를 반환한다.
6. `providersFor`가 consumer service와 file path filter에 맞는 provider를 반환한다.
7. MCP tool이 `readOnlyHint: true`와 resource link를 포함해 query result를 노출한다.
8. MCP resolution preview가 `cross_repo_links`를 mutate하지 않고 computed link를 반환한다.
9. 기존 `workspace resolve-contracts`, `workspace contract-diff`, W1 primary cross-repo impact, bench coverage가 계속 통과한다.

## Documentation

업데이트 대상:

- `docs/cli-reference*.md`: `workspace verify`, `workspace consumers`, `workspace providers` 문서화.
- `docs/mcp*.md`: 새 cross-repo MCP tool과 read-only preview boundary 문서화.
- `docs/roadmap*.md`: 구현 후 link consistency 항목 체크.
- `IMPROVEMENT_OPPORTUNITIES.md`: W2와 W6를 shipped 또는 partially shipped로 갱신하고 남은 follow-on을 명시.
- `docs/verification*.md`: final implementation이 새 verification command를 `npm run verify`에 추가하면 focused verifier test를 언급.

Translated page를 수정할 때 영어, 한국어, 중국어 문서는 의미가 같아야 한다.

## Implementation Boundary

이 설계는 다음을 구현하지 않는다.

- stale link 자동 삭제 또는 repair;
- `cross_repo_links`의 duplicate inverse row;
- `analyzeDiff` 안의 automatic contract diff 실행;
- remote repository discovery 또는 network cloning;
- monorepo sub-package cataloging;
- cross-repo resolution을 persist하는 permissioned MCP write tool.

첫 구현은 diagnose와 query에 집중한다. 사용자가 자동 cleanup을 필요로 하면 이후 repair slice에서 명시적 `workspace repair-links --dry-run/--apply` workflow를 추가할 수 있다.

## Verification Gate

구현 승인 전 실행:

```bash
npm run lint
npm test -- --test-name-pattern "workspace|cross-repo|MCP"
npm run test:mcp
npm run bench
npm run verify
```

개발 중 scoped test를 먼저 돌릴 수 있지만, final acceptance에는 `npm run verify`가 필요하다.

## Spec Self-Review

- Completeness scan: unfinished marker, placeholder, open-ended tool name이 없다.
- Consistency check: CLI, MCP, future UI behavior가 모두 같은 normalized link model을 읽는다.
- Scope check: verification과 queryability에 집중한 하나의 W2+W6 slice다. Repair, monorepo cataloging, automatic diff refresh는 out of scope다.
- Ambiguity check: read-only MCP resolution은 명시적으로 non-persisting preview이고, 기존 CLI resolution은 persisted workflow로 유지된다.
