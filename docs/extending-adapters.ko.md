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

이 때문에 등록 순서가 load-bearing이다. 기본 registry는 순서대로 등록한다: build-system/package adapter, config/infra adapter, TypeScript/JavaScript adapter, JVM/Spring adapter, Python adapter, Go adapter, Rust adapter, 그리고 마지막으로 multi-language regex adapter. 그 마지막 adapter는 `supports()`가 항상 `true`를 반환하는 **catch-all**이므로 반드시 LAST로 등록되어야 한다 — catch-all 뒤에 등록된 adapter는 도달 불가능하다. registry의 안전망이 이 순서를 문서화하고 assert한다.

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

## 함께 보기

- [mcp.ko.md](mcp.ko.md) — 인덱싱된 graph를 읽는 MCP surface
- [cli-reference.ko.md](cli-reference.ko.md) — `parallax index`와 분석 명령
- [invariants.ko.md](invariants.ko.md) — evidence-first 불변 원칙(I-10)
- [glossary.ko.md](glossary.ko.md) — adapter, evidence, confidence 정의
