# 배포 절차

현재는 사용자의 선택에 따라 소스와 VSIX를 GitHub Releases에 수동 공개합니다. 자동화 워크플로는 docs/workflows의 템플릿으로만 보관하며 활성화하지 않습니다. 현재 공개 상태는 [SETUP-STATUS.md](SETUP-STATUS.md)를 참조하세요. 아래 자동 배포 절차는 이후 별도 활성화할 때 사용합니다.

## GitHub Releases

1. package.json과 package-lock.json의 루트 확장 버전을 함께 변경합니다. 의존성 버전은 별도로 유지합니다.
2. CHANGELOG.md와 docs/RELEASE-NOTES.md를 갱신합니다.
3. main에 커밋하고 CI의 Windows·Ubuntu 검사가 통과하는지 확인합니다.
4. 패키지 버전과 같은 vX.Y.Z 태그를 해당 커밋에 붙여 push합니다.
5. Release VSIX가 버전을 확인하고 두 환경의 필수 검수를 다시 실행합니다.
6. 검수된 Windows VSIX·SHA256을 GitHub Release에 자동 첨부합니다. 같은 VSIX는 WSL에도 설치할 수 있습니다.

~~~sh
git tag v0.2.22
git push origin v0.2.22
~~~

이미 게시한 태그나 파일을 덮어쓰지 않고 수정 버전을 새로 배포합니다. npm run package는 필수 검수 전에 VSIX를 만들지 않습니다. CI와 릴리스 로그는 합성 입력만 포함합니다.

## Marketplace 준비

현재 package.json의 publisher는 기존 로컬 설치ID를 유지하기 위한 local-tools입니다. 이 이름에 대한 Marketplace 소유권을 확인한 상태는 아닙니다. GitHub 계정과 Marketplace 게시자 등록은 별개입니다. 소유하지 않은 게시자로 게시하지 않습니다.

게시할 때 다음을 한 번 설정해야 합니다.

1. [Marketplace 게시자 관리](https://marketplace.visualstudio.com/manage/publishers/)에서 사용할 게시자를 등록하거나 소유권을 확인합니다.
2. 다른 publisher를 사용한다면 package.json의 publisher를 바꾸고 새 버전으로 GitHub Release를 만듭니다. 기존 local-tools.usage-atlas와 확장ID·저장 공간이 달라지므로 기존 사용자의 기록 이전 안내를 먼저 준비합니다.
3. Marketplace 게시자의 Trusted Publishing 정책을 다음과 같이 구성합니다: owner=msmckimgpt-tech, repository=usage-atlas, workflow=marketplace.yml, environment=marketplace.
4. GitHub 저장소의 marketplace Environment를 생성하고 필요하면 승인 담당자를 지정합니다.
5. 저장소 Actions 변수 MARKETPLACE_PUBLISHER를 소유한 게시자ID, MARKETPLACE_ENABLED를 true로 설정합니다.
6. Publish Marketplace 워크플로를 수동 실행하고 검수된 릴리스 태그를 입력합니다. 현재 main과 같은 버전/게시자의 GitHub Release만 게시합니다.

이 흐름은 GitHub OIDC와 vsce --oidc를 사용하며 장기 PAT를 저장하지 않습니다. 기본 상태에서 Marketplace 작업은 비활성화됩니다. 입력 태그·게시자ID·다운로드 파일의 SHA256·내부 manifest를 확인하고 GitHub 릴리스와 동일한 VSIX를 게시합니다.

공식 근거(2026-11-05 확인): [VS Code 게시 안내](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [VS Code CI](https://code.visualstudio.com/api/working-with-extensions/continuous-integration), [GitHub 워크플로 권한](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).

## 라이선스

LICENSE, THIRD-PARTY-NOTICES.md, licenses/Codexon-LICENSE.txt, media/D3-LICENSE, media/D3-NOTICES 및 원저자UI 고지는 모든 소스/바이너리 배포에 유지합니다. 단일 MIT 라이선스만으로 프로젝트 전체의 조건을 대체하지 않습니다.
