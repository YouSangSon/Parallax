# Parallax — 차별화 전략 (Plan Draft)

> **Input:** 사내 개발공모전 평가자 피드백 — "통합 컨텍스트 관리 레이어 + 코드베이스 색인 + 의사결정 맥락 데이터화 — 이런 프로젝트를 이미 만들고 있다." 출처는 일반 카테고리 언급, 구체 프로젝트명 미지목.
> **Goal:** Parallax의 진짜 wedge를 찾고, 다음 한 슬라이스를 선택해 실행 우선순위로 만든다.
> **Status:** Draft for `/gstack-autoplan` review.

---

## 1. 피드백의 진짜 의미

"이미 만들고 있다"의 함의 셋 — 어느 게 진짜인지 평가자 본인도 모를 가능성:

- (a) **시장이 포화** — Cody / Cursor / Greptile / Continue / Sourcegraph 등이 코드 인덱싱+검색을 점유.
- (b) **개념 자체가 흔함** — "agent memory" + "code context" 키워드는 이제 2026 표준 어휘.
- (c) **차별점이 안 보임** — 우리가 만들고 있는 것이 *위 도구의 N번째 클론*으로 인식.

→ 진짜 위험은 (c). (a)/(b)는 시장 성숙 신호로 오히려 호재.

## 2. 카테고리 풍경 (2026-05 기준)

| 카테고리 | 대표 | 강점 | 빈칸 |
|---|---|---|---|
| **Code search/RAG indexer** | Sourcegraph Cody, Greptile, Continue, Cursor `@codebase` | LLM-backed 검색, IDE 통합 | 의사결정 lineage 없음, 코드 변경 영향 추론 약함 |
| **Agent memory (general)** | MCP memory server, Letta(MemGPT), Cognition Devin 내부 메모리 | 세션간 fact 보존 | 코드 graph와 분리, 코드 영향 모름 |
| **LLM IDE assistant** | Cursor, Windsurf, Copilot Workspace | 빠른 코드 생성 | 비공개 인덱스, 외부 서비스 의존 |
| **Knowledge base / ADR** | adr-tools, Linear/Notion docs | 의사결정 기록 명시적 | 코드와 자동 연결 없음, agent 사용 어려움 |
| **Graph DB + Vector DB DIY** | Neo4j + pgvector + 자체 ETL | 모든 것을 모델링 가능 | 운영비 큼, 단일 PC 불가 |

**관찰:** 다섯 카테고리 *각각* 강하지만 **교집합이 비어있다**. Parallax의 자리는 "위 다섯 카테고리를 SQLite 한 파일에 응축한 substrate."

## 3. `value-proposition.ko.md` §5 요약 (이미 있는 것)

- Claude/GPT 메모리 vs Parallax: 자유 텍스트 vs 구조화 fact + branch + 시간여행
- MCP memory server vs Parallax: 단순 KV vs 시간/분기/인과/코드그래프 1급
- Sourcegraph/CodeQL vs Parallax: 사람용 정적 분석 vs AI용 의사결정+영향도
- Graph+Vector DB DIY vs Parallax: 운영 1/10 (단일 SQLite + sqlite-vec)

**이미 다섯 카테고리 중 네 카테고리에 답이 있음.** 진짜 빈칸은 "LLM IDE assistant"(Cursor/Greptile/Continue) 비교. 추가 필요.

## 4. Wedge 후보 (구체 차별화 축)

### W-A. Time-travel decision graph for code
- `branch` / `merge` / `as_of_tx`로 "이 결정이 5턴 전엔 어떻게 보였는가" 단일 쿼리.
- 다른 도구가 못 함: Cody는 검색만, Cursor는 IDE chat history, MCP memory는 flat list.
- 핵심 wedge — fact_provenance + transaction DAG가 이미 구현됨.

### W-B. Change-impact ↔ decision-lineage 통합
- "이 commit이 무엇을 깰까" + "왜 이렇게 결정했는가"를 *같은 fact graph에서* 한 번에.
- Sourcegraph는 영향만, Linear ADR은 결정만 — 우리는 둘이 같은 entity에 매달림.
- 평가자가 "AI가 어디 깨뜨리나 모른다 + 어제 결정 다 까먹는다"라 한 두 짜증을 한 substrate으로 해결.

### W-C. Air-gapped agent context (local-first redacted)
- `<repo>/.parallax/impact.db` 단일 파일. 외부 서비스 없음. redact-then-embed 자동.
- Cursor/Greptile은 클라우드 인덱스. Cody는 self-host 가능하지만 서버 운영 필요.
- 사내/금융/방산/공공 — sensitive code segment에서 wedge가 가장 큼.

### W-D. MCP standard substrate (도구 agnostic)
- Claude·Codex·Cursor·자체 agent — *모두 같은 SQLite를 MCP로 읽음*.
- Cursor/Greptile은 자기 IDE/agent에 lock-in. Cody는 자체 client.
- 도구 시장이 빠르게 바뀌는 지금, agent-agnostic substrate은 lock-in 회피 가치.

### W-E. Korean enterprise stack first-class
- Java/Kotlin/Spring Boot endpoint/persistence/test relation v0 이미 구현.
- 사내 개발공모전·국내 SI/금융/제조 시장 — 영어권 도구는 한국어 doc/주석/identifier 약함.
- 적용 마찰: tier-1 enterprise stack 커버리지 (TS/Py/Go/Rust + JVM/Spring).

## 5. 권장 차별화 전략

W-A·W-B·W-C 셋을 **하나의 wedge로 묶는다:**

> **"Local-first, time-traveling decision + impact graph for AI coding agents."**
> — 코드 변경 영향과 의사결정 lineage가 같은 SQLite 안에 들어있고, agent가 MCP로 즉시 읽고, 5턴 전 시점도 재생 가능하며, 외부에 코드가 안 나간다.

이 wedge가 강한 이유:
1. **단일 줄로 표현됨** — 평가자가 5초 안에 "다른 도구와 다르다" 이해.
2. **기술 차별성 ↔ 사용자 가치가 1:1** — branch/as_of_tx는 추상적이지 않고 "어제 결정 까먹는다" 짜증 직답.
3. **시장이 비어있음** — Cody/Cursor/Greptile은 검색, MCP memory는 flat, Linear ADR은 코드 분리 — 누구도 교집합 안 닫음.
4. **이미 구현됨** — fact_provenance, transaction DAG, branch state, redact-then-embed 모두 코드에 존재 (`docs/invariants.md` I-1..I-10).

W-D(MCP agnostic)와 W-E(Korean enterprise)는 *go-to-market lens*: 단기 채택자 채널.

## 6. 다음 한 슬라이스 (실행 우선순위)

차별점이 *말로 안 통할 위험*이 가장 큼. 실증 데모가 wedge 메시지보다 강하다.

| 우선순위 | 작업 | 이유 |
|---|---|---|
| **P0** | 5분 데모 시나리오: "어제 결정한 X 정책 → 오늘 새 PR이 정책 깸 → branch로 대안 시뮬레이션 → as_of_tx로 어제 시점 재생" 단일 흐름 비디오 | wedge 메시지의 *증거* — 다른 도구가 이걸 못 함을 시각화 |
| P1 | Cursor `@codebase` / Cody / Greptile와 *같은 PR*에 대한 출력 비교 fixture | 비교 매트릭스를 추측 아닌 실측 |
| P1 | `docs/value-proposition.ko.md` §5에 "vs Cursor/Greptile/Continue" 행 추가 | 풍경 빈칸 메움 |
| P2 | Korean Java/Kotlin/Spring Boot fixture에서 end-to-end "Claude 변경 → impact context → MCP 응답" 동영상 | go-to-market segment 증거 |
| P2 | "Air-gapped 데모" — 인터넷 끊고 같은 흐름 동작 | local-first wedge 증거 |

## 7. 안 할 것

- **IDE 플러그인 자체 개발.** Cursor/Cody 따라가지 않음. MCP standard에 머무름.
- **클라우드 인덱싱 서비스.** I-1 위반.
- **자체 ADR UI.** Linear/Notion과 경쟁 안 함 — 그쪽 산출물을 *읽어와* impact graph에 매다는 어댑터만.
- **다른 도구 직접 비교 마케팅.** W-A·B·C 통합 메시지 한 줄에 집중.

---

## 검토 요청 포인트 (autoplan용)

- W-A·B·C 통합이 정말 "단일 줄로 표현"되는지 — 메시지 압축 검증.
- P0 데모 시나리오의 evidence path가 현재 코드로 실현 가능한지 — `docs/roadmap.md` §4 (Agent surface) 또는 §5 (UI Explorer)와 시퀀스 정합 검토.
- §5에 추가할 "vs Cursor/Greptile" 행이 정확한지 — 실제 출력 비교 없이는 위험.
- "안 할 것" 목록이 충분히 보수적인지 — 사내 채택자 채널과 충돌 가능성.
