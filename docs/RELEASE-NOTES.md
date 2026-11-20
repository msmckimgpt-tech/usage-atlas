Usage Atlas 0.3.14 — 차트 hover 강조/흐림 전환 부드럽게 개선

- 차트에서 그래프에 마우스를 올릴 때 강조선과 나머지 흐림 처리(`opacity`, `stroke-width`)가 즉시 튀지 않고 `0.24s cubic-bezier(0.22, 1, 0.36, 1)`로 부드럽게 전환되도록 개선했습니다.
- `prefers-reduced-motion: reduce` 환경에서는 전환 애니메이션 없이 즉시 반영합니다.
- 수집·예측·저장 형식은 0.3.13과 같습니다.

Windows·WSL용 VSIX와 SHA256입니다.
