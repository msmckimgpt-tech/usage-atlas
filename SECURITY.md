# 보안 문제 제보

계정 토큰, 대화 본문, 개인 프로젝트 경로를 공개 이슈에 첨부하지 마세요. 공개 저장소의 Security 탭에서 private vulnerability reporting이 활성화되어 있으면 Report a vulnerability를 사용하세요. 해당 기능을 사용할 수 없다면 공개 이슈에는 재현 가능한 합성 사례와 영향만 남기고 민감정보를 제외하세요.

배포 의존성은 lockfile에 고정합니다. 공개 파일 검사는 허용된 소스 목록·개인 홈 경로·로그인 파일명·알려진 키 형식을 검사합니다. GitHub Actions의 토큰은 기본 읽기 전용이며 GitHub 릴리스 작성 단계에만 contents:write, Marketplace 게시 단계에만 id-token:write를 허용합니다.
