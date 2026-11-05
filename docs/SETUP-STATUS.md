# 초기 공개 상태

2026-11-05: 공개 저장소와 검수된 로컬 VSIX를 준비했습니다. 소스에 개인 기록·로그·설정·인증 파일을 포함하지 않습니다.

현재 GitHub CLI 인증의 workflow 권한이 없어 .github/workflows 업로드가 GitHub에서 거절됐습니다. 연결 앱의 쓰기 요청도403을 반환했습니다. 따라서 자동 검수·태그 릴리스·Marketplace 워크플로는 아직 활성화됐다고 주장하지 않습니다.

검수한 워크플로 원본은 docs/workflows의 세 파일에 보관합니다. 권한이 확인되면 .github/workflows로 옮겨 실제 Actions 실행 결과를 확인합니다. GitHub Releases의 수동 VSIX 배포는 현재 저장소 권한으로 가능합니다. Marketplace 등록/게시자 소유권·Trusted Publishing 설정은 별도 단계입니다.

로컬 검수: Windows379 PASS/1 SKIP, WSL379 PASS/1 SKIP, 총380조건. Windows 공개 파일/구문/전체 단위/브라우저/실제 VS Code의15단계와 배포 파일 검증을 통과했습니다. 원격 CI 통과 결과로 대체하지 않습니다.
