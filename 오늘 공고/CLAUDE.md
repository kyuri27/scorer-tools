# 세움터 공고 확장 (Chrome Extension)

공공건축 설계공모 공고를 세 곳에서 수집해 하나의 화면에 보여주는 크롬 확장 프로그램.

## 파일 구조

```
manifest.json      — MV3 매니페스트 (권한, host_permissions)
background.js      — Service Worker. 데이터 수집 핵심 로직
content_main.js    — MAIN world 콘텐츠 스크립트 (세움터 XHR 가로채기)
index.html         — 확장 전용 탭 UI (아이콘 클릭 시 열림)
popup.js           — index.html 동작 스크립트
popup.html         — 미사용 (index.html이 전용 탭으로 대체)
```

## 데이터 소스 3개

### 1. 세움터 (eais.go.kr)
- URL: `https://www.eais.go.kr/moct/awp/aia01/AWPAIA01L01`
- API: `AWPAIA01R02` (POST, JSON)
- 방식: Debugger API로 네트워크 응답 캡처 → "더 보기" 버튼 클릭으로 페이지네이션 처리
- `content_main.js`로 MAIN world XHR 가로채기도 병행
- 캐시 키: `seumterList` (session storage, TTL 5분)

### 2. 나라장터 G2B (g2b.go.kr)
- URL: `https://www.g2b.go.kr`
- API: `selectBidPbacScrollTypeList.do`
- 방식: 탭 자동화 (Debugger API + executeScript)
  1. 입찰공고목록 이동
  2. 상세조건 패널 열기 (1500ms 대기)
  3. 낙찰방법 → 설계공모 선택
     - 셀렉터: `select[id*="sbxScsbdMthdCd"]` (w2selectbox 네이티브 select)
     - 값 직접 설정 + `change` 이벤트 발생
  4. 날짜 캘린더에서 날짜 설정
  5. 검색 버튼 클릭 → 응답 캡처
- 캐시 키: `g2bList` (session storage, TTL 5분)

### 3. 건축허브 (hub.go.kr)
- URL: `https://www.hub.go.kr/portal/dps/dsr/idx-dsr-selectDesignPbpPbancList.do?intYn=N`
- 방식: 탭 열기 → executeScript로 DOM 파싱 (날짜 필터링)
- 캐시 키: `hubList` (session storage, TTL 5분)

## UI (index.html + popup.js)

- 아이콘 클릭 시 `index.html`을 전용 탭으로 오픈 (이미 열려 있으면 포커스)
- 세 섹션으로 구성: 세움터(남색) / 나라장터(진청) / 건축허브(녹색)
- 날짜 피커: 선택 날짜 기준으로 세 곳 동시 갱신, 캐시 초기화 후 재요청
- 탭 필터: "날짜별 공고" / "진행중 전체"
- D-Day 배지: 7일 이내 빨강, 이후 파랑, 마감 회색

## 메시지 타입 (popup.js → background.js)

| type | 설명 |
|------|------|
| `FETCH_LIST` | 세움터 목록 요청 (`progStatNm` 파라미터) |
| `GET_CACHE` | 세움터 캐시 폴링 |
| `FETCH_G2B` | 나라장터 목록 요청 (`dateYMD` 파라미터, YYYYMMDD) |
| `FETCH_HUB` | 건축허브 목록 요청 (`dateYMD` 파라미터) |

## 주요 주의사항

- **나라장터 낙찰방법 셀렉터**: `select[id*="sbxScsbdMthdCd"]`가 정확한 ID 패턴. `scsbdMthdCd`(sbx 없는 버전)는 매칭 안 됨.
- **나라장터 상세조건 패널**: 열린 후 1500ms 대기 필요 (너무 짧으면 드롭다운 미조작).
- **나라장터는 w2selectbox 커스텀 컴포넌트**: 네이티브 `<select>`에 직접 value 설정 + `change` 이벤트 방식이 유일하게 안정적.
- 세움터는 SPA라 딥링크 불가 → 목록 페이지(`AWPAIA01L01`)로만 연결.
- Debugger API는 탭당 하나만 attach 가능. `cleanup()`에서 반드시 detach.

## 개발 / 로드 방법

```
chrome://extensions → 개발자 모드 ON → 압축해제된 확장 프로그램 로드
→ /Users/kyurikim/Desktop/바이브코딩/세움터_공고_확장 폴더 선택
```

코드 수정 후: 확장 관리 페이지에서 새로고침(↺) 버튼 클릭.
