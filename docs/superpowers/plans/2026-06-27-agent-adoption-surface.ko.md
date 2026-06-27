# Agent Adoption Surface 구현 계획

[English](2026-06-27-agent-adoption-surface.md) · **한국어** · [中文](2026-06-27-agent-adoption-surface.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조사로 확인한 7개 adoption slice를 순서대로 구현해 Parallax impact graph를 GitHub Code Scanning, Copilot/custom-agent 설치, 구조화 MCP 결과, repo-map context card, foreground status/watch UX, 더 풍부한 docs impact, deterministic security-routing recommendation으로 노출한다.

**Architecture:** `ImpactReport`를 권위 있는 분석 산출물로 유지하고 SARIF, MCP structured result, repo map, routing recommendation은 순수 projection layer로 추가한다. local-first SQLite, read-only-first agent surface, explicit trigger, recommendation-only action 모델을 유지한다. 각 slice는 독립적으로 테스트하고 리뷰한 뒤 다음 slice로 넘어간다.

**Tech Stack:** TypeScript, Node.js `node:test`, `node:sqlite` 기반 SQLite, Zod input schema를 쓰는 MCP SDK, SARIF 2.1.0 JSON, GitHub Actions composite action metadata, 3개 언어 Markdown 문서.

## Global Constraints

- Node runtime은 `>=24.0.0`을 유지한다.
- background daemon이나 implicit listener를 만들지 않는다. `watch`는 명시적으로 실행한 foreground CLI process여야 한다.
- MCP tool은 source tree를 수정하지 않는다. 기존 MCP telemetry/context-pack local database write는 허용하되 계속 문서화한다.
- Semgrep, OpenRewrite, CodeQL, GitHub upload를 자동 실행하지 않는다. Parallax는 사용자가 외부 tool을 직접 실행할 수 있도록 file, command, recommendation만 낸다.
- 출력은 deterministic이어야 한다: stable sort, stable rule id, stable partial fingerprint, bounded snippet.
- `docs/`의 공개 문서는 `X.md`, `X.ko.md`, `X.zh.md`를 함께 유지한다.
- `docs/mcp*.md`를 바꾸면 MCP tools table과 `tools/list` 테스트를 맞춘다.
- `ImpactReport` shape를 바꾸면 `src/report_schema.ts`, `schemas/impact-report.schema.json`, `docs/report-schema*.md`, schema test를 같은 task에서 갱신한다.
- SARIF output은 `2.1.0`을 사용한다. GitHub upload 문서는 같은 SARIF 파일 안에 동일 tool/category run을 중복하지 않도록 안내한다.
- 외부 근거는 2026-06-27 기준 GitHub SARIF upload/support 문서, GitHub Copilot custom-agent 문서, MCP `outputSchema`/`structuredContent` 문서, Semgrep MCP deprecation notice를 사용한다.

---

## Scope Check

이 계획은 하나의 작은 기능이 아니라 7개 adoption slice 프로그램이다. 사용자가 1~7 순서 실행을 명시했으므로 하나의 ordered ledger로 관리한다. 각 task는 독립적으로 동작하고 테스트 가능한 software를 만들며, 리뷰가 끝나야 다음 task로 간다.

## Grill Decisions

1. **MCP structured output이 agent package에 유리하니 Task 3을 Task 2보다 먼저 할까?** 아니다. 요청 순서가 1~7이므로 Task 2는 현재 MCP tool 이름을 기준으로 유용한 Copilot/custom-agent package를 먼저 제공하고, Task 3은 같은 tool 이름에 structured output을 추가한다.
2. **SARIF를 stored report schema 변경으로 만들까?** 아니다. SARIF는 `ImpactReport`에서 파생되는 projection이다. 그래서 `analyze --json`과 report schema를 흔들지 않는다.
3. **SARIF를 stdout 전용으로 만들까?** 아니다. CI log와 machine JSON이 섞이지 않게 `--sarif-output <path>`를 먼저 제공한다.
4. **status/watch가 daemon을 만들어도 될까?** 아니다. invariant와 security test가 implicit daemon을 금지한다. `status`는 read-only이고 `watch`는 foreground-only다.
5. **Semgrep/OpenRewrite routing이 tool을 실행해도 될까?** 아니다. 기존 `ImpactAction`의 recommendation 모델에 command/args만 구조화해서 넣는다.

## File Structure

- `src/sarif.ts`를 추가해 `ImpactReport`에서 SARIF 2.1.0을 만든다.
- `src/cli.ts`는 `analyze --sarif-output`, `install-agent` package flag, `repo-map`, `status`, `watch`를 순차적으로 받는다.
- `src/index.ts`는 각 slice의 public helper를 export한다.
- `action.yml`은 Parallax SARIF 생성을 위한 optional GitHub composite action이다.
- `src/agent_config.ts`는 MCP config, Copilot instructions, custom-agent file 계획을 만든다.
- `src/mcp_output_schemas.ts`는 MCP `outputSchema`를 공유한다.
- `src/mcp.ts`는 `outputSchema`, `structuredContent`, 이후 `parallax_repo_map`을 제공한다.
- `src/repo_map.ts`는 token-budgeted repo map/context card를 만든다.
- `src/status.ts`는 read-only status summary와 foreground watch loop를 담당한다.
- `src/adapters/multi-language-regex.ts`, `src/artifacts.ts`, `src/work_artifacts.ts`, `src/ui/data.ts`, `src/context_pack.ts`는 docs/knowledge-base impact graph를 확장한다.
- `src/routing_recommendations.ts`는 Semgrep/OpenRewrite/CodeQL recommendation rule을 deterministic하게 만든다.

---

### Task 1: SARIF Export And GitHub Action

**Files:** `src/sarif.ts`, `tests/sarif.test.ts`, `action.yml`, `src/cli.ts`, `src/index.ts`, `tests/parallax.test.ts`, README 3종, `docs/cli-reference*.md`, `docs/report-schema*.md`, `docs/roadmap*.md`, `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `impactReportToSarif(report, options)`와 CLI `parallax analyze --sarif-output <path> [--sarif-category <category>]`.

- [ ] **Step 1: 실패하는 SARIF serializer test 작성**

`tests/sarif.test.ts`에서 `ImpactReport` fixture가 SARIF `version: "2.1.0"`, `tool.driver.name: "Parallax"`, `automationDetails.id`, affected file location, region, stable `partialFingerprints.parallaxImpact`, evidence id를 내는지 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --test tests/sarif.test.ts`

Expected: `src/sarif.ts`가 없어서 FAIL.

- [ ] **Step 3: `src/sarif.ts` 구현**

`node:crypto` hash로 fingerprint를 만들고, confidence별 rule id, changed/evidence related locations, relation path 기반 code flow, bounded snippet, repo-relative URI 정규화를 구현한다.

- [ ] **Step 4: public export 추가**

`src/index.ts`에서 `impactReportToSarif`, `SarifLog`, `SarifOptions`를 export한다.

- [ ] **Step 5: CLI 파일 출력 추가**

`src/cli.ts`의 `analyze`에 `--sarif-output <path>`, `--sarif-category <category>`를 추가한다. `--json`과 같이 쓰면 명확한 오류를 낸다. parent directory를 만들고 pretty JSON을 쓴다. stdout은 기존 human summary를 유지한다.

- [ ] **Step 6: CLI regression test 작성**

`tests/parallax.test.ts`에서 temp repo를 만들고 `analyze --changed ... --sarif-output parallax.sarif --sarif-category unit`을 실행한 뒤 SARIF file의 version, category, URI를 검증한다.

- [ ] **Step 7: GitHub composite action 추가**

`action.yml`은 `changed`, `sarif-output`, `sarif-category`, `fail-on` input을 받고 `npx parallax analyze ... --sarif-output ...`만 실행한다. SARIF upload는 README workflow snippet에서 `github/codeql-action/upload-sarif@v3`로 별도 안내한다.

- [ ] **Step 8: 문서 갱신**

CLI flag, SARIF가 report schema bump가 아니라 projection이라는 점, GitHub Code Scanning workflow 예시, roadmap/backlog 상태를 영어/한국어/중국어 문서에 반영한다.

- [ ] **Step 9: 검증 및 commit**

```bash
node --import tsx --test tests/sarif.test.ts
node --import tsx --test tests/parallax.test.ts --test-name-pattern "SARIF|CLI analyze"
npm run check
npm run docs:lint
git diff --check
git commit -m "feat: export impact reports as sarif"
```

### Task 2: Copilot Custom-Agent Install Package

**Files:** `src/agent_config.ts`, `src/cli.ts`, `tests/agent-config.test.ts`, `docs/cli-reference*.md`, `docs/mcp*.md`, `docs/roadmap*.md`, `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `planCopilotAgentPackage(options)`, `installCopilotAgentPackage(options)`, CLI `parallax install-agent --copilot-package --target <repo> [--dry-run] [--force]`.

- [ ] Dry-run, no-overwrite, `--force`, generated `.github/copilot-instructions.md`, `.github/agents/parallax-impact.agent.md`, MCP config snippet을 테스트한다.
- [ ] Template generation은 pure function으로 만들고 filesystem write는 얇게 둔다.
- [ ] CLI는 planned relative path와 action을 출력한다.
- [ ] Docs는 이 명령이 GitHub에 접근하지 않고 target repo 파일만 쓴다고 말한다.
- [ ] Verify: `node --import tsx --test tests/agent-config.test.ts && npm run check && npm run docs:lint && git diff --check`.
- [ ] Commit: `git commit -m "feat: generate copilot agent package"`.

### Task 3: MCP Output Schemas And Structured Content

**Files:** `src/mcp_output_schemas.ts`, `src/mcp.ts`, `tests/mcp.test.ts`, `docs/mcp*.md`

**Interfaces:** tool별 `outputSchema`, `toolJsonResponse(value)`의 `structuredContent`, 기존 `content[0].text` mirror 유지.

- [ ] `tools/list`가 representative tool의 `outputSchema`를 노출하는지 테스트한다.
- [ ] tool call 결과의 `structuredContent`가 `JSON.parse(content[0].text)`와 같은지 테스트한다.
- [ ] 기존 JSON-returning tool을 shared helper로 통일한다.
- [ ] Verify: `npm run test:mcp && npm run check && npm run docs:lint && git diff --check`.
- [ ] Commit: `git commit -m "feat: expose structured mcp outputs"`.

### Task 4: Repo Map And Context Card

**Files:** `src/repo_map.ts`, `tests/repo-map.test.ts`, `src/types.ts`, `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `tests/mcp.test.ts`, `docs/cli-reference*.md`, `docs/mcp*.md`, `docs/roadmap*.md`, `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `buildRepoMap(options): RepoMap`, CLI `parallax repo-map --changed <files> [--query <text>] [--budget <tokens>] [--json]`, MCP `parallax_repo_map`.

- [ ] changed root, affected file, test, docs, work artifact, evidence, action, `parallax://` resource ranking과 omitted count를 테스트한다.
- [ ] `buildContextPack`, `searchContext`, graph resource를 재사용한다.
- [ ] token budget은 `Math.ceil(text.length / 4)` 추정으로 문서화한다.
- [ ] Verify: `node --import tsx --test tests/repo-map.test.ts && npm run test:mcp && npm run check && npm run docs:lint && git diff --check`.
- [ ] Commit: `git commit -m "feat: build token-budgeted repo maps"`.

### Task 5: Status And Foreground Watch UX

**Files:** `src/status.ts`, `tests/status.test.ts`, `src/cli.ts`, `src/index.ts`, `tests/security.test.ts`, `docs/cli-reference*.md`, `docs/operations*.md`, 필요 시 `docs/invariants*.md`

**Interfaces:** `getProjectStatus(options): ProjectStatus`, CLI `parallax status [--json]`, CLI `parallax watch --changed <files> [--interval <seconds>]`.

- [ ] latest index run, coverage, adapter health, vector state, telemetry count, next command를 status test로 검증한다.
- [ ] `doctorProject()` projection을 재사용한다.
- [ ] `watch`는 foreground polling만 수행하고 SIGINT에서 종료한다.
- [ ] Security test가 implicit daemon/listener 금지를 계속 보장한다.
- [ ] Verify: `node --import tsx --test tests/status.test.ts && npm run test:security && npm run check && npm run docs:lint && git diff --check`.
- [ ] Commit: `git commit -m "feat: add explicit status and watch ux"`.

### Task 6: Docs And Knowledge-Base Impact Graph

**Files:** `src/adapters/multi-language-regex.ts`, `src/artifacts.ts`, `src/work_artifacts.ts`, `src/ui/data.ts`, `src/context_pack.ts`, `tests/parallax.test.ts`, `tests/work_artifacts.test.ts`, `tests/ui.test.ts`, `tests/mcp.test.ts`, `docs/architecture*.md`, `docs/glossary*.md`

**Interfaces:** Markdown wiki link, Markdown link, ADR/policy/PRD heading anchor, ownership reference, requirement id를 evidence 있는 relation으로 추출한다.

- [ ] code change가 policy/ADR/PRD docs impact를 드러내고, doc change가 governed code/tests/resources를 드러내는 fixture를 추가한다.
- [ ] 모든 새 relation은 evidence file/span, extractor id, confidence, bounded snippet을 가진다.
- [ ] UI payload는 full body가 아니라 resource URI와 freshness만 노출한다.
- [ ] Verify: relevant `parallax`, `work_artifacts`, UI, MCP tests와 `npm run bench`, `npm run check`, `npm run docs:lint`.
- [ ] Commit: `git commit -m "feat: expand docs impact graph"`.

### Task 7: Semgrep And OpenRewrite Routing Recommendations

**Files:** `src/routing_recommendations.ts`, `tests/routing-recommendations.test.ts`, `src/analyzer.ts`, `src/index.ts`, `docs/report-schema*.md`, `docs/verification*.md`, `docs/roadmap*.md`, `IMPROVEMENT_OPPORTUNITIES.md`

**Interfaces:** `recommendRoutingActions(reportInputs): ImpactAction[]`, 기존 `ImpactAction.kind: 'review'` 우선 사용.

- [ ] security-sensitive TypeScript/Python path는 Semgrep, Java build/API route는 OpenRewrite, docs-only/generated change는 불필요한 scanner recommendation을 만들지 않는 테스트를 작성한다.
- [ ] path/language/evidence 기반 deterministic rule을 구현하고 기존 action과 dedupe한다.
- [ ] `analyzeDiff()` action 뒤에 recommendation을 append한다.
- [ ] Verify: `node --import tsx --test tests/routing-recommendations.test.ts && node --import tsx --test tests/parallax.test.ts --test-name-pattern "actions|command" && npm run schemas:check && npm run check && npm run docs:lint && git diff --check`.
- [ ] Commit: `git commit -m "feat: recommend security routing actions"`.

## Final Program Verification

Task 7과 모든 per-task review가 끝나면:

```bash
npm run verify
git status --short --branch
```

마지막으로 `superpowers:requesting-code-review`로 whole-branch review를 실행한다. 깨끗하면 `origin/main`과 fast-forward 상태를 확인한 뒤 `main`에 push한다.

