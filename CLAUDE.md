# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 파일 구조

단일 HTML 파일 (`공모결과정리도구.html`, ~2700줄). 외부 서버 없음. GitHub Pages로 배포.

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

## 지원 파일 타입

| 타입 | 확장자 | Gemini 분석 | 이름 변경 | 비고 |
|------|--------|------------|----------|------|
| pdf | .pdf | ✅ | ✅ | 결과 파일끼리 접두사별 병합 |
| image | .png .jpg .jpeg .webp | ✅ | ✅ | 수상작 이미지 매핑 |
| hwp | .hwp .hwpx | ❌ | ✅ | 개별 이름 변경만 |
| excel | .xlsx .xls | ❌ | ✅ | 개별 이름 변경만 |
| zip | .zip | ❌ | ✅ | 개별 이름 변경만 |

**공고 파일은 PDF 포함 모두 병합하지 않고 파일별 개별 이름 변경.**

## 핵심 아키텍처

### 전역 상태
```
seumterData              — 세움터 JSON에서 파싱한 공모 정보 (module-level let, NOT window._seumterData)
window._currentData      — 분석 결과 (renderSummary/downloadAwardsTxt 등에서 참조)
window._judgesData       — 렌더링된 심사위원 배열 (드래그 순서 변경 시 업데이트)
window._judgesSaved      — 변경사항 저장된 심사위원 배열 (renderSummary 재호출 시 복원)
window._awardsSaved      — 변경사항 저장된 수상작 배열 (renderSummary 재호출 시 복원)
window._awardLabelOverrides  — 정리명 수동 변경 { idx: '변경된라벨' }
window._processedUploadFiles — renderDownloads에서 처리된 결과 파일 (공모 결과 입력하기용)
window._processedNoticeFiles — 처리된 공고 파일 (공모 정보 입력하기용)
noticeFiles / resultFiles    — 업로드된 파일 배열 (ArrayBuffer 포함)
```

**중요**: `resetAll()`은 위 변수를 모두 초기화해야 함. `seumterData`는 반드시 `seumterData = null` (window 아님).

### 주요 함수 흐름

**`applySeumterJSON()`**
- 세움터 JSON 파싱 → `cleanNamesInData()` 적용 → `seumterData` 저장
- 공모명을 `manualCompetitionName` 입력란에 자동 채움

**`runAnalysis()`**
- Gemini 분석 실행. `seumterData`만 있고 파일 없어도 동작 (이름 변경만)
- `judges_planned`가 없으면 공고 파일도 Gemini에 전송해 심사위원 추출
- 결과를 세움터 데이터와 병합 후 `renderSummary()` 호출
- 503 에러 시 지수 백오프 자동 재시도 (10s→20s→40s→80s, 최대 4회)

**`renderSummary(s)`**
- 수상작 표시 조건: `hasResultFiles = resultFiles.some(f => f.type === 'pdf' || f.type === 'image')` — HWP·Excel·ZIP만 있으면 미표시
- 수상작: `manualAwards || (hasResultFiles ? s.awards : null) || []`
- 심사위원: PDF 추출 순서 우선 → 세움터 순서
- 심사위원 기본 참석 상태: PDF 결과 파일 있으면 PDF 기준, 없으면 전원 '참석'
- 수상작 정리명: input 직접 편집 → `updateAwardLabel(idx, val)` → `window._awardLabelOverrides[idx]`

**`renderDownloads(data)`**
- 날짜: 수동 입력란(`manualNoticeDate`, `manualAnnounceDate`)을 DOM에서 직접 읽어 JSON 날짜보다 우선 적용
- 공고 파일: 파일별 개별 이름 변경 (병합 없음)
- 결과 파일: 같은 접두사끼리 PDF 병합
- 파일명 규칙: `{접두사}_{공모명}_{날짜}.pdf`

### 심사위원

**타입**: `'본'` (본위원·외부위원·내부위원 등 전부) / `'예비'` 두 가지만
```javascript
function normalizeJudgeType(type) {
  if (!type) return '본';
  if (type.includes('예비')) return '예비';
  return '본';
}
```

**`judges_attended`**: `{name: string, org: string}[]` 객체 배열 (문자열 아님)

**순서 우선순위**: PDF 문서 등장 순서 > 세움터 JSON 순서. 예비위원은 항상 마지막.

**수동 편집**: drag-and-drop 순서 변경, 타입 토글(본/예비), 삭제(✕), 추가(＋). "변경사항 저장" 클릭 시 `window._judgesSaved`에 보존.

### 수상작

**공동응모**: `office` 필드에 `+` 구분자로 연결 (예: `"건축사사무소A+건축사사무소B"`). Gemini 프롬프트에 "같은 행에 업체명이 두 줄 이상이면 전부 `+`로 연결, 첫 줄만 가져오지 말 것" 명시.

**이미지 파일명 자동 파싱**: `{awardType}{rank?}_{num}.ext` 패턴 인식 (예: `가작1_18.jpg`, `당선작_3.jpg`). awards가 없거나 매칭 실패 시 파일명으로 자동 생성.
```javascript
function parseAwardFromFilename(nameNoExt) {
  const m = nameNoExt.match(/^([가-힣]+?)(\d+)?_(\d+)$/);
  if (!m) return null;
  return { awardType: m[1], pdfRank: m[2] ? parseInt(m[2]) : null, num: m[3] };
}
```

**수동 편집**: 구분·정리명·설계사무소·대표설계자 모두 inline input. 추가(＋)/삭제(✕). "변경사항 저장" → `window._awardsSaved`.

### 파일명 생성

```javascript
const NOTICE_KEYWORDS = ['과업지시서', '지침서', '공고문', '제안서'];
const RESULT_KEYWORDS = ['심사의결서', '평가사유서', '투표결과', '심사결과', '결과공고', '심사위원명단', '심사표', '평가표', '집계표', '입상작', '당선작'];
```
- `extractNoticePrefix` / `extractResultPrefix` → 키워드 매칭 후 접두사 추출
- `[붙임N]` 패턴 파일명에서 제거
- 날짜 입력: `manualNoticeDate`/`manualAnnounceDate` DOM 직접 읽음 (JSON보다 항상 우선)

### 데이터 정제 규칙

**`cleanNamesInData()`** — `applySeumterJSON` 시 적용
- 사람 이름 띄어쓰기 제거 (`cleanPersonName`)
- 심사위원 타입 정규화 → `normalizeJudgeType`
- 설계사무소명에서 `[단독응모]` 제거

**`cleanCompetitionName(raw)`**
- 제거 suffix: `'건축설계용역 일반', '건축설계용역', '설계용역', '용역', '건립', '설계공모', '제안공모', '현상공모', '지명공모', '설계경기', '공모', '사업'`
- 지역명 자동 추출 (`extractRegionPrefix`): `전라남도 → 전남` 등 17개 광역시도 매핑

**`fuzzyMatchName(seumterName, pdfName)`**
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
  "judges_attended": [{"name": "홍길동", "org": "소속기관"}],
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
- 미지정 심사위원(`name.includes('미지정')`)은 렌더링 시 자동 제외
- `judges_attended`는 `{name, org}` 객체 배열 (문자열 아님)

### 외부 연동
- **공모 결과 입력하기** (`runAwardInput`): 로컬 HTTP 서버 `localhost:8765`로 수상작 데이터 전송
- **공모 정보 입력하기** (`runCompetitionInput`): 같은 포트로 공고 파일 + 공모 정보 전송
- **세움터 프록시** (`세움터_proxy.js`): `localhost:3456`에서 세움터 API 세션 쿠키 자동 처리

### 디버그 로그
line ~831에 임시 디버그 로그 남아있음:
```javascript
logProgress(`[dbg] noticeFiles=${noticeFiles.length}, ...`);
```
