# Cross-Repo Primary Impact 구현 계획

**한국어** · [English](2026-06-25-cross-repo-primary-impact.md) · [中文](2026-06-25-cross-repo-primary-impact.zh.md)

> **agentic worker용:** 이 계획을 실행할 때는 `superpowers:subagent-driven-development`(권장) 또는 `superpowers:executing-plans`를 사용한다. 세부 코드 스니펫과 정확한 단계는 canonical 영문 문서에 둔다.

**목표:** 저장된 workspace breaking-contract consumer를 기본 `analyzeDiff` report, graph export, MCP report payload, UI workbench에 직접 노출한다.

**아키텍처:** `crossRepoImpacts` report 필드를 additive로 추가하고, 기존 `BREAKS_COMPATIBILITY_WITH` workspace link를 affected target과 relation-bearing evidence로 변환하는 read-only analyzer lane을 만든다. Contract diff 재계산은 별도 workflow로 유지하며, `analyzeDiff`는 이미 저장된 link만 읽고 malformed provenance는 deterministic warning으로 보고한다.

**기술 스택:** TypeScript, Node.js `node:test`, SQLite via `node:sqlite`, zod report schema, 기존 Parallax workspace/contract-diff resolver, 3개 언어 Markdown 문서.

## 전역 제약

- `analyzeDiff`에서 `analyzeContractDiff`, `resolveCrossRepoContracts`, workspace mutation을 실행하지 않는다.
- changed file이 현재 repo의 latest completed index run에 있는 provider contract path와 일치할 때만 cross-repo lane을 실행한다.
- 같은 provider repo와 contract path를 가리키는 저장된 `BREAKS_COMPATIBILITY_WITH` link만 사용한다.
- invalid/legacy provenance는 throw하지 않고 skip하며, skipped count를 하나의 deterministic warning으로 보고한다.
- absolute local repo path를 report field, UI label, docs example, screenshot에 노출하지 않는다.
- `crossRepoImpacts`는 optional/additive이며 기존 persisted report는 계속 읽힌다.
- cross-repo evidence에는 graph export가 report JSON만으로 edge를 복원할 수 있도록 `subject`, `target`, `relationKind`, `relationConfidence`, `extractorId: 'cross-repo-contract-impact'`를 포함한다.
- 이 slice에서는 새 command나 MCP write surface를 추가하지 않는다.
- 영어/한국어/중국어 문서는 의미가 일치해야 한다.
- 최종 수용 기준은 `npm run schemas:build`, `npm run lint`, `npm test`, `npm run test:mcp`, `npm run test:ui`, `npm run verify` 통과다.

## 파일 구조

- `src/workspace_resources.ts`를 새로 만들어 `parallax://workspaces/{name}` URI helper를 MCP/UI/analyzer가 공유한다.
- `src/cross_repo_impact.ts`를 새로 만들어 저장된 breaking link를 `CrossRepoImpactCandidate`로 변환하는 read-only loader를 둔다.
- `src/types.ts`, `src/index.ts`, `src/report_schema.ts`, `schemas/impact-report.schema.json`에 `CrossRepoImpact`와 schema `1.3.0`을 반영한다.
- `src/analyzer.ts`에서 changed contract마다 loader를 호출하고 `affectedFiles`, `affected`, `evidence`, warning, report payload에 병합한다.
- `src/mcp_resources.ts`, `src/ui/data.ts`의 중복 workspace URI helper를 공유 helper로 교체한다.
- `src/ui.ts`, `src/ui/shared.ts`, `src/ui/panels.ts`, `src/ui/client.ts`에서 cross-repo preview/lane/source-link 동작을 갱신한다.
- `tests/report-schema.test.ts`, `tests/contract-diff.test.ts`, `tests/ui.test.ts`에 schema/analyzer/graph/malformed/UI regression을 추가한다.
- 구현 후 `docs/cli-reference*`, `docs/mcp*`, `docs/report-schema*`, `docs/roadmap*`, `IMPROVEMENT_OPPORTUNITIES.md`를 갱신한다.

## Task 1: Report contract와 workspace resource helper

수정 범위:

- `src/workspace_resources.ts`
- `src/types.ts`
- `src/index.ts`
- `src/report_schema.ts`
- `schemas/impact-report.schema.json`
- `src/mcp_resources.ts`
- `src/ui/data.ts`
- `tests/report-schema.test.ts`

핵심 결과:

- `CrossRepoImpact` type과 optional `ImpactReport.crossRepoImpacts`를 추가한다.
- `IMPACT_REPORT_SCHEMA_VERSION`을 `1.3.0`으로 올린다.
- `workspaceResources(workspaceName)` helper를 MCP/UI/analyzer가 공유한다.
- schema artifact를 재생성한다.

검증:

```bash
npm run schemas:build
node --import tsx --test tests/report-schema.test.ts
npm run schemas:check
npm run check
```

커밋:

```bash
git commit -m "feat(report): add cross-repo impact schema"
```

## Task 2: Analyzer cross-repo lane

수정 범위:

- `src/cross_repo_impact.ts`
- `src/analyzer.ts`
- `tests/contract-diff.test.ts`

핵심 결과:

- `loadCrossRepoImpactsForChangedContract(...)`를 구현한다.
- provider-owned workspace fixture로 실제 persisted `BREAKS_COMPATIBILITY_WITH` link를 만든다.
- `analyzeDiff`가 `web:src/client.ts` 같은 external consumer를 `crossRepoImpacts`, `affectedFiles`, `affected`, relation-bearing `evidence`에 포함한다.
- graph export가 persisted report evidence에서 `BREAKS_COMPATIBILITY_WITH` edge를 복원한다.
- malformed provenance는 하나의 warning으로 skip된다.

검증:

```bash
node --import tsx --test tests/contract-diff.test.ts --test-name-pattern "analyzeDiff surfaces persisted cross-repo|malformed cross-repo|non-contract changed"
npm run check
```

커밋:

```bash
git commit -m "feat(analyze): surface cross-repo contract impact"
```

## Task 3: UI preview, lane label, external evidence source

수정 범위:

- `src/ui.ts`
- `src/ui/data.ts`
- `src/ui/shared.ts`
- `src/ui/panels.ts`
- `src/ui/client.ts`
- `tests/ui.test.ts`

핵심 결과:

- `UiReportPreview.crossRepoImpacts`를 추가한다.
- workbench impact lane에 `Cross-repo consumers`를 추가하고 한국어/중국어 label도 넣는다.
- `cross-repo-contract-impact` evidence와 external affected path에는 로컬 `/source?path=...` 링크를 만들지 않는다.
- UI bootstrap/report HTML에 workspace resource URI가 표시된다.

검증:

```bash
node --import tsx --test tests/ui.test.ts --test-name-pattern "cross-repo consumer impacts|list-first report workbench"
```

커밋:

```bash
git commit -m "feat(ui): show cross-repo consumer impact"
```

## Task 4: Public docs, verification, review, push

수정 범위:

- `docs/cli-reference.md`, `docs/cli-reference.ko.md`, `docs/cli-reference.zh.md`
- `docs/mcp.md`, `docs/mcp.ko.md`, `docs/mcp.zh.md`
- `docs/report-schema.md`, `docs/report-schema.ko.md`, `docs/report-schema.zh.md`
- `docs/roadmap.md`, `docs/roadmap.ko.md`, `docs/roadmap.zh.md`
- `IMPROVEMENT_OPPORTUNITIES.md`

핵심 결과:

- CLI/MCP 문서에 `crossRepoImpacts`가 이미 저장된 workspace breaking link를 surfacing한다는 점을 설명한다.
- report schema docs의 current version을 `1.3.0`으로 갱신한다.
- W1을 roadmap/backlog에서 shipped로 표시한다.
- 최종 verify 결과와 review 상태를 `.superpowers/sdd/progress.md`, `.superpowers/sdd/CLAUDE_HANDOFF.md`에 남긴다.

최종 검증:

```bash
npm run schemas:build
npm run schemas:check
npm run docs:lint
npm run lint
npm test
npm run test:mcp
npm run test:ui
npm run verify
git diff --check
```

커밋 및 push:

```bash
git commit -m "docs: document cross-repo primary impact"
git push origin main
```
