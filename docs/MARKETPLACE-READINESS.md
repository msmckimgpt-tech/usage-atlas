# VS Code Marketplace 게시 준비 검토 (2026-11-18)

## 1. 모범 절차

1. **게시자 등록**: marketplace.visualstudio.com/manage. publisher ID는 확장 ID(`publisher.name`)의 일부라 나중에 바꾸면 별개 확장이 된다. 먼저 확정한다.
2. **package.json 필드**: publisher, name, displayName, description, version, engines.vscode, categories, keywords, icon(128x128 이상 PNG, SVG 불가), license, repository, bugs, homepage, galleryBanner.
3. **패키징**: `.vscodeignore`로 최소 파일만 포함. README(Marketplace 첫 화면)·CHANGELOG·LICENSE 포함. README 이미지는 https만. `vsce package` 결과를 직접 설치해 검증.
4. **인증**: 장기 PAT 대신 Trusted Publishing(OIDC). 게시자 관리 페이지의 정책(repo/workflow/environment), 워크플로 `id-token: write`, `vsce publish --oidc`(@vscode/vsce 4.1.0 이상). GitHub Actions만 지원.
5. **릴리스**: 태그 vX.Y.Z → CI 검수 → GitHub Release의 같은 VSIX를 게시. 게시한 버전은 덮어쓸 수 없다. 프리릴리스는 `--pre-release`.
6. **Open VSX 병행(선택)**: VS Code 포크용. 별도 네임스페이스·토큰.
7. **정책**: 타사 상표 사용 금지 또는 비공식 명시, 개인정보·텔레메트리 고지, 다른 확장 수정 지양, 번들 바이너리 설명, 서드파티 라이선스 고지.

## 2. 확장별 판정

| 확장 | 판정 | 근거 |
|---|---|---|
| usage-atlas 0.3.9 | 1순위 | 공개 저장소, MIT+서드파티 고지, PRIVACY/SECURITY/CHANGELOG, 배포 게이트, vsce 4.1.0 고정, OIDC 템플릿(.github/workflows/marketplace.yml). publisher·icon·galleryBanner는 반영됨. |
| codex-session-tabs 0.16.0 | 보류 | 공식 openai.chatgpt 확장 내부를 패치. 정책 거부·삭제 위험, 상대 업데이트 시 깨짐. |
| agy-session-tabs 0.2.3 | 보류 | 공식 Antigravity 확장 패치(patch.cjs), 특정 버전 의존. |
| claude-task-observer 0.1.4 | 게시 안 함 | 활성화 시 공식 Claude Code·Codex·AGY 확장 파일에 연결 코드를 자동 패치하고 끄는 설정이 없음. 비공개 GitHub 저장소·Release로만 배포(2026-11-18 결정). |
| session-browser 0.6.0 | 부적합 | private, 외부 MCP 호스트 exe·Chromium·고정 경로(E:\) 의존, 문서에 Marketplace 미게시 명시. |
| wsl-load-monitor | 해당 없음 | 확장이 아니라 PowerShell 스크립트. |

## 3. 권장 순서

1. publisher ID 결정·등록.
2. usage-atlas 파일럿: icon·categories·galleryBanner 추가 → 0.3.9 → Trusted Publishing 정책, `marketplace` Environment, 변수 `MARKETPLACE_PUBLISHER`/`MARKETPLACE_ENABLED` → 워크플로 수동 실행.
3. claude-task-observer 정비 후 게시.
4. 세션 탭 2종은 GitHub 배포 유지.

## 4. 환경

- `node`/`npm`이 PATH에 없다(설치 위치 `%LOCALAPPDATA%\Programs\nodejs`). 로컬에서 `npm run package`를 쓰려면 PATH 추가가 필요하다.

## 참고
- https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- https://code.visualstudio.com/updates/v1_144
- https://github.com/microsoft/vscode-vsce
