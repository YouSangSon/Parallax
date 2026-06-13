# Parallax — 가치 제안 문서

[English](value-proposition.md) · **한국어** · [中文](value-proposition.zh.md)

> **이 문서의 역할:** 사내 개발공모전 평가자가 5분 안에 *무엇을·왜·어떻게 다른가*를 잡을 수 있도록 한 페이지로 압축한 살아있는 문서. 개발 진행에 따라 계속 보완한다.
>
> **마지막 갱신:** 2026-04-30
>
> **함께 보면 좋은 문서:**
> - 사용자 대상 README: [`README.ko.md`](../README.ko.md)
> - 큰 그림 설계 노트: [`docs/agent-db-exploration.ko.md`](agent-db-exploration.ko.md)
> - 사용 흐름·예시: [`docs/agent-memory-cookbook.ko.md`]
> - 진행 현황: [`docs/progress.ko.md`]
> - 다음 마일스톤: [`docs/phase3-handoff.ko.md`](phase3-handoff.ko.md)

---

## 1. 한 줄 요약

> **AI 코딩 도구(Claude Code, Codex 등)에게 "코드베이스 지도"와 "어제 한 생각 노트"를 같이 쥐어주는 로컬 도구. 단일 SQLite 파일 하나로 외부 의존 없이.**

## 2. 풀려는 문제 — 두 가지 짜증

AI 코딩 도구를 실무에서 쓰면 두 가지가 거슬린다.

### 문제 1. AI가 "어디가 깨지는지" 모른 채 코드를 만진다

`auth.ts`의 함수 하나를 바꾸면, 그 함수를 쓰는 다른 파일 7개가 같이 망가질 수 있다.
인간 개발자는 grep으로 확인하지만, AI는 자기 head 안의 추측만으로 움직인다.

→ **변경 영향도를 사전에 보여줘야 한다.**

### 문제 2. AI는 어제 한 결정을 다 까먹는다

오늘 AI가 *"이 인증 로직은 보안 이슈 때문에 X 방식으로 짠 거다"* 라고 판단하고 코드를 짜도,
다음 세션에선 그 판단이 사라진다. 채팅이 끝나면 휘발된다.

→ **결정·관찰·근거를 영구 저장하고 검색 가능하게 해야 한다.**

## 3. 핵심 통찰 — 둘은 사실 같은 데이터다

> **"코드 영향도 분석"과 "AI 메모리"는 둘 다 결국 *"X가 Y에 어떻게 연결되는가, 그 증거는 무엇인가"* 를 저장하는 일이다.**

이 통찰 하나로 시스템이 단순해진다. **하나의 SQLite 파일**에 두 트랙을 *듀얼라이트*한다.

- 인덱서가 `import` 한 줄을 발견 → `relations` 테이블에 한 줄 + **동시에** `facts` 테이블에 한 줄. 같은 트랜잭션.
- 그러면 AI가 *"왜 이 파일이 영향받는다고 봤어?"* 를 묻는 순간 `fact_provenance` 사슬을 거꾸로 타고 원본 코드 스니펫까지 도달한다.

그래프 DB도, 벡터 DB도, 외부 캐시도 없이 — 한 파일.

## 4. 핵심 가치 4가지

### V1. Local-first, 단일 파일, 외부 의존 0

`.parallax/impact.db` 한 파일에 모든 것이 들어간다.
- 사내 보안 정책 친화적 — 코드와 결정 데이터가 사용자 PC를 떠나지 않음
- 백업: 파일 하나 복사 / git에 commit해 팀 공유 가능
- 임베딩까지 in-process(`@huggingface/transformers` ONNX) — 외부 API 호출 0

### V2. 시간/분기/인과를 1급 시민으로

Datomic·git에서 빌려온 패턴 하나로 세 기능을 한 메커니즘에서 떨어뜨린다.

| 기능 | 어떻게 |
|---|---|
| 시간여행 ("5턴 전엔 어떻게 보였지?") | `as_of_tx` 재귀 CTE |
| 분기 (여러 plan을 동시 시뮬레이션 후 채택) | branch fork/merge, 데이터 복사 0 |
| 인과 사슬 ("이 결정의 근거는?") | `fact_provenance` BFS |

### V3. 코드 그래프와 메모리의 통합 검색

여러 도구를 따로 보지 않고, **"이 파일에 대해 알려진 모든 것"** 한 번 쿼리로:

- 누가 import하는지 (코드 관계)
- AI가 과거에 한 결정 (memory)
- 그 결정의 근거 스니펫 (provenance)

이게 한 응답으로 온다.

### V4. 비밀 보호 자동화

비밀번호·API 키·private key 패턴을 인덱싱·저장 단계에서 자동 redaction.
또한 **redact-then-embed 게이트**: 비밀이 잡히면 임베딩 row 자체를 안 만든다 — 비밀이 벡터 공간으로도 새지 않음.

## 5. 유사 서비스와의 차별성

평가자가 자주 떠올릴 비교 대상별로 정리.

### vs. Claude 자체 메모리 / ChatGPT memory

| 축 | Claude·GPT 메모리 | Parallax |
|---|---|---|
| 저장 형태 | 자유 텍스트(마크다운) | 구조화된 fact (entity, attribute, value) |
| 시간/분기 | 없음 (덮어쓰면 사라짐) | as_of 시간여행 + branch |
| 인과 추적 | 없음 | fact_provenance 사슬 |
| 코드 그래프 통합 | 없음 — 코드는 매번 grep | 코드 관계도 같은 fact 테이블에 |
| 비밀 처리 | 사용자가 조심 | 자동 redaction + zero-row embedding |
| 데이터 소유 | 외부 서비스 인프라 | 사용자 PC 단일 파일 |
| 다른 AI 도구 사용 | Claude/GPT 전용 | MCP 표준 — Codex·Cursor 모두 |
| 오프라인 | ❌ | ✅ |

요약: Claude·GPT 메모리는 *"나(에이전트)와 너(사용자)의 관계 메모"*. Parallax는 *"내가 만지는 코드베이스의 작동 기억"* — 보완 관계.

### vs. MCP memory server (커뮤니티 표준 메모리)

대부분의 MCP memory 서버는 단순 key-value 또는 텍스트 메모리.
Parallax는 **MCP 위에 시간/분기/인과/코드그래프를 1급으로 얹은** 메모리.

### vs. Sourcegraph / CodeQL

| 축 | Sourcegraph·CodeQL | Parallax |
|---|---|---|
| 목적 | 정적 분석·검색 (사람이 보는 도구) | AI 에이전트의 의사결정 기록 + 영향도 |
| 인프라 | 서버 운영 필요 | 로컬 단일 파일 |
| 메모리 레이어 | 없음 | 1급 시민 |
| MCP 통합 | 없음 (별도 프로토콜) | 표준 MCP stdio |

기존 도구가 *코드를 검색하는 사람*을 위한 것이라면, Parallax는 *코드를 만지는 AI*를 위한 것.

### vs. 그래프 DB(Neo4j 등) + 벡터 DB 조합

직접 만들면: 그래프 DB 서버 + 벡터 DB + ETL 파이프라인 + 인증/권한.
Parallax는 SQLite 한 파일 + sqlite-vec 확장으로 같은 본질을 표현. 운영 복잡도 1/10.

## 6. 현재 상태 — 동작하는 것 / 안 되는 것

### 동작함 ✅
- TypeScript/JavaScript/Markdown 정확하게 인덱싱
- 9개 추가 언어(Python·Go·Rust·Java·Kotlin·C#·C·C++) regex 휴리스틱 인덱싱
- 인프라/계약 파일(Docker·Terraform·protobuf·GraphQL·CODEOWNERS 등) 인덱싱
- "변경 파일 → 영향받는 파일" bounded multi-hop 분석 (cycle/fanout 보호)
- AI 결정/관찰을 fact로 영속화
- 시간여행 (`as_of_tx`), retract dedup (`current_only`), 의미 검색 (`semantic`)
- 여러 가설 시뮬레이션을 위한 branch fork/merge
- 비밀 자동 redaction + zero-row 임베딩
- MCP stdio 서버 — Claude Code·Codex 즉시 연결

### 진행 중 / 미구현 🟡
- TypeScript Compiler API 의미 어댑터 (정규식 → 정확한 구문 분석)
- 여러 저장소 묶어 분석 (workspace catalog) — 스키마는 준비됨
- API 컨트랙트 추적 (OpenAPI/protobuf 변경 영향) — 스키마는 준비됨
- 시각적 웹 그래프 탐색기
- 오래된 메모리 자동 요약 (reflective consolidation, )
- 버려진 branch 자동 정리

테스트: 43 passing. 4,114 LOC TypeScript. 외부 의존 4개(MCP SDK, transformers.js, sqlite-vec, zod).

## 7. 확장 로드맵 — 가치를 키우는 방향

### A. 정확도 천장 깨기 (가장 임팩트 큼)
- TS Compiler API 어댑터 → path alias / re-export / dynamic import까지 정확
- Tree-sitter / LSP 통합 → 거의 모든 언어 의미적 파싱
- CodeQL 어댑터 → 데이터 흐름까지 추적

### B. 코드 외부로 확장 — 마이크로서비스 시대 핵심
- 여러 저장소 묶기 (`workspaces`/`workspace_repos`) — 이미 스키마 있음
- API 컨트랙트(OpenAPI/protobuf/GraphQL/AsyncAPI) → 변경 시 다운스트림 컨슈머 자동 식별
- CI/Docker/K8s/Terraform 인프라 변경 영향도

### C. 회사 업무 산출물까지 통합 — 가장 야심찬 방향
- PRD, 회의록, 의사결정 기록, KPI 문서를 entity로 등록
- *"이 PRD 변경 → 어떤 코드 함수와 테스트가 영향?"*
- *"이 코드 변경 → 어떤 운영 문서·고객 자료에 반영 필요?"*
- 코드 영향도 도구 → **"회사 전체 변경 영향도 도구"** 로 도약

### D. AI 메모리 자동화
- Reflective consolidation: 자는 동안 뇌가 정리하듯, 오래된 메모를 LLM이 자동 요약·승격
- Branch GC: 시뮬레이션용으로 만든 buried branch 자동 정리
- 중요도 점수 기반 archive

### E. UX / 시각화
- 웹 그래프 탐색기 (영향도 그래프 클릭 탐색)
- VSCode·JetBrains 확장 (에디터 안에서 영향도 즉시 표시)
- 타임라인 뷰 (AI 결정을 시간순으로 재생)
- Obsidian sync (메모를 vault로)

### F. 외부 시스템 연동
- Linear/Jira 티켓 entity → "이 변경이 어떤 티켓을 닫는가" 자동 매핑
- Slack 스레드를 evidence로 연결
- GitHub PR 머지 = fact 자동 기록

### G. 팀 모드 — 분산 fact sync (미구현, 추후 구현 검토)

현재는 1인 1PC 전제. 팀 공유로 확장할 때도 *single .db / local-first* 정체성을 버리지 않는 방향을 검토 중.

**핵심 아이디어:** 중앙 서버 강제 없이, **각자 로컬 SQLite에서 작업하고 fact만 주기적으로 동기화**하는 git-like 분산 모델.

이게 자연스러운 이유:
- facts는 이미 **content-addressable** (id = `sha256(entity|attribute|value|op)`) — 누가 어디서 만들든 같은 fact는 같은 ID, 자동 dedup
- transactions는 이미 **multi-parent DAG** (`transaction_parents`) — git의 commit 그래프와 동형
- branches는 이미 **head 포인터 + parent_branch** — git의 branch와 동형

즉 SQLite 안에 *git 같은 구조가 이미 들어있어서*, 팀 공유는 새로운 발명이 아니라 자연스러운 확장.

**구현 패턴 — `.db`는 비공개, fact만 텍스트로 공유:**

```
[팀원 A 로컬]                  [git repo]                  [팀원 B 로컬]
  impact.db    ──export──→     facts/                ←──import──    impact.db
  (.gitignore)                  *.jsonl                              (.gitignore)
                              (텍스트, PR 리뷰 가능)
```

`.db` 파일 자체는 SQLite 내부 페이지 구조라 git이 다루지 못함(diff 안 보이고 충돌 해결 불가). 그래서 **fact 데이터만 JSONL 텍스트로 export → git에 commit/push** 하는 방식이 자연스럽다.

가상 사용 흐름:
```bash
# 팀원 A
parallax remember --entity file:src/auth.ts --attribute decision --value '"X 방식"'
parallax export --since last-sync > facts/2026-04-30-A.jsonl
git add facts/ && git commit -m "share auth decisions" && git push

# 팀원 B
git pull
parallax import facts/2026-04-30-A.jsonl
# → A가 만든 fact가 B의 로컬 .db에 머지. content-addressable이라 자동 dedup.
```

**충돌이 안 나는 이유:** fact ID = `sha256(entity|attribute|value|op)`. A·B가 같은 결정을 독립적으로 만들면 동일 ID → `INSERT OR IGNORE`로 자동 dedup. 다른 결정이면 ID 다름 → 둘 다 보존. fact는 append-only라 git의 *"같은 줄 다른 수정"* 충돌 패턴 자체가 발생 안 함.

**부수 효과 — "AI 결정을 PR로 리뷰":** fact JSONL이 텍스트라 git 인터페이스에서 그대로 코드 리뷰. *"AI가 한 이 결정 받아들일까?"* 가 PR 한 번으로 처리됨. 사내에서 *"AI에 함부로 맡기기 무섭다"* 는 우려에 직접 답이 되는 워크플로우.

**선택적 공유 정책 옵션:**
| 무엇을 공유하나 | 적합 |
|---|---|
| A. 코드 그래프 fact만 (인덱서가 만든 imports/calls/declares) | 팀이 같은 코드베이스 공유, AI 결정은 각자 |
| B. + AI 결정 fact 포함 | "왜 이렇게 짰지?"를 팀이 공유 |
| C. `--share` 플래그 또는 `team-shared` branch만 | 민감한 결정은 비공개, 공유 결정만 push |

C가 가장 현실적 — 사용자가 명시적으로 공유한 fact만 export.

**채널 옵션 (git만 답은 아님):**
| 채널 | 장점 | 단점 |
|---|---|---|
| **git repo** (메인 권장) | 익숙, 리뷰·history 무료 | 매뉴얼 export/import |
| 별도 git repo (`<project>-facts`) | 코드 repo 안 더럽힘 | repo 두 개 관리 |
| 사내 sync 서버 (HTTP) | 자동, 실시간 | 서버 한 대 운영 |
| 공유 폴더 (NAS, S3) | 인프라 거의 없음 | 충돌 정책 약함 |

**비교 대상 (다른 길 참고용):**
| 모델 | 비유 | local-first | 운영 복잡도 |
|---|---|---|---|
| **분산 fact sync (이 방향)** | git | ✅ 유지 | ★★ |
| 중앙 메모리 서버(Postgres 등) | Google Docs | ❌ 깨짐 | ★★★★ |
| Turso/Litestream 같은 SQLite 분산 변종 | 하이브리드 | △ | ★★ |

**상태:** 미구현, **추후 구현 검토**. content-addressable 모델이 이미 받아주는 구조라 *우선순위 결정 시 빠르게 진입 가능*. (reflective consolidation, branch GC) 이후 후보. 시작은 git 채널 + 매뉴얼 export/import → 검증되면 `parallax sync` 자동화 사이드카 추가 방향.

**평가자 Q&A 카드:** *"규모 커지면 SQLite로 안 되지 않나요?"* → "*.db 자체는 git에 안 올립니다. 안의 fact만 텍스트로 export하고, content-addressable이라 머지 충돌이 없습니다. 부수적으로 AI 결정을 PR로 리뷰하는 워크플로우가 따라옵니다.*"

## 8. 평가자에게 강조하고 싶은 메시지

1. **타이밍**: AI 코딩 도구가 본격 채택되는 *지금* 필요한 인프라 레이어다. AI가 코드를 더 만질수록 영향도/메모리 부재의 비용이 급격히 커진다.

2. **단순함**: 단일 SQLite 파일 + MCP stdio. 운영 복잡도가 거의 0 — 사내 어떤 환경에서도 도입 마찰 없음.

3. **표준 위에**: 자체 프로토콜이 아니라 MCP라는 업계 표준 위에. Claude Code, Codex, Cursor가 모두 같은 메모리·영향도 기반을 공유.

4. **Local-first 보안**: 사내 코드/결정이 외부로 나가지 않음 — 보안 검토 통과 용이.

5. **확장 자리가 스키마에 박힘**: workspace/contract/cross-repo/work-artifact 테이블이 이미 마이그레이션에 포함. 어댑터만 추가하면 위 로드맵이 빠르게 진행됨.

## 9. 한 문장으로 다시

> AI에게 *코드베이스의 지도*와 *자기 결정의 일기*를 같이 쥐어주는, 단일 파일·표준 프로토콜·로컬 우선 도구.

---

## 부록: 이 문서를 갱신하는 규칙

- **새 핵심 기능이 동작 시작** → §6 (현재 상태) 갱신.
- **차별성 메시지가 더 정확해짐** → §3, §5 갱신.
- **로드맵 항목이 동작으로 진입** → §7에서 §6으로 옮김.
- **유사 서비스/경쟁자 등장** → §5에 비교 추가.
- **사용자 인터뷰/평가자 피드백으로 강조점 변경** → §8 갱신.

내용을 바꿀 때는 *"평가자가 5분 안에 핵심을 잡는가"* 를 기준으로 한다. 길어지면 압축한다.
