# 초기 공개 상태

검증일: 2026-11-05 KST.

- 공개 소스: https://github.com/msmckimgpt-tech/usage-atlas
- 배포 후보 태그: v0.2.22, 소스 커밋 e90a7204f6dad57d482ac72c1777ac4237d788f4
- 배포 초안: https://github.com/msmckimgpt-tech/usage-atlas/releases/tag/untagged-d216db8bf859229e2f8a
- 첨부: usage-atlas-0.2.22.vsix 및 .sha256
- VSIX SHA256: 9130eb76616cb2fbfbd0c4c0ca26a3ed63a17029ba9113504bd4ab2500874616
- GitHub에서 내려받은 첨부 파일과 로컬 검수 파일의 해시가 동일하고 내부46개 파일 검증이 통과했습니다.
- 저장소는 익명 HTTPS 접근200을 확인했습니다. 초안 첨부는 저장소 관리자가 배포를 확정하기 전까지 공개 다운로드가 아닙니다.
- 소스에 개인 기록·로그·설정·인증 파일 및 생성 EXE를 포함하지 않습니다.

현재 GitHub CLI 인증의 workflow 권한이 없어 .github/workflows 업로드가 GitHub에서 거절됐습니다. 연결 앱의 쓰기 요청도403을 반환했습니다. 브라우저 접근 호스트는 사용할 수 없었습니다. 자동 검수·태그 릴리스·Marketplace 워크플로는 활성화 대기입니다.

검수한 워크플로 원본은 docs/workflows의 세 파일에 보관합니다. 권한이 확인되면 .github/workflows로 옮겨 실제 Actions 실행 결과를 확인합니다. 현재 배포 초안은 관리자의 Publish release 동작으로 VSIX를 공개할 수 있습니다. Marketplace 등록/게시자 소유권·Trusted Publishing 설정은 별도 단계입니다.

로컬 검수: Windows379 PASS/1 SKIP, WSL379 PASS/1 SKIP, 총380조건. Windows 공개 파일/구문/전체 단위/브라우저/실제 VS Code의15단계와 배포 파일 검증을 통과했습니다. 원격 CI 통과 결과로 대체하지 않습니다. 의존성 감사는0건입니다.
