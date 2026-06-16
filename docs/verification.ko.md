# Parallax — 검증과 테스트

[English](verification.md) · **한국어** · [中文](verification.zh.md)

Parallax는 정확성을 여러 계층으로 검증한다 — 빠른 unit suite, typecheck, docs linter, deterministic accuracy bench, 그리고 Parallax를 자기 자신에 대해 다시 인덱싱하는 dogfood guard. CI는 모든 push와 pull request마다 이 전부를 실행한다. 이 문서는 각 계층이 무엇을 잡아내고 언제 실행해야 하는지 설명한다 — 핵심 교훈은 green unit test가 engine 변경에 **필요하지만 충분하지는 않다**는 것이다.

## script 한눈에 보기

아래 명령은 모두 `package.json`에 정의된 `npm run` script다.

| 명령 | 하는 일 | 실행 시점 |
| :--- | :--- | :--- |
| `npm test` | `tsx --test`로 `tests/**/*.test.ts`에 대해 Node test runner 실행 | 모든 변경 후. 기본 빠른 suite |
| `npm run check` | `tsc --noEmit` typecheck, 출력 없음 | commit 전. type 회귀를 잡음 |
| `npm run lint` | `check` + `docs:lint`를 함께 실행 | commit / PR 전. 전체 static gate |
| `npm run docs:lint` | tracked/untracked Markdown에 대해 `scripts/docs-lint.js` 실행, local `.md` link target 포함 | 문서를 편집한 뒤 |
| `npm run verify` | canonical source-checkout release gate 실행: lint, install smoke, fast test, dogfood, bench, high-level audit | release 전과 CI |
| `npm run build` | `tsc -p tsconfig.json`, `dist/`로 compile | 배포하거나 CLI를 smoke test하기 전 |
| `npm run bench` | `bench/impact-bench.ts` 실행. accuracy 회귀 시 non-zero로 종료 | engine/adapter 변경 후 |
| `npm run test:dogfood` | Parallax를 자기 source에 대해 인덱싱하고 내부 graph가 살아남는지 검증 | engine 변경 후(indexer/adapters/analyzer/store/graph) |
| `npm run test:mcp` | `tests/mcp.test.ts` 실행(impact / context / memory / telemetry / path validation) | MCP surface 변경 후 |
| `npm run test:ui` | `tests/ui.test.ts` 실행(UI snapshot, server, JSON resource endpoint) | UI 변경 후 |
| `npm run test:security` | `tests/security.test.ts` 실행(path containment + redaction) | store / path / redaction 변경 후 |
| `npm run test:install-smoke` | `npm run build` 후 `node dist/src/cli.js --help` | 릴리스 전, 패키징된 CLI가 실행되는지 확인 |

`test:fixtures`는 `npm test`의 alias이고, `test:benchmark`는 `npm run bench`의 alias다. `npm run verify`에는 `npm audit --audit-level=high`가 포함되므로 마지막 audit 단계는 npm registry와 network 상태에 의존한다.

## dogfood guard — 진짜 안전망

`tests/dogfood.integration.ts`는 반드시 이해해야 할 가장 중요한 계층이다. 이것이 존재하는 이유는, 과거에 green unit suite가 완전히 망가진 내부 의존성 graph와 공존했기 때문이다 — 실제 NodeNext `./x.js` import가 `external_entity`로 무너져, 많이 import되는 모듈이 코드 의존자(dependent)를 **0**으로 보고했는데도 모든 unit test가 green이었다. unit suite는 사용자가 보는 방식으로 실제 engine 출력을 보지 않았던 것이다.

dogfood guard는 그 틈을 메운다. 각 test에서:

1. Parallax 자신의 `src/`를 격리된 임시 repo로 복사한 뒤 그 위에서 `initProject` + `indexProject`를 실행한다 — 실제 사용자 경로다.
2. `src/store.ts`에 대해 `analyzeDiff`를 호출하고, `proven` confidence를 가진 `src/` 아래 의존자가 최소 `MIN_PROVEN_SRC_DEPENDENTS`(5)개 이상이며, 최상위로 랭크된 affected file 자체가 `proven` `src/` 의존자임을 검증한다(이는 confidence 우선 정렬도 함께 보호한다).
3. 정규 store를 read-only로 열어 `relations` + `entities` 테이블에 raw SQL을 실행한다. target이 로컬 `src/%` 엔티티이고 `kind != 'external_entity'`인 `DEPENDS_ON` edge 수를 세고(`MIN_INTERNAL_DEPENDS_ON_ROWS`, 20을 초과해야 함), `file:src/store.ts`의 `proven` `src/%` 의존자 수를 센다(하한 5에 도달해야 함).

이 assertion들은 **정확한 개수가 아니라 하한(floor)** 을 사용하므로 정당한 refactor가 test를 깨지 않는다. 판별 기준은 원래 버그가 만들어낸 *~0으로의 붕괴*이지 어떤 정확한 숫자가 아니다. SQL은 일부러 정규 `relations` + `entities` 테이블과 `external_entity` 붕괴를 겨냥한다 — 바로 그것이 이 test가 막는 실패 양상이다.

### 왜 `npm test`에 들어 있지 않은가

기본 suite는 `tests/**/*.test.ts`를 glob한다. 이 guard의 이름은 `tests/dogfood.integration.ts`로 — `*.test.ts`와 **일치하지 않으므로** glob이 설계상 이를 건너뛴다(전체 source 트리를 다시 인덱싱하므로 느리기도 하다). `npm run test:dogfood`와 CI는 파일을 직접 지정해 실행한다.

**교훈:** green `npm test`는 필요하지만 충분하지 않다. engine에 대한 모든 변경 — indexer, adapters, analyzer, store, graph, cross-repo — 은 unit이 green인 것만으로는 안 되고 dogfood로 검증해야 한다. unit suite가 green인 동안에도 실제 graph가 망가져 있을 수 있기 때문이다.

## accuracy bench

`bench/impact-bench.ts`는 고정된 multi-language fixture(TypeScript/JavaScript, JVM/Spring Boot, Python, Go, Rust, OpenAPI contract, build manifest)를 만들어 인덱싱하고, 그 결과 graph를 pin된 기대 relation 집합과 대조해 채점한다. pin하는 항목:

- **relation recall과 precision** — 기대된 모든 relation이 매칭되어야 하고, 예상치 못한 relation이 없어야 한다.
- **affected-file recall** — 변경 파일에 대한 `analyzeDiff`가 기대된 모든 의존자를 드러내야 한다.
- **evidence presence, span completeness, adapter attribution** — relation은 evidence/span을 지니고 올바른 adapter에 귀속되어야 한다.
- **retrieval 지표** — brief context budget 안에서 `searchContextForRepo`의 recall/precision/MRR/nDCG.

runner는 deterministic JSON 리포트를 쓰고, suite가 통과하지 못하면 non-zero exit code를 설정한다. surface는 둘이다:

- `tests/impact-bench.test.ts`는 `npm test`의 일부로 bench를 실행하고, 리포트 형태와 pin된 기대 relation 집합, 그리고 score/recall 임계값을 검증한다.
- `npm run bench`는 `bench/impact-bench.ts`를 직접 실행하고 recall/score 회귀 시 non-zero로 종료한다 — CI가 쓰는 형태다.

relation 추출, 랭킹, retrieval을 건드리는 변경 후에는 `npm run bench`를 실행하자.

## docs linter

`scripts/docs-lint.js`(`npm run docs:lint`로 실행)는 tracked Markdown과 ignore되지 않은 local untracked Markdown에 대한 static gate다. 다음을 강제한다:

- **금지 콘텐츠 없음** — 로컬 머신 경로, restore-point 메타데이터, API key, service token, bearer/JWT credential, credential이 포함된 database URL, private key 같은 runtime redaction 대상 secret family. 이 스캔은 fenced code block을 포함한 raw 텍스트에서 실행된다.
- **trilingual parity** — trilingual zone(`docs/`에서 `docs/assets/` 제외, `skills/`, 루트 `README`/`CONTRIBUTING`/`SECURITY`)의 모든 문서는 `X.md`, `X.ko.md`, `X.zh.md` 셋을 모두 가져야 한다.
- **switcher 존재** — 각 파일은 다른 두 언어 변형으로 링크해야 한다(H1 아래의 언어 switcher).
- **same-language 내부 링크** — `X.ko.md` 안에서는 같은 언어 twin이 존재하는 한 내부 `.md` 링크가 `.ko.md` 형제를 가리켜야 한다(`X.zh.md` 안에서는 `.zh.md`). switcher 줄만이 허용된 유일한 cross-language 예외다. 링크 검사에서 fenced code block은 무시되므로 code block 안의 markdown 링크 *예시* 는 안전하다.
- **존재하는 local Markdown target** — image가 아닌 local `.md` 링크는 staged 전 새 untracked 문서를 포함해 working tree 안의 Markdown 파일로 resolve되어야 한다.

## 지속적 통합(CI)

`.github/workflows/ci.yml`은 `main`으로의 모든 push와 pull request에서 실행된다. `verify` job은 Node.js 24에서 다음 순서로 실행된다:

```bash
npm ci
npm run verify
```

`npm run verify`는 canonical source-checkout gate다. lint를 먼저 실행한 뒤 install smoke(유일한 build를 담당), fast unit suite, dogfood, bench, 마지막으로 registry-dependent audit을 실행한다.

## 테스트를 추가하는 법

테스트는 `tests/` 아래에 있으며 **Arrange-Act-Assert** 패턴을 따른다 — 격리된 임시 repo를 준비하고, 실제 진입점(`initProject` / `indexProject` / `analyzeDiff` / `searchContextForRepo`)을 실행한 뒤 결과를 검증한다. 대부분의 suite는 임시 디렉터리를 만들고 정리하므로 각 test가 격리된다.

- **unit과 integration test**는 `tests/*.test.ts`이며 `npm test`로 실행된다.
- **adapter 변경**은 추가로 `bench/impact-bench.ts`의 bench fixture에 새 기대 relation을 더해야 하고, [`extending-adapters.ko.md`](extending-adapters.ko.md)에 설명된 evidence/confidence 규율을 따라야 한다.
- **engine 변경** — indexer, adapters, analyzer, store, graph, cross-repo 계층 어디든 — 은 unit이 green인 것만으로는 안 되고 `npm run test:dogfood`로 dogfood 검증해야 한다. relation 추출이나 랭킹 방식을 바꿨다면 `npm run bench`를 다시 실행하고, pin된 기댓값은 변경이 의도된 경우에만 갱신하자.

PR을 열기 전에 전체 로컬 gate를 실행하자:

```bash
npm run verify
```

## 함께 보기

- [extending-adapters.ko.md](extending-adapters.ko.md) — adapter contract, evidence/confidence 규율, adapter 테스트
- [invariants.ko.md](invariants.ko.md) — bench가 확인하는 evidence-first와 deterministic-output 불변 원칙
- [cli-reference.ko.md](cli-reference.ko.md) — 테스트가 행사하는 CLI surface
- [README.ko.md](README.ko.md) — 문서 인덱스
