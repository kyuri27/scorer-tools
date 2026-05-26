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
import sys, os, threading, queue as _queue_module, select as _select
import json, base64, tempfile, shutil, time, unicodedata

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


def _save_files_to_temp(files_data: list) -> Path:
    """base64 파일 목록을 임시 폴더에 저장하고 경로 반환"""
    tmp = Path(tempfile.mkdtemp(prefix="scorer_"))
    for f in files_data:
        fname = f.get("filename", "file")
        try:
            (tmp / fname).write_bytes(base64.b64decode(f.get("data", "")))
        except Exception as e:
            print(f"  ⚠️  파일 저장 실패 ({fname}): {e}")
    return tmp


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
    while True:
        # HTTP 트리거가 있으면 즉시 반환
        try:
            return _trigger_queue.get_nowait()
        except _queue_module.Empty:
            pass
        # 300ms 안에 키보드 입력이 있으면 읽어서 반환
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
    return sorted(judges, key=lambda j: ({"외부": 0, "예비": 1}.get(j["type"], 2), j["name"]))


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

    page.wait_for_timeout(SEARCH_WAIT_MS)

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

def extract_search_keyword(name: str) -> str:
    for sfx in ADMIN_SUFFIXES:
        if name.endswith(sfx):
            kw = name[:-len(sfx)].strip()
            if kw:
                return kw
    return name


def _search_org_and_select(page, search_term, original_name) -> bool:
    sb = page.locator('input[aria-controls="dataTable"]')
    sb.wait_for(state="visible", timeout=5000)
    sb.click()
    sb.fill("")
    sb.fill(search_term)
    page.wait_for_timeout(SEARCH_WAIT_MS)

    rows = page.locator('#dataTable tbody tr')
    rc = rows.count()
    if rc == 0 or "No data" in rows.nth(0).inner_text():
        return False

    if rc == 1:
        target = rows.nth(0)
        print("     검색결과 1개 → 자동 선택")
    else:
        print(f"     검색결과 {rc}개 → 유사도 매칭 중")
        best, bi = 0.0, 0
        for i in range(rc):
            s = affiliation_similarity(original_name, rows.nth(i).inner_text())
            if s > best:
                best, bi = s, i
        target = rows.nth(bi)
        print(f"     매칭 (유사도 {best:.0%})")

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

    print(f"     '{name}' 으로 검색 중...")
    found = _search_org_and_select(page, name, name)
    if not found:
        kw = extract_search_keyword(name)
        if kw != name:
            print(f"     결과 없음 → '{kw}' 으로 재검색...")
            found = _search_org_and_select(page, kw, name)

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


def upload_notice_files(page, comp_id: str, files_dir_override: Path = None) -> tuple:
    """공고파일 업로드 (공모 파일 폴더 또는 HTML에서 받은 임시 폴더)"""
    files_dir = files_dir_override or (SCRIPT_DIR / NOTICE_FILES_DIR)

    if not files_dir.exists():
        if files_dir_override is None:
            files_dir.mkdir()
            return False, f"'공모 파일' 폴더가 없어서 새로 만들었습니다. 파일을 넣고 다시 시도해주세요."
        return False, "파일 폴더를 찾을 수 없습니다."

    files = sorted([f for f in files_dir.iterdir() if f.is_file() and not f.name.startswith(".")])
    if not files:
        return False, "업로드할 파일 없음"

    print(f"  업로드할 공고파일 {len(files)}개:")
    for f in files:
        print(f"    - {f.name}")

    url = f"https://scorer.co.kr/admin/file_manage/{comp_id}"
    print(f"  → {url} 이동 중...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
    except Exception as e:
        return False, f"이동 실패: {e}"

    try:
        fi = page.locator('input[type="file"]')
        fi.wait_for(state="attached", timeout=5000)
        fi.set_input_files([str(f) for f in files])
        page.wait_for_timeout(500)
    except Exception as e:
        return False, f"파일 선택 실패: {e}"

    try:
        page.locator('button[type="submit"]').click()
        page.wait_for_timeout(2000)
    except Exception as e:
        return False, f"저장 실패: {e}"

    return True, f"{len(files)}개 파일 업로드 완료"


def run_info_task(page, context, auth_path: Path, data: dict):
    """HTML /start-competition 페이로드 처리 (공모 정보 입력)"""
    comp_id = str(data.get("competition_id", "")).strip()
    agency  = data.get("agency", "").strip()
    judges_raw = data.get("judges", [])
    notice_files_data = data.get("notice_files", [])

    if not comp_id.isdigit():
        print(f"❌ 잘못된 공모 ID: '{comp_id}'")
        return

    judges = load_judges_from_payload(judges_raw)

    # 심사위원
    if judges:
        print(f"\n[심사위원 입력] {len(judges)}명")
        if not navigate_to_competition(page, comp_id):
            return
        _save_auth(context, auth_path)
        ok = run_judges_input(page, judges)
        if not ok:
            print("\n❌ 브라우저 연결 끊김")
            return
    else:
        print("\n[심사위원 입력] 전달받은 심사위원 없음, 건너뜁니다.")

    # 공고파일 업로드
    if notice_files_data:
        print(f"\n[공고파일 업로드] {len(notice_files_data)}개")
        tmp = None
        try:
            tmp = _save_files_to_temp(notice_files_data)
            ok, msg = upload_notice_files(page, comp_id, files_dir_override=tmp)
            print(f"  {'✅' if ok else '❌'} {msg}")
        finally:
            if tmp and tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("\n[공고파일 업로드] 전달받은 파일 없음, 건너뜁니다.")

    # 발주처
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


def _create_entry(page, create_url, entry_name, img_path):
    page.goto(create_url)
    page.wait_for_load_state("load", timeout=15000)

    try:
        inp = page.get_by_label("입상작명")
        inp.wait_for(state="visible", timeout=3000)
    except Exception:
        inp = page.locator("input[type='text']").first
        inp.wait_for(state="visible", timeout=5000)
    inp.fill(entry_name)

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
    page.goto(contest_url)
    page.wait_for_load_state("networkidle", timeout=15000)

    try:
        sel = page.locator("select[name$='_length']").first
        sel.select_option("-1")
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass

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

    if entry_names:
        page_text = nfc(page.content())
        for en in entry_names:
            if nfc(en) in page_text and nfc(en) not in existing:
                existing.add(nfc(en))

    all_rows = page.locator("table tbody tr")
    row_count = all_rows.count()
    if row_count > 0:
        first_cells = all_rows.first.locator("td")
        fc = first_cells.count()
        debug = [nfc(first_cells.nth(j).inner_text().strip()) for j in range(min(fc, 6))]
        print(f"\n  [디버그] 테이블 행 {row_count}개, 첫 행 셀({fc}개): {debug}")

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

    keywords = [extra_info] if extra_info else []
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

    files = [str(UPLOAD_DIR / f) for f in os.listdir(UPLOAD_DIR)
             if not nfc(f).startswith(".")]
    if not files:
        print("  ⚠️ '결과 파일' 폴더 비어있음 → 건너뜁니다.")
        return

    url = f"https://scorer.co.kr/admin/file_manage/{contest_id}"
    page.goto(url)
    page.wait_for_load_state("load", timeout=15000)

    page.locator("input[type='file']").first.set_input_files(files)
    time.sleep(0.5)

    btn = page.get_by_role("button", name="저장하기")
    btn.wait_for(state="visible", timeout=5000)
    btn.click()
    page.wait_for_load_state("load", timeout=15000)
    print(f"  ✅ {len(files)}개 파일 업로드 완료")

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


def run_result_task(page, context, auth_path: Path, data: dict):
    """HTML /start 페이로드 처리 (공모 결과 입력)"""
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

    # 수신 파일/이미지 저장
    if awards_txt:
        (SCRIPT_DIR / AWARDS_FILE).write_text(awards_txt, encoding="utf-8-sig")
        print(f"  수상작목록.txt 저장됨")
    if images:
        IMAGE_DIR.mkdir(exist_ok=True)
        for img in images:
            (IMAGE_DIR / img["filename"]).write_bytes(base64.b64decode(img["data"]))
        print(f"  이미지 {len(images)}장 저장됨")
    if upload_files_data:
        UPLOAD_DIR.mkdir(exist_ok=True)
        for uf in upload_files_data:
            (UPLOAD_DIR / uf["filename"]).write_bytes(base64.b64decode(uf["data"]))
        print(f"  결과 파일 {len(upload_files_data)}개 저장됨")

    if not awards_txt:
        print("❌ 수상작 데이터가 없습니다.")
        return

    # 수상작 목록 파싱
    entries = []
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
        return

    print(f"\n📋 {len(entries)}개 입상작 처리 시작\n")

    # ── 1단계: 입상작 등록 ──
    print(f"{'─' * 50}")
    print(f"  1단계: 입상작 등록 ({len(entries)}개)")
    print(f"{'─' * 50}")
    print("  기존 등록 항목 확인 중...")
    existing = _get_existing_entry_names(page, contest_url, [e[0] for e in entries])

    created = []
    for i, (entry_name, architect_name, extra_info) in enumerate(entries, 1):
        img = _find_image(entry_name)
        if not img:
            print(f"[{i}/{len(entries)}] {entry_name}  →  ⏭  이미지 없어 건너뜁니다")
            continue
        if nfc(entry_name) in existing:
            print(f"[{i}/{len(entries)}] {entry_name}  →  ⏭  이미 등록됨")
            created.append((entry_name, architect_name, extra_info))
            continue
        print(f"[{i}/{len(entries)}] {entry_name} ...", end="", flush=True)
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
        pairs = [(arch_list[j], extra_list[j] if j < len(extra_list) else "")
                 for j in range(len(arch_list))]
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

    # ── 3단계: 결과파일 업로드 ──
    print(f"\n{'─' * 50}")
    print(f"  3단계: 결과파일 업로드")
    print(f"{'─' * 50}")
    upload_result_files(page, comp_id)

    # ── 4단계: 심사위원 불참 처리 ──
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
    print(f"  입상작: {len(created)}/{len(entries)}개")
    print(f"  건축가: {arch_ok}/{len(created)}개")
    if judges:
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

    if not auth_path.exists():
        print()
        print(">>> 카카오톡으로 로그인 후 엔터를 눌러주세요.")
        input(">>> [엔터] ")
        _save_auth(context, auth_path)
        print(f"💾 로그인 세션 저장 완료. 다음부터는 자동 로그인됩니다.")

    return browser, context, page


# ============================================================
# 실행 모드
# ============================================================

def _run_combined_mode(page, context, auth_path: Path):
    """
    터미널 입력과 HTML 버튼을 동시에 대기.
    - 공모 ID 입력 후 엔터 → 공모 정보 입력 (심사위원 + 공고파일 + 발주처)
    - HTML '공모 정보 입력하기' 클릭 → 공모 정보 입력
    - HTML '공모 결과 입력하기' 클릭 → 공모 결과 입력
    """
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

    auth_path = SCRIPT_DIR / AUTH_FILE

    with sync_playwright() as p:
        browser, context, page = _open_browser(p, auth_path)
        try:
            _run_combined_mode(page, context, auth_path)
        finally:
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
