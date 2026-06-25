# Cross-Repo Primary Impact 설계

[English](2026-06-25-cross-repo-primary-impact-design.md) · **한국어** · [中文](2026-06-25-cross-repo-primary-impact-design.zh.md)

**상태:** 구현 승인됨. 구현 계획: `docs/superpowers/plans/2026-06-25-cross-repo-primary-impact.ko.md`.

**백로그 항목:** W1, `analyzeDiff` 안의 cross-repo contract impact.

**목표:** 변경된 contract가 등록된 workspace consumer를 깨뜨릴 때 primary impact report가 해당 consumer service와 file을 직접 보여준다. Cross-repo impact를 `parallax workspace contract-diff` 출력이나 `parallax://workspaces/{name}/cross-repo-links` resource에만 남겨두지 않는다.

## 사용자 결과

Provider contract를 바꾸는 사용자는 즉시 다음을 봐야 한다:

- 위험한 consumer service;
- 깨진 endpoint 또는 event와 매칭된 consumer file;
- 원인이 된 provider contract와 breaking change;
- 결과를 뒷받침하는 confidence와 evidence;
- MCP/UI resource link로 이어지는 조사 경로.

첫 화면 report와 UI는 사용자가 workspace side lane을 알아야 하지 않아도 "이 contract 변경을 배포하면 누가 깨지는가?"에 답해야 한다.

## 현재 상태

Parallax에는 이미 이 기능에 필요한 raw data가 있다:

- `contracts`와 `contract_versions`는 indexed provider contract를 식별한다.
- `cross_repo_links`는 `analyzeContractDiff`가 만든 `BREAKS_COMPATIBILITY_WITH` link를 저장한다.
- link provenance는 `consumer`, `provider`, `change`, `evidence` 객체를 가진다.
- MCP resource는 workspace contract와 cross-repo link를 노출할 수 있다.

빈칸은 통합이다. `analyzeDiff`는 local entity graph와 legacy file edge만 걷는다. Workspace breaking link를 보지 않기 때문에 `parallax analyze`, MCP `parallax_analyze_diff`, persisted report, graph export, UI는 primary path에서 cross-repo consumer를 놓친다.

## 선택한 접근

`analyzeDiff` 안에 좁은 cross-repo lane을 추가한다.

이 lane은 changed file이 latest completed run에 indexed된 contract path와 일치할 때만 실행된다. 해당 contract에 대해 같은 provider repo와 contract path를 가리키는 provenance를 가진 workspace `BREAKS_COMPATIBILITY_WITH` link를 읽는다. 유효한 link 하나는 다음을 만든다:

- `crossRepoImpacts` 항목 하나;
- cross-repo path label을 쓰는 consumer file용 `affectedFiles` 항목 하나;
- consumer file을 나타내는 `external_entity` `affected` target 하나;
- graph export와 UI가 edge를 그릴 수 있는 relation metadata 포함 evidence 하나.

이 lane은 의도적으로 read-only다. Contract를 resolve하거나 breaking change를 다시 계산하거나 workspace link를 수정하지 않는다. 이미 persist된 workspace evidence를 main report에 보여주기만 한다.

## 검토한 대안

### A. 기존 breaking link를 `analyzeDiff`에 표시 (선택)

한 slice당 사용자-visible 가치가 가장 크다. 기존 resolver와 contract-diff output을 재사용하고, deterministic behavior를 유지하며, 새 workflow 없이 primary report를 유용하게 만든다.

Tradeoff: report는 이미 resolve되고 persist된 link만 보여준다. Workspace가 stale이면 조용히 재계산하지 않고 warning을 낸다.

### B. `analyzeDiff` 중 contract-diff 자동 실행

Report freshness는 좋아지지만, 현재 latest index 기준 impact mapping command 안에 더 많은 write behavior와 비싼 analysis가 들어온다. `parallax_analyze_diff`가 일부 mode에서 report/telemetry를 persist하기 때문에 read-only-first MCP 경계도 흐려진다.

Tradeoff: freshness는 좋고, 예측 가능성과 결합도는 나빠진다.

### C. 새 MCP tool/resource만 추가

Primary report는 그대로라 schema risk가 낮지만 사용자 문제를 해결하지 못한다. Agent와 사용자는 여전히 cross-repo breakage를 이해하려고 side lane을 직접 발견하고 호출해야 한다.

Tradeoff: schema risk는 낮고, product impact도 낮다.

## Report Shape

`ImpactReport`에 optional field를 추가한다:

```ts
type CrossRepoImpact = {
  workspace: string;
  provider: {
    serviceName: string;
    repoPath?: string;
    contractPath: string;
  };
  consumer: {
    serviceName: string;
    repoPath?: string;
    path: string;
  };
  change: {
    kind: string;
    method?: string;
    path?: string;
    previousEndpointId?: string;
  };
  confidence: Confidence;
  evidence: {
    filePath: string;
    snippet: string;
  };
  resources?: {
    workspace?: string;
    crossRepoLinks?: string;
  };
};
```

이 field는 optional/additive이므로 report schema는 minor version bump를 받는다. 기존 report는 새 schema에 계속 valid해야 한다. 구현은 오래된 schema version을 적고 있는 report-schema 문서도 같이 고쳐야 한다.

Privacy를 위해 absolute local path를 노출할 수 있는 `repoPath`는 public JSON에서 생략해야 한다. Primary identity는 `serviceName`, `contractPath`, `consumer.path`다. Resource URI는 local path를 새지 않게 workspace resource를 가리킬 수 있다.

## Affected Targets And Evidence

Cross-repo impact는 기존 report surface에 참여해야 한다:

- `affectedFiles.path`: absolute repo path가 아니라 `web:src/client.ts` 같은 stable display label을 사용한다.
- `affectedFiles.reason`: `breaks cross-repo consumer web via contracts/openapi.yaml`.
- `affectedFiles.confidence`: `cross_repo_links.confidence` 값을 `asConfidence`로 normalize해서 사용한다.
- `affectedFiles.depth`: `1`.
- `affectedFiles.relationPath`: 사람이 읽을 수 있는 contract break step을 포함한다.
- `affected.target.kind`: `external_entity`.
- `evidence.kind`: `BREAKS_COMPATIBILITY_WITH`.
- `evidence.subject`: consumer target.
- `evidence.target`: provider contract entity.
- `evidence.relationKind`: `BREAKS_COMPATIBILITY_WITH`.
- `evidence.extractorId`: `cross-repo-contract-impact`.

이렇게 하면 saved report graph export가 canonical row에 의존하지 않고 persisted JSON evidence만으로 cross-repo edge를 다시 만들 수 있어 invariant I-11과 맞는다.

## Matching Rules

Lane은 다음 조건이 모두 참일 때만 cross-repo impact를 낸다:

- changed file path가 현재 repo의 indexed contract path와 같다;
- local DB에 workspace row가 있다;
- `BREAKS_COMPATIBILITY_WITH` link가 해당 workspace에 속한다;
- parsed provenance provider `contractPath`가 changed contract path와 같다;
- 사용 가능한 repo identity가 있으면 parsed provenance provider repo가 현재 repo와 일치한다;
- parsed provenance에 consumer file path와 evidence snippet이 있다.

Invalid 또는 legacy provenance는 throw하지 않는다. 해당 link는 skip하고, malformed cross-repo link가 몇 개 무시됐는지 report warning 하나에 기록한다.

## UI, MCP, Graph 동작

이 slice에는 새 command가 필요 없다.

Primary surface는 report를 통해 새 데이터를 받는다:

- CLI `analyze --json`은 `crossRepoImpacts`를 포함한다.
- MCP `parallax_analyze_diff`도 같은 report field를 반환한다.
- persisted report resource도 해당 field를 포함한다.
- graph export는 report evidence에서 cross-repo `BREAKS_COMPATIBILITY_WITH` edge를 렌더링한다.
- UI는 기존 affected/inspector flow 안에 cross-repo impact를 보여주고 `cross-repo` 같은 작은 lane label을 붙인다.

UI에 display label용 작은 mapping helper가 필요하면 UI data preparation 안에만 둔다. Report JSON과 drift될 수 있는 별도 data source는 만들지 않는다.

## Error Handling

- Workspace 없음: cross-repo impact 없음, warning 없음.
- Workspace는 있지만 matching breaking link 없음: cross-repo impact 없음, warning 없음.
- Malformed provenance: malformed link를 skip하고 deterministic warning 하나를 추가.
- Stale workspace link: 기존 link confidence와 evidence를 표시하고 재계산하지 않음. Stale/orphan detection은 미래 W2 verification command 범위.
- Absolute path: docs나 public-facing report display label에 local machine path를 넣지 않음.

## Tests

구현 전 focused coverage를 추가한다:

1. Changed file이 provider contract일 때 `analyzeDiff`가 persisted `BREAKS_COMPATIBILITY_WITH` link를 표시한다.
2. Emitted report가 consumer file에 대한 `crossRepoImpacts`, `affectedFiles`, `affected`, relation-bearing evidence를 포함한다.
3. Persisted report에서 만든 report graph export가 cross-repo `BREAKS_COMPATIBILITY_WITH` edge를 포함하고 cross-repo row를 조회하지 않아도 안정적이다.
4. Non-contract changed file과 matching breaking link가 없는 contract는 기존 report output을 유지한다.
5. Malformed breaking-link provenance는 deterministic warning 하나와 함께 skip된다.
6. Optional field와 schema version bump 후 report schema drift guard가 통과한다.

## Documentation

구현 slice에서 다음 public docs를 갱신한다:

- `docs/cli-reference*.md`: workspace link가 있으면 `analyze`가 cross-repo consumer impact를 포함할 수 있음을 설명.
- `docs/mcp*.md`: `parallax_analyze_diff`가 같은 cross-repo section을 반환함을 설명.
- `docs/report-schema*.md`: documented current version을 bump하고 `crossRepoImpacts`를 설명.
- `docs/roadmap*.md`: 구현 후 W1 shipped 표시.
- `IMPROVEMENT_OPPORTUNITIES.md`: W1을 shipped로 옮기고 sequencing 갱신.

영어, 한국어, 중국어 문서는 의미가 같아야 한다.

## Implementation Boundary

이 설계는 다음을 구현하지 않는다:

- `analyzeDiff` 안에서 contract diff 자동 실행;
- W2 범위인 cross-repo link reconciliation 또는 bidirectional repair;
- W3 범위인 monorepo sub-package cataloging;
- 새 MCP write surface;
- network access 또는 remote repository discovery.

## Verification Gate

Merge 전 구현은 다음을 통과해야 한다:

```bash
npm run schemas:build
npm run lint
npm test
npm run test:mcp
npm run test:ui
npm run verify
```

개발 중 scoped test를 먼저 돌릴 수 있지만 final acceptance에는 `npm run verify`가 필요하다.

## Open Implementation Notes

- SQL/provenance parsing이 compact function을 넘어서면 `src/analyzer.ts` 내부 작은 helper 또는 dedicated module인 `loadCrossRepoImpactsForChangedContract(...)`를 선호한다.
- `src/mcp_resources.ts`의 `workspaceResources(...)` 재사용이 layering cycle을 만들지 않을 때만 재사용한다. Cycle이 생기면 URI construction을 shared helper로 옮긴다.
- Warning text는 deterministic하고 기존 warnings와 함께 sort되어야 한다.
- 기존 persisted report가 계속 읽히도록 `CrossRepoImpact`는 additive/optional로 유지한다.
