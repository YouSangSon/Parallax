# 불변 원칙 (Invariants)

[English](invariants.md) · **한국어** · [中文](invariants.zh.md)

> 프로젝트가 다시 시작해도 깨지 않을 핵심 결정. 새로운 결정은 이 문서를 위반하지 않는 선에서 한다.

---

## I-1. Local-first, single SQLite DB

모든 데이터는 `<repo>/.parallax/impact.db` 하나에 저장한다. 외부 서비스(graph DB, hosted vector store, cloud sync) 의존 없음. 첫 부팅 시 fresh DB 생성, schema migration은 DB 열 때 자동 수행.

**왜 깨면 안 되는가:**

- 코드 구조를 외부 서비스에 보내는 것은 많은 팀에 non-starter다.
- 외부 의존 하나가 설치 마찰을 두 배로 만든다. SQLite는 어디든 이미 있다.
- 비행기/SCIF/방화벽 뒤에서도 작동해야 한다.
- 단일 파일은 복사·diff·archive·sandbox가 쉽다.

## I-2. Content-addressable fact id (SHA-256)

`fact.id = SHA-256(entity || attribute || value_blob || op)`. 같은 (entity, attribute, value, op) 튜플은 항상 같은 id. dedup 비용 0.

## I-3. ADD-only schema migration

기존 컬럼을 변경/삭제하지 않는다. 항상 새 컬럼/테이블을 추가하는 방식. 과거 schema로 열린 DB도 계속 읽을 수 있어야 한다.

## I-4. Redact-then-embed (zero-row policy)

secret 패턴이 감지된 값은 redaction 후에만 embedding 파이프라인에 들어간다. 원본은 fact value에도 redact된 상태로 저장. 외부 모델 호출 전 redaction이 무조건 선행.

## I-5. Async work outside SQLite transaction

LLM 호출, embedding 계산, 네트워크 fetch 등 long-running 작업은 SQLite transaction 바깥에서 한다. DB 잠금 시간을 ms 단위로 유지.

## I-6. Explicit triggers, no daemon

reflect/index/gc 같은 정리 작업은 명시적인 CLI/MCP 호출로만 실행된다. background worker나 데몬을 만들지 않는다. 사용자가 언제 어떤 작업이 도는지 항상 안다.

## I-7. No LLM/embedding SDKs (fetch only)

OpenAI/Anthropic/HuggingFace SDK를 의존성에 추가하지 않는다. 필요하면 `fetch`로 직접 호출. SDK 업데이트가 프로젝트의 의존성 무게를 좌우하지 않도록.

## I-8. Read-only agent surface first

MCP는 안전한 read-only 분석 표면을 먼저 안정화한다. write 권한은 별도 모델과 리뷰를 거친 뒤 추가한다. agent가 실수로 destructive 작업을 못 하게 기본값으로 막는다.

## I-9. Actions are recommendations

테스트나 리뷰 command를 자동 실행하지 않는다. `command + args` 구조로 추천만 한다. 실행 책임은 사람 또는 상위 agent에 있다.

## I-10. Evidence first, no silent certainty

모든 영향도 판단은 evidence + provenance + confidence를 같이 가져야 한다. 모르는 것은 `unknown` / coverage gap / missing adapter로 명시적으로 드러낸다. 추정값을 사실처럼 반환하지 않는다.
분석 리포트는 adapter run 단위의 confidence와 known gap도 함께 노출해서, parser-backed 결과와 broad heuristic coverage를 agent와 사람이 구분할 수 있어야 한다.

## I-11. Saved reports are immutable snapshots

저장된 리포트와 report-scoped graph export는 저장된 report JSON snapshot에서 읽는다. 이후 index run, carry-forward, retention, repair, canonical graph row 변경이 기존 리포트의 내용을 바꾸면 안 된다. Persisted report에 relation-bearing evidence가 없을 때만 canonical graph row가 legacy report를 보강할 수 있다.
