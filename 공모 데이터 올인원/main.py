#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
공모 데이터 자동 입력 스크립트
==============================
공모 정보 입력 (심사위원 / 공고파일 / 발주처) +
공모 결과 입력 (수상작 / 건축가 / 결과파일 / 심사위원 불참처리)

[사용 방법]
  1. 맥_실행.command 더블클릭
  2. 브라우저에서 카카오톡 로그인 (최초 1회)
  3. 아래 중 원하는 방법으로 실행:
     - 공모 ID 입력 후 엔터  → 공모 정보 입력 (심사위원 + 공고파일 + 발주처)
     - HTML 도구에서 버튼 클릭 → 해당 작업 자동 실행
       ・ '공모 정보 입력하기' → 심사위원 + 공고파일 + 발주처
       ・ '공모 결과 입력하기' → 수상작 + 건축가 + 결과파일 + 불참처리

[폴더 구조]
  공모 데이터 입력/
    main.py
    맥_실행.command
    auth_state.json     (자동 생성)
    심사위원.txt         (터미널 모드용 심사위원 목록)
    발주처.txt           (터미널 모드용 발주처 이름)
    수상작목록.txt        (결과 입력 후 자동 저장)
    공모 파일/           (공고파일 — HTML에서 자동 저장)
    결과 파일/           (심사결과 파일 — HTML에서 자동 저장)
    입상작 이미지/        (수상작 이미지 — HTML에서 자동 저장)
"""

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import sys, os, threading, queue as _queue_module
import json, base64, time, unicodedata

# select는 macOS/Linux 전용 (Windows에서는 msvcrt 사용)
if sys.platform != "win32":
    import select as _select

# ============================================================
# 설정값
# ============================================================
JUDGES_FILE      = "심사위원.txt"
AUTH_FILE        = "auth_state.json"
ORG_FILE         = "발주처.txt"
AWARDS_FILE      = "수상작목록.txt"
NOTICE_FILES_DIR = "공모 파일"
RESULT_FILES_DIR = "결과 파일"
IMAGE_DIR_NAME   = "입상작 이미지"

BROWSER_WIDTH  = 1920
BROWSER_HEIGHT = 1080
SERVER_PORT    = 8765

SEARCH_WAIT_MS = 1000
ACTION_WAIT_MS = 500

SCRIPT_DIR = Path(__file__).parent
IMAGE_DIR  = SCRIPT_DIR / IMAGE_DIR_NAME
UPLOAD_DIR = SCRIPT_DIR / RESULT_FILES_DIR

_trigger_queue: "_queue_module.Queue" = _queue_module.Queue()


# ============================================================
# 공통 유틸
# ============================================================

def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def normalize(text: str) -> str:
    """소속 매칭용 정규화 — 공백/특수문자 제거 후 소문자"""
    if not text:
        return ""
    result = "".join(text.split())
    for ch in "()（）.,·ㆍ・[]{}":
        result = result.replace(ch, "")
    return result.lower()


def affiliation_similarity(a: str, b: str) -> float:
    """두 소속명 유사도 (0~1). 한 쪽이 다른 쪽을 포함하면 1.0"""
    a_n, b_n = normalize(a), normalize(b)
    if not a_n or not b_n:
        return 0.0
    if a_n in b_n or b_n in a_n:
        return 1.0
    common = sum(1 for c in set(a_n) if c in b_n)
    return common / max(len(set(a_n)), len(set(b_n)))


def auto_accept_dialogs(page):
    page.on("dialog", lambda d: d.accept())


def pause_for_error():
    print("\n⚠️  오류 발생. 선택하세요:")
    print("  엔터 → 재시도")
    print("  s    → 건너뛰기")
    print("  q    → 종료")
    choice = input("> ").strip().lower()
    if choice == "s":
        return "skip"
    if choice == "q":
        sys.exit(0)
    return "retry"


def pause_for_user():
    print("  ✋ 브라우저에서 직접 선택 후 엔터를 누르세요.  (q → 종료)")
    choice = input("  > ").strip().lower()
    if choice == "q":
        sys.exit(0)


def _save_auth(context, auth_path: Path):
    try:
        context.storage_state(path=str(auth_path))
    except Exception:
        pass


def _clear_and_save_files(dir_path: Path, files_data: list):
    """폴더를 비우고 base64 파일 목록을 저장"""
    dir_path.mkdir(parents=True, exist_ok=True)
    # 기존 파일 삭제
    for f in dir_path.iterdir():
        if f.is_file() and not f.name.startswith("."):
            f.unlink()
    # 새 파일 저장
    for f in files_data:
        fname = f.get("filename", "file")
        try:
            (dir_path / fname).write_bytes(base64.b64decode(f.get("data", "")))
        except Exception as e:
            print(f"  ⚠️  파일 저장 실패 ({fname}): {e}")


# ============================================================
# 로컬 HTTP 서버 (HTML 도구 연동)
# ============================================================

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # 서버 로그 억제

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            body = json.dumps({"status": "ready"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path in ("/start-competition", "/start"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length))
                task_type = "info" if self.path == "/start-competition" else "result"
                _trigger_queue.put((task_type, data))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except Exception as e:
                self.send_response(500)
                self._cors()
                self.end_headers()
                self.wfile.write(str(e).encode())
        else:
            self.send_response(404)
            self.end_headers()


class _ReuseAddrServer(HTTPServer):
    """SO_REUSEADDR — 이전 실행이 포트를 점유 중일 때도 바로 재시작 가능"""
    allow_reuse_address = True


def start_local_server() -> _ReuseAddrServer:
    try:
        server = _ReuseAddrServer(("localhost", SERVER_PORT), _Handler)
    except OSError:
        print(f"⚠️  포트 {SERVER_PORT} 이미 사용 중 — 기존 프로세스를 종료 후 다시 실행해주세요.")
        import sys; sys.exit(1)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # 서버 로그 억제

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            body = json.dumps({"status": "ready"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path in ("/start-competition", "/start"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length))
                task_type = "info" if self.path == "/start-competition" else "result"
                _trigger_queue.put((task_type, data))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except Exception as e:
                self.send_response(500)
                self._cors()
                self.end_headers()
                self.wfile.write(str(e).encode())
        else:
            self.send_response(404)
            self.end_headers()


def start_local_server() -> HTTPServer:
    server = HTTPServer(("localhost", SERVER_PORT), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _wait_for_trigger() -> tuple:
    """
    키보드 입력(공모 ID) 또는 HTTP 트리거를 동시에 기다림.
    어느 쪽이 먼저 도착하든 즉시 반환.
    반환값: ("keyboard", "6375") 또는 ("info", {...}) 또는 ("result", {...})
    """
    if sys.platform == "win32":
        # Windows: msvcrt로 논블로킹 키보드 입력
        import msvcrt
        buf = ""
        while True:
            try:
                return _trigger_queue.get_nowait()
            except _queue_module.Empty:
                pass
            if msvcrt.kbhit():
                ch = msvcrt.getwche()
                if ch in ('\r', '\n'):
                    print()
                    return ("keyboard", buf.strip())
                elif ch == '\x03':  # Ctrl+C
                    raise KeyboardInterrupt
                elif ch == '\x08':  # 백스페이스
                    if buf:
                        buf = buf[:-1]
                        sys.stdout.write('\b \b')
                        sys.stdout.flush()
                else:
                    buf += ch
            time.sleep(0.05)
    else:
        # macOS/Linux: select()
        while True:
            try:
                return _trigger_queue.get_nowait()
            except _queue_module.Empty:
                pass
            r, _, _ = _select.select([sys.stdin], [], [], 0.3)
            if r:
                line = sys.stdin.readline().strip()
                return ("keyboard", line)


# ============================================================
# ① 공모 정보 입력 (심사위원 / 공고파일 / 발주처)
# ============================================================

def load_judges_from_file() -> list:
    """심사위원.txt에서 심사위원 목록 읽기"""
    path = SCRIPT_DIR / JUDGES_FILE
    if not path.exists():
        sample = (
            "# 심사위원 정보 파일\n"
            "# 형식: 구분(외부/예비), 이름, 소속\n\n"
            "외부, 박종국, 일.월건축사사무소\n"
            "예비, 심상우, (주)지오건축사사무소\n"
        )
        path.write_text(sample, encoding="utf-8-sig")
        print(f"📝 '{JUDGES_FILE}' 파일이 없어서 예시 파일을 생성했어요.")
        return []

    judges = []
    with open(path, encoding="utf-8-sig") as f:
        for ln, raw in enumerate(f, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 3:
                print(f"⚠️  {ln}번째 줄 형식 오류 (건너뜀): {line}")
                continue
            judge_type, name = parts[0], parts[1]
            affiliation = ",".join(parts[2:]).strip()
            if judge_type not in ("외부", "예비"):
                print(f"⚠️  {ln}번째 줄 구분값 오류 '{judge_type}' (건너뜀)")
                continue
            judges.append({"type": judge_type, "name": name, "affiliation": affiliation})
    return judges


def load_judges_from_payload(judges_raw: list) -> list:
    """HTML 페이로드 judges [{name, org, type}] → 내부 형식 [{name, affiliation, type}]"""
    return [
        {
            "name": j.get("name", "").strip(),
            "affiliation": j.get("org", "").strip(),
            "type": j.get("type", "외부"),
        }
        for j in judges_raw
        if j.get("name", "").strip()
    ]


def sort_judges(judges: list) -> list:
    return sorted(judges, key=lambda j: {"외부": 0, "예비": 1}.get(j["type"], 2))


def get_left_table(page):
    try:
        t = page.locator("table.table-hover")
        if t.count() > 0:
            return t.first
    except Exception:
        pass
    return None


def get_registered_names(page) -> set:
    table = get_left_table(page)
    if table is None:
        return set()
    try:
        cells = table.locator("tbody tr td:nth-child(3)")
        return {t.strip() for t in cells.all_inner_texts() if t.strip()}
    except Exception:
        return set()


def find_left_table_last_row(page, expected_name=""):
    table = get_left_table(page)
    if table is not None:
        try:
            body_rows = table.locator("tbody tr")
            if body_rows.count() == 0:
                body_rows = table.locator("tr")
            rc = body_rows.count()
            if rc > 0:
                last = body_rows.nth(rc - 1)
                if not expected_name or expected_name in last.inner_text():
                    return last
                named = table.locator(f'tr:has-text("{expected_name}")').last
                if named.count() > 0:
                    return named
                return last
        except Exception:
            pass
    if expected_name:
        try:
            all_rows = page.locator(f'tr:has-text("{expected_name}")')
            for i in range(all_rows.count()):
                row = all_rows.nth(i)
                if (row.locator('button:has-text("변경하기")').count() > 0
                        and row.locator('button:has-text("선택")').count() == 0):
                    return row
        except Exception:
            pass
    return None


def add_judge(page, judge: dict) -> tuple:
    """심사위원 한 명 추가. (success: bool, msg: str) 반환"""
    name, affiliation = judge["name"], judge["affiliation"]
    is_backup = judge["type"] == "예비"
    print(f"  → 검색: {name} ({affiliation})")

    try:
        sb = page.locator('input[aria-controls="dataTable"]')
        sb.wait_for(state="visible", timeout=5000)
        sb.click()
        sb.fill("")
        sb.fill(name)
    except Exception:
        return False, "검색 박스를 찾지 못함"


    # DataTable 필터 완료 대기 (최대 3초)
    # 0행은 필터링 중간 상태일 수 있으므로 1행 이상 + 2회 연속 동일할 때 안정으로 판단
    page.wait_for_timeout(200)  # 최소 초기 대기
    _prev_rc = -1
    _stable = 0
    for _ in range(28):  # 최대 2.8초 추가 대기
        page.wait_for_timeout(100)
        _cur_rc = page.locator('#dataTable tbody tr').count()
        if _cur_rc > 0 and _cur_rc == _prev_rc:
            _stable += 1
            if _stable >= 2:
                break
        else:
            _stable = 0
        _prev_rc = _cur_rc



    try:
        rows = page.locator('#dataTable tbody tr')
        rc = rows.count()
        if rc == 0:
            return False, "검색 결과 없음"
        first_text = rows.nth(0).inner_text()
        if "No data" in first_text or ("데이터" in first_text and "없" in first_text):
            return False, "검색 결과 없음"

        if rc == 1:
            target_idx = 0
            print(f"     검색결과 1명 → 자동 선택")
        else:
            print(f"     검색결과 {rc}명 → 소속으로 매칭 중")
            best, target_idx = 0.0, 0
            for i in range(rc):
                score = affiliation_similarity(affiliation, rows.nth(i).inner_text())
                if score > best:
                    best, target_idx = score, i
            if best < 0.3:
                return False, "동명이인 소속 매칭 실패"
            print(f"     매칭 (유사도 {best:.0%})")

        target = rows.nth(target_idx)
        btn = target.locator('button:has-text("선택"), a:has-text("선택"), input[value="선택"]').first
        if btn.count() == 0:
            return False, "'선택' 버튼 없음"
        btn.wait_for(state="visible", timeout=5000)
        btn.click(timeout=5000)
        page.wait_for_timeout(ACTION_WAIT_MS)

    except Exception as e:
        err = str(e)
        if "Timeout" in err:
            return False, "선택 버튼 클릭 시간 초과"
        return False, f"선택 중 오류: {err}"

    if is_backup:
        try:
            print("     → 예비로 변경 중...")
            page.wait_for_timeout(ACTION_WAIT_MS)
            left_row = find_left_table_last_row(page, name)
            if left_row is None:
                return False, f"좌측 목록에서 '{name}' 행을 찾지 못함"
            change_btns = left_row.locator('button:has-text("변경하기")')
            if change_btns.count() >= 1:
                change_btns.nth(0).click()
                page.wait_for_timeout(ACTION_WAIT_MS)
                print("     → 예비 변경 완료")
            else:
                return False, "'변경하기' 버튼을 못 찾음"
        except Exception as e:
            return False, f"예비 변경 중 오류: {e}"

    return True, "성공"


def run_judges_input(page, judges: list) -> bool:
    """심사위원 목록 전체 입력. False = 브라우저 연결 끊김"""
    if not judges:
        print("❌ 심사위원 정보가 없습니다.")
        return True

    sorted_j = sort_judges(judges)
    registered = get_registered_names(page)
    if registered:
        print(f"\n이미 등록된 심사위원 {len(registered)}명 → 자동 건너뜁니다")

    print(f"\n총 {len(sorted_j)}명 입력 예정:")
    for i, j in enumerate(sorted_j, 1):
        mark = " ✓ 이미등록" if j["name"] in registered else ""
        print(f"  {i}. [{j['type']}] {j['name']} - {j['affiliation']}{mark}")
    print()

    results = []
    idx = 0
    while idx < len(sorted_j):
        judge = sorted_j[idx]
        no = idx + 1

        if judge["name"] in registered:
            print(f"[{no}/{len(sorted_j)}] {judge['name']} → 이미 등록됨, 건너뜁니다")
            results.append((judge, True, "이미 등록됨"))
            idx += 1
            continue

        print(f"[{no}/{len(sorted_j)}] {judge['name']} 처리 중...")

        try:
            success, msg = add_judge(page, judge)
        except Exception as e:
            err = str(e).lower()
            is_dead = (("browser" in err and "closed" in err)
                       or ("context" in err and "closed" in err)
                       or "crash" in err)
            if is_dead:
                print(f"  ❌ 브라우저 연결 끊김: {e}")
                _print_judge_summary(results, sorted_j)
                return False
            success, msg = False, f"예외: {e}"

        if success:
            print(f"  ✅ 완료")
            results.append((judge, True, msg))
            idx += 1
            try:
                page.wait_for_timeout(ACTION_WAIT_MS)
            except Exception:
                _print_judge_summary(results, sorted_j)
                return False
            continue

        # ── 실패 → 일시정지 ──
        print(f"  ❌ 실패: {msg}")
        print(f"\n  ⏸  일시정지: [{judge['type']}] {judge['name']} 추가 실패")
        print(f"  [엔터] 건너뜀  [r] 재시도  [s] 수동 완료로 표시  [q] 중단")
        try:
            choice = input("  >>> ").strip().lower()
        except Exception:
            choice = "q"

        if choice == "q":
            results.append((judge, False, f"{msg} (사용자 중단)"))
            _print_judge_summary(results, sorted_j)
            return True
        elif choice == "r":
            continue
        elif choice == "s":
            results.append((judge, True, "수동 추가"))
            idx += 1
        else:
            results.append((judge, False, f"{msg} (건너뜀)"))
            idx += 1

    _print_judge_summary(results, sorted_j)
    return True


def _print_judge_summary(results, all_judges):
    print("\n" + "=" * 50)
    ok = sum(1 for _, s, _ in results if s)
    print(f"심사위원 결과: {ok}/{len(all_judges)}명 성공")
    for j, s, m in results:
        print(f"  {'✅' if s else '❌'} [{j['type']}] {j['name']} - {m}")


def navigate_to_competition(page, comp_id: str) -> bool:
    url = f"https://scorer.co.kr/admin/competition/{comp_id}/jury_manage"
    print(f">>> {url} 이동 중...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
    except Exception as e:
        print(f"❌ 페이지 이동 실패: {e}")
        return False
    if any(x in page.url for x in ("login", "signin", "auth")):
        print("\n⚠️  로그인 세션 만료. 브라우저에서 다시 로그인 후 엔터를 눌러주세요.")
        input(">>> [엔터] ")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(1000)
        except Exception as e:
            print(f"❌ 재이동 실패: {e}")
            return False
    return True


ADMIN_SUFFIXES = [
    "특별자치시", "특별자치도", "특별시", "광역시",
    "시청", "군청", "구청", "도청",
    "시", "군", "구", "도",
]

# 검색 시 제거할 기관 접미사 (학교·공공기관 등)
ORG_SUFFIXES = [
    "초등학교", "중학교", "고등학교", "대학교", "대학원", "학교",
    "교육청", "교육지원청",
    "공사", "공단", "재단", "연구원", "연구소",
    "센터", "본부", "청", "원",
]

# 도·광역시 접두사 (키워드 추출 2단계에서 제거)
PROVINCE_PREFIXES = [
    "강원특별자치도", "전북특별자치도",
    "서울특별시", "부산광역시", "대구광역시", "인천광역시",
    "광주광역시", "대전광역시", "울산광역시", "세종특별자치시",
    "경기도", "강원도", "충청북도", "충청남도",
    "전라북도", "전라남도", "경상북도", "경상남도", "제주특별자치도",
    "제주도",
]

def extract_search_keyword(name: str) -> str:
    """발주처 이름에서 핵심 검색 키워드 추출 (행정·기관 접미사 제거)"""
    for sfx in ADMIN_SUFFIXES + ORG_SUFFIXES:
        if name.endswith(sfx):
            kw = name[:-len(sfx)].strip()
            if kw:
                return kw
    return name


def extract_core_keyword(name: str) -> str:
    """접미사 제거 후 도/광역시 접두사까지 제거하여 핵심 키워드 추출
    예) 경상북도포항교육지원청 → (교육지원청 제거) → 경상북도포항 → (경상북도 제거) → 포항
    """
    kw = extract_search_keyword(name)
    # 접두사 제거
    for pfx in PROVINCE_PREFIXES:
        if kw.startswith(pfx):
            core = kw[len(pfx):].strip()
            if core:
                return core
    # 접두사 목록에 없어도 끝에 행정 접미사가 남은 경우 재시도
    # (예: "경기도수원" 중 "경기도" 미포함 시 "수원" 추출 불가 → 그냥 kw 반환)
    return kw


def _wait_for_org_table(page):
    """DataTable 필터 완료 대기 (1행 이상 + 2회 연속 안정)"""
    page.wait_for_timeout(200)
    _prev_rc = -1
    _stable = 0
    for _ in range(28):
        page.wait_for_timeout(100)
        _cur_rc = page.locator('#dataTable tbody tr').count()
        if _cur_rc > 0 and _cur_rc == _prev_rc:
            _stable += 1
            if _stable >= 2:
                break
        else:
            _stable = 0
        _prev_rc = _cur_rc


def _collect_all_table_rows(page) -> list:
    """DataTable 전체 페이지를 순회하며 (page_num, row_idx, text) 수집"""
    all_rows = []
    current_page = 1

    while True:
        rows = page.locator('#dataTable tbody tr')
        rc = rows.count()
        if rc > 0:
            first_text = rows.nth(0).inner_text()
            if not ("No data" in first_text or ("데이터" in first_text and "없" in first_text)):
                for i in range(rc):
                    all_rows.append((current_page, i, rows.nth(i).inner_text()))

        # 다음 페이지 버튼 확인
        next_btn = page.locator('#dataTable_next')
        if next_btn.count() == 0:
            break
        next_cls = next_btn.get_attribute('class') or ''
        if 'disabled' in next_cls:
            break
        next_btn.click()
        _wait_for_org_table(page)
        current_page += 1

    return all_rows


def _search_org_and_select(page, search_term, original_name) -> bool:
    sb = page.locator('input[aria-controls="dataTable"]')
    sb.wait_for(state="visible", timeout=5000)
    sb.click()
    sb.fill("")
    sb.fill(search_term)
    _wait_for_org_table(page)

    all_rows = _collect_all_table_rows(page)
    total_pages = all_rows[-1][0] if all_rows else 0

    if not all_rows:
        return False

    if len(all_rows) == 1:
        target_page, target_row_idx, _ = all_rows[0]
        print("     검색결과 1개 → 자동 선택")
    else:
        page_info = f" (총 {total_pages}페이지)" if total_pages > 1 else ""
        print(f"     검색결과 {len(all_rows)}개{page_info} → 유사도 매칭 중")
        best, best_idx = 0.0, 0
        for idx, (pg, ri, text) in enumerate(all_rows):
            s = affiliation_similarity(original_name, text)
            if s > best:
                best, best_idx = s, idx
        target_page, target_row_idx, _ = all_rows[best_idx]
        print(f"     매칭 (유사도 {best:.0%})")

    # 현재 위치(마지막 페이지)에서 target_page로 이동
    current_page = total_pages
    if current_page != target_page:
        first_btn = page.locator('#dataTable_first')
        if first_btn.count() > 0:
            first_btn.click()
            _wait_for_org_table(page)
        else:
            # first 버튼 없으면 previous 반복
            prev_btn = page.locator('#dataTable_previous')
            for _ in range(current_page - 1):
                if 'disabled' in (prev_btn.get_attribute('class') or ''):
                    break
                prev_btn.click()
                _wait_for_org_table(page)
        # target_page까지 next 클릭
        for _ in range(target_page - 1):
            page.locator('#dataTable_next').click()
            _wait_for_org_table(page)

    rows = page.locator('#dataTable tbody tr')
    target = rows.nth(target_row_idx)
    btn = target.locator('button:has-text("선택")')
    if btn.count() == 0:
        return False
    btn.first.wait_for(state="visible", timeout=5000)
    btn.first.click(timeout=5000)
    page.wait_for_timeout(ACTION_WAIT_MS)
    return True


def run_organization_input(page, comp_id: str, agency: str = None):
    """발주처 관리 페이지에서 발주처 검색 후 선택"""
    if agency:
        name = agency
    else:
        name = _load_org_from_file()
    if not name:
        print(f"  ❌ '{ORG_FILE}'에서 발주처 이름을 읽을 수 없습니다.")
        return

    print(f"  발주처: {name}")
    url = f"https://scorer.co.kr/admin/competition/{comp_id}/organization_manage"
    print(f"  → {url} 이동 중...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
    except Exception as e:
        print(f"  ❌ 이동 실패: {e}")
        return

    # 이미 등록 확인
    try:
        cells = page.locator("table:not(#dataTable) td b")
        for i in range(cells.count()):
            rn = cells.nth(i).inner_text().strip()
            if affiliation_similarity(name, rn) >= 0.8:
                print(f"  ✓ 이미 등록됨 ({rn}), 건너뜁니다")
                return
    except Exception:
        pass

    tried: set = set()

    def _try(term: str) -> bool:
        if term in tried:
            return False
        tried.add(term)
        print(f"     '{term}' 으로 검색 중...")
        return _search_org_and_select(page, term, name)

    found = _try(name)
    if not found:
        kw = extract_search_keyword(name)
        found = _try(kw)
    if not found:
        core = extract_core_keyword(name)
        found = _try(core)

    if not found:
        print(f"  ❌ '{name}'을(를) DB에서 찾지 못했습니다.")
        return
    print(f"  ✅ 발주처 '{name}' 추가 완료")


def _load_org_from_file() -> str:
    path = SCRIPT_DIR / ORG_FILE
    if not path.exists():
        return ""
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    return ""


def _get_uploaded_filenames(page) -> set:
    """파일 관리 페이지에 이미 업로드된 파일명 목록 반환"""
    try:
        names = page.evaluate("""
            () => Array.from(document.querySelectorAll('table tbody tr td'))
                       .map(td => td.innerText.trim())
                       .filter(t => /\\.[a-zA-Z]{2,5}$/.test(t))
        """)
        return {n for n in names if n}
    except Exception:
        return set()


def upload_notice_files(page, comp_id: str) -> tuple:
    """공모 파일 폴더의 파일을 파일관리 페이지에 업로드"""
    files_dir = SCRIPT_DIR / NOTICE_FILES_DIR

    if not files_dir.exists():
        files_dir.mkdir()
        return False, f"'공모 파일' 폴더가 없어서 새로 만들었습니다. 파일을 넣고 다시 시도해주세요."

    files = sorted([f for f in files_dir.iterdir() if f.is_file() and not f.name.startswith(".")])
    if not files:
        return False, "업로드할 파일 없음"

    url = f"https://scorer.co.kr/admin/file_manage/{comp_id}"
    print(f"  → {url} 이동 중...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
    except Exception as e:
        return False, f"이동 실패: {e}"

    # 이미 업로드된 파일 확인 후 중복 제거
    existing = _get_uploaded_filenames(page)
    new_files = [f for f in files if f.name not in existing]

    if existing:
        skipped = [f.name for f in files if f.name in existing]
        if skipped:
            print(f"  ⏭  이미 업로드됨 ({len(skipped)}개): {', '.join(skipped)}")
    if not new_files:
        return True, "모든 파일이 이미 업로드되어 있습니다."

    print(f"  업로드할 공고파일 {len(new_files)}개:")
    for f in new_files:
        print(f"    - {f.name}")

    try:
        fi = page.locator('input[type="file"]')
        fi.wait_for(state="attached", timeout=5000)
        fi.set_input_files([str(f) for f in new_files])
        page.wait_for_timeout(500)
    except Exception as e:
        return False, f"파일 선택 실패: {e}"

    try:
        page.locator('button[type="submit"]').click()
        page.wait_for_timeout(2000)
    except Exception as e:
        return False, f"저장 실패: {e}"

    return True, f"{len(new_files)}개 파일 업로드 완료"


def run_info_task(page, context, auth_path: Path, data: dict, task_mode: int = 1):
    """HTML /start-competition 페이로드 처리 (공모 정보 입력)
    task_mode:
      1=전체(정보+결과), 2=정보전체, 3=정보-심사위원, 4=정보-파일, 5=정보-발주처
      6~9=결과 전용 모드 → 정보 입력 건너뜀
    """
    # 결과 전용 모드일 때는 정보 입력 불필요
    if task_mode in (6, 7, 8, 9):
        print(f"  ℹ️  현재 모드는 결과 입력 전용입니다. 정보 입력을 건너뜁니다.")
        return

    comp_id = str(data.get("competition_id", "")).strip()
    agency  = data.get("agency", "").strip()
    judges_raw = data.get("judges", [])
    notice_files_data = data.get("notice_files", [])

    if not comp_id.isdigit():
        print(f"❌ 잘못된 공모 ID: '{comp_id}'")
        return

    judges = load_judges_from_payload(judges_raw)

    # 항상 페이지 이동 먼저
    if not navigate_to_competition(page, comp_id):
        return
    _save_auth(context, auth_path)

    # 심사위원  (mode: 1, 2, 3)
    if task_mode in (1, 2, 3):
        if judges:
            print(f"\n[심사위원 입력] {len(judges)}명")
            ok = run_judges_input(page, judges)
            if not ok:
                print("\n❌ 브라우저 연결 끊김")
                return
        else:
            print("\n[심사위원 입력] 전달받은 심사위원 없음, 건너뜁니다.")

    # 공고파일 업로드  (mode: 1, 2, 4)
    if task_mode in (1, 2, 4):
        if notice_files_data:
            print(f"\n[공고파일 업로드] {len(notice_files_data)}개")
            _clear_and_save_files(SCRIPT_DIR / NOTICE_FILES_DIR, notice_files_data)
            ok, msg = upload_notice_files(page, comp_id)
            print(f"  {'✅' if ok else '❌'} {msg}")
        else:
            print("\n[공고파일 업로드] 전달받은 파일 없음, 건너뜁니다.")

    # 발주처  (mode: 1, 2, 5)
    if task_mode in (1, 2, 5):
        if agency:
            print(f"\n[발주처 입력]")
            run_organization_input(page, comp_id, agency=agency)
        else:
            print("\n[발주처 입력] 전달받은 발주처 없음, 건너뜁니다.")



# ============================================================
# ② 공모 결과 입력 (수상작 / 건축가 / 결과파일 / 불참처리)
# ============================================================

def _find_image(entry_name: str):
    if not IMAGE_DIR.exists():
        return None
    for fname in os.listdir(IMAGE_DIR):
        stem = Path(nfc(fname)).stem
        en = nfc(entry_name)
        if stem.startswith(en + "_") or stem == en:
            return str(IMAGE_DIR / fname)
    return None


def _clean_architect_name(name: str) -> str:
    for tok in ["주식회사", "(주)", "㈜", "건축사사무소", "종합", "스튜디오"]:
        name = name.replace(tok, "")
    return name.strip()


def _create_entry(page, create_url, entry_name, img_path=None):
    page.goto(create_url)
    page.wait_for_load_state("load", timeout=15000)

    try:
        inp = page.get_by_label("입상작명")
        inp.wait_for(state="visible", timeout=3000)
    except Exception:
        inp = page.locator("input[type='text']").first
        inp.wait_for(state="visible", timeout=5000)
    inp.fill(entry_name)

    if img_path:
        page.locator("input[type='file']").first.set_input_files(img_path)
        time.sleep(0.3)

    try:
        btn = page.get_by_role("button", name="저장하기")
        btn.wait_for(state="visible", timeout=5000)
        btn.click()
    except Exception:
        btn = page.locator("button[type='submit'], input[type='submit']").first
        btn.wait_for(state="visible", timeout=5000)
        btn.click()

    page.wait_for_load_state("load", timeout=15000)
    time.sleep(0.2)


def _get_existing_entry_names(page, contest_url, entry_names=None) -> set:
    page.goto(contest_url, wait_until="domcontentloaded", timeout=15000)

    # 전체 표시(-1) 선택 후 테이블 행 수 안정화 대기
    try:
        sel = page.locator("select[name$='_length']").first
        sel.wait_for(state="visible", timeout=5000)
        sel.select_option("-1")
        # networkidle 대신 행 수 안정화 polling
        _prev = -1
        _stable = 0
        for _ in range(30):
            page.wait_for_timeout(200)
            cur = page.locator("table tbody tr").count()
            if cur == _prev:
                _stable += 1
                if _stable >= 2:
                    break
            else:
                _stable = 0
            _prev = cur
    except Exception:
        page.wait_for_timeout(800)

    existing = set()
    try:
        candidates = page.evaluate("""
            () => {
                const rows = document.querySelectorAll('table tbody tr');
                return Array.from(rows).map(r => {
                    const cells = r.querySelectorAll('td');
                    if (cells.length < 4) return '';
                    return cells[3].innerText.trim();
                });
            }
        """)
        for name in candidates:
            name = nfc(name)
            if name and not name.isdigit():
                existing.add(name)
    except Exception:
        rows = page.locator("table tbody tr")
        for i in range(rows.count()):
            cells = rows.nth(i).locator("td")
            if cells.count() >= 4:
                n = nfc(cells.nth(3).inner_text().strip())
                if n and not n.isdigit():
                    existing.add(n)

    if existing:
        print(f"  기존 항목 {len(existing)}개: {', '.join(sorted(existing))}")
    return existing


def _go_to_architect_manage(page, contest_url, entry_name):
    page.goto(contest_url)
    page.wait_for_load_state("load", timeout=15000)
    time.sleep(0.3)

    row = page.locator("table tbody tr").filter(has_text=entry_name).first
    row.wait_for(state="visible", timeout=5000)
    try:
        btn = row.locator("a[href*='architect_manage']").first
        btn.wait_for(state="visible", timeout=3000)
        btn.click()
    except Exception:
        row.locator("button, a").filter(has_text="관리하기").last.click()
    page.wait_for_load_state("load", timeout=15000)


def _get_assigned_architect_names(page) -> list:
    assigned = []
    rows = page.locator("table tbody tr")
    for i in range(rows.count()):
        row = rows.nth(i)
        if row.locator("button:has-text('삭제하기')").count() > 0:
            assigned.append(row.inner_text().replace("삭제하기", "").strip())
    return assigned


def _select_architect(page, search_name, extra_info, original_name=""):
    sb = page.locator("input[type='search']").first
    sb.wait_for(state="visible", timeout=5000)
    sb.fill(search_name)
    time.sleep(0.7)

    rows = page.locator("#dataTable tbody tr")
    count = rows.count()

    if count == 0 or (count == 1 and "No data" in rows.first.inner_text()):
        print(f"\n  ⚠️ '{search_name}' 검색 결과 없음.")
        pause_for_user()
        return

    if count == 1:
        btn = rows.first.locator("button:has-text('선택'), a:has-text('선택'), input[value='선택']").first
        btn.wait_for(state="visible", timeout=5000)
        btn.click()
        time.sleep(0.2)
        return

    # extra_info가 콤마로 구분된 여러 키워드일 수 있음 (공동참여자 disambiguation 포함)
    keywords = [e.strip() for e in extra_info.split(",") if e.strip()] if extra_info else []
    for kw in ["종합", "스튜디오"]:
        if kw in original_name:
            keywords.append(kw)

    for kw in keywords:
        for i in range(count):
            if kw in rows.nth(i).inner_text():
                btn = rows.nth(i).locator("button:has-text('선택'), a:has-text('선택'), input[value='선택']").first
                btn.wait_for(state="visible", timeout=5000)
                btn.click()
                time.sleep(0.2)
                return

    print(f"\n  ⚠️ '{search_name}' 동명 결과 {count}개, 자동 판별 불가.")
    pause_for_user()


def _ensure_judging_toggles_on(page) -> bool:
    toggled = 0
    rows = page.locator("table tbody tr")
    for i in range(rows.count()):
        row = rows.nth(i)
        if not row.inner_text().strip():
            continue
        for j in range(row.locator("input[type='checkbox']").count()):
            cb = row.locator("input[type='checkbox']").nth(j)
            try:
                if not cb.is_checked():
                    cb.check()
                    toggled += 1
                    print(f"     ↳ 행 {i+1}: 심사결과 파일 여부 ON")
            except Exception:
                pass
    if toggled == 0:
        off = page.locator(
            "table tbody tr .toggle.off, "
            "table tbody tr [class*='toggle'][class*='off'], "
            "table tbody tr [class*='switch'][aria-checked='false']"
        )
        for j in range(off.count()):
            try:
                off.nth(j).click()
                toggled += 1
                print(f"     ↳ 토글 {j+1}: ON")
                time.sleep(0.2)
            except Exception:
                pass
    return toggled > 0


def upload_result_files(page, contest_id: str):
    """결과 파일 폴더의 파일을 파일관리 페이지에 업로드"""
    if not UPLOAD_DIR.exists():
        print("  ℹ️  '결과 파일' 폴더 없음 → 건너뜁니다.")
        return

    all_files = [f for f in os.listdir(UPLOAD_DIR) if not nfc(f).startswith(".")]
    if not all_files:
        print("  ⚠️ '결과 파일' 폴더 비어있음 → 건너뜁니다.")
        return

    url = f"https://scorer.co.kr/admin/file_manage/{contest_id}"
    page.goto(url)
    page.wait_for_load_state("load", timeout=15000)

    # 이미 업로드된 파일 확인 후 중복 제거
    existing = _get_uploaded_filenames(page)
    new_files = [f for f in all_files if f not in existing]

    if existing:
        skipped = [f for f in all_files if f in existing]
        if skipped:
            print(f"  ⏭  이미 업로드됨 ({len(skipped)}개): {', '.join(skipped)}")
    if not new_files:
        print("  ✅ 모든 파일이 이미 업로드되어 있습니다.")
        return

    file_paths = [str(UPLOAD_DIR / f) for f in new_files]
    page.locator("input[type='file']").first.set_input_files(file_paths)
    time.sleep(0.5)

    btn = page.get_by_role("button", name="저장하기")
    btn.wait_for(state="visible", timeout=5000)
    btn.click()
    page.wait_for_load_state("load", timeout=15000)
    print(f"  ✅ {len(new_files)}개 파일 업로드 완료")

    print("  심사결과 파일 여부 확인 중...")
    if _ensure_judging_toggles_on(page):
        try:
            page.get_by_role("button", name="저장하기").click()
            page.wait_for_load_state("load", timeout=15000)
            print("  ✅ 토글 저장 완료")
        except Exception as e:
            print(f"  ⚠️ 토글 저장 오류: {e}")
    else:
        print("  ✅ 모든 파일 심사결과 파일 여부 ON")


def _manage_jury_absence(page, contest_id, judges):
    absent = [j for j in judges if j.get("status") == "불참"]
    if not absent:
        print("  불참 심사위원 없음")
        return

    url = f"https://scorer.co.kr/admin/competition/{contest_id}/jury_manage"
    page.goto(url)
    page.wait_for_load_state("load", timeout=15000)

    table = page.locator("table").first
    for judge in absent:
        name = nfc(judge["name"])
        print(f"  [{judge['name']}] 불참 처리 중...", end="", flush=True)
        rows = table.locator("tbody tr")
        found = False
        for i in range(rows.count()):
            cells = rows.nth(i).locator("td")
            if cells.count() < 6:
                continue
            if nfc(cells.nth(2).inner_text().strip()) != name:
                continue
            found = True
            absent_cell = cells.nth(5)
            if "변경하기" not in absent_cell.inner_text().strip():
                print("  ⏭  이미 불참 처리됨")
                break
            absent_cell.locator("button, a").first.click()
            time.sleep(0.8)
            page.wait_for_load_state("load", timeout=10000)
            print("  ✅")
            break
        if not found:
            print(f"\n  ⚠️ '{judge['name']}' 을(를) 목록에서 찾지 못함")


def run_result_task(page, context, auth_path: Path, data: dict, task_mode: int = 1):
    """HTML /start 페이로드 처리 (공모 결과 입력)
    task_mode:
      1=전체(정보+결과), 6=결과전체, 7=결과-입상작, 8=결과-결과파일, 9=결과-불참처리
      2~5=정보 전용 모드 → 결과 입력 건너뜀
    """
    # 정보 전용 모드일 때는 결과 입력 불필요
    if task_mode in (2, 3, 4, 5):
        print(f"  ℹ️  현재 모드는 정보 입력 전용입니다. 결과 입력을 건너뜁니다.")
        return

    comp_id           = str(data.get("competition_id", "")).strip()
    awards_txt        = data.get("awards_txt", "")
    images            = data.get("images", [])
    upload_files_data = data.get("upload_files", [])
    judges            = data.get("judges") or []

    if not comp_id.isdigit():
        print(f"❌ 잘못된 공모 ID: '{comp_id}'")
        return

    contest_url = f"https://scorer.co.kr/admin/entry/{comp_id}"
    create_url  = f"https://scorer.co.kr/admin/entry/create/{comp_id}"
    arch_ok = 0  # 건축가 관리 성공 수

    # 수신 파일/이미지 저장 (폴더 비우고 새로 저장)
    if awards_txt:
        (SCRIPT_DIR / AWARDS_FILE).write_text(awards_txt, encoding="utf-8-sig")
        print(f"  수상작목록.txt 저장됨")
    if images:
        _clear_and_save_files(IMAGE_DIR, images)
        print(f"  이미지 {len(images)}장 저장됨")
    if upload_files_data:
        _clear_and_save_files(UPLOAD_DIR, upload_files_data)
        print(f"  결과 파일 {len(upload_files_data)}개 저장됨")

    created = []
    entries = []

    # ── 1+2단계: 입상작 등록 + 건축가 관리  (mode: 1, 6, 7) ──
    if task_mode in (1, 6, 7):
        if not awards_txt:
            print("❌ 수상작 데이터가 없습니다.")
            if task_mode == 7:
                return
        else:
            for line in awards_txt.splitlines():
                parts = line.rstrip("\n").split("\t")
                if parts and parts[0].strip():
                    entries.append((
                        parts[0].strip(),
                        parts[1].strip() if len(parts) > 1 else "",
                        parts[2].strip() if len(parts) > 2 else "",
                    ))
            if not entries:
                print("❌ 입상작 목록이 비어있습니다.")
                if task_mode == 7:
                    return
            else:
                print(f"\n📋 {len(entries)}개 입상작 처리 시작\n")

                # ── 1단계: 입상작 등록 ──
                print(f"{'─' * 50}")
                print(f"  1단계: 입상작 등록 ({len(entries)}개)")
                print(f"{'─' * 50}")
                print("  기존 등록 항목 확인 중...")
                existing = _get_existing_entry_names(page, contest_url, [e[0] for e in entries])

                for i, (entry_name, architect_name, extra_info) in enumerate(entries, 1):
                    img = _find_image(entry_name)
                    if nfc(entry_name) in existing:
                        print(f"[{i}/{len(entries)}] {entry_name}  →  ⏭  이미 등록됨")
                        created.append((entry_name, architect_name, extra_info))
                        continue
                    img_label = "이미지 없음" if not img else ""
                    print(f"[{i}/{len(entries)}] {entry_name}{' ('+img_label+')' if img_label else ''} ...", end="", flush=True)
                    while True:
                        try:
                            _create_entry(page, create_url, entry_name, img)
                            print("  ✅")
                            created.append((entry_name, architect_name, extra_info))
                            break
                        except PlaywrightTimeoutError as e:
                            print(f"\n  ❌ 시간 초과: {e}")
                        except Exception as e:
                            err = str(e).lower()
                            if "browser" in err and "closed" in err:
                                print("\n❌ 브라우저 연결 끊김")
                                return
                            print(f"\n  ❌ 오류: {e}")
                        if pause_for_error() == "skip":
                            break

                # ── 2단계: 건축가 관리 ──
                print(f"\n{'─' * 50}")
                print(f"  2단계: 건축가 관리 ({len(created)}개)")
                print(f"{'─' * 50}")
                arch_ok = 0
                for i, (entry_name, architect_name, extra_info) in enumerate(created, 1):
                    arch_list  = [a.strip() for a in architect_name.split(",") if a.strip()]
                    extra_list = [e.strip() for e in extra_info.split(",") if e.strip()]
                    pairs = []
                    for j in range(len(arch_list)):
                        if j < len(arch_list) - 1:
                            # 중간 office: 대응하는 designer 하나만
                            extra = extra_list[j] if j < len(extra_list) else ""
                        else:
                            # 마지막 office: 남은 designer 전부를 disambiguation 키워드로 합침
                            extras = extra_list[j:] if j < len(extra_list) else []
                            extra = ",".join(extras)
                        pairs.append((arch_list[j], extra))
                    keywords = [f"'{_clean_architect_name(a)}'" for a, _ in pairs]
                    print(f"[{i}/{len(created)}] {entry_name}  →  {', '.join(keywords)} ...", end="", flush=True)
                    while True:
                        try:
                            _go_to_architect_manage(page, contest_url, entry_name)
                            assigned = _get_assigned_architect_names(page)
                            if len(assigned) >= len(pairs):
                                print("  ⏭  이미 전원 배정됨")
                                arch_ok += 1
                                break
                            for arch, extra in pairs:
                                sn = _clean_architect_name(arch)
                                if any(sn in n for n in assigned):
                                    print(f"     ⏭  '{sn}' 이미 배정됨")
                                else:
                                    print(f"     ➕ '{sn}' ...", end="", flush=True)
                                    _select_architect(page, sn, extra, arch)
                                    print(" ✅")
                            print("  완료")
                            page.goto(contest_url)
                            page.wait_for_load_state("load", timeout=15000)
                            arch_ok += 1
                            break
                        except PlaywrightTimeoutError as e:
                            print(f"\n  ❌ 시간 초과: {e}")
                        except Exception as e:
                            err = str(e).lower()
                            if "browser" in err and "closed" in err:
                                print("\n❌ 브라우저 연결 끊김")
                                return
                            print(f"\n  ❌ 오류: {e}")
                        if pause_for_error() == "skip":
                            break

    # ── 3단계: 결과파일 업로드  (mode: 1, 6, 8) ──
    if task_mode in (1, 6, 8):
        print(f"\n{'─' * 50}")
        print(f"  3단계: 결과파일 업로드")
        print(f"{'─' * 50}")
        upload_result_files(page, comp_id)

    # ── 4단계: 심사위원 불참 처리  (mode: 1, 6, 9) ──
    if task_mode in (1, 6, 9):
        if judges:
            absent_count = sum(1 for j in judges if j.get("status") == "불참")
            print(f"\n{'─' * 50}")
            print(f"  4단계: 심사위원 불참 처리 (불참 {absent_count}명)")
            print(f"{'─' * 50}")
            _manage_jury_absence(page, comp_id, judges)
        else:
            print(f"\n  ℹ️  심사위원 데이터 없음 → 불참 처리 건너뜁니다.")

    _save_auth(context, auth_path)

    absent_done = sum(1 for j in judges if j.get("status") == "불참")
    print(f"\n{'=' * 50}")
    print(f"  공모 결과 입력 완료!")
    if entries and task_mode in (1, 6, 7):
        print(f"  입상작: {len(created)}/{len(entries)}개")
        print(f"  건축가: {arch_ok}/{len(created)}개")
    if judges and task_mode in (1, 6, 9):
        print(f"  불참 처리: {absent_done}명")
    print(f"{'=' * 50}")


# ============================================================
# 브라우저 / 인증
# ============================================================

def _open_browser(p, auth_path: Path):
    browser = p.chromium.launch(
        headless=False,
        args=[f'--window-size={BROWSER_WIDTH},{BROWSER_HEIGHT}']
    )
    kw = {"no_viewport": True}
    if auth_path.exists():
        print(f"💾 저장된 로그인 세션 불러옵니다.")
        kw["storage_state"] = str(auth_path)
    context = browser.new_context(**kw)
    page = context.new_page()
    auto_accept_dialogs(page)

    print()
    print(">>> 브라우저가 열렸습니다.")
    print(">>> ⚠️  이 브라우저 창에서만 작업하세요! (다른 창 금지)")

    return browser, context, page



# ============================================================
# 실행 모드
# ============================================================

def _run_combined_mode(page, context, auth_path: Path, server=None):
    """
    터미널 입력과 HTML 버튼을 동시에 대기.
    - 공모 ID 입력 후 엔터 → 공모 정보 입력 (심사위원 + 공고파일 + 발주처)
    - HTML '공모 정보 입력하기' 클릭 → 공모 정보 입력
    - HTML '공모 결과 입력하기' 클릭 → 공모 결과 입력
    """
    if server is None:
        server = start_local_server()
        print(f"\n🌐 서버 준비 완료 (포트 {SERVER_PORT})")
    print("   HTML 도구 '공모 정보 입력하기' / '공모 결과 입력하기' 버튼 대기 중\n")

    comp_no = 1
    while True:
        print("─" * 60)
        print("공모 ID 입력 후 엔터  또는  HTML 도구에서 버튼 클릭  (종료: q)")
        print("─" * 60)
        print(">>> ", end="", flush=True)

        task_type, data = _wait_for_trigger()

        # ── 키보드 입력 ──
        if task_type == "keyboard":
            comp_id = str(data)
            if comp_id.lower() == "q":
                print("\n>>> 종료합니다. 수고하셨습니다! 👋")
                break
            if not comp_id.isdigit():
                if comp_id:
                    print(f"\n⚠️  숫자만 입력해주세요. (입력값: '{comp_id}')")
                continue

            print(f"\n{'█' * 60}")
            print(f"█ {comp_no}번째 공모 — 정보 입력 (ID: {comp_id})")
            print("█" * 60)

            try:
                if navigate_to_competition(page, comp_id):
                    _save_auth(context, auth_path)
                    ok = run_judges_input(page, load_judges_from_file())
                    if not ok:
                        print("\n❌ 브라우저 연결 끊김. 종료합니다.")
                        break
                print("\n[공고파일 업로드]")
                ok, msg = upload_notice_files(page, comp_id)
                print(f"  {'✅' if ok else '❌'} {msg}")
                print("\n[발주처 입력]")
                run_organization_input(page, comp_id)
            except Exception as e:
                print(f"❌ 처리 중 예외 발생: {e}")

        # ── HTTP 트리거 ──
        else:
            comp_id = str(data.get("competition_id", "")).strip()
            label = "정보 입력" if task_type == "info" else "결과 입력"
            print(f"\n{'█' * 60}")
            print(f"█ {comp_no}번째 공모 — {label} (ID: {comp_id})")
            print("█" * 60)
            try:
                if task_type == "info":
                    run_info_task(page, context, auth_path, data)
                else:
                    run_result_task(page, context, auth_path, data)
            except Exception as e:
                print(f"❌ 처리 중 예외 발생: {e}")

        _save_auth(context, auth_path)
        comp_no += 1

    try:
        server.shutdown()
    except Exception:
        pass


# ============================================================
# 진입점
# ============================================================

def main():
    print("=" * 60)
    print("  공모 데이터 자동 입력  |  스코어러")
    print("=" * 60)

    # ── 작업 모드 선택 ──────────────────────────────────────────
    print("\n어떤 작업을 할까요?\n")
    print("  [1] 전체  (정보 / 결과 — HTML 버튼에 따라 자동)")
    print()
    print("  ── 공모 정보 입력 ──────────────────────────")
    print("  [2] 정보 전체  (심사위원 + 파일 업로드 + 발주처)")
    print("  [3] 정보 — 심사위원만")
    print("  [4] 정보 — 파일 업로드만")
    print("  [5] 정보 — 발주처만")
    print()
    print("  ── 공모 결과 입력 ──────────────────────────")
    print("  [6] 결과 전체  (입상작 + 결과파일 + 불참처리)")
    print("  [7] 결과 — 입상작만")
    print("  [8] 결과 — 결과파일만")
    print("  [9] 결과 — 심사위원 불참만")
    print("\n" + "─" * 30)
    while True:
        mode_input = input(">>> 번호 선택: ").strip()
        if mode_input in ("1", "2", "3", "4", "5", "6", "7", "8", "9"):
            task_mode = int(mode_input)
            break
        print("  1~9 중 하나를 입력해주세요.")
    mode_labels = {
        1: "전체 (정보 / 결과)",
        2: "정보 전체 (심사위원 + 파일 업로드 + 발주처)",
        3: "정보 — 심사위원만",
        4: "정보 — 파일 업로드만",
        5: "정보 — 발주처만",
        6: "결과 전체 (입상작 + 결과파일 + 불참처리)",
        7: "결과 — 입상작만",
        8: "결과 — 결과파일만",
        9: "결과 — 심사위원 불참만",
    }
    print(f"✓ 선택: {mode_labels[task_mode]}\n")
    # ────────────────────────────────────────────────────────────

    auth_path = SCRIPT_DIR / AUTH_FILE

    server = start_local_server()
    print(f"🌐 서버 준비 완료 (포트 {SERVER_PORT})")

    with sync_playwright() as p:
        browser = None
        context = None
        page    = None
        comp_no = 1

        try:
            while True:
                print("─" * 60)
                print("공모 ID 입력 후 엔터  또는  HTML 도구에서 버튼 클릭  (종료: q)")
                print("─" * 60)
                print(">>> ", end="", flush=True)

                task_type, data = _wait_for_trigger()

                # 종료
                if task_type == "keyboard" and str(data).strip().lower() == "q":
                    print("\n>>> 종료합니다. 수고하셨습니다! 👋")
                    break

                # 첫 트리거 시점에 브라우저 열기 (로그인 포함)
                if browser is None:
                    browser, context, page = _open_browser(p, auth_path)

                labels = {"keyboard": "정보 입력 (터미널)", "info": "정보 입력 (HTML)", "result": "결과 입력 (HTML)"}
                print(f"\n{'█' * 60}")
                print(f"█ {comp_no}번째 공모 — {labels.get(task_type, task_type)}")
                print("█" * 60)

                try:
                    if task_type == "keyboard":
                        comp_id = str(data).strip()
                        if not comp_id.isdigit():
                            if comp_id:
                                print(f"\n⚠️  숫자만 입력해주세요. (입력값: '{comp_id}')")
                            continue
                        if task_mode in (6, 7, 8, 9):
                            print("  ℹ️  현재 모드는 결과 입력 전용입니다. 터미널 ID 입력은 정보 입력 전용입니다.")
                            continue
                        if navigate_to_competition(page, comp_id):
                            _save_auth(context, auth_path)
                            # 심사위원  (mode: 1, 2, 3)
                            if task_mode in (1, 2, 3):
                                ok = run_judges_input(page, load_judges_from_file())
                                if not ok:
                                    print("\n❌ 브라우저 연결 끊김. 종료합니다.")
                                    break
                            # 공고파일  (mode: 1, 2, 4)
                            if task_mode in (1, 2, 4):
                                print("\n[공고파일 업로드]")
                                ok, msg = upload_notice_files(page, comp_id)
                                print(f"  {'✅' if ok else '❌'} {msg}")
                            # 발주처  (mode: 1, 2, 5)
                            if task_mode in (1, 2, 5):
                                print("\n[발주처 입력]")
                                run_organization_input(page, comp_id)
                    elif task_type == "info":
                        run_info_task(page, context, auth_path, data, task_mode)
                    else:
                        run_result_task(page, context, auth_path, data, task_mode)
                except Exception as e:
                    print(f"❌ 처리 중 예외 발생: {e}")

                _save_auth(context, auth_path)
                comp_no += 1

        finally:
            try:
                server.shutdown()
            except Exception:
                pass
            if browser:
                print("\n>>> 브라우저를 닫으려면 엔터를 누르세요.")
                try:
                    input()
                except Exception:
                    pass
                try:
                    browser.close()
                except Exception:
                    pass


if __name__ == "__main__":
    main()
