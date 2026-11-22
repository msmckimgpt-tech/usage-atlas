# 기여 안내

## 개발 환경과 검수

1. 저장소를 복제하고 Node.js 24 이상에서 `npm ci`를 실행합니다.
2. `npx playwright install chromium`으로 브라우저를 준비합니다. Linux CI는 `--with-deps`를 사용합니다.
3. `npm test`와 `npm run check:publication`으로 계산과 공개 파일을 검사합니다.
4. `npm run build:webview` 후 `npm run verify:release`로 브라우저·네이티브 호스트를 검사합니다.
5. Windows에서는 `npm run package`로 최종 검수와 VSIX 패키징을 실행합니다.

## 회귀 테스트와 데이터 원칙

수집·누적·환산·예측의 의미를 변경할 때는 실제 오류 사례를 합성 회귀 데이터로 재현하세요. 개별 원본 기록·구독 사용률·추가 크레딧의 축을 섞거나 확인되지 않은 값을 0으로 채우지 않습니다. 실제 계정과 개인 파일은 자동 검수에 사용하지 않습니다.

## 환경 변수와 배포 범위

환경 변수 `USAGE_ATLAS_BROWSER`로 브라우저 실행 파일을, `USAGE_ATLAS_VSCODE_PATH`로 격리 검수에 사용할 VS Code 실행 파일을 지정할 수 있습니다. 개인 VS Code의 설정과 확장 목록은 검수 대상이 아닙니다.

동봉한 라이선스와 원저자 UI 고지는 그대로 유지하세요. 생성된 EXE·VSIX·로그·계정 기록은 Git에 커밋하지 않습니다. 처음 공개한 저장소는 실행 소스, 합성 fixture, 재현 가능한 빌드 도구만 포함합니다.

## 개발 환경과 패키징(README에서 이동)

Node.js 24 이상과 npm이 필요하며 Windows 패키징에는 .NET Framework C# 컴파일러가 필요합니다. 설치되는 확장 자체는 외부 Node.js 설치 없이 VS Code 확장 호스트에서 실행됩니다.

~~~sh
npm ci
npx playwright install chromium
npm test
npm run build:webview
npm run verify:release
~~~

Windows에서 설치 가능한 VSIX와 SHA256을 만듭니다.

~~~sh
npm run package
~~~

이 명령은 Windows 수집 도우미 빌드와 필수 검수를 통과한 경우에만 VSIX를 생성합니다. GUI 검수는 합성 데이터와 격리된 VS Code 프로필을 사용하며 필요한 경우 VS Code 테스트 실행 파일을 자동 다운로드합니다. 저장된 실제 계정·대화·수집 기록은 검수 입력이 아닙니다.

[검증 구조](VALIDATION.md)도 참조하세요.
