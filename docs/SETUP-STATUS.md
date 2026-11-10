# 공개 배포 상태

검증일: 2026-11-10 KST.

- 공개 소스: https://github.com/msmckimgpt-tech/usage-atlas
- 공개 배포 태그: v0.2.24, 소스 커밋 9024412a52932b0ccc71cc02347a49bdabb17927 (이전 v0.2.23, d7f6e9e)
- 공개 릴리스: https://github.com/msmckimgpt-tech/usage-atlas/releases/tag/v0.2.24
- 공개일: 2026-11-10 KST
- 첨부: usage-atlas-0.2.24.vsix 및 .sha256
- VSIX SHA256: 31268108135a894da9a773b9505af8e5c4467b1fb5f68919396fe532dd3f05a3
- GitHub에서 내려받은 첨부 파일과 로컬 검수 파일의 해시가 동일하고 내부 46개 파일 검증이 통과했습니다.
- 소스와 VSIX·SHA256을 공개했습니다. GitHub Release는 초안이 아닌 공개 상태입니다.
- 소스에 개인 기록·로그·설정·인증 파일 및 생성 EXE를 포함하지 않습니다.

사용자는 추가 인증 없이 현재 권한으로 소스·VSIX만 공개하도록 선택했습니다. GitHub CLI 인증의 workflow 권한이 없어 자동화 파일 업로드가 거절된 상태이며, 추가 권한을 요청하거나 인증을 변경하지 않습니다. 자동 검수·태그 릴리스·Marketplace 워크플로는 비활성 상태로 유지합니다.

워크플로 템플릿은 docs/workflows의 세 파일에 보관하며 .github/workflows에 등록하지 않습니다. 현재 배포 채널은 GitHub Releases의 수동 VSIX 배포입니다. Marketplace 등록·게시는 수행하지 않았습니다. 자동화나 Marketplace 활성화는 사용자가 이후 별도로 요청할 때 진행합니다.

로컬 검수(0.2.24): Windows 383 PASS/1 SKIP, WSL 383 PASS/1 SKIP, 총 384조건입니다. WSL의 첫 병렬 실행은 환경 메모리 부족으로 한 조건이 실패하여, 같은 전체 검사를 순차 실행해 통과했습니다. Windows의 공개 파일/구문/전체 단위/브라우저/실제 VS Code 15단계와 배포 파일 검증도 통과했습니다. 실제 VS Code에서 다른 탭으로 3회 전환·숨김 중 데이터 갱신·기존 탭 열기 후 시작/종료 시각의 보존과 새 패널 기본 기간을 확인했고 제공자 호출은 0건입니다. Windows 2개 프로필과 WSL의 기존 2개 사용자 설치를 0.2.24로 갱신하고, 세 설치 위치의 파일 46개씩과 설정 파일 보존을 확인했습니다. 원격 CI 활성화 및 강제 사용자 창 재시작은 하지 않았습니다. 의존성은 0.2.23과 같습니다.
