# Parallax — 리포트 JSON Schema

[English](report-schema.md) · **한국어** · [中文](report-schema.zh.md)

`parallax analyze --json`은 **impact report**를 출력한다. Parallax는 이 출력에 대한 기계 판독용 [JSON Schema](https://json-schema.org/)를 발행하므로, 소비자(CI 게이트, 대시보드, 다른 에이전트)는 TypeScript 타입을 역설계하지 않고도 출력을 검증할 수 있다.

## 산출물

| | |
| :--- | :--- |
| 경로 | [`schemas/impact-report.schema.json`](../schemas/impact-report.schema.json) |
| Dialect | JSON Schema draft 2020-12 |
| `$id` | `https://github.com/YouSangSon/Parallax/blob/main/schemas/impact-report.schema.json` |
| `version` | 리포트 형태의 시맨틱 버전(현재 `1.0.0`) |

이 스키마는 `parallax analyze --json`이 내보내는 객체(`ImpactReport`)를 기술한다: `id`, `indexRunId`, `changedFiles`, `affectedFiles`, `changed`, `affected`, `actions`, `evidence`, 그리고 선택적 `adapterInsights` / `warnings`. `--json`은 리포트를 저장하지 않으므로 선택 필드 `reportPath`는 이 출력에서 빠진다.

## 출력 검증

어떤 JSON Schema 검증기든 동작한다. 예를 들어 [`ajv`](https://ajv.js.org/)로:

```bash
parallax analyze --changed src/store.ts --json > report.json
npx ajv-cli validate -s schemas/impact-report.schema.json -d report.json --spec=draft2020
```

## 버전 정책

`version` 필드는 리포트 형태의 시맨틱 버전을 담는다:

- **patch** — 문서 한정 또는 비구조적 명료화.
- **minor** — 선택 필드 추가(기존 소비자는 계속 유효).
- **major** — 필드 제거/이름 변경 또는 타입 강화(소비자에게 호환성 깨짐).

`$id`는 안정적으로 유지되며, 소비자가 고정해야 할 신호는 `version` 필드다.

## 동기화 유지 방법

손으로 쓴 `ImpactReport` 타입(`src/types.ts`)이 권위를 가진다. 스키마는 zod(`src/report_schema.ts`)로 미러링되며 산출물은 거기서 생성된다:

```bash
npm run schemas:build   # schemas/impact-report.schema.json 재생성
```

두 가드가 산출물을 정직하게 유지하며, 둘 다 `npm run verify`에 배선되어 있다:

- **컴파일 타임 적합성** 단언(`tests/report-schema.test.ts`)은 `ImpactReport`와 zod 스키마가 어긋나면 `npm run check`를 실패시킨다.
- **drift guard**(`npm run schemas:check`, `npm run lint`의 일부)는 커밋된 산출물이 낡았으면 실패시킨다. 또한 한 테스트가 실제 `analyze --json` 출력을 스키마로 검증하므로, 발행된 계약은 타입뿐 아니라 실제 출력과 대조된다.

## 범위

이 스키마는 impact report를 다룬다. 벤치마크 리포트(`.parallax/bench/` 아래로 내보내는 `parallax` 품질 지표)는 내부 산출물이며 아직 스키마화되지 않았다.

## 함께 보기

- [cli-reference.ko.md](cli-reference.ko.md) — `analyze --json` 플래그
- [mcp.ko.md](mcp.ko.md) — 같은 저장소 위의 MCP 서버 surface
