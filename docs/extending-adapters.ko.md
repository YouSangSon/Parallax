# Parallax — 어댑터 확장

[English](extending-adapters.md) · **한국어** · [中文](extending-adapters.zh.md)

Parallax는 **semantic adapter**를 통해 entity/relation graph를 추출한다. 각 adapter는 하나의 언어 또는 파일 형식을 담당하며, 스캔된 파일을 entity, relation, diagnostic으로 바꾼다. 이 가이드는 adapter 계약, adapter가 등록·선택되는 방식, 그리고 따라야 하는 evidence/confidence 규율을 최소 예제와 함께 설명한다.

## adapter 계약

adapter는 `SemanticAdapter` 인터페이스(`src/adapters/types.ts`)를 구현한다:

- `id` — 고유하고 안정적인 식별자. 같은 `id`로 두 adapter를 등록하면 throw한다.
- `version` — adapter 버전 문자열([버전 관리](#버전-관리와-재추출) 참고).
- `capabilities` — 이 adapter가 만들 수 있는 `AdapterCapability` 값.
- `confidence?` — adapter의 기본 confidence 라벨(생략 시 `unknown`으로 폴백).
- `knownGaps?` — 이 adapter가 해석하지 *않는* 것에 대한 사람이 읽는 메모.
- `selectionMode?` — 범위가 정해진 언어/파일 adapter의 기본값은 `targeted`, 마지막 fallback adapter는 `catch-all`.
- `supports(file)` — 이 adapter가 파일을 처리하면 `true`를 반환.
- `start(ctx, files)` — index run을 위한 `AdapterRun`(또는 `Promise<AdapterRun>`)을 반환.

반환된 `AdapterRun`은 `IndexEvent`를 yield하는 async generator인 `process(file)`과 선택적 `dispose()`를 노출한다. 각 `IndexEvent`는 세 가지 kind 중 하나다:

- `entity` — `PendingEntity`(`EntityDescriptor`: `kind`, 선택적 `path`, `symbol`, `symbolKind`, `languageId`, `displayName`, `metadata`).
- `relation` — `source`와 `target` descriptor, `RelationKind`, 선택적 `metadata`와 `evidence`를 가진 `PendingRelation`.
- `diagnostic` — `warn` 또는 `error` 메시지, 선택적으로 파일에 연결.

orchestrator는 각 `EntityDescriptor`를 content-hash해 entity id를 계산하므로, 같은 descriptor는 항상 같은 entity로 매핑된다.

## Capability

`AdapterCapability`는 다음 중 하나다: `imports`, `exports`, `calls`, `references`, `types`, `symbols`, `docrefs`, `tests`, `packages`. adapter는 추출할 수 있는 부분집합을 선언해 coverage와 gap이 adapter별로 명시되게 한다.

## Evidence와 confidence (불변 원칙 I-10)

모든 relation은 `evidence` — source 파일, span, snippet — 와 confidence 라벨을 가져야 한다. `Confidence`는 네 단계다:

- `proven` — parser 수준 fact로 뒷받침됨.
- `inferred` — 도출되었지만 잘 뒷받침됨.
- `heuristic` — 폭넓은 패턴 기반 coverage.
- `unknown` — confidence가 없을 때의 폴백.

이는 불변 원칙 **I-10**([invariants.ko.md](invariants.ko.md) 참고)을 강제한다 — 모든 impact 판단은 evidence + provenance + confidence를 함께 가지며, 알 수 없는 것은 fact로 제시하지 않고 `unknown`으로 드러낸다. adapter의 run별 confidence와 `knownGaps`는 기록되어, agent와 사람이 parser 기반 결과를 폭넓은 heuristic coverage와 구분할 수 있게 한다.

## 등록과 선택 순서

adapter는 registry(`src/adapters/registry.ts`)에 살며 `src/indexer.ts`의 `createDefaultRegistry()`가 조립한다. 선택은 등록 순서에서 **first-match-wins**다 — `pickAdapter(file)`은 `supports()`가 `true`를 반환하는 첫 등록 adapter를 반환한다.

이 때문에 등록 순서가 load-bearing이다. 기본 registry는 순서대로 등록한다: build-system/package adapter, config/infra adapter, TypeScript/JavaScript adapter, JVM/Spring adapter, Python adapter, Go adapter, Rust adapter, 그리고 마지막으로 multi-language regex adapter. 그 마지막 adapter는 `supports()`가 항상 `true`를 반환하는 **catch-all**이므로 반드시 LAST로 등록되어야 한다 — catch-all 뒤에 등록된 adapter는 도달 불가능하다. registry는 이 순서를 강제한다.

registry는 이제 이 계약을 명시적으로 강제한다. `selectionMode`는 기존 source compatibility를 위해 선택 사항이며 생략하면 `targeted`다. 마지막 fallback coverage를 의도한 adapter만 `selectionMode = 'catch-all'`을 설정한다. `AdapterRegistry.register()`는 이미 등록된 catch-all adapter 뒤에 다른 adapter를 등록하려 하면 거부하며, error에는 새 adapter와 이를 막는 catch-all adapter의 이름이 모두 들어간다. 중복 `id` 검증은 여전히 먼저 실행되어 기존 중복 id error를 유지한다.

adapter 등록을 검토하거나 테스트할 때는 `registry.manifest()`를 사용한다. 이 API는 등록 순서의 immutable snapshot을 반환한다. 각 entry에는 `order`, `id`, `version`, `capabilities`, `confidence`(기본값 `unknown`), `knownGaps`(기본값 빈 배열), `selectionMode`(기본값 `targeted`)가 포함된다. 호출자는 registry 상태를 변경하지 않고 이 정보를 검사할 수 있다.

## 버전 관리와 재추출

각 index run은 모든 활성 adapter의 `id`와 `version`으로 구성된 `extractor_version` 시그니처를 기록한다. adapter의 `version`을 올리면 다음 `parallax index` run에서 그 기록된 시그니처가 바뀐다. adapter의 추출 출력이 바뀔 때마다 `version`을 올려, 실행이 adapter 버전을 가로질러 조용히 섞이지 않게 하자.

## 최소 예제

`.example` 파일을 처리해 하나의 `file` entity와 하나의 `IMPORTS` relation을 evidence와 함께 내보내는 작은 adapter:

```ts
import type {
  AdapterCapability,
  AdapterRun,
  ExtractCtx,
  IndexEvent,
  SemanticAdapter
} from './types.js';
import type { ScannedFile } from '../types.js';

const capabilities: readonly AdapterCapability[] = ['imports'];

export class ExampleAdapter implements SemanticAdapter {
  readonly id = 'example';
  readonly version = '0.1.0';
  readonly capabilities = capabilities;
  readonly confidence = 'heuristic';
  readonly selectionMode = 'targeted';
  readonly knownGaps = ['only resolves a single literal import form'];

  supports(file: ScannedFile): boolean {
    return file.relativePath.endsWith('.example');
  }

  start(_ctx: ExtractCtx, _files: readonly ScannedFile[]): AdapterRun {
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        // 1) 파일을 entity로 선언.
        yield { kind: 'entity', entity: { kind: 'file', path: file.relativePath } };

        // 2) evidence가 뒷받침하는 relation을 내보냄.
        const match = /^import\s+(\S+)/m.exec(file.content);
        if (match) {
          yield {
            kind: 'relation',
            relation: {
              source: { kind: 'file', path: file.relativePath },
              target: { kind: 'file', path: match[1]! },
              kind: 'IMPORTS',
              evidence: [
                {
                  file: file.relativePath,
                  snippet: match[0],
                  startLine: 1,
                  confidence: 'heuristic'
                }
              ]
            }
          };
        }
      }
    };
  }
}
```

catch-all adapter **앞에** `createDefaultRegistry()`에 등록해, `supports()`가 먼저 참조되게 한다.

## adapter checklist

adapter를 추가하거나 바꾸기 전에:

- 고유한 `id`를 사용하고, 추출 output이 바뀌면 `version`을 올린다.
- 언어/파일별 adapter에는 `selectionMode = 'targeted'`를 선호하고, `catch-all`은 마지막 fallback adapter에만 사용한다.
- 모든 targeted adapter를 catch-all adapter보다 앞에 등록한다.
- focused test나 review note에서 `registry.manifest()`로 순서, capability, confidence, known gap, selection mode를 확인한다.
- manifest가 heuristic 또는 불완전한 coverage를 드러낼 수 있도록 `knownGaps`를 최신으로 유지한다.

## 함께 보기

- [mcp.ko.md](mcp.ko.md) — 인덱싱된 graph를 읽는 MCP surface
- [cli-reference.ko.md](cli-reference.ko.md) — `parallax index`와 분석 명령
- [invariants.ko.md](invariants.ko.md) — evidence-first 불변 원칙(I-10)
- [glossary.ko.md](glossary.ko.md) — adapter, evidence, confidence 정의
