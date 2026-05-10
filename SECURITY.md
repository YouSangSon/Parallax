# Security Policy

Impact Trace는 로컬 저장소를 읽고 분석하는 도구입니다. 보안 이슈는 일반 버그보다
우선순위가 높습니다.

## 지원 범위

현재 보안 지원 범위:

- `main` branch
- 최신 npm package 기준 코드

## 신고 방법

GitHub Security Advisory를 사용해 비공개로 신고해 주세요.

Repository: https://github.com/YouSangSon/Impact-trace

Security-sensitive 예시:

- repo root 밖 파일을 읽는 path traversal
- symlink escape
- MCP write capability가 의도치 않게 노출되는 문제
- redaction 우회로 secret이 report/MCP output에 노출되는 문제
- `.impact-trace/` 내부 DB나 report에 raw secret이 저장되는 문제

공개 issue에는 실제 secret, private repository path, exploit payload를 올리지
말아 주세요.

## 보안 원칙

- MCP는 source/external write를 하지 않습니다. 예외적으로 agent memory facts,
  branch lifecycle, reflection/repair, context telemetry 같은 `.impact-trace/`
  내부 repo-local writes는 명시된 tool에서만 허용합니다.
- Impact report와 context pack은 기본적으로 tool 응답에서 compact하게 반환하고,
  큰 payload는 resource-on-demand로 읽습니다.
- project command execution은 MVP 범위 밖입니다.
- 모든 file input은 realpath containment check를 거쳐야 합니다.
- evidence는 저장 또는 출력 전에 redaction되어야 합니다.
- docs lint는 local machine path와 secret-like content를 차단해야 합니다.
