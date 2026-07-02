# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 파일 구조

단일 HTML 파일 (`공모결과정리도구.html`, ~2450줄). 외부 서버 없음. GitHub Pages로 배포.

- **GitHub 저장소**: `https://github.com/kyuri27/scorer-tools.git`
- **배포 URL**: `https://kyuri27.github.io/scorer-tools/공모결과정리도구.html`
- **로컬 작업 경로**: `/Users/kyurikim/Desktop/바이브코딩/스코어러 데이터/scorer-tools/`

커밋/푸시:
```bash
cd "/Users/kyurikim/Desktop/바이브코딩/스코어러 데이터/scorer-tools"
git add 공모결과정리도구.html CLAUDE.md
git commit -m "..."
git push origin main
```
(push 시 CLAUDE.md도 반드시 함께 업데이트·커밋)

## 라이브러리 (모두 인라인 번들)

- **PDF.js** — PDF → 이미지 변환 (페이지 렌더링)
- **pdf-lib** — PDF 병합 (결과 파일 합본)
- **JSZip** — ZIP 생성 (현재 미사용, 순수 JS buildZip으로 대체됨)
- **Google Gemini API** — PDF/이미지 분석 (REST 호출, 키는 localStorage에 저장)

## 핵심 아키텍처

### 전역 상태
```
seumterData              — 세움터 JSON에서 파싱한 공모 정보 (module-level let, NOT window._seumterData)
window._currentData      — 분석 결과 (renderSummary/downloadAwardsTxt 등에서 참조)
window._judgesData       — 렌더링된 심사위원 배열 (드래그 순서 변경 시 업데이트)
window._judgeCustomOrder — 드래그로 변경된 심사위원 순서 (이름 배열, null이면 기본 순서)
window._judgeStatusOverrides — 참석 상태 수동 변경 { name: '참석'|'불참' }
window._awardLabelOverrides  — 정리명 수동 변경 { idx: '변경된라벨' }
window._processedUploadFiles — renderDownloads에서 처리된 결과 파일 (공모 결과 입력하기용)
window._processedNoticeFiles — 처리된 공고 파일 (공모 정보 입력하기용)
noticeFiles / resultFiles    — 업로드된 파일 배열 (ArrayBuffer 포함)
```

**중요**: `resetAll()`은 위 변수를 모두 초기화해야 함. `seumterData`는 반드시 `seumterData = null` (window 아님).

### 주요 함수 흐름

**`applySeumterJSON()`** (line ~406)
- 세움터 JSON 파싱 → `cleanNamesInData()` 적용 → `seumterData` 저장
- 공모명을 `manualCompetitionName` 입력란에 자동 채움

**`runAnalysis()`** (line ~776)
- Gemini 분석 실행. `seumterData`만 있고 파일 없어도 동작
- `judges_planned`가 없으면 공고 파일도 Gemini에 전송해 심사위원 추출
- 결과를 세움터 데이터와 병합 후 `renderSummary()` 호출

**`renderSummary(s)`** (line ~1537)
- 심사위원: PDF 추출 순서 우선 → 세움터 순서 → `_judgeCustomOrder`로 최종 정렬
- 수상작 정리명: `_awardLabelOverrides[idx]` 있으면 우선 적용
- 심사위원 기본 참석 상태: PDF 결과 파일이 있으면 PDF 기준, 없으면 전원 '참석'

**`renderDownloads(data)`** (line ~2187)
- 파일명 생성 규칙: `{지역명}_{공모명}_{날짜}_{접두사}[_ENG|_KOR]`
- 공고 파일(`noticeGroups`): 개별 이름 변경만, **PDF 병합 안 함**
- 결과 파일(`resultGroups`): 같은 접두사끼리 PDF 병합
- `_ENG`/`_KOR` suffix는 보존 (`extractLangSuffix`)

**`buildZip(files)`** (line ~2081)
- 순수 JS로 ZIP 바이너리 직접 생성 (JSZip 미사용)
- 한글 파일명 깨짐 방지: general purpose bit flag `0x0800` (UTF-8) 설정 필수
  - local file header offset 6: `lv.setUint16(6, 0x0800, true)`
  - central directory offset 8: `cv.setUint16(8, 0x0800, true)`

### 데이터 정제 규칙

**`cleanNamesInData()`** — `applySeumterJSON` 시 적용
- 사람 이름 띄어쓰기 제거 (`cleanPersonName`)
- 심사위원 타입 정규화: `본위원`/`외부위원` → `외부`, `예비위원` → `예비`
- 설계사무소명에서 `[단독응모]` 제거
- 법인 접두어 `(주)/㈜/(株)` 제거는 `renderDownloads`의 파일명 생성 단계에서 처리

**`cleanCompetitionName(raw)`** (line ~1478)
- 제거 suffix 목록(앞에서부터 길이 우선): `'건축설계용역 일반', '건축설계용역', '설계용역', '용역', '건립', '설계공모', '제안공모', '현상공모', '지명공모', '설계경기', '공모', '사업'`
- 지역명 자동 추출 (`extractRegionPrefix`): `전라남도 → 전남` 등 17개 광역시도 매핑

**`parseJudgesText(text)`** (line ~1389)
- 심사위원 텍스트 파싱: 탭 구분, 또는 섹션 헤더(`예비심사위원`, `본위원` 등)로 타입 감지
- 타입 regex: `예비(?:위원)?`, `외부위원?` → `?`만 쓰면 `예비위원` 안 잡힘, 반드시 `(?:위원)?` 사용

**`fuzzyMatchName(seumterName, pdfName)`** (line ~1264)
- 심사위원 이름 매칭: 양쪽 모두 2글자 이상이고 두 번째 글자까지 같으면 동일인으로 처리

### seumterData JSON 형식

```json
{
  "competitionName": "공모명",
  "build": "건립사업명(선택)",
  "location": "전라남도 여수시",
  "noticeDate": "20240101",
  "announceDate": "20240301",
  "resultNoticeUrl": "https://...",
  "judges_planned": [{"name": "홍길동", "type": "외부"}],
  "judges_attended": ["홍길동"],
  "chairperson": "홍길동",
  "awards": [
    {
      "awardType": "당선작",
      "office": "건축사사무소A+건축사사무소B",
      "designer": "홍길동+김길동",
      "imgSrc": "https://..."
    }
  ]
}
```
- 공동수상: `office`와 `designer`를 `+`로 구분 → 표시 시 `,`로 변환

### 비밀번호 보호
- HTML 상단 `checkPw()` 함수 (line ~187): JS 인라인 패스워드 체크
- GitHub Pages public 저장소이므로 소스에서 비밀번호 노출됨 (보안 목적이 아닌 단순 접근 제한)

### 외부 연동
- **공모 결과 입력하기** (`runAwardInput`): 로컬 HTTP 서버 `localhost:8765`로 수상작 데이터 전송
- **공모 정보 입력하기** (`runCompetitionInput`): 같은 포트로 공고 파일 + 공모 정보 전송
- **세움터 프록시** (`세움터_proxy.js`): `localhost:3456`에서 세움터 API 세션 쿠키 자동 처리

### 디버그 로그
line ~831에 임시 디버그 로그 남아있음:
```javascript
logProgress(`[dbg] noticeFiles=${noticeFiles.length}, ...`);
```
