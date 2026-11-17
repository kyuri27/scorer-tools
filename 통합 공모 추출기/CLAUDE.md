# 통합 공모 추출기 — CLAUDE.md

## 프로젝트 개요

Chrome MV3 확장프로그램. 세움터(eais.go.kr), 나라장터(g2b.go.kr), 건축허브(hub.go.kr) 공모 페이지에서 정보를 자동 추출하고, 그 외 사이트는 Gemini AI로 추출한다.

## 파일 구조

```
unified_ext/
├── manifest.json          — MV3 매니페스트 (권한, 서비스워커, 팝업 정의)
├── popup.html / popup.css — 팝업 UI
├── popup.js               — 팝업 전체 로직 (메인 파일)
├── background.js          — 서비스워커 (탭 이벤트, 메시지 중계)
├── content_seumter.js     — 세움터 콘텐츠 스크립트
├── content_g2b.js         — 나라장터 콘텐츠 스크립트
└── content_hub.js         — 건축허브 콘텐츠 스크립트
```

## 사이트별 추출 방식

### 세움터 (eais.go.kr) — `siteMode = 'seumter'`
- `content_seumter.js`가 DOM 파싱 → `extractData()` 메시지로 팝업에 전달
- 첨부파일: `_attachedFileEls` 배열로 수집 → ZIP 다운로드
- 심사결과 공고 버튼: `data-seumter-result-notice` 속성으로 마킹, `clickResultNotice` 메시지로 클릭
- 재주입 안전: `window.__seumterState` 패턴 사용 (`let` 재선언 방지)

### 나라장터 (g2b.go.kr) — `siteMode = 'g2b'`
- `content_g2b.js`가 WebSquare 프레임워크 DOM 파싱
- 첨부파일 다운로드: WebSquare 그리드 API(`window.scwin`, `window.w2`) + 체크박스 선택 + `window.alert` 억제
- 직접 링크 URL: `buildG2BDirectUrl(입찰공고번호)` → `https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=X&bidPbancOrd=Y`
  - 공고번호 형식: `R26BK01485707 - 000` → `bidPbancNo=R26BK01485707&bidPbancOrd=000`

### 건축허브 (hub.go.kr) — `siteMode = 'hub'`
- `content_hub.js`가 DOM 파싱
- 공동참여자 대표: 괄호 안에 표시 (예: `홍길동(대표)`)

### 범용 AI 추출 — `siteMode = 'ai'`
- Gemini API 호출로 현재 페이지 텍스트 분석
- `storage`에 저장된 API 키 사용

## 핵심 로직 (popup.js)

### 사이트 감지
팝업 열릴 때 현재 탭 URL로 `siteMode` 결정:
- `eais.go.kr` → `'seumter'`
- `g2b.go.kr` → `'g2b'`
- `hub.go.kr` → `'hub'`
- 그 외 → `'ai'`

### 추출 결과 렌더링
- `renderResultSeumter(data)` — 세움터 결과 UI
- `renderResultG2B(data)` — 나라장터 결과 UI
- `renderResultHub(data)` — 건축허브 결과 UI

### 클립보드 복사 (공모 정리 도구 연동)
- `copyForToolSeumter(d)` / `copyForToolG2B(d)` / `copyForToolHub(d)`
- JSON 형식으로 복사, 공모 정리 도구에 붙여넣기

### ZIP 다운로드
- `buildZip(files)` — 파일 배열 → ZIP Blob 생성
- **중요**: UTF-8 파일명 플래그 `0x0800` 필수 (local file header + central directory header 양쪽 모두)
  - 빠뜨리면 Windows에서 한글 파일명이 깨짐

## 개발 규칙

### 커밋/푸시
- **커밋**: 오류 없이 작업이 완료되어 다음 단계로 넘어갈 때 실행
- **푸시**: 사용자가 명시적으로 요청할 때만 실행

### 콘텐츠 스크립트 재주입 주의
- `chrome.scripting.executeScript`로 같은 탭에 스크립트가 여러 번 주입될 수 있음
- `let`/`const` 최상위 선언 대신 `window.__XXXState` 패턴 사용:
  ```javascript
  if (!window.__seumterState) window.__seumterState = { ... };
  var _myVar = window.__seumterState.myVar;
  ```

### 팝업 닫힘 방지
- `chrome.tabs.create({ active: false })` 도 탭 포커스를 이동시켜 팝업이 닫힘
- 새 탭 열기가 필요하면 `chrome.tabs.onCreated` + `chrome.tabs.update({ active: true })`로 원래 탭 복귀

### WebSquare (나라장터) 주의사항
- `window.alert`이 동기적으로 블로킹 → 첨부파일 다운로드 전 반드시 억제
- 그리드 체크박스 선택: 여러 전략 시도 (API → DOM fallback)

## 관련 디렉토리

```
/Volumes/T7/스코어러/데이터/
├── 통합 공모 추출기/    ← 이 프로젝트
├── 공모 데이터 올인원 입력/
└── 공모정리도구/
```

git 저장소는 별도 드라이브(My Passport)에 있음 — T7에서는 직접 커밋 불가.
