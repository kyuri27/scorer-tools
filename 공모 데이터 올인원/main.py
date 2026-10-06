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
import json, base64, time, unicodedata, shutil, tempfile

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

# 현재 작업에서 건너뛴 항목 — 완료 후 한꺼번에 출력
_issues: list = []


def _add_issue(category: str, detail: str):
    _issues.append((category, detail))


def _print_issues_summary():
    if not _issues:
        return
    print(f"\n{'─' * 50}")
    print(f"  ⚠️  건너뛴 항목 ({len(_issues)}건) — 직접 확인 필요")
    print(f"{'─' * 50}")
    for i, (cat, detail) in enumerate(_issues, 1):
        print(f"  {i}. [{cat}] {detail}")
    print(f"{'─' * 50}")


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


_AFFIL_BOILERPLATE = [
    "주식회사", "유한회사", "(주)", "㈜", "(유)",
    "종합건축사사무소", "건축사사무소", "사무소",
    "종합", "스튜디오", "이엔지", "엔지니어링",
    "조경설계사무소", "조경설계", "조경",
]


def _strip_affiliation_boilerplate(s: str) -> str:
    """소속명에서 '건축사사무소'/'종합' 등 공통 접미사 제거 — 핵심 이름만 남김"""
    for tok in _AFFIL_BOILERPLATE:
        s = s.replace(tok, "")
    return s


def affiliation_similarity(a: str, b: str) -> float:
    """두 소속명 유사도 (0~1). 한 쪽이 다른 쪽을 포함하면 1.0"""
    a_n, b_n = normalize(a), normalize(b)
    if not a_n or not b_n:
        return 0.0
    if a_n in b_n or b_n in a_n:
        return 1.0

    # '건축사사무소'/'종합' 등 공통 접미사 제거 후 핵심부끼리 비교
    # (제거 안 하면 거의 모든 건축사사무소가 공통 글자로 인해 유사도가 부풀려져 오매칭 발생)
    a_core, b_core = _strip_affiliation_boilerplate(a_n), _strip_affiliation_boilerplate(b_n)
    if a_core and b_core:
        if a_core in b_core or b_core in a_core:
            return 1.0
        common = sum(1 for c in set(a_core) if c in b_core)
        return common / max(len(set(a_core)), len(set(b_core)))

    common = sum(1 for c in set(a_n) if c in b_n)
    return common / max(len(set(a_n)), len(set(b_n)))


def auto_accept_dialogs(page):
    def _accept(d):
        try:
            d.accept()
        except Exception:
            pass
    page.on("dialog", _accept)


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


def _wipe_dir(dir_path: Path):
    """폴더 내 업로드 가능한 파일만 모두 삭제 (폴더 자체는 유지)"""
    if not dir_path.exists():
        return
    for f in list(dir_path.iterdir()):
        if f.is_file() and _is_uploadable(f.name):
            try:
                f.unlink()
            except Exception:
                try:
                    os.remove(os.path.join(str(dir_path), f.name))
                except Exception:
                    pass


def _clear_and_save_files(dir_path: Path, files_data: list) -> list:
    """폴더를 완전히 비우고 base64 파일 목록을 저장. 저장된 Path 목록 반환."""
    if dir_path.exists():
        # 1차: shutil.rmtree로 폴더 전체 삭제
        try:
            shutil.rmtree(dir_path)
        except Exception as e:
            print(f"  ⚠️  폴더 삭제 실패 ({e}), 파일별 삭제 시도...")

        # 2차: 폴더가 아직 남아있으면 파일 하나씩 삭제
        if dir_path.exists():
            import glob as _glob
            # 숨김파일(.DS_Store, ._* 등) 포함 전부 삭제
            for fpath in _glob.glob(str(dir_path / '*')) + _glob.glob(str(dir_path / '.*')):
                try:
                    os.remove(fpath)
                except Exception:
                    pass

        # 3차: 그래도 남은 파일 확인 및 경고
        if dir_path.exists():
            remaining = [f.name for f in dir_path.iterdir() if f.is_file()]
            if remaining:
                print(f"  ⚠️  다음 파일을 삭제하지 못했습니다: {remaining}")

    dir_path.mkdir(parents=True, exist_ok=True)
    # 새 파일 저장 — 저장된 경로만 반환 (폴더에 남은 파일 오염 방지)
    saved_paths = []
    for f in files_data:
        fname = f.get("filename", "file")
        try:
            p = dir_path / fname
            p.write_bytes(base64.b64decode(f.get("data", "")))
            saved_paths.append(p)
        except Exception as e:
            print(f"  ⚠️  파일 저장 실패 ({fname}): {e}")

    print(f"  폴더 초기화 완료 → {len(saved_paths)}개 저장: {', '.join(p.name for p in saved_paths)}")
    return saved_paths


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


def _kill_port(port: int):
    """해당 포트를 사용 중인 프로세스를 강제 종료 (Mac/Windows 공통)"""
    try:
        if sys.platform == "win32":
            import subprocess
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True, text=True
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.strip().split()
                    pid = parts[-1]
                    if pid.isdigit():
                        subprocess.run(["taskkill", "/PID", pid, "/F"],
                                       capture_output=True)
                        print(f"  기존 프로세스(PID {pid}) 종료 완료")
        else:
            import subprocess
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True, text=True
            )
            for pid in result.stdout.strip().splitlines():
                if pid.isdigit():
                    subprocess.run(["kill", "-9", pid], capture_output=True)
                    print(f"  기존 프로세스(PID {pid}) 종료 완료")
    except Exception as e:
        print(f"  프로세스 종료 실패: {e}")


def start_local_server() -> _ReuseAddrServer:
    try:
        server = _ReuseAddrServer(("localhost", SERVER_PORT), _Handler)
    except OSError:
        print(f"⚠️  포트 {SERVER_PORT} 이미 사용 중 — 브라우저에 열린 localhost:{SERVER_PORT} 탭이 있다면 닫아주세요.")
        print(f"   기존 프로세스 종료 중...")
        _kill_port(SERVER_PORT)
        server = None
        for wait in (1, 2, 3):
            time.sleep(wait)
            try:
                server = _ReuseAddrServer(("localhost", SERVER_PORT), _Handler)
                break
            except OSError:
                print(f"  포트 해제 대기 중... ({wait}초)")
        if server is None:
            print(f"❌ 포트 {SERVER_PORT} 해제 실패.")
            print(f"   브라우저에서 localhost:{SERVER_PORT} 탭을 닫고, 터미널도 완전히 닫은 뒤 다시 실행해주세요.")
            sys.exit(1)
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
                if line:  # 빈 줄(개행 잔류)은 무시하고 계속 대기
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
    # 외부/예비 그룹 분리만, 그룹 내 순서는 입력 순서(문서 추출 순서) 유지
    return sorted(judges, key=lambda j: {"본": 0, "외부": 0, "예비": 1}.get(j["type"], 2))


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
        # DataTable JS 바인딩 완료 대기 — 첫 검색 시 tbody tr이 나타날 때까지 대기
        for _ in range(20):
            if page.locator('#dataTable tbody tr').count() > 0:
                break
            page.wait_for_timeout(150)
        sb.click()
        sb.fill("")
        page.wait_for_timeout(300)   # 이전 검색 결과 리셋 대기
        sb.fill(name)
    except Exception:
        return False, "검색 박스를 찾지 못함"

    def _wait_stable():
        """DataTable debounce(400ms) 후 행 수 안정화 대기"""
        page.wait_for_timeout(600)
        _prev = -1
        _s = 0
        for _ in range(30):
            page.wait_for_timeout(100)
            _cur = page.locator('#dataTable tbody tr').count()
            if _cur == _prev:
                _s += 1
                if _s >= 2:
                    break
            else:
                _s = 0
            _prev = _cur
        return page.locator('#dataTable tbody tr').count()

    rc = _wait_stable()

    def _read_all_rows():
        """소속 컬럼(index 4)만 추출 — 전체 행 텍스트 사용 시 유사도가 희석되는 문제 방지"""
        try:
            return page.evaluate("""
                () => Array.from(document.querySelectorAll('#dataTable tbody tr'))
                           .map(r => {
                               const cells = r.querySelectorAll('td');
                               if (cells.length >= 5) return cells[4].innerText.trim();
                               return r.innerText.trim();
                           })
            """) or []
        except Exception:
            return []

    def _read_all_rows_full():
        """이름 포함 여부 확인용 전체 행 텍스트"""
        try:
            return page.evaluate("""
                () => Array.from(document.querySelectorAll('#dataTable tbody tr'))
                           .map(r => r.innerText || '')
            """) or []
        except Exception:
            return []

    # 10명 이상이면 필터 미적용(DataTable 미초기화) 가능성 — 이름 포함 여부 확인 후 재시도
    if rc >= 10:
        rows_text = _read_all_rows_full()
        if not any(name in t for t in rows_text[:10]):
            sb2 = page.locator('input[aria-controls="dataTable"]')
            sb2.fill("")
            page.wait_for_timeout(400)
            sb2.fill(name)
            rc = _wait_stable()

    def _collect_all_pages() -> list:
        """검색 결과 전체 페이지를 순회하며 (page_num, row_idx, affiliation_text, full_text) 수집.
        매칭 대상이 1페이지에 없을 수 있으므로 전체 페이지를 본 후 매칭한다."""
        collected = []
        current = 1
        while True:
            try:
                page_data = page.evaluate("""
                    () => Array.from(document.querySelectorAll('#dataTable tbody tr')).map(r => {
                        const cells = r.querySelectorAll('td');
                        const aff = cells.length >= 5 ? cells[4].innerText.trim() : '';
                        return { aff, full: r.innerText || '' };
                    })
                """) or []
            except Exception:
                page_data = []
            if page_data:
                first_full = page_data[0].get("full", "")
                if not ("No data" in first_full or ("데이터" in first_full and "없" in first_full)):
                    for i, d in enumerate(page_data):
                        collected.append((current, i, d.get("aff", ""), d.get("full", "")))
            next_btn = page.locator('#dataTable_next')
            if next_btn.count() == 0:
                break
            next_cls = next_btn.get_attribute('class') or ''
            if 'disabled' in next_cls:
                break
            next_btn.click()
            _wait_stable()
            current += 1
        return collected

    try:
        all_rows = _collect_all_pages()
        rc = len(all_rows)
        if rc == 0:
            return False, "검색 결과 없음"

        total_pages = all_rows[-1][0]

        if rc == 1:
            target_page, target_idx, found_aff, found_full = all_rows[0]
            if affiliation:
                score = affiliation_similarity(affiliation, found_aff)
                aff_display = found_aff.strip() or "(소속 없음)"
                if score >= 0.3:
                    print(f"     검색결과 1명 · 소속 확인 ✅ ({aff_display}, 유사도 {score:.0%})")
                else:
                    # 소속 불일치 → 사용자 확인 필요
                    print(f"\n  ⚠️  소속 불일치!")
                    print(f"     기대: {affiliation}")
                    print(f"     실제: {aff_display}")
                    print(f"  [엔터] 선택  [s] 건너뜀  [q] 중단")
                    import sys as _sys, select as _sel
                    _r, _, _ = _sel.select([_sys.stdin], [], [], 0.1)
                    if _r:
                        _sys.stdin.readline()
                    line = input("  > ").strip().lower()
                    if line == "q":
                        return False, "사용자 중단"
                    if line == "s":
                        return False, f"소속 불일치로 건너뜀 (기대:{affiliation} / 실제:{aff_display})"
                    # 엔터 → 선택 진행
            else:
                print(f"     검색결과 1명 → 자동 선택")
        else:
            page_info = f" (총 {total_pages}페이지)" if total_pages > 1 else ""
            print(f"     검색결과 {rc}명{page_info} → 소속으로 매칭 중")
            best, best_pos = 0.0, 0
            for pos, (pg, ri, aff, full) in enumerate(all_rows):
                score = affiliation_similarity(affiliation, aff)
                if score > best:
                    best, best_pos = score, pos
            if best < 0.3:
                return False, "동명이인 소속 매칭 실패"
            target_page, target_idx, _, _ = all_rows[best_pos]
            print(f"     매칭 (유사도 {best:.0%})")

        # 현재 위치(마지막 페이지)에서 target_page로 이동
        current_page = total_pages
        if current_page != target_page:
            first_btn = page.locator('#dataTable_first')
            if first_btn.count() > 0:
                first_btn.click()
                _wait_stable()
            else:
                prev_btn = page.locator('#dataTable_previous')
                for _ in range(current_page - 1):
                    if 'disabled' in (prev_btn.get_attribute('class') or ''):
                        break
                    prev_btn.click()
                    _wait_stable()
            for _ in range(target_page - 1):
                page.locator('#dataTable_next').click()
                _wait_stable()

        rows = page.locator('#dataTable tbody tr')
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


def _lookup_kira(context, name: str):
    """대한건축사협회(KIRA)에서 건축사 검색 → 소속 정보를 터미널에 출력.
    새 탭에서 검색 후 닫는다."""
    KIRA_URL = "https://www.kira.or.kr/memfind/main.do"
    print(f"\n  🔍 대한건축사협회에서 '{name}' 검색 중...")
    kira_page = None
    try:
        kira_page = context.new_page()
        kira_page.goto(KIRA_URL, wait_until="domcontentloaded", timeout=15000)
        kira_page.wait_for_timeout(1000)

        # 이름 입력 필드 탐색 (사이트 구조 불확실 → 다양한 selector 시도)
        inp = None
        for sel in [
            "input[name='memNm']", "input[name='name']", "input[name='keyword']",
            "input[name='searchKeyword']", "#memNm", "#name",
            "input[placeholder*='이름']", "input[placeholder*='검색']",
            "input[type='text']:visible",
        ]:
            loc = kira_page.locator(sel)
            if loc.count() > 0:
                try:
                    loc.first.wait_for(state="visible", timeout=1000)
                    inp = loc.first
                    break
                except Exception:
                    pass

        if inp is None:
            print(f"  ⚠️ KIRA 검색창을 찾지 못했습니다.")
            print(f"     브라우저에서 직접 확인: {KIRA_URL}")
            return

        inp.fill(name)

        # 검색 버튼 클릭
        for sel in [
            "button[type='submit']", "input[type='submit']",
            "button:has-text('검색')", "a:has-text('검색')",
            ".btn-search", "#btnSearch",
        ]:
            b = kira_page.locator(sel)
            if b.count() > 0:
                try:
                    b.first.click(timeout=3000)
                    break
                except Exception:
                    pass

        kira_page.wait_for_timeout(2000)

        # 결과 테이블 파싱
        rows = kira_page.locator("table tbody tr")
        rc = rows.count()
        if rc == 0:
            # 결과 없음 메시지를 직접 확인
            body = kira_page.locator("body").inner_text(timeout=2000)
            if "없" in body or "결과" in body:
                print(f"  ℹ️  KIRA 검색 결과 없음")
            else:
                print(f"  ⚠️ KIRA 결과를 파싱하지 못했습니다. 브라우저에서 직접 확인하세요.")
            return

        print(f"  📋 KIRA 검색 결과 {rc}건:")
        for i in range(min(rc, 5)):
            cells = rows.nth(i).locator("td")
            if cells.count() == 0:
                continue
            texts = [cells.nth(j).inner_text().strip() for j in range(cells.count())]
            texts = [t for t in texts if t]
            print(f"     {i + 1}. {' | '.join(texts)}")

    except Exception as e:
        print(f"  ⚠️ KIRA 검색 오류: {e}")
    finally:
        if kira_page:
            try:
                kira_page.close()
            except Exception:
                pass


def run_judges_input(page, judges: list, context=None) -> bool:
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

        # ── 실패 → 일시정지 (순서가 중요하므로 자동 건너뜀 불가) ──
        print(f"  ❌ 실패: {msg}")
        # DB에 없는 경우 → KIRA에서 소속 정보 자동 조회
        if "검색 결과 없음" in msg and context is not None:
            _lookup_kira(context, judge["name"])
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
            _add_issue("심사위원 등록 실패", f"[{judge['type']}] {judge['name']} — {msg}")
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
        print(f"     검색결과 {len(all_rows)}개{page_info} → 매칭 중")

        # 1순위: 이름 컬럼이 original_name과 정확히 일치하는 행
        _BTN_LABELS = {"선택", "수정", "삭제", "취소", "저장"}
        def _extract_names(text):
            parts = [p.strip() for p in text.replace('\t', '\n').split('\n') if p.strip()]
            return [p for p in parts if p not in _BTN_LABELS and not p.isdigit()]

        exact_idx = None
        for idx, (pg, ri, text) in enumerate(all_rows):
            if original_name in _extract_names(text):
                exact_idx = idx
                break

        if exact_idx is not None:
            target_page, target_row_idx, _ = all_rows[exact_idx]
            print(f"     정확 일치 → 선택")
        else:
            # 2순위: 유사도 매칭
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

    # 하위기관명 포함 계층형 이름인 경우 — 뒤 토큰을 하나씩 제거하며 재시도
    # 예) 한국농어촌공사 강원지역본부 원주지사
    #     → 한국농어촌공사 강원지역본부 → 한국농어촌공사 강원지역 → 한국농어촌공사 → 한국농어촌
    if not found:
        tokens = name.split()
        for end in range(len(tokens) - 1, 0, -1):
            partial = " ".join(tokens[:end])
            found = _try(partial)
            if found:
                break
            kw2 = extract_search_keyword(partial)
            if kw2 != partial:
                found = _try(kw2)
                if found:
                    break

    if not found:
        print(f"  ❌ '{name}'을(를) DB에서 찾지 못했습니다. → 건너뜁니다")
        _add_issue("발주처 못 찾음", f"'{name}' — 직접 등록 필요")
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


# Windows/Mac 시스템 파일 — 업로드 제외 목록
_SYSTEM_FILES = {
    "thumbs.db", "desktop.ini", "ehthumbs.db", "ehthumbs_vista.db",
    ".ds_store", ".localized", ".spotlight-v100", ".trashes",
}

def _is_uploadable(filename: str) -> bool:
    """업로드 가능한 실제 파일인지 확인 (시스템·숨김 파일 제외)"""
    name = filename.lower()
    if name.startswith("."):          # .DS_Store 등 숨김 파일
        return False
    if name in _SYSTEM_FILES:         # Thumbs.db, desktop.ini 등
        return False
    if name.startswith("~$"):         # Office 임시 파일
        return False
    return True


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


def upload_notice_files(page, comp_id: str, specific_files: list = None) -> tuple:
    """공모 파일 폴더의 파일을 파일관리 페이지에 업로드.
    specific_files: HTML에서 이번에 저장한 파일 경로 목록. 지정 시 폴더 스캔 대신 이 파일만 업로드.
    """
    files_dir = SCRIPT_DIR / NOTICE_FILES_DIR

    if specific_files is not None:
        # HTML 트리거 모드 — 이번에 저장한 파일만 (폴더 오염 무관)
        files = [f for f in specific_files if f.exists() and _is_uploadable(f.name)]
    else:
        # 터미널 모드 — 폴더 전체 스캔
        if not files_dir.exists():
            files_dir.mkdir()
            return False, f"'공모 파일' 폴더가 없어서 새로 만들었습니다. 파일을 넣고 다시 시도해주세요."
        files = sorted([f for f in files_dir.iterdir() if f.is_file() and _is_uploadable(f.name)])
    if not files:
        return False, "업로드할 파일 없음"

    print(f"  폴더 내 파일 {len(files)}개: {', '.join(f.name for f in files)}")

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
        # 업로드할 게 없어도 폴더 비우기
        _wipe_dir(files_dir)
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

    # 서버 오류 여부 확인
    try:
        body = page.locator("body").inner_text(timeout=3000)
        if "페이지가 작동하지 않습니다" in body or "list index out of range" in body or "500" in page.title():
            return False, f"서버 오류 (500) — 업로드 실패. 파일 개수/형식을 확인하거나 수동으로 업로드해주세요."
    except Exception:
        pass

    # 업로드 완료 후 폴더 비우기 — 다음 공모에 이전 파일이 섞이지 않도록
    _wipe_dir(files_dir)

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
    _issues.clear()

    comp_id = str(data.get("competition_id", "")).strip()
    agency  = data.get("agency", "").strip()
    judges_raw = data.get("judges", [])
    notice_files_data = data.get("notice_files", [])

    if not comp_id.isdigit():
        print(f"❌ 잘못된 공모 ID: '{comp_id}'")
        return

    judges = load_judges_from_payload(judges_raw)

    # 심사위원  (mode: 1, 2, 3) — jury_manage 페이지 필요
    if task_mode in (1, 2, 3):
        if not navigate_to_competition(page, comp_id):
            return
        _save_auth(context, auth_path)
        if judges:
            print(f"\n[심사위원 입력] {len(judges)}명")
            ok = run_judges_input(page, judges, context=context)
            if not ok:
                print("\n❌ 브라우저 연결 끊김")
                return
        else:
            print("\n[심사위원 입력] 전달받은 심사위원 없음, 건너뜁니다.")

    # 공고파일 업로드  (mode: 1, 2, 4) — file_manage 페이지로 직접 이동
    if task_mode in (1, 2, 4):
        # 이전 단계 navigation 완전히 완료 후 진행
        try:
            page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        if notice_files_data:
            print(f"\n[공고파일 업로드] {len(notice_files_data)}개")
            saved_paths = _clear_and_save_files(SCRIPT_DIR / NOTICE_FILES_DIR, notice_files_data)
            ok, msg = upload_notice_files(page, comp_id, specific_files=saved_paths)
            print(f"  {'✅' if ok else '❌'} {msg}")
        else:
            print("\n[공고파일 업로드] 전달받은 파일 없음, 건너뜁니다.")

    # 발주처  (mode: 1, 2, 5) — organization_manage 페이지로 직접 이동
    if task_mode in (1, 2, 5):
        # 이전 단계 navigation 완전히 완료 후 진행
        try:
            page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        if agency:
            print(f"\n[발주처 입력]")
            run_organization_input(page, comp_id, agency=agency)
        else:
            print("\n[발주처 입력] 전달받은 발주처 없음, 건너뜁니다.")

    _print_issues_summary()


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
            orig = os.path.join(str(IMAGE_DIR), fname)
            ext  = Path(fname).suffix
            # 특수문자 파일명 → 임시 파일로 복사해서 반환 (Playwright 경로 오류 방지)
            try:
                tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
                tmp.close()
                shutil.copy2(orig, tmp.name)
                return tmp.name
            except Exception:
                return orig   # 복사 실패 시 원본 경로 그대로 시도
    return None


def _clean_architect_name(name: str) -> str:
    import re as _re
    # 법인 표기 제거
    for tok in ["주식회사", "유한회사", "(주)", "㈜", "(유)"]:
        name = name.replace(tok, "")
    name = name.strip()

    # 종합건축사사무소가 앞에 붙은 경우 → 뒷부분 사용
    # 예) 종합건축사사무소길이엔지 → 길이엔지
    if name.startswith("종합건축사사무소"):
        name = name[len("종합건축사사무소"):].strip()
    else:
        # 뒤에 붙거나 중간에 있는 경우 → 앞부분(핵심) 남김
        # 예) 길종합건축사사무소이엔지 → 길 (이엔지도 제거)
        name = name.replace("종합건축사사무소", "")
        name = name.replace("건축사사무소", "")
        name = name.replace("종합", "")

    # 조경 관련 접미사 제거 (긴 것부터 순서대로)
    name = name.replace("조경설계사무소", "")
    name = name.replace("조경설계", "")
    name = name.replace("조경", "")

    # 영문/한글 ENG, 스튜디오 제거
    name = _re.sub(r'eng', '', name, flags=_re.IGNORECASE)
    # '이엔지' 제거 — 단, '이엔지니어링'의 일부일 때는 제거하지 않음
    name = _re.sub(r'이엔지(?!니어링)', '', name)
    # '엔지니어링' 접미사 제거 — 단, '이엔지니어링'처럼 '이'가 바로 앞에 오는 경우는 보존
    name = _re.sub(r'(?<!이)엔지니어링', '', name)
    name = name.replace("스튜디오", "")

    # 기호 제거 — '-'는 보존, 나머지 기호(괄호/특수문자 등)는 모두 제거
    name = _re.sub(r'[^a-zA-Z0-9가-힣\s\-]', '', name)
    name = _re.sub(r'\s+', ' ', name)

    return name.strip()


def _create_entry(page, create_url, entry_name, img_path=None, result_url=None):
    page.goto(create_url)
    page.wait_for_load_state("load", timeout=15000)

    try:
        inp = page.get_by_label("입상작명")
        inp.wait_for(state="visible", timeout=3000)
    except Exception:
        inp = page.locator("input[type='text']").first
        inp.wait_for(state="visible", timeout=5000)
    inp.fill(entry_name)

    # 공개여부 → 공개로 설정
    try:
        pub = page.locator("select[name='published']")
        if pub.count() > 0:
            try:
                pub.first.select_option(label="공개")
            except Exception:
                pub.first.select_option(value="1")
    except Exception:
        pass

    # 심사결과 URL 입력 (create 폼에 필드가 있으면 여기서 처리)
    url_filled = False
    if result_url:
        try:
            url_inp = page.locator("input[name='entry_data_url']")
            if url_inp.count() > 0:
                url_inp.first.fill(result_url)
                url_filled = True
                print(f"  🔗 심사결과 URL 입력 (create 폼): {result_url[:60]}")
            else:
                # 실제 폼에서 input 이름을 확인해 디버그 정보 출력
                all_inputs = page.locator("input[type='url'], input[type='text'][name*='url'], input[type='text'][name*='link']")
                names = []
                for i in range(min(all_inputs.count(), 5)):
                    try:
                        names.append(all_inputs.nth(i).get_attribute("name") or "?")
                    except Exception:
                        pass
                if names:
                    print(f"  ℹ️  create 폼 URL 관련 필드 없음 (entry_data_url). 발견된 필드: {names}")
        except Exception as e:
            print(f"  ⚠️  심사결과 URL 입력 오류 (create): {e}")

    if img_path:
        try:
            page.locator("input[type='file']").first.set_input_files(img_path)
        except Exception as e2:
            print(f"  ⚠️  이미지 업로드 실패 ({e2}), 이미지 없이 등록합니다.")
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

    # 저장 실패 감지 — 서버 검증 실패 시 예외 없이 등록 폼에 그대로 머무는 경우가 있음
    if "/create/" in page.url:
        err_msg = ""
        try:
            err_msg = page.locator(".alert, .error, .invalid-feedback, .text-danger").first.inner_text(timeout=1000)
        except Exception:
            pass
        raise Exception(f"입상작 등록 실패 — 저장 후에도 등록 폼에 머물러 있음{(' (' + err_msg + ')') if err_msg else ''}")

    # 리디렉트된 편집 페이지에 entry_data_url 필드가 있으면 여기서 채우고 재저장
    # (create 폼에 없고 편집 폼에만 있는 경우 대응)
    if result_url and not url_filled:
        try:
            url_inp2 = page.locator("input[name='entry_data_url']")
            cnt2 = url_inp2.count()
            if cnt2 > 0:
                url_inp2.first.fill(result_url)
                print(f"  🔗 심사결과 URL 입력 (편집 폼): {result_url[:60]}")
                try:
                    save_btn = page.get_by_role("button", name="저장하기")
                    save_btn.wait_for(state="visible", timeout=3000)
                    save_btn.click()
                except Exception:
                    page.locator("button[type='submit'], input[type='submit']").first.click()
                page.wait_for_load_state("load", timeout=10000)
                url_filled = True
            else:
                # 편집 폼에도 없으면 실제 필드명 탐색
                all_inp = page.locator("input")
                field_names = []
                for i in range(min(all_inp.count(), 20)):
                    try:
                        n = all_inp.nth(i).get_attribute("name") or ""
                        if n:
                            field_names.append(n)
                    except Exception:
                        pass
                print(f"  ⚠️  심사결과 URL 필드(entry_data_url) 못 찾음. 편집 폼 input name 목록: {field_names}")
        except Exception as e:
            print(f"  ⚠️  심사결과 URL 입력 오류 (편집): {e}")

    if result_url and not url_filled:
        print(f"  ❌ 심사결과 URL 저장 실패 — 수동 입력 필요: {result_url}")


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


def _select_architect(page, search_name, extra_info, original_name="") -> bool:
    """건축사 선택. 성공 시 True, 실패(건너뜀) 시 False 반환."""
    sb = page.locator("input[type='search']").first
    sb.wait_for(state="visible", timeout=5000)

    # '길종합건축사사무소이엔지' 같이 종합건축사사무소가 접미사로 붙은 경우:
    # 핵심명('길')만으로 검색하면 결과가 너무 많으므로
    # 먼저 '길종합'으로 검색하고, 결과 없으면 '길'로 재시도
    orig_stripped = original_name
    for tok in ["주식회사", "유한회사", "(주)", "㈜", "(유)"]:
        orig_stripped = orig_stripped.replace(tok, "").strip()
    has_suffix_jongap = ("종합건축사사무소" in orig_stripped
                         and not orig_stripped.startswith("종합건축사사무소"))

    def _no_select_btn(row) -> bool:
        """DataTable '결과 없음' 행 판단 — 텍스트 대신 선택 버튼 유무로 확인"""
        try:
            return row.locator(
                "button:has-text('선택'), a:has-text('선택'), input[value='선택']"
            ).count() == 0
        except Exception:
            return True

    # extra_info에서 대표자명 목록 추출 (검증용)
    _designer_names = [n.strip() for n in extra_info.split(",") if n.strip()] if extra_info else []

    def _verify_and_select(row_locator, verify_firm=False) -> bool:
        """사무소명·대표자명 확인 후 선택. 불일치 시 이슈 기록 후 False 반환.
        verify_firm=True: 대표자명 폴백 검색 결과 — 사무소명도 추가 검증."""
        try:
            cells = row_locator.locator("td")
            cc = cells.count()
            actual_firm = cells.nth(2).inner_text().strip() if cc >= 3 else ""
            rep_name    = cells.nth(3).inner_text().strip() if cc >= 4 else ""
        except Exception:
            actual_firm = rep_name = ""

        # 대표자명 폴백으로 찾은 경우: 사무소명이 기대값과 일치하는지 확인
        if verify_firm and search_name and actual_firm:
            cleaned_actual = _clean_architect_name(actual_firm)
            if cleaned_actual != search_name:
                print(f"\n  ⚠️  사무소명 불일치! 기대: {search_name}  실제: {actual_firm} (대표: {rep_name})")
                _add_issue("건축가 사무소명 불일치",
                           f"기대:'{search_name}', 실제:'{actual_firm}'(대표:{rep_name}) — 직접 확인 필요")
                return False

        # 대표자명 확인 (사무소명이 맞더라도 사람이 다를 수 있으므로)
        if _designer_names and rep_name:
            matched = any(d in rep_name or rep_name in d for d in _designer_names if d)
            if not matched:
                print(f"\n  ⚠️  대표자명 불일치! 기대: {'/'.join(_designer_names)}  실제: {rep_name} ({actual_firm})")
                _add_issue("건축가 대표자명 불일치",
                           f"'{search_name}' — 기대:{'/'.join(_designer_names)}, 실제:{rep_name}({actual_firm})")
                return False

        btn = row_locator.locator("button:has-text('선택'), a:has-text('선택'), input[value='선택']").first
        btn.wait_for(state="visible", timeout=5000)
        btn.click()
        time.sleep(0.2)
        return True

    first_term = (search_name + "종합") if has_suffix_jongap else search_name
    sb.fill(first_term)
    time.sleep(1.0)

    rows = page.locator("#dataTable tbody tr")
    count = rows.count()

    # '길종합' 검색 실패 → '길'로 재시도
    if has_suffix_jongap and (count == 0 or (count == 1 and _no_select_btn(rows.first))):
        print(f"\n  '{first_term}' 검색 결과 없음 → '{search_name}'으로 재시도", end="", flush=True)
        sb.fill(search_name)
        time.sleep(1.0)
        rows = page.locator("#dataTable tbody tr")
        count = rows.count()

    # 사무소명 검색 실패 → 대표자명(extra_info 첫 번째)으로 재시도
    _designer_fallback = False
    if count == 0 or (count == 1 and _no_select_btn(rows.first)):
        designer = extra_info.split(",")[0].strip() if extra_info else ""
        if designer:
            print(f"\n  '{search_name}' 검색 결과 없음 → 대표자명 '{designer}'으로 재시도", end="", flush=True)
            sb.fill(designer)
            time.sleep(1.0)
            rows = page.locator("#dataTable tbody tr")
            count = rows.count()
            _designer_fallback = True
        if not designer or count == 0 or (count == 1 and _no_select_btn(rows.first)):
            msg = f"'{search_name}'" + (f" / '{designer}'" if designer else "") + " — 검색 결과 없음"
            print(f"\n  ⚠️ {msg} → 건너뜁니다")
            _add_issue("건축가 검색 실패", msg)
            return False

    if count == 1:
        return _verify_and_select(rows.first, verify_firm=_designer_fallback)

    # 핵심 사무소명이 정확히 일치하는 행이 1개뿐이면 자동 선택
    # 테이블 컬럼: ID(0) | 이미지(1) | 이름(2) | 대표자명(3) | 검색키워드(4)
    exact_matches = []
    for i in range(count):
        cells = rows.nth(i).locator("td")
        cc = cells.count()
        if cc == 0:
            continue
        name_col = 2 if cc >= 3 else 0
        row_office_name = cells.nth(name_col).inner_text().strip()
        if _clean_architect_name(row_office_name) == search_name:
            exact_matches.append(i)
    if len(exact_matches) == 1:
        i = exact_matches[0]
        print(f"     '{search_name}' 핵심명 정확 일치 → 자동 선택")
        return _verify_and_select(rows.nth(i))

    keywords = [e.strip() for e in extra_info.split(",") if e.strip()] if extra_info else []

    # 대표자명 폴백으로 검색한 경우, 원래 사무소 핵심명을 disambiguation 1순위 키워드로 추가
    # 예) '에스에이' 검색 실패 → '김주영' 재검색 → 그랑/에스에이 두 결과
    #     → keywords 앞에 '에스에이' 추가 → '에스에이'가 포함된 행(건축사사무소 에스에이) 선택
    if search_name and search_name not in keywords:
        keywords.insert(0, search_name)

    # 정리 과정에서 제거됐던 보일러플레이트를 동명이인 disambiguation 키워드로 재활용
    # 우선순위: 구체적인 복합 키워드 먼저, 범용 키워드 나중
    orig_stripped = original_name
    for tok in ["주식회사", "유한회사", "(주)", "㈜", "(유)"]:
        orig_stripped = orig_stripped.replace(tok, "").strip()

    # 1순위: search_name + 종합 (예: "길종합") — 가장 구체적
    if "종합건축사사무소" in orig_stripped and not orig_stripped.startswith("종합건축사사무소"):
        keywords.append(search_name + "종합")

    # 2순위: 고유 접미사 (이엔지/엔지니어링/스튜디오/조경은 종합보다 드물어서 더 구체적)
    for bp in ["스튜디오", "이엔지", "엔지니어링", "조경"]:
        if bp in orig_stripped:
            keywords.append(bp)

    # 3순위: 종합 (범용적 — 다른 키워드로 못 찾을 때 마지막 수단)
    if "종합" in orig_stripped:
        keywords.append("종합")

    # exact_matches가 여러 개이면 그 행들 안에서만 검색
    # — search_name 키워드는 건너뜀(모두 같은 핵심명이라 의미 없고, 다른 행의 대표자명에 포함될 수 있음)
    if len(exact_matches) > 1:
        candidate_indices = exact_matches
        disambig_keywords = [kw for kw in keywords if kw != search_name]
    else:
        candidate_indices = list(range(count))
        disambig_keywords = keywords

    for kw in disambig_keywords:
        for i in candidate_indices:
            if kw in rows.nth(i).inner_text():
                return _verify_and_select(rows.nth(i), verify_firm=_designer_fallback)

    print(f"\n  ⚠️ '{search_name}' 동명 결과 {count}개, 자동 판별 불가 → 건너뜁니다")
    _add_issue("건축가 자동 판별 불가", f"'{search_name}' 동명 {count}개 — 직접 선택 필요")
    return False


def _ensure_judging_toggles_on(page, target_filenames=None) -> bool:
    """새로 업로드된 파일 행의 심사결과 파일 여부 토글만 ON으로 설정.
    target_filenames 가 주어지면 해당 파일명이 포함된 행만 처리.
    """
    try:
        filenames_js = json.dumps(list(target_filenames)) if target_filenames else "null"
        toggled = page.evaluate(f"""
            () => {{
                const targets = {filenames_js};
                let cnt = 0;

                const rows = Array.from(document.querySelectorAll('table tbody tr'));
                for (const row of rows) {{
                    // target_filenames 가 있으면 해당 파일명 포함 행만 처리
                    if (targets) {{
                        const rowText = row.innerText || '';
                        if (!targets.some(fn => rowText.includes(fn))) continue;
                    }}
                    // checkbox 방식
                    const cb = row.querySelector('input[type="checkbox"]');
                    if (cb && !cb.checked) {{ cb.click(); cnt++; continue; }}
                    // toggle/switch 방식
                    const toggle = row.querySelector(
                        '.toggle.off, [class*="toggle"][class*="off"], [class*="switch"][aria-checked="false"]'
                    );
                    if (toggle) {{ toggle.click(); cnt++; }}
                }}
                return cnt;
            }}
        """)
        if toggled and toggled > 0:
            print(f"     ↳ {toggled}개 심사결과 파일 여부 ON")
            return True
    except Exception:
        pass
    return False


def upload_result_files(page, contest_id: str, specific_files: list = None):
    """결과 파일 폴더의 파일을 파일관리 페이지에 업로드.
    specific_files: HTML에서 이번에 저장한 파일 경로 목록. 지정 시 폴더 스캔 대신 이 파일만 업로드.
    """
    if specific_files is not None:
        # HTML 트리거 모드 — 이번에 저장한 파일만
        all_files = [f.name for f in specific_files if f.exists() and _is_uploadable(f.name)]
        if not all_files:
            print("  ⚠️ 업로드할 결과 파일 없음 → 건너뜁니다.")
            return
    else:
        # 터미널 모드 — 폴더 전체 스캔
        if not UPLOAD_DIR.exists():
            print("  ℹ️  '결과 파일' 폴더 없음 → 건너뜁니다.")
            return
        all_files = [f for f in os.listdir(UPLOAD_DIR) if _is_uploadable(nfc(f))]
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

    # 서버 오류 여부 확인
    try:
        body = page.locator("body").inner_text(timeout=3000)
        if "페이지가 작동하지 않습니다" in body or "list index out of range" in body or "500" in page.title():
            print(f"  ❌ 서버 오류 (500) — 파일 업로드 실패. 수동으로 업로드해주세요.")
            return
    except Exception:
        pass

    print(f"  ✅ {len(new_files)}개 파일 업로드 완료")

    # 업로드 완료 후 폴더 비우기 — 다음 공모에 이전 파일이 섞이지 않도록
    _wipe_dir(UPLOAD_DIR)

    print("  심사결과 파일 여부 확인 중...")
    if _ensure_judging_toggles_on(page, target_filenames=new_files):
        try:
            page.get_by_role("button", name="저장하기").click()
            page.wait_for_load_state("load", timeout=15000)
            print("  ✅ 토글 저장 완료")
        except Exception as e:
            print(f"  ⚠️ 토글 저장 오류: {e}")
    else:
        print("  ✅ 새로 업로드된 파일 심사결과 파일 여부 ON")


def _manage_jury_absence(page, contest_id, judges, auto_absent_names=None):
    """불참 처리.
    - judges 중 status=="불참"인 명시적 불참
    - auto_absent_names: 어드민에 있지만 이번 참석 목록에 없어서 자동 불참 처리할 이름 목록
    """
    # 명시적 불참 (payload에서 표시된 경우)
    absent = [j for j in judges if j.get("status") == "불참"]
    # 자동 불참 (어드민에 있지만 이번 참석 명단에 없는 경우)
    if auto_absent_names:
        explicit_names = {j["name"] for j in absent}
        for name in auto_absent_names:
            if name not in explicit_names:
                absent.append({"name": name, "status": "불참", "_auto": True})

    if not absent:
        print("  불참 심사위원 없음")
        return

    url = f"https://scorer.co.kr/admin/competition/{contest_id}/jury_manage"
    page.goto(url)
    page.wait_for_load_state("load", timeout=15000)

    table = page.locator("table").first
    for judge in absent:
        label = "(자동)" if judge.get("_auto") else ""
        name = nfc(judge["name"])
        print(f"  [{judge['name']}]{label} 불참 처리 중...", end="", flush=True)
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
    _issues.clear()

    comp_id           = str(data.get("competition_id", "")).strip()
    awards_txt        = data.get("awards_txt", "")
    result_url        = data.get("result_url", "").strip()
    images            = data.get("images", [])
    upload_files_data = data.get("upload_files", [])
    judges            = data.get("judges") or []
    auto_absent       = []   # Step 4에서 채워짐 — 완료 메시지에서도 사용

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
    # 결과 파일 폴더 항상 초기화 — 파일 없을 때도 이전 공모 파일 남지 않도록
    _wipe_dir(UPLOAD_DIR)
    saved_result_paths = []
    if upload_files_data:
        saved_result_paths = _clear_and_save_files(UPLOAD_DIR, upload_files_data)
        print(f"  결과 파일 {len(upload_files_data)}개 저장됨")
    else:
        print(f"  결과 파일 없음 (폴더 비움)")

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
                    try:
                        _create_entry(page, create_url, entry_name, img, result_url=result_url)
                        print("  ✅")
                        created.append((entry_name, architect_name, extra_info))
                    except Exception as e:
                        err = str(e).lower()
                        if "browser" in err and "closed" in err:
                            print("\n❌ 브라우저 연결 끊김")
                            return
                        print(f"\n  ❌ 오류: {e} → 건너뜁니다")
                        _add_issue("입상작 등록 실패", f"'{entry_name}' — {e}")
                    # temp 이미지 파일 정리
                    if img and img.startswith(tempfile.gettempdir()):
                        try:
                            Path(img).unlink(missing_ok=True)
                        except Exception:
                            pass

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
                    try:
                        _go_to_architect_manage(page, contest_url, entry_name)
                        assigned = _get_assigned_architect_names(page)
                        if len(assigned) >= len(pairs):
                            print("  ⏭  이미 전원 배정됨")
                            arch_ok += 1
                        else:
                            for arch, extra in pairs:
                                sn = _clean_architect_name(arch)
                                if any(sn in n for n in assigned):
                                    print(f"     ⏭  '{sn}' 이미 배정됨")
                                else:
                                    print(f"     ➕ '{sn}' ...", end="", flush=True)
                                    try:
                                        ok = _select_architect(page, sn, extra, arch)
                                        print(" ✅" if ok else " ⚠️ 건너뜀")
                                    except Exception as e_arch:
                                        err_a = str(e_arch).lower()
                                        if "browser" in err_a and "closed" in err_a:
                                            raise  # 브라우저 종료는 외부로 전파
                                        print(f" ❌ 오류: {e_arch} → 건너뜀")
                                        _add_issue("건축가 선택 오류", f"'{entry_name}' → '{sn}' — {e_arch}")
                            print("  완료")
                            page.goto(contest_url)
                            page.wait_for_load_state("load", timeout=15000)
                            arch_ok += 1
                    except Exception as e:
                        err = str(e).lower()
                        if "browser" in err and "closed" in err:
                            print("\n❌ 브라우저 연결 끊김")
                            return
                        print(f"\n  ❌ 오류: {e} → 건너뜁니다")
                        _add_issue("건축가 관리 실패", f"'{entry_name}' — {e}")

    # ── 3단계: 결과파일 업로드  (mode: 1, 6, 8) ──
    if task_mode in (1, 6, 8):
        print(f"\n{'─' * 50}")
        print(f"  3단계: 결과파일 업로드")
        print(f"{'─' * 50}")
        upload_result_files(page, comp_id, specific_files=saved_result_paths)

    # ── 4단계: 심사위원 불참 처리  (mode: 1, 6, 9) ──
    if task_mode in (1, 6, 9):
        if judges:
            absent_count = sum(1 for j in judges if j.get("status") == "불참")
            print(f"\n{'─' * 50}")
            print(f"  4단계: 심사위원 불참 처리")
            print(f"{'─' * 50}")

            # 심사위원 등록 여부 항상 확인 → 미등록 시 등록
            judges_for_input = load_judges_from_payload(judges)
            registered = set()
            if judges_for_input:
                if not navigate_to_competition(page, comp_id):
                    return
                _save_auth(context, auth_path)
                registered = get_registered_names(page)
                missing = [j for j in judges_for_input if j["name"] not in registered]
                if missing:
                    print(f"  미등록 심사위원 {len(missing)}명 → 등록 진행")
                    ok = run_judges_input(page, judges_for_input, context=context)
                    if not ok:
                        print("\n❌ 브라우저 연결 끊김")
                        return
                    # 등록 후 목록 갱신
                    registered = get_registered_names(page)
                else:
                    print(f"  ✅ 심사위원 {len(registered)}명 이미 등록됨")

            # 자동 불참 계산:
            # 어드민에 등록된 심사위원 중 이번 공모정리도구 제출 목록에 없는 사람
            # = 참석하지 않아 공모정리도구에서 입력되지 않은 사람
            attended_names = {j.get("name", "").strip() for j in judges}
            auto_absent = [n for n in registered if n not in attended_names]
            if auto_absent:
                print(f"  → 참석 목록에 없는 {len(auto_absent)}명 자동 불참: {', '.join(auto_absent)}")
            if absent_count:
                print(f"  → 명시적 불참 {absent_count}명")

            _manage_jury_absence(page, comp_id, judges, auto_absent_names=auto_absent)
        else:
            print(f"\n  ℹ️  심사위원 데이터 없음 → 불참 처리 건너뜁니다.")

    _save_auth(context, auth_path)

    print(f"\n{'=' * 50}")
    print(f"  공모 결과 입력 완료!")
    if entries and task_mode in (1, 6, 7):
        print(f"  입상작: {len(created)}/{len(entries)}개")
        print(f"  건축가: {arch_ok}/{len(created)}개")
    if judges and task_mode in (1, 6, 9):
        explicit_absent = sum(1 for j in judges if j.get("status") == "불참")
        total_absent = explicit_absent + len(auto_absent)
        parts = []
        if explicit_absent:
            parts.append(f"명시 {explicit_absent}명")
        if auto_absent:
            parts.append(f"자동 {len(auto_absent)}명: {', '.join(auto_absent)}")
        print(f"  불참 처리: 총 {total_absent}명" + (f" ({', '.join(parts)})" if parts else ""))
    print(f"{'=' * 50}")
    _print_issues_summary()


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
                    ok = run_judges_input(page, load_judges_from_file(), context=context)
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
    MODE_LABELS = {
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

    def _print_menu():
        print("\n" + "=" * 60)
        print("  공모 데이터 자동 입력  |  스코어러")
        print("=" * 60)
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
        print()
        print("  [10] 종료")
        print("\n" + "─" * 30)

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
                # ── 모드 선택 메뉴 ────────────────────────────────────
                # HTML 버튼이 메뉴 대기 중에 눌렸으면 → 모드 1 자동 선택
                if not _trigger_queue.empty():
                    task_mode = 1
                    print(f"\n>>> HTML 버튼 클릭 감지 — {MODE_LABELS[1]}(으)로 진행합니다.")
                else:
                    _print_menu()
                    while True:
                        mode_input = input(">>> 번호 선택: ").strip().lower()
                        if mode_input in ("10", "q"):
                            print("\n>>> 종료합니다. 수고하셨습니다! 👋")
                            raise SystemExit(0)
                        if mode_input in ("1", "2", "3", "4", "5", "6", "7", "8", "9"):
                            task_mode = int(mode_input)
                            break
                        print("  1~10 중 하나를 입력해주세요.")
                    print(f"✓ 선택: {MODE_LABELS[task_mode]}\n")

                # ── 공모 트리거 대기 ──────────────────────────────────
                print("─" * 60)
                print("공모 ID 입력 후 엔터  또는  HTML 도구에서 버튼 클릭  (종료: q)")
                print("─" * 60)
                print(">>> ", end="", flush=True)

                task_type, data = _wait_for_trigger()

                # 종료
                if task_type == "keyboard" and str(data).strip().lower() == "q":
                    print("\n>>> 종료합니다. 수고하셨습니다! 👋")
                    break

                # 브라우저 열기 — 없거나 닫혀있으면 (재)오픈
                def _browser_alive():
                    try:
                        return browser is not None and len(context.pages) > 0 and not page.is_closed()
                    except Exception:
                        return False

                if not _browser_alive():
                    if browser is not None:
                        print("⚠️  브라우저가 닫혀 있어 다시 엽니다...")
                        try:
                            browser.close()
                        except Exception:
                            pass
                    browser, context, page = _open_browser(p, auth_path)

                labels = {"keyboard": "정보 입력 (터미널)", "info": "정보 입력 (HTML)", "result": "결과 입력 (HTML)"}
                print(f"\n{'█' * 60}")
                print(f"█ {comp_no}번째 공모 — {labels.get(task_type, task_type)}")
                print("█" * 60)

                task_ok = True
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
                                ok = run_judges_input(page, load_judges_from_file(), context=context)
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
                    task_ok = False

                _save_auth(context, auth_path)
                comp_no += 1
                if task_ok:
                    print(f"\n✅ 완료! 메뉴로 돌아갑니다...")
                else:
                    print(f"\n⚠️  오류가 발생했습니다. 메뉴로 돌아갑니다...")
                # ── 처리 완료 → 외부 while True 로 돌아가 메뉴 재표시 ──

        except SystemExit:
            pass
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
