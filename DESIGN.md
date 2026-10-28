# Design

## 근거 위치 계산의 줄 배열 제거

`offsetPosition()`은 근거 하나를 만들 때마다 앞부분 문자열을 줄 배열로
나눴다. 같은 prefix에서 LF 위치만 순회하면 줄 수와 마지막 줄 시작점을
얻으므로 배열이 필요 없다. 열은 기존처럼 UTF-16 길이로 계산한다.
CRLF의 CR과 LF 사이에서는 CR 너비를 유지하고, 단독 CR과 U+2028/U+2029는
기존 계약대로 LF 줄 번호를 늘리지 않는다.

출력 계약이 같으므로 공유 regex 버전 41을 유지한다. 캐시나 AST 재사용,
파일 읽기 생략은 추가하지 않는다. 순수 경계 검사와 동일 입력의 이벤트
해시 비교가 정확성을 확인하며, 제한된 CI 비용 관측은
[검증 문서](docs/verification.md#evidence-position-allocation)를 따른다.

## TypeScript 혼합 재수출의 순환 종료

`a.ts`가 `b.ts`의 이름 있는 export를 default로 내보내고, `b.ts`가 다시
`a.ts`의 default를 가져오면 두 resolver가 서로 호출된다. 기존 구현은 같은
종류의 호출에서만 방문 기록을 전달해 이 혼합 순환에서 스택을 소진했다.
두 교차 호출에도 같은 기록을 전달한다. 별도 깊이 제한은 정상 체인을 길이에
따라 잘라 버리므로 추가하지 않았다.

방문 대상은 파일만이 아니라 해당 export다. Default는 `[path]`, named는
`[path, name]`을 JSON으로 직렬화해 구분한다. 문자열 export 이름과 콜론이 든
파일 경로가 같아 보이는 구분자 키를 만들 수 있기 때문이다. 순환 분기를
건너뛴 뒤 다른 star 재수출에서 찾은 실제 선언은 계속 사용한다. 기존 factory
resolver의 방문 기록 전달 방식을 재사용하며 새 cache나 전역 상태는 없다.

같은 구분은 조회 캐시와 namespace/factory 방문 기록에도 필요하다. 예를 들어
`["a.ts", "b.ts:Thing"]`과 `["a.ts:b.ts", "Thing"]`을 `:`로 이어 붙이면
같은 문자열이 된다. 이 충돌은 두 번째 타입·메서드를 첫 번째 파일에 연결하거나,
먼저 저장한 조회 실패 때문에 정상 선언을 숨긴다. 남은 8곳도 JSON tuple로
바꾸며, factory의 default 키는 `[path, "default"]`로 기존 export 정체성을
유지한다. 경로 하나만 쓰는 캐시와 탐색 순서는 그대로 둔다.

구현은 `src/adapters/multi-language-regex.ts`의 export 조회와 방문 기록에
있다. 순환 수정은 버전 40, 후속 키 구분은 공유 regex 버전 41로 이전 추출
결과를 무효화한다. 순수 회귀는
`tests/typescript-export-cycle.test.ts`, 저장 graph와 보고서 검사는 기존
incremental oracle이 소유한다. 이 재현은 이전 VM 전체 소스 timeout의 원인
증명이 아니며, 매우 깊은 비순환 체인까지 반복 탐색으로 바꾸지는 않는다.

## Active Slice: S1 Changed-Content Invalidation Safety

### Problem

Two independent assumptions make changed-only extraction unsafe:

- a `full-index` adapter's output for one owned file may depend on any indexed
  file body; a `tsconfig.json`-only alias edit can therefore stale an unchanged
  TypeScript edge;
- `fileContentScope = 'target-only'` constrains reads, not emitted-row ownership;
  a compliant adapter processing changed `a.ts` may emit a relation sourced from
  unchanged `b.ts`, which source-path carry-forward would preserve if it vanishes.

### Decision

Keep the existing full extraction/persistence path as the safety mechanism:

- no changed indexed bodies: retain the current incremental carry-forward and
  skip adapter startup;
- any changed indexed body: promote the effective run to full extraction and do
  not carry rows;
- include an indexer-semantics revision in `extractor_version` so a pre-fix
  completed cohort cannot be reused after upgrading.

This consumes the declared contract without adding a dependency graph or partial
adapter invalidation model.

### Data Flow

1. Scan and classify with the current conservative reader.
2. Compute the content-hash delta.
3. Promote any non-empty changed set to the existing full path.
5. Use the effective mode consistently for coverage, adapter processing,
   persistence, evidence, carry-forward, and the returned result.

### Measurement

The exact incremental-vs-fresh-full oracle is the correctness gate. Existing
`bench:perf` scan timings remain advisory and do not prove read reduction.
Deterministic body-read counts belong to a later slice, after a separate emitted-
row ownership contract and enforcement exist.

### Known Ceiling

Changed-body runs receive no incremental extraction speedup. Add narrower
invalidation only when a measured workload justifies an explicit emitted-row
ownership contract, runtime enforcement, and persistence oracle.

### Sources

- [Git status porcelain and untracked-file semantics](https://git-scm.com/docs/git-status)
- [Git index cache and racy-clean safeguards](https://git-scm.com/docs/git-update-index)
- [Node file-system discovery and stat semantics](https://nodejs.org/api/fs.html)
- [clangd background and per-file index model](https://clangd.llvm.org/design/indexing.html)
