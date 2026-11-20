Usage Atlas 0.3.16 — SVG 복합 경로 통합 및 GPU 오버레이 분리로 hover·줌 60fps 개선

- 같은 시리즈의 다중 청크를 단일 복합 `<path>`로 통합해 다중 공급자·대량 기록 환경에서 SVG DOM 노드 수를 약 79% 줄였습니다.
- 수직 가이드선과 드래그 선택 영역을 `<svg>` 밖 GPU 오버레이(`transform: translate3d`)로 분리해 마우스 이동 시 `<svg>` 전체가 재래스터화되는 문제를 해결했습니다.
- 툴팁 레이아웃 격리(`contain: layout style`), 강조 전 크기 측정, `.ua-trace` 단일 클래스 전환으로 hover 및 강조 전환 프레임 시간을 60fps 수준으로 개선했습니다.
- 수집·예측·저장 형식은 0.3.15와 같습니다.

Windows·WSL용 VSIX와 SHA256입니다.
