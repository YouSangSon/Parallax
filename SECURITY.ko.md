# Security Policy

[English](SECURITY.md) · **한국어** · [中文](SECURITY.zh.md)

Parallax는 로컬 저장소를 읽고 분석하는 도구입니다. 보안 이슈는 일반 버그보다
우선순위가 높습니다.

## 지원 범위

현재 보안 지원 범위:

- `main` branch
- 최신 npm package 기준 코드

## 신고 방법

GitHub Security Advisory를 사용해 비공개로 신고해 주세요.

Repository: https://github.com/YouSangSon/Parallax

Security-sensitive 예시:

- repo root 밖 파일을 읽는 path traversal
- symlink escape
- MCP write capability가 의도치 않게 노출되는 문제
- redaction 우회로 secret이 report/MCP output에 노출되는 문제
- `.parallax/` 내부 DB나 report에 raw secret이 저장되는 문제

공개 issue에는 실제 secret, private repository path, exploit payload를 올리지
말아 주세요.

## 보안 원칙

- MCP는 source/external write를 하지 않습니다. 예외적으로 agent memory facts,
  branch lifecycle, reflection/repair, context telemetry 같은 `.parallax/`
  내부 repo-local writes는 명시된 tool에서만 허용합니다.
- Impact report와 context pack은 기본적으로 tool 응답에서 compact하게 반환하고,
  큰 payload는 resource-on-demand로 읽습니다.
- project command execution은 MVP 범위 밖입니다.
- 모든 file input은 realpath containment check를 거쳐야 합니다.
- evidence는 저장 또는 출력 전에 redaction되어야 합니다.
- docs lint는 local machine path와 secret-like content를 차단해야 합니다.

## 외부 memory platform에서 배운 guardrail

`rohitg00/agentmemory` 적용성 검토 중 viewer XSS, shell installer RCE,
default HTTP bind, unauthenticated mesh, export traversal, redaction gap 같은
upstream advisory를 확인했습니다. Parallax는 해당 platform을 가져오지
않지만, 다음 원칙은 core guardrail로 유지합니다.

- 기본 실행 경로는 CLI와 MCP stdio입니다. HTTP server, stream server,
  WebSocket, proxy, background daemon은 core에 암묵적으로 추가하지 않습니다.
- `curl | sh` 형태 installer는 문서나 자동화의 기본 경로로 쓰지 않습니다.
- local UI가 추가되면 opt-in이어야 하며, CSP nonce, no inline handler,
  escaped text rendering, raw secret 미표시를 기본으로 둡니다.
- 외부 export/write 기능이 추가되면 lexical path check만으로는 부족합니다.
  realpath/lstat 기반 containment와 symlink escape 테스트가 필수입니다.
- MCP `tools/list`는 exact surface test로 고정하고, list에 없는 agentmemory식
  export/write/mesh/team 도구가 `tools/call`로 직접 호출되어도 실패해야 합니다.
- automatic hook capture와 context injection은 기본 기능이 아닙니다. 향후 hook
  adapter를 만들더라도 opt-in, bounded payload, fire-and-forget telemetry,
  short timeout을 요구합니다.
