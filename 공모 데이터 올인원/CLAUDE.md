# 공모 데이터 올인원 입력 — CLAUDE.md

## 개요

`scorer.co.kr`에 공모 데이터를 자동 입력하는 Python 3 + Playwright 스크립트.
HTML 정리도구(`공모결과정리도구.html`)와 연동해 동작하며, 포트 8765 로컬 서버로 통신한다.

## 파일 구조

```
/Volumes/My Passport/스코어러/데이터/공모 데이터 올인원/   ← 현재 작업 경로 (외장 드라이브)
  main.py              # 메인 자동화 스크립트
  전달용/               # 배포용 파일 사본

/Users/kyurikim/Desktop/바이브코딩/스코어러 데이터/공모 데이터 올인원 입력/   ← 원본 경로 (Git repo)
  main.py              # 메인 자동화 스크립트
  맥_실행.command       # Mac 실행 스크립트
  맥_설치.command       # Mac 의존성 설치 스크립트
  윈도우_실행.bat        # Windows 실행 스크립트
  윈도우_설치.bat        # Windows 의존성 설치 스크립트
  auth_state.json      # 브라우저 로그인 세션 (자동 생성)
  수상작목록.txt         # 결과 입력 후 자동 저장
  공모 파일/            # 공고파일 (HTML에서 자동 저장 → 업로드 후 자동 삭제)
  결과 파일/            # 심사결과 파일 (HTML에서 자동 저장 → 업로드 후 자동 삭제)
  입상작 이미지/         # 수상작 이미지 (HTML에서 자동 저장)
  전달용/               # 배포용 파일 사본
```

## HTML 정리도구 위치

```
/Users/kyurikim/Desktop/바이브코딩/스코어러 데이터/공모결과정리도구/공모결과정리도구.html
```

- 포트 8765로 `main.py`에 POST 요청
- 버튼 클릭 → `_trigger_queue`에 적재 → 자동 모드 1 또는 6 실행
- `result_url` 필드: `input[name='entry_data_url']`에 입력됨

## 실행 방법

```bash
# Mac
double-click 맥_실행.command
# 또는
cd "/Users/kyurikim/Desktop/바이브코딩/스코어러 데이터/공모 데이터 올인원 입력"
python3 main.py
```

## 모드 선택 메뉴

실행 시 표시되는 메뉴:
- **1** — 공모 정보 입력 (심사위원 + 공고파일 + 발주처) [전체]
- **2** — 심사위원만 입력
- **3** — 공고파일만 업로드
- **4** — 파일 업로드만 (직접 file_manage로 이동)
- **5** — 발주처만 입력
- **6** — 공모 결과 입력 (수상작 + 건축가 + 결과파일 + 불참처리)
- **9** — 결과 재입력 (수상작 삭제 후 재등록)
- **10 / q** — 종료

HTML 도구의 버튼 클릭 시 → 자동으로 모드 1 또는 6 실행.

## 주요 상수 (main.py 상단)

| 상수 | 값 | 설명 |
|------|----|------|
| `SERVER_PORT` | 8765 | HTML 도구와 통신 포트 |
| `BROWSER_WIDTH/HEIGHT` | 1920×1080 | 브라우저 창 크기 |
| `SEARCH_WAIT_MS` | 1000 | 검색 후 대기 시간(ms) |
| `ACTION_WAIT_MS` | 500 | 액션 후 대기 시간(ms) |
| `NOTICE_FILES_DIR` | "공모 파일" | 공고파일 폴더명 |
| `RESULT_FILES_DIR` | "결과 파일" | 결과파일 폴더명 |
| `IMAGE_DIR_NAME` | "입상작 이미지" | 이미지 폴더명 |

## 핵심 함수

### 파일 관련
- **`_is_uploadable(filename)`** — `Thumbs.db`, `.DS_Store` 등 시스템 파일 제외
- **`_clear_and_save_files(dir_path, files_data) → list[Path]`** — 폴더 초기화 3단계(rmtree → glob 개별삭제 → 잔여경고) 후 파일 저장, 저장된 경로 목록 반환
- **`_wipe_dir(dir_path)`** — 업로드 후 폴더 내 파일만 삭제 (폴더 유지)
- **`_find_image(entry_name)`** — 특수문자(`㈜` 등) 포함 파일명은 임시 파일로 복사 후 반환

### 업로드 함수 (`specific_files` 패턴)
- **`upload_notice_files(page, comp_id, specific_files=None)`** — HTML 트리거 시 `specific_files`로 방금 저장한 파일만 업로드 (폴더 전체 스캔 방지)
- **`upload_result_files(page, contest_id, specific_files=None)`** — 동일. `specific_files=[]`이면 업로드 건너뜀
- 결과 파일 없는 공모도 항상 결과 폴더를 먼저 wipe → `saved_result_paths`로만 업로드하므로 이전 공모 파일 절대 올라가지 않음

### 브라우저 관련
- **`_browser_alive()`** — `page.is_closed()` + `context.pages` 확인
- **`_kill_port(port)`** — 포트 점유 프로세스 종료 (Mac: `lsof`, Windows: `netstat`)
- **`auto_accept_dialogs(page)`** — 팝업 자동 수락 (try/except로 중복 수락 방지)

### DataTable 검색
- **`_read_all_rows()`** — `page.evaluate()` JS로 소속 컬럼(index 4)만 원자적으로 추출
- **`_read_all_rows_full()`** — 이름 포함 확인용 전체 행 텍스트 추출
- **`_wait_stable()`** — 행 수가 2회 연속 동일할 때까지 polling (DataTable debounce ~400ms 대응)
- 검색 순서: `fill("")` → 300ms 대기 → `fill(name)` → 600ms + stable 확인
- **`_collect_all_pages()`** (add_judge 내부 중첩함수) — DataTable 전 페이지 순회(`#dataTable_next`가 disabled될 때까지), 모든 행 수집 후 목표 페이지로 이동해 클릭

### 심사위원 관련
- **`sort_judges(judges)`** — `{"본": 0, "외부": 0, "예비": 1}` 맵으로 정렬. 본·외부 위원이 예비보다 먼저
- **`affiliation_similarity(a, b)`** — 소속 비교. `_strip_affiliation_boilerplate()` 로 보일러플레이트 제거 후 비교, 임계값 0.3
- **`_AFFIL_BOILERPLATE`** = `["주식회사","유한회사","(주)","㈜","(유)","종합건축사사무소","건축사사무소","사무소","종합","스튜디오","이엔지","엔지니어링","조경설계사무소","조경설계","조경"]`
- **`get_registered_names(page)`** — 현재 등록된 심사위원 이름 목록 반환
- **`_ensure_judging_toggles_on(page, target_filenames)`** — 이번에 업로드한 파일 행만 대상

### 심사위원 등록 흐름 (Step 4 — 불참처리 단계)
1. judges 데이터가 있으면 `get_registered_names()`로 이미 등록된 이름 확인
2. 미등록 위원이 있으면 `run_judges_input()` 실행
3. 이미 모두 등록돼 있으면 "✅ 이미 등록됨" 출력 후 불참처리만 진행
4. 불참처리: `_manage_jury_absence(page, comp_id, judges)`

### 건축사명 정규화 (`_clean_architect_name`)
- `주식회사`/`유한회사`/`(주)`/`㈜`/`(유)` 제거
- `종합건축사사무소 ○○` (앞) vs `○○ 종합건축사사무소` (뒤) 구분 처리
- `조경설계사무소` / `조경설계` / `조경` 제거
- `eng` (대소문자 무관) 제거
- `이엔지(?!니어링)` — 부정형 전방탐색으로 `엔지니어링` 안의 `이엔지`는 보존
- `(?<!이)엔지니어링` — 부정형 후방탐색으로 `이엔지니어링`은 보존하고 `유선엔지니어링` 등의 접미사는 제거
- `스튜디오` 제거
- `-` 외 기호 전부 제거 (`[^a-zA-Z0-9가-힣\s\-]`)

### 건축사 선택 (`_select_architect`) 로직

**검색 순서:**
1. `search_name + "종합"` 으로 먼저 검색 (`has_suffix_jongap=True`인 경우)
2. 결과 없거나 no-select-button 행뿐이면 → `search_name`만으로 재시도
3. 여전히 실패 → `extra_info` 첫 번째 값(대표자명)으로 재검색 (`_designer_fallback = True`)
4. 완전 실패 → `_issues`에 로그 후 `False` 반환

**선택 로직:**
1. 결과 1건 → `_verify_and_select(verify_firm=_designer_fallback)` 호출
2. 결과 다건 → `_clean_architect_name` 정규화 후 정확 일치(exact_matches) 찾기
   - exact_matches == 1: 해당 행 자동 선택
   - exact_matches > 1: **그 행들 안에서만** `search_name`을 제외한 키워드로 disambiguation
   - exact_matches == 0: 전체 행에서 키워드 매칭
3. keyword 매칭도 실패 → `pause_for_user()`

**`_no_select_btn(row)` (내부 함수):**
- DataTable "No data" 텍스트가 아닌 **선택 버튼 유무**로 빈 결과 판단 (한국어 DataTable 대응)
- `button:has-text('선택'), a:has-text('선택'), input[value='선택']` count == 0 이면 빈 결과

**`_verify_and_select(row_locator, verify_firm=False)` (내부 함수):**
- `verify_firm=True`이면: 행의 사무소명(3열)을 `_clean_architect_name`으로 정규화 후 `search_name`과 비교, 불일치 시 `_issues`에 기록 후 `False` 반환
- `_designer_names`가 있으면: 행의 대표자명(4열)과 비교, 불일치 시 `_issues`에 기록 후 `False` 반환
- 검증 통과 시 선택 버튼 클릭 후 `True` 반환
- **대표자명 fallback 후에는 항상 `verify_firm=True`** (`_designer_fallback` 플래그)

**검색 대기:** 0.7초 → 1.0초로 증가 (DataTable debounce 대응)

### 심사위원 등록 (`add_judge`) — 단독 결과 소속 확인
- 검색 결과가 **1명**인 경우에도 `affiliation`이 있으면 `affiliation_similarity()`로 소속 검증
  - 유사도 ≥ 0.3: 자동 선택 + 소속 확인 ✅ 출력
  - 유사도 < 0.3: ⚠️ 경고 출력 후 `[엔터] 선택 / [s] 건너뜀 / [q] 중단` 프롬프트
  - `affiliation`이 없으면: 1명이면 그냥 자동 선택 (기존과 동일)

### 발주처 검색 (`_search_org_and_select`) — 이름 정확 일치 우선
- `affiliation_similarity`는 "포함" 관계에서 1.0을 반환하므로 `경북대학교`를 검색하면 `경북대학교병원`도 1.0이 돼 첫 번째 행이 선택될 수 있음
- Fix: `_extract_names(text)`로 행 텍스트에서 버튼 레이블(`선택`/`수정`/`삭제` 등)과 숫자를 제거한 뒤, `original_name`이 그 목록에 정확히 포함되는지 먼저 확인
- 정확 일치 행이 있으면 → 바로 선택 (유사도 계산 생략)
- 정확 일치 없으면 → 기존 `affiliation_similarity` 점수 최대 행 선택

### 입상작 등록 (`_create_entry`) — 심사결과 URL 입력
- `result_url` 파라미터 추가: 심사결과 확인 URL
- 폼 저장 전 `input[name='entry_data_url']` 필드가 있으면 바로 채움
- 저장 후 redirect된 페이지에도 해당 필드가 있으면 한 번 더 채우고 재저장 (create 폼에는 없고 편집 폼에만 있는 경우 대응)

### 발주처 검색 (`run_organization_input`) 점진적 토큰 제거
- `"한국농어촌공사 강원지역본부 원주지사"` 같은 계층형 기관명은 검색 실패 시 뒤에서부터 토큰을 하나씩 제거하며 재시도
- `"한국농어촌공사 강원지역본부"` → `"한국농어촌공사"` 순으로 축약

### 입상작 등록 (`_create_entry`)
- 저장 후 URL에 `/create/`가 여전히 있으면 등록 실패로 간주 → Exception 발생
- 폼의 `공개여부` 드롭다운 → 자동으로 `"공개"` 선택

## 알려진 이슈 및 해결책

| 증상 | 원인 | 해결 |
|------|------|------|
| 이전 공모 파일 같이 업로드 | 폴더 스캔 방식이 잔여 파일 포함 | `specific_files` 패턴: 방금 저장한 경로만 업로드 |
| 결과파일 없는데 이전 파일 업로드 | `[]` → `None` 변환 후 폴더 스캔 경로 진입 | 항상 폴더 wipe 먼저, `specific_files=[]` 직접 전달 |
| DataTable 검색 결과 stale | debounce ~400ms | 300ms+600ms 대기 + `_wait_stable()` polling |
| 동명이인 소속 매칭 오류 | 건축사사무소 보일러플레이트가 유사도 부풀림 | `_strip_affiliation_boilerplate()` 후 비교 |
| 심사위원 다음 페이지 못 찾음 | 첫 페이지만 읽음 | `_collect_all_pages()` 전 페이지 순회 |
| 이미지 업로드 실패(`㈜` 등) | `set_input_files` 특수문자 경로 오류 | 임시 파일로 복사 후 사용 |
| 포트 8765 점유 | 이전 프로세스 미종료 | `_kill_port()` 자동 실행 |
| 브라우저 닫힌 후 오류 | `browser is None` 체크 불충분 | `_browser_alive()` 함수 |
| 예비위원이 먼저 입력됨 | sort 맵에 `본` 키 누락 → default 2로 밀림 | `{"본": 0, "외부": 0, "예비": 1}` 수정 |
| `이엔지` 제거가 `엔지니어링` 내부 오작동 | `replace` 단순 치환 | `이엔지(?!니어링)` 부정형 전방탐색 |
| `유선엔지니어링` 못 찾음 | `엔지니어링` 접미사 미제거 | `(?<!이)엔지니어링` 부정형 후방탐색으로 제거 |
| `길종합` 재검색 실패 | DataTable 한국어 "No data" 텍스트 감지 불가 | `_no_select_btn`: 선택 버튼 유무로 판단, 대기 1.0초 |
| 검색 결과 1건이어도 심사위원 소속 미확인 | 단독 결과는 무조건 선택 | `add_judge`: 단독 결과도 소속 유사도 검사 후 수동 확인 프롬프트 |
| 수상작 건축가 대표자명 미확인 | `_select_architect` 선택 전 대표자명 검증 없음 | `_verify_and_select`: 대표자명 + 사무소명 검증 통합 |
| 대표자명 fallback 후 사무소명 미확인 | fallback 경로에서 `verify_firm=False` | `_designer_fallback` 플래그로 `verify_firm=True` 강제 |
| `모아건축사사무소` 오선택 | exact_matches 다건 시 `search_name` 키워드가 다른 행의 대표자명과 일치 | exact_matches 다건이면 그 행 안에서만 `search_name` 제외 키워드로 disambiguation |
| `경북대학교` → `경북대학교병원` 오선택 | `affiliation_similarity` "포함"→1.0 반환, 첫 번째 행 선택 | `_search_org_and_select`: 정확 일치 우선 선택, similarity는 fallback |
| 심사결과 URL 미입력 | create 폼에 `entry_data_url` 필드 없음 | 저장 후 redirect된 편집 폼에서 재탐색·입력·재저장 |
| `(유)` 포함 사무소명 검색 실패 | `(유)` 제거 미구현 | `_clean_architect_name`·`_AFFIL_BOILERPLATE`에 `유한회사`/`(유)` 추가 |
| 입상작 저장 실패 감지 못함 | 서버 검증 실패해도 폼 유지; URL 확인 안 함 | 저장 후 `/create/` URL 잔류 체크 |
| 기호 포함 사무소명 검색 오류 | `#`, `&` 등 기호가 검색어에 포함 | `-` 외 기호 전부 제거 |

## 수정 후 배포 절차

`main.py` 수정 시 → 외장 드라이브 + `전달용/` 폴더 사본도 동기화 + zip 재생성:

```bash
BASE="/Users/kyurikim/Desktop/바이브코딩/스코어러 데이터/공모 데이터 올인원 입력"
EXT="/Volumes/My Passport/스코어러/데이터/공모 데이터 올인원"
cp "$BASE/main.py" "$BASE/전달용/main.py"
cp "$BASE/main.py" "$EXT/main.py"
cp "$BASE/main.py" "$EXT/전달용/main.py"
zip -r /tmp/공모데이터올인원.zip "$BASE" --exclude "*.pyc" --exclude "*/__pycache__/*"
cp /tmp/공모데이터올인원.zip "$BASE/공모데이터올인원.zip"
```

**푸시 시 반드시 이 CLAUDE.md도 변경 내용 반영 후 함께 커밋.**

Git repo: `kyuri27/scorer-tools` (clone: `/tmp/scorer-tools/`)
