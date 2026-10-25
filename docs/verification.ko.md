# Parallax — 검증과 테스트

[English](verification.md) · **한국어** · [中文](verification.zh.md)

Parallax는 정확성을 여러 계층으로 검증한다 — 빠른 unit suite, typecheck, docs linter, deterministic accuracy bench, 그리고 Parallax를 자기 자신에 대해 다시 인덱싱하는 dogfood guard. CI는 모든 push와 pull request마다 이 전부를 실행한다. 이 문서는 각 계층이 무엇을 잡아내고 언제 실행해야 하는지 설명한다 — 핵심 교훈은 green unit test가 engine 변경에 **필요하지만 충분하지는 않다**는 것이다.

## script 한눈에 보기

아래 명령은 모두 `package.json`에 정의된 `npm run` script다.

| 명령 | 하는 일 | 실행 시점 |
| :--- | :--- | :--- |
| `npm test` | `tsx --test`로 `tests/**/*.test.ts`에 대해 Node test runner 실행 | 모든 변경 후. 기본 빠른 suite |
| `npm run check` | `tsc --noEmit` typecheck, 출력 없음 | commit 전. type 회귀를 잡음 |
| `npm run audit:dependencies` | Fail-closed high-severity dependency audit gate 실행 | commit / PR 전과 CI에서 |
| `npm run lint` | `check` + `docs:lint`를 함께 실행 | commit / PR 전. 전체 static gate |
| `npm run docs:lint` | tracked/untracked Markdown에 대해 `scripts/docs-lint.js` 실행, local `.md` link target 포함 | 문서를 편집한 뒤 |
| `npm run verify` | canonical source-checkout release gate 실행: lint, install smoke, fast test, dogfood, bench, high-level audit | release 전과 CI |
| `npm run build` | `tsc -p tsconfig.json`, `dist/`로 compile | 배포하거나 CLI를 smoke test하기 전 |
| `npm run bench` | `bench/impact-bench.ts` 실행. accuracy 회귀 시 non-zero로 종료 | engine/adapter 변경 후 |
| `npm run bench:report` | 최신 bench JSON을 Markdown으로 렌더링하고, 선택적으로 baseline report와 비교 | `npm run bench` 후 또는 CI summary에서 |
| `npm run bench:perf` | `bench/impact-perf.ts` 실행; 합성 repo에서 full index, no-op incremental index, edited-file reindex, 각 scan phase, analyze phase 시간과 observed peak RSS를 측정(비결정적, `verify`에 미포함) | 인덱싱/traversal 성능 작업 시 |
| `npm run test:dogfood` | Parallax를 자기 source에 대해 인덱싱하고 내부 graph가 살아남는지 검증 | engine 변경 후(indexer/adapters/analyzer/store/graph) |
| `npm run test:mcp` | `tests/mcp.test.ts` 실행(impact / context / memory / telemetry / path validation) | MCP surface 변경 후 |
| `npm run test:ui` | `tests/ui.test.ts` 실행(UI snapshot, server, JSON resource endpoint) | UI 변경 후 |
| `npm run test:security` | `tests/security.test.ts` 실행(path containment, redaction, dependency audit gate) | store / path / redaction / audit gate 변경 후 |
| `npm run test:install-smoke` | `npm run build` 후 `node dist/src/cli.js --help` | 릴리스 전, 패키징된 CLI가 실행되는지 확인 |

`bench:perf`는 full/no-op/edit 실행별 `*_scan_body_reads`, `*_scan_body_bytes`, `*_scan_sample_reads`, `*_scan_sample_bytes`도 출력한다. 스캐너가 성공적으로 읽은 횟수와 파일 API가 반환한 바이트 수이며, 어댑터가 지원하지 않는 인식 가능한 파일과 크기 제한을 넘긴 파일의 일부 읽기도 포함한다. Git·메타데이터 작업, 사용자 어댑터의 직접 읽기, 장치·캐시 I/O는 제외한다. Git이 없는 no-op과 clean same-HEAD 검증 모두 본문을 읽는다. Cache miss에서는 두 번 스캔할 수 있으며 시간과 읽기량은 두 scan을 합산한다. 완료된 scan의 계측값은 `IndexOptions.perfObserver`의 선택적 세 번째 인자로 전달하며, 실패한 scan에는 계측값이 없다. CLI/index 결과 형식은 그대로 유지한다.

`test:fixtures`는 `npm test`의 alias이고, `test:benchmark`는 `npm run bench`의 alias다. `npm run verify`에는 `npm run audit:dependencies`가 포함되므로 마지막 audit 단계는 npm registry와 network 상태에 의존한다.

Dependency gate는 high/critical finding이 0개이고 exit code가 0인 유효한
npm audit v2 report만 통과시킨다. Low/moderate-only report는 허용하며 예외
allowlist는 없다. High/critical finding, count 또는 exit status 불일치,
잘못된 JSON, command/network 실패는 fail-closed로 거부한다. Gate는 raw npm
진단을 출력하지 않는다. Raw 진단이 필요하면 로컬에서
`npm audit --audit-level=high --json`을 다시 실행한다.

Security workflow의 audit 준비 설치는 `npm ci --ignore-scripts`를 사용한다.
취약점 검사는 dependency metadata와 registry 보고서를 대조하므로 ONNX 등 native
설치 script가 필요하지 않다. `npm ci`의 lock 불일치 실패와 고정된 tree 설치는 유지하고,
high/critical·명령 실패·JSON 검증 gate도 바꾸지 않는다. 실제 native 설치와 전체 실행
검증은 Release gate의 일반 `npm ci`가 담당한다.
[npm ci 공식 설명](https://docs.npmjs.com/cli/v11/commands/npm-ci/#ignore-scripts)을 기준으로
감사 job에만 범위를 제한한다. 이 선택은 registry 통신이나 Release 설치의 네트워크
실패까지 없애지는 않는다.

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

## 증분 정확성 gate

`IndexResult.mode = 'incremental'`은 검증된 scanner 입력과 선택 Git 이력이 같을 때만
사용한다. 본문·unsupported 입력·skip sample·이력이 달라지거나 이전 입력이 미검증이면
`mode = 'full'`로 전체 extraction을 수행한다. `fileContentScope`만으로 changed-only extraction을 허용할 수는 없다.
이 계약은 read 범위만 제한하며 emitted row의 ownership은 제한하지 않는다.

회귀 oracle은 `tests/incremental-index-oracle.test.ts`다. `tsconfig.json` path
alias만 바꾼 case를 포함하며, rerun graph가 같은 final tree의 fresh index와
동일해야 한다. Component test는 target-only adapter가 다른 source의 relation을
emit한 뒤 제거하는 case도 검증한다.

변경 없는 실행은 entity/contract 버전, adapter 진단과 SCIP 관계를 보존하고,
scanner의 skipped 상태만 새로 반영한다. SCIP 재import는 이전 관계를 교체하며,
co-change 갱신도 runtime trace로 높인 신뢰도를 유지한다. 저장 실패는 graph 쓰기를
모두 롤백한 뒤 실패한 실행을 기록한다. Extractor/semantics revision이 바뀌면 전체
재구축하므로, 외부 SCIP/trace 정보는 재구축 후 다시 적용해야 한다.

실제 복구는 SQL 쓰기 트랜잭션과 co-change savepoint가 담당한다. 결과를 소비하지
않던 수동 `CurrentStateSnapshot`과 행별 capture 조회·Map 복사는 제거했다.
입력 동결·yield 이벤트 복사, 발행 기준 검사와 실패 audit은 유지한다.
이는 중복 작업을 없앤 정리이며 latency·RSS 개선률을 측정한 결과는 아니다.

```bash
node --import tsx --test tests/incremental-index-oracle.test.ts
```

### 겹친 인덱싱의 발행 기준

SQL 쓰기를 차례대로 실행해도, 잠금을 얻기 전에 계산한 결과의 기준이 최신이라는
뜻은 아니다. 예를 들어 A와 B가 같은 완료 run R0를 읽고 no-op을 계산하면,
A가 행을 R1로 옮긴 뒤 B는 R0에서 옮길 graph를 찾지 못해 빈 R2를 발행할 수 있다.
Full index도 나중에 시작한 작업이 먼저 끝나면, 늦게 끝난 옛 작업이 최신 cohort와
맞지 않는 행과 memory head를 덮을 수 있다.

`persistCollectedIndexRun`은 `BEGIN IMMEDIATE` 직후, 어떤 graph/transaction도 쓰기
전에 현재 최신 completed run ID(없으면 null)와 main branch ID/head를 계획 때 값과
정확히 비교한다. 스캔 중 더 큰 ID의 run이 먼저 완료되면, 스캔 뒤 읽은 기준이
같아도 옛 ID로 행을 되돌릴 수 있으므로 최신 completed ID는 자기 ID보다 작아야 한다.
하나라도 어긋나면 `index publication baseline changed; retry indexing` 오류로 거부한다. 기존 catch는 자기 run의 실패 audit만 남기고, 새 graph·version·head를
발행하지 않는다. 실행 중인 adapter를 자동 재시도하지 않으므로 파일이 안정된 뒤
명령을 다시 실행한다. clean same-HEAD도 입력 검증 후 읽기 snapshot에서 결과만 재사용한다.

| 대안 | 판단 |
| --- | --- |
| adapter 시작 전부터 쓰기 잠금 보유 | 비동기 작업 내내 다른 writer를 막고 같은 프로세스의 동기 SQLite 대기와 충돌할 수 있다 |
| 발행 시 baseline 대조 | 기존 짧은 쓰기 트랜잭션을 유지하며 오래된 계산만 거부한다 |
| DB 전체 mutation epoch 도입 | 모든 writer와 schema를 바꿔야 하므로 이번 index/head 경쟁에는 필요하지 않다 |

원리 참고는 [SQLite transaction](https://www.sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions)의
writer admission과, Codex `970111f`의
[`Session::replace_compacted_history`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/mod.rs#L4387)다.
Codex의 Prefix 교체 분기는 준비한 요약을 설치하기 직전 state lock 안에서 history generation·길이·인증
owner를 검증하고 맞지 않으면 교체하지 않는다. Parallax는 이 발행 직전 재검증 원리를
DB의 완료 cohort와 branch head에 맞췄다. 인증·요약·자동 fallback 구조나 코드를
옮기지 않았으며 Codex 테스트는 실행하지 않았다. 전체 source version 확인 범위는
아래 파일 읽기 참고와 같다.

`tests/incremental-index-oracle.test.ts`의 결정적 순서 검사는 동시 no-op, 기존/없는
baseline의 full 역완료, adapter 실행 중 memory head 변경을 다룬다. 강화된 로컬 자원
정책에 따라 이 DB oracle은 기존 원격 CI에서 실행하고 로컬에서는 type/lint만 검사한다.
동일 cohort의 선행 SCIP import는 잠금 안에서 읽는 no-op carry에 포함되지만, full
재구축은 기존대로 augmentation을 다시 적용해야 한다. 이 guard는 파일시스템 snapshot이나
여러 SQL로 나뉜 trace writer 전체의 원자성을 보장하지 않는다.

### Clean Git 캐시와 현재 cohort

완료 run ID는 과거 실행 기록이고 `files` 등 canonical graph 행은 최신 실행으로
옮겨진다. Clean A를 만든 뒤 본문을 수정해 dirty B를 인덱싱하고 `git restore`로
A의 파일을 되돌려도, A의 행이 DB에 다시 생기지는 않는다. HEAD가 같다는 이유로
과거 clean A를 고르면 A의 ID와 0인 live-row 카운터가 함께 반환될 수 있다.

`reuseCleanGitIndexIfUnchanged`는 최신 completed row 하나를 먼저 고른 뒤 그 row의
extractor version·HEAD·clean bit를 검사한다. 조건이 맞는 과거 run을 검색하지 않는다.
Miss이면 기존 scan/delta 경로가 현재 본문을 확인해 필요한 재구축을 수행한다.
복구된 clean cohort도 다음 실행에서 실제 입력을 읽어 검증한 뒤 재사용한다. 빈 저장소도
유효하므로 0개 파일 자체를 cache miss 조건으로 삼지는 않는다.

후보를 고른 뒤 files·coverage·카운터를 여러 SQL로 읽는 동안 다른 프로세스가
행을 새 cohort로 옮길 수도 있다. 따라서 후보 선택부터 마지막 결과 조회까지
`BEGIN DEFERRED`의 읽기 snapshot으로 입력 검증까지 묶고 hit·miss·예외 모두 종료한다.
현재 WAL 설정에서는 writer slot을 차지하지 않는다. Snapshot 시작 등 치명적 오류가
기존 failed-run catch 전에 발생해도 호출자가 DB를 닫는다. 읽기 snapshot만 종료하는
`ROLLBACK`은 graph 변경 실패나 새 failed index run의 생성이라는 뜻이 아니다.

이 선택은 위 [SQLite transaction 원문](https://www.sqlite.org/lang_transaction.html)과
발행 직전에 기준을 확인하는 원리를 재사용한다. 이 DB 조회 일관성에는 global mutation
epoch나 전체 과거 graph 복사가 필요하지 않다. `tests/incremental-index-oracle.test.ts`의 원격 회귀는
A→dirty B→restore A→fresh-full 동등성→새 clean 재사용과, 후보 조회 사이 실제 별도 CLI
writer가 cohort를 발행하는 순서를 검증한다. 읽기 snapshot에서 보관한 hit도 snapshot을
종료한 뒤 autocommit 조회로 최신 completed ID를 정확히 다시 확인한다. 이동했으면
miss로 처리해 새 run/입력을 발행하며, 같은 snapshot 안의 재조회로 대체하지 않는다.
별도 CLI가 B를 발행한 뒤 파일을 A로 복원해도 latest graph가 fresh A와 같아야 한다.
마지막 ID 확인 이후의 writer 완료는 반환 전이더라도 post-admission 경쟁 범위다.
읽기 시작 실패 시 DB close도 강제로 확인한다. 스캔 observer 안에서 실제 child를 먼저
완료시킨 별도 순서도 검증한다. 더 작은 parent ID의 발행을 거부하고 child graph와 다음
clean 재사용을 유지해야 한다. 로컬에서는 이 DB 검사를 실행하지 않는다.

보장 범위는 조회 중 후보와 행의 일관성이다. 반환 직후에도 해당 run이 계속 최신이거나
Git·파일시스템 전체가 하나의 snapshot이라는 보장은 아니다. 본문을 읽어 검증하므로
읽기 snapshot이 길어질 수 있고 WAL 보존 비용도 고려해야 한다. 변경 파일만 읽는
selective scanner는 아직 활성화하지 않는다.

### Git clean과 실제 본문 변경

Git의 assume-unchanged/skip-worktree, 정규화 및 남은 stat cache는 실제 본문 변경을
clean으로 숨길 수 있다. 같은 HEAD에서도 shallow 이력을 늘리거나 줄이면 co-change
입력이 달라진다. 어댑터의 `supports()`가 hash를 바꿀 수도 있어, 분류 후 DB hash와
현재 파일을 비교하는 것만으로 과거 추출 입력을 확인할 수 없다.

`hashIndexInputs`는 분류 callback 전에 실제 scanner 순서의 경로·language·decoded
본문 hash, skipped reason/sample 값과 선택한 Git 이력을 SHA-256으로 묶는다.
이력을 한 번 캡처해 digest와 `computeCoChanges`에 같은 값을 전달한다. 계측값과
현재 시각은 포함하지 않는다. Cache hit는 이 기록이 같은 경우에만 기존 run을 반환한다.
Miss에서는 읽기 snapshot을 닫고 새 run ID를 발급한 다음 다시 scan/history를 읽는다.
먼저 읽은 결과를 새 실행에 재사용하면 그 사이 바뀐 입력을 놓치거나 발행 순서를 깨뜨릴 수 있다.

| 대안 | 판단 |
| --- | --- |
| 현재 Git flag/config 차단 | 과거 정규화와 stat cache 이력을 놓친다 |
| metadata 또는 기존 분류 후 hash 비교 | 현재 본문과 과거 실제 입력의 연결이 부족하다 |
| 기존 bounded scanner + 원본 입력 기록 | 본문을 읽는 비용으로 입력을 직접 대조하고 기존 SQL 발행 구조를 재사용한다 |

Schema v17의 nullable `index_runs.input_snapshot_hash`는 완료 graph와 같은 transaction에서
저장한다. 기존 cohort를 과거 hash로 backfill하지 않는다. NULL·알 수 없는 버전·불일치는
다음 index를 full로 승격한다. **처음 한 번 재구축한 뒤 SCIP/trace augmentation을 다시
적용해야 한다.** 이는 기존 full/reapply 계약이며 과거 audit이 graph 복구 백업이라는 뜻은 아니다.
이후 실제 동일 입력은 버전·진단·SCIP·trace를 보존한다. 이 필드를 읽지 않는 기존 v16
읽기 API는 계속 지원한다. Co-change savepoint가 실패하면 best-effort completed audit을
유지하되 receipt를 NULL로 남겨 다음 실행이 full로 회복한다. 발행 실패는 graph와 receipt를 함께 롤백한다.

원리 참고는 Bazel의 [action cache](https://bazel.build/remote/caching)와
[hermeticity](https://bazel.build/basics/hermeticity)다. 결과 재사용에는 입력의 동일성과
입력 경계가 필요하다는 개념만 적용했다. Bazel·원격 cache·sandbox를 도입하거나 코드를
복사하지 않았다. Parallax 어댑터의 임의 외부 읽기·비결정성을 격리했다는 보장도 아니다.

[PR #51](https://github.com/YouSangSon/Parallax/pull/51)의 원격 DB oracle은 Git 숨김 본문,
분류 중 hash 변경의 cache/일반 delta 경로, legacy 재구축과 재적용, 이력 증가·제거,
precheck 이후 재스캔 및 graph/receipt 실패 원자성을 다룬다. 로컬에서는 type/lint만
검사한다. 본문·sample 읽기 횟수와 바이트는 실제 두 scan까지 합산하며, Git 자체 읽기는
observer 범위 밖이다. 읽기 감소나 속도 향상을 측정한 결과가 아니다.

`parallax index --max-file-bytes 1000000`은 여전히 clean 결과 재사용을 건너뛰고 기본
1 MB 한도를 명시한다. 기본 경로도 실제 입력을 읽으므로 본문 재검증을 위한 필수 우회는 아니다.

### 파일 읽기 경쟁 조건과 자원 한계

경로는 파일의 이름이며, 열린 파일 descriptor는 실제로 연 파일을 가리킨다.
`stat(path)`로 크기를 검사한 뒤 `readFile(path)`로 다시 열면 그 사이 경로가
다른 파일로 교체될 수 있다. 스캐너는 한 번 연 descriptor에서 일반 파일 여부와
크기를 검사하고, 그 크기만 할당해 읽는다. 짧은 읽기는 남은 부분을 이어 읽고,
EOF·크기·수정 시각이 달라지면 결과를 저장하지 않고 실패한다. 큰 파일의 sample도
같은 descriptor에서 최대 4,096바이트만 읽으며, 실패해도 descriptor를 닫는다.
열린 파일의 sample 읽기 오류는 기존처럼 생략하지만, 파일 자체를 열지 못하면
크기를 추정해 건너뛰지 않고 스캔을 실패 처리한다.

| 방법 | 선택에 영향을 준 한계 |
| --- | --- |
| 경로를 검사한 뒤 다시 열기 | 교체된 파일을 읽어 크기 제한을 우회할 수 있다 |
| descriptor에 `readFile` 적용 | 같은 파일이어도 검사 후 커지면 읽기·할당량이 늘 수 있다 |
| 검사한 크기만 descriptor에서 읽기 | 작은 반복문과 재검사가 필요하지만 읽기·할당 상한을 유지한다 |

개념 참고는 OpenAI Codex의 로컬 커밋 `970111f6cb62cc02fe36a82ea7d71b37a2889c97`의
[`local_file_system_read.rs::read_file`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/exec-server/src/local_file_system_read.rs)다.
Codex는 열린 파일의 metadata와 실제 읽기 양쪽에 상한을 적용하고, 비동기 호출 취소를
청크 사이에서 확인한다. 참고 범위는 descriptor와 실제 읽기량을 함께 제한하는 원리다.
Parallax는 기존 동기 스캐너와 기본 1 MB 제한에 맞춰, 검사한 크기만 읽고 변경 시
실패하는 방식으로 구현했다. 예를 들어 16바이트 파일이 검사 후 216바이트가 되면
16바이트까지만 읽고 graph에 반영하지 않는다. 이를 작은 파일시스템 회귀 검사로 확인한다.

다른 대안인 Codex의
[`no_follow/unix.rs::open_entry_sync`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/exec-server/src/no_follow/unix.rs)는
디렉터리 descriptor를 기준으로 각 요소를 `openat`한다. 부모 경로 보호에는 더 적합하지만,
Node의 현재 표준 API 경계를 넘어 native 구성요소와 플랫폼별 유지 비용이 필요해
이번 단위에서는 채택하지 않았다. Codex의 큰 파일용 취소 계층도 동기 스캐너에 옮기지 않았다.
코드는 차용하지 않았으며, 소스 비교를 성능 비교나 자체 발명의 근거로 사용하지 않는다.
참고 checkout은 깨끗했고 원격 최신 버전 여부와 Codex 테스트 실행은 확인하지 않았다.

Linux/macOS에서는 `O_NOFOLLOW`와 `O_NONBLOCK`으로 leaf symlink·FIFO 교체도
방어한다. 해당 flag가 없는 플랫폼은 읽기 전 leaf의 일반 파일 여부와 dev/ino를
열린 descriptor와 대조한다. Windows 실행 검증과 부모 디렉터리까지 포함한
원자적 filesystem snapshot은 제공하지 않는다. Counter는 syscall 횟수가 아니라
성공한 본문/sample 읽기 작업 수와 실제 반환 바이트다.

구현은 `src/indexer.ts`의 `scanFiles`/`readContentSample`, 작은 실패 재현은
`tests/scanner.test.ts`가 소유한다. 파일 교체·동일 파일 증가·짧은 읽기·읽기 오류와
descriptor 종료를 확인하며 DB·서버를 띄우지 않는다.
[Node 24 파일 API와 플랫폼별 flag](https://nodejs.org/download/release/v24.14.0/docs/api/fs.html#file-open-constants)를
기준으로 한다. 일반적인 파일 수정 중 스캔이 실패하면 파일이 안정된 뒤 다시 실행한다.

## accuracy bench

`bench/impact-bench.ts`는 고정된 multi-language fixture(TypeScript/JavaScript, JVM/Spring Boot, Python, Go, Rust, OpenAPI contract, build manifest)를 만들어 인덱싱하고, 그 결과 graph를 pin된 기대 relation 집합과 대조해 채점한다. pin하는 항목:

- **relation recall과 precision** — 기대된 모든 relation이 매칭되어야 하고, 예상치 못한 relation이 없어야 한다.
- **affected-file recall** — 변경 파일에 대한 `analyzeDiff`가 기대된 모든 의존자를 드러내야 한다.
- **evidence presence, span completeness, adapter attribution** — relation은 evidence/span을 지니고 올바른 adapter에 귀속되어야 한다.
- **retrieval 지표** — brief context budget 안에서 `searchContextForRepo`의 recall/precision/MRR/nDCG.
- **semantic model recall/isolation** — deterministic int8 fixture embedding으로 embedding 모델명이 바뀔 때 semantic recall이 기대 top fact를 반환하고 cross-model decoy가 섞이지 않는지 검증한다.

runner는 deterministic JSON 리포트를 쓰고, suite가 통과하지 못하면 non-zero exit code를 설정한다. surface는 둘이다:

- `tests/impact-bench.test.ts`는 `npm test`의 일부로 bench를 실행하고, 리포트 형태와 pin된 기대 relation 집합, 그리고 score/recall 임계값을 검증한다.
- `npm run bench`는 `bench/impact-bench.ts`를 직접 실행하고 recall/score 회귀 시 non-zero로 종료한다 — CI가 쓰는 형태다.

Deterministic bench에는 cross-repo, contract-diff, co-change, trace-promotion lane도 포함된다. cross-repo contract-impact lane은 two-repo workspace fixture를 만들고 `analyzeContractDiff`로 breaking contract link를 persist한 뒤, `analyzeDiff`와 report-scoped graph export가 expected `web:src/client.ts` consumer impact를 계속 노출하는지 확인한다. contract-diff quality lane은 removed response required property, removed response optional property, added request required property, request enum-value removal, request format addition, response property type change, response nullable addition, response format change, response enum-value removal에 대한 paired OpenAPI v1/v2 fixture와 JSON Schema root-object 및 Avro top-level record required-property removal case를 실행하고, matched cases/changes를 `contractDiffQuality`로 보고한다. co-change quality lane은 `src/alpha.ts`와 `src/beta.ts`가 반복해서 함께 바뀌는 작은 git-history fixture를 만들고, `queryCoChanges`와 `analyzeDiff`가 `src/beta.ts`를 expected heuristic partner로 `coChangeQuality`에 함께 노출하는지 확인한다. trace-promotion lane은 runtime에서 관측된 `src/beta.ts -> src/alpha.ts` edge를 ingest한 뒤, 승격된 relation이 proven impact로 노출되는지 `tracePromotionQuality`로 확인한다. 이 lane들은 기존 `summary.score`를 reweight하지 않고 `summary.passed`를 gate한다.

relation 추출, 랭킹, retrieval을 건드리는 변경 후에는 `npm run bench`를 실행하자.

`npm run bench:report`는 `.parallax/bench/impact-bench-report.json`을 압축된 Markdown summary로 바꾼다. `--baseline <json>`을 넘기면 이전 report 대비 delta column을 포함하고, `--github-step-summary`를 넘기면 GitHub Actions step summary에 append한다. CI는 pull request에서 PR base SHA로 baseline report를 만든 뒤, `npm run verify` 이후 head-vs-base bench delta를 리포트한다.

## performance bench

`bench/impact-perf.ts`(`npm run bench:perf`로 실행)는 **결정적 합성 repo**(`bench/synthetic-repo.ts`)를 점점 큰 규모로 만들어 full index, no-op incremental index, edited-file reindex, 각 scan phase, analyze 비용을 측정한다 — leaf를 바꾸면 모든 importer로 파급되는 module hub 구조로, analyzer의 reverse-dependency traversal을 스트레스한다. accuracy bench 및 `npm run verify`와 **의도적으로 분리**되어 있다: 시간과 peak RSS는 비결정적이라 바이트-동일한 `impact-bench-report.json`에 절대 들어가면 안 된다. baseline을 잡거나 인덱서/analyzer 작업 중 회귀가 의심될 때 사용하고, CI에서는 index phase 중 최악의 `/kfile` 비용을 넉넉한 `--max-ms-per-kfile` ceiling으로 게이트할 수 있다.

```bash
npm run bench:perf -- --scales 1000,10000        # 사용자 지정 규모
npm run bench:perf -- --max-ms-per-kfile 2000    # ceiling 초과 시 실패
```

비교 가능한 large-repo baseline은 clean checkout에서 10k와 50k 파일 규모로 잡는다:

```bash
npm run bench:perf -- --scales 10000,50000
```

command, commit, Node version, OS / hardware class, 전체 output table을 함께 기록한다. `--max-ms-per-kfile`은 프로젝트 baseline을 잡은 뒤 local 또는 CI smoke ceiling으로만 사용하고, exact timing이나 RSS를 `npm run verify`에 넣지 않는다.

출력 표는 `full_index_ms`, `full_scan_ms`, `noop_incremental_ms`, `noop_scan_ms`, `edit_reindex_ms`, `edit_scan_ms`, `analyze_no_persist_ms`, `analyze_persist_ms`, `observed_peak_rss_mb`, total phase에 대응하는 `/kfile` 시간 열을 분리한다. Peak RSS는 Node 내장 RSS reading을 phase 경계에서 샘플링하므로 실용적인 추세 신호이지 정확한 allocator trace는 아니다. 시간 측정 실행은 verify에 없지만 합성 generator와 표 formatter는 `tests/synthetic-repo.test.ts`로 정규 verify 게이트에서 가드된다.

### 현재 로컬 baseline

2026-06-28에 commit `f8f6060`, macOS Darwin 24.6.0, Apple M1 Max, CPU core 10개, RAM 32 GiB, Node `v24.14.0`, npm `11.9.0` 환경에서 측정했다.

이 historical table은 scan phase column 추가 전 기준이며 당시의
`edit_incremental_ms` 이름을 유지한다. Current output은 changed-body phase를
`edit_reindex_ms`로 표시하므로 비교할 때 current checkout에서 다시 실행한다.

명령:

```bash
npm run bench:perf -- --scales 1000,2000
```

| files | full_index_ms | noop_incremental_ms | edit_incremental_ms | analyze_no_persist_ms | analyze_persist_ms | affected | observed_peak_rss_mb | full_index_ms/kfile | noop_incremental_ms/kfile | edit_incremental_ms/kfile | analyze_no_persist_ms/kfile | analyze_persist_ms/kfile |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 5251 | 3655.8 | 3594.0 | 1947.0 | 1935.7 | 200 | 328 | 5251 | 3656 | 3594 | 1947 | 1936 |
| 2000 | 17526 | 14266.0 | 14179.2 | 7688.0 | 7707.7 | 200 | 261 | 8763 | 7133 | 7090 | 3844 | 3854 |

표준 large-repo 명령 `npm run bench:perf -- --scales 10000`도 시도했다. 이 호스트에서는 약 20분 안에 표를 출력하지 못해 중단했다. 10k full-phase run이 로컬 제한 안에 끝나지 않았으므로 50k run은 시작하지 않았다. analyzer/indexing 비용을 줄이거나 perf runner에 phase-split/progress mode를 추가하기 전까지, 이 baseline host에서 10k/50k full-phase `bench:perf`는 **아직 지원 가능한 기준으로 보지 않는다**.

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
npm run bench:report -- --github-step-summary --allow-missing --baseline .parallax/bench/impact-bench-baseline.json
```

`npm run verify`는 canonical source-checkout gate다. lint를 먼저 실행한 뒤 install smoke(유일한 build를 담당), fast unit suite, dogfood, bench, 마지막으로 registry-dependent audit을 실행한다. Pull request에서는 CI가 먼저 base SHA에서 `.parallax/bench/impact-bench-baseline.json`을 준비하므로 마지막 summary에는 score, relation, affected-file, retrieval, semantic recall delta가 포함된다.

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
