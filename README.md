# Usage Atlas

Codex와 Claude Code의 구독 사용량·추가 크레딧·소진 예측을 한 화면에서 확인하는 VS Code 확장입니다. Windows와 WSL에서 동작합니다. OpenAI 및 Anthropic의 공식 제품이 아닌 독립 확장입니다.

[다운로드](https://github.com/msmckimgpt-tech/usage-atlas/releases) · [문제 제보](https://github.com/msmckimgpt-tech/usage-atlas/issues) · [개인정보 처리](PRIVACY.md) · [배포 안내](docs/RELEASING.md)

## 기능

- 두 제공자의 5시간·주간 사용률을 동시에 표시하며 모델 집중 보기와 겹쳐 보기를 지원합니다.
- 사용률·변화량·누적 보기, 현재 한도·기본 용량 비교, 초기화 선·마커를 지원합니다.
- 추가 크레딧을 구독 관측 환산 또는 공식 월 구독료 대비 금액 비율로 비교합니다.
- 최근 평균과 요일·시간대별 패턴으로 구독100% 도달을 예측합니다. 표본이 충분하면 비감소 소비량 제약을 적용한 과거 오차 범위를 함께 표시합니다.
- 차트 드래그 확대, 중간 버튼 이동, 우클릭 드래그 확대·축소, Ctrl+휠 확대·축소, Shift+휠 이동을 지원합니다.
- 하단 날짜 범위 조절기의 양 끝을 드래그할 수 있으며 더블클릭으로 기본 범위로 돌아갑니다.
- 상태 표시줄 Usage에 마우스를 올리면 최근5시간 미리보기가 표시됩니다.
- 그래프를 더블클릭하면 전체 화면 상세 분석에서 호출·세션·로컬 대화 내역을 확인할 수 있습니다.
- 밝음·어두움·시스템 테마, 적응형 페이지 크기, 금액 소수점, 툴팁 투명도를 설정할 수 있습니다.

## 설치

1. [Releases](https://github.com/msmckimgpt-tech/usage-atlas/releases)에서 최신 VSIX를 내려받습니다.
2. VS Code 확장 화면의 메뉴에서 **Install from VSIX…**를 선택합니다.
3. 명령 팔레트에서 **Usage Atlas: 사용량 그래프 열기**를 실행합니다.

CLI로 설치할 수도 있습니다. 파일명은 내려받은 버전에 맞춥니다.

~~~sh
code --install-extension ./usage-atlas-0.2.22.vsix
~~~

기존 로컬 설치와 같은 확장ID인 local-tools.usage-atlas를 유지합니다. Marketplace 등록은 아직 완료되지 않았으며, 현재 배포 채널은 GitHub Releases입니다.

WSL을 사용한다면 **Remote - WSL 창에 연결한 상태**에서 같은 VSIX를 설치하고 해당 원격 창의 확장 화면에 설치됐는지 확인하세요. Windows와 WSL은 각각 실행되는 사용자 계정의 공식 로그인과 로컬 기록을 참조하며 기록을 자동 병합하지 않습니다.

## 제공자 연결

- Codex: 공식 확장 **Codex - OpenAI’s coding agent**의 설치된 실행 파일과 기존 로그인을 우선 사용합니다. 필요하면 Usage Atlas 설정에서 Codex 실행 파일 경로를 지정합니다.
- Claude: 기존 Claude Code 로그인을 참조합니다. 사용량 호환 API는 공개된 고정 계약이 아니며 제공자 변경·제한에 영향을 받을 수 있습니다. 설정에서 이 조회를 끌 수 있습니다.
- 별도 API 키나 비밀번호를 Usage Atlas에 입력하지 않습니다. 계정 상태나 요금제가 제공하지 않는 지표는 -로 표시합니다.

명령 팔레트의 **Usage Atlas: 설정**은 VS Code 기본 설정창으로 연결됩니다. 수집·보관, 차트·표시, 소진 예측, 제공자 연결, 분석·진단 순서로 묶여 있습니다.

## 차트와 해석

사용률은 현재 구독 주기의0~100%를 뜻하고, 기본 용량 비교에서는 설정 배율에 따라500%·2000% 등으로 표시할 수 있습니다. 변화량은 실제 연속 관측 사이의 증가분이고, 누적은 확인된 소비를 기간에 걸쳐 더한 값입니다. 차트 누락 구간의 추정 연결은 저장된 원본이나 소비량 합계를 수정하지 않습니다.

**추가 크레딧 → 구독**은 같은 계정·요금제의 구독 관측과 공식 호출 요율을 근거로 자동 환산한 추정값입니다. 제공되지 않는5시간 사용률을 주간 사용률로 대체하지 않습니다. 속도 모드가 기록되지 않은 경우 Standard로 추정하며 불명확한 근거는 보류합니다.

**추가 크레딧 → 금액**은 추가 소비의 공식 기본가격 ÷ 월 구독 기본가격 ×100%입니다. 구독 한도와 독립된 금액 축을 사용하며 구독 소진 예측에 더하지 않습니다. 가격 카탈로그의 출처·확인일은 src/billing-catalog.json에 보관합니다. 이는 할인·세금·프로모션이 반영된 실제 영수증 금액이 아닙니다. 요금제 변경 때 통화 누적은 유지하되 분모가 달라져 비율이 바뀔 수 있습니다.

소진 예상은 최근 관측과 과거 패턴이 이어진다는 가정입니다. 다음 초기화 또는100%에서 예상선을 끝냅니다. 누락·초기화 가정 증가·사용률 회복·다른 계정이나 요금제는 학습에서 제외하며 근거가 부족하면 -로 표시합니다. 과거 오차 범위는 미래 확률을 보장하는 신뢰구간이 아닙니다.

기본 보관은90일이며 기록 수·파일 크기 제한이 함께 적용됩니다. Chart History Days는 처음 표시할 범위만 바꾸며 삭제된 기록을 복원하거나 보관 기간을 연장하지 않습니다. 적응형 수집과 서버 오류 백오프가 실제 요청 간격에 영향을 줄 수 있습니다.

## 개발

Node.js24 이상과 npm, Windows 패키징에는 .NET Framework C# 컴파일러가 필요합니다. 설치되는 확장 자체는 외부 Node.js 설치 없이 VS Code 확장 호스트에서 실행됩니다.

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

이 명령은 Windows 수집 도우미 빌드와 필수 검수를 통과한 경우에만 VSIX를 생성합니다. GUI 검수는 합성 데이터와 격리된 VS Code 프로필을 사용합니다. 필요한 경우 VS Code 테스트 실행 파일을 자동 다운로드합니다. 저장된 실제 계정·대화·수집 기록은 검수 입력이 아닙니다.

[기여 안내](CONTRIBUTING.md)와 [검증 구조](VALIDATION.md)를 참조하세요.

## 라이선스와 원저자

기존 Usage Atlas 소스는 [MIT License](LICENSE)를 따릅니다. Codexon에서 유래한 수집·분석 부분에는 [Codexon Attribution License 1.0](licenses/Codexon-LICENSE.txt)이 적용됩니다.

- Original project: Codexon
- Original author: **jisoq**
- Copyright (c) 2026 jisoq
- Original repository: https://github.com/jisoq/Codexon

원저자 고지와 원본 저장소 링크는 상세 모달 및 **Usage Atlas: 정보 및 라이선스** 명령에도 유지합니다. Usage Atlas의 변경은 원저자의 보증이나 승인을 의미하지 않습니다. D3 고지는 media/D3-LICENSE와 media/D3-NOTICES에 보존합니다. 자세한 적용 범위는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 참조하세요.
