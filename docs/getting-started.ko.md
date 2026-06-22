# Parallax - 시작하기

[English](getting-started.md) · **한국어** · [中文](getting-started.zh.md)

가장 짧지만 실제로 쓸 수 있는 경로를 정리했다. 저장소를 초기화하고, 로컬 인덱스를 만든 뒤, 변경 하나를 분석하고, 저장된 리포트를 UI에서 확인한 다음, 같은 read-only surface를 MCP 클라이언트나 CI guardrail로 연결한다.

가정: `parallax` CLI가 이미 `PATH`에 있다.

## 1. 저장소 초기화

분석할 저장소 루트에서 실행한다.

```bash
parallax init
```

이 명령은 로컬 `.parallax/` 디렉터리와 `.parallax/impact.db` SQLite 데이터베이스를 만든다.

## 2. 첫 인덱스 생성

```bash
parallax index
```

첫 실행은 working tree를 스캔해 파일, entity, relation, evidence, coverage row를 로컬 데이터베이스에 저장한다. 코드나 문서를 바꾼 뒤에는 `parallax index`를 다시 실행해 그래프를 갱신한다.

## 3. 변경 분석

명시한 변경 파일 하나를 분석한다.

```bash
parallax analyze --changed src/auth/session.ts --depth 2
```

기계 소비용이라면 persisted report 대신 JSON을 출력한다.

```bash
parallax analyze --changed src/auth/session.ts --depth 2 --json > report.json
```

정확한 경로는 저장소마다 다르지만, impact report는 대략 아래처럼 보여야 한다.

```json
{
  "changedFiles": ["src/auth/session.ts"],
  "affectedFiles": [
    { "path": "src/routes/private.ts", "confidence": "proven", "depth": 1 },
    { "path": "tests/session.test.ts", "confidence": "inferred", "depth": 1 },
    { "path": "docs/auth-policy.md", "confidence": "heuristic", "depth": 1 }
  ]
}
```

핵심 신호는 Parallax가 코드, 테스트, 문서, 계약, 설정에 걸친 blast radius를 evidence와 confidence label과 함께 정렬해 준다는 점이다. 기본적으로 `analyze`는 영향을 받은 파일이 하나라도 있으면 exit code `1`을 반환한다.

## 4. 저장된 리포트를 UI에서 열기

로컬 explorer를 쓰려면 persisted report 흐름을 사용한다.

```bash
parallax analyze --changed src/auth/session.ts --depth 2
parallax ui
```

특정 저장 리포트를 열 수도 있다.

```bash
parallax ui --report <report-id> --port 3717
```

UI는 같은 결과를 changed -> affected -> evidence -> action 흐름으로 보여주므로, 어떤 대상이 왜 상단에 왔는지 또는 다음 검증이 무엇인지 확인하기 좋다.

## 5. MCP 다음 단계

저장소에 completed index가 하나라도 있으면, 같은 로컬 저장소를 MCP 클라이언트에 노출할 수 있다.

```bash
parallax mcp serve
```

이 명령을 Claude Code, Codex, 또는 다른 MCP 클라이언트의 stdio 서버로 등록한다. 서버는 현재 작업 디렉터리에서 저장소를 해석하므로, 분석할 저장소에서 실행해야 한다. 전체 tool/resource surface는 [mcp.ko.md](mcp.ko.md)를 참고하자.

## 6. CI 또는 guardrail 다음 단계

브랜치나 PR에서는 git diff를 바로 분석하면 된다.

```bash
parallax analyze --base main --head HEAD --fail-on proven --json > report.json
```

`--fail-on`으로 어떤 confidence 레벨에서 guardrail을 작동시킬지 정한다. CI의 보수적 시작점은 `proven`이다. 고신뢰 impact에만 실패하기 때문이다. 발행된 `report.json` 스키마는 패키지에 [`../schemas/impact-report.schema.json`](../schemas/impact-report.schema.json)으로 함께 포함된다. 검증 방법은 [report-schema.ko.md](report-schema.ko.md)를 참고하자.

## 함께 보기

- [cli-reference.ko.md](cli-reference.ko.md) - 모든 CLI 명령, 플래그, exit code
- [mcp.ko.md](mcp.ko.md) - stdio 서버, tool, prompt, resource
- [report-schema.ko.md](report-schema.ko.md) - `analyze --json`용 JSON Schema
- [verification.ko.md](verification.ko.md) - release gate, docs lint, dogfood, bench 계층
