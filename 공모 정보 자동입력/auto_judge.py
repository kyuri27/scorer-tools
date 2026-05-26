"""
심사위원 자동 입력 스크립트
==========================

[처음 사용할 때]
  1. 같은 폴더에 judges.txt 파일을 만들고 심사위원 정보 입력
  2. 터미널에서 `python3 auto_judge.py` 실행
  3. 열린 브라우저에서 카톡 로그인 + 첫 공모 '심사위원 관리하기' 페이지로 이동
  4. 터미널로 돌아와 엔터 → 자동 입력 시작

[다음 공모 처리할 때]
  - 자동 입력이 끝나면 터미널에 메뉴가 나옵니다
  - 브라우저에서 직접 다음 공모 '심사위원 관리하기' 페이지로 이동
  - judges.txt 파일을 새 명단으로 수정 후 저장
  - 터미널에서 엔터 → 또 자동 입력
  - 브라우저는 계속 켜져 있어서 카톡 로그인 다시 안 해도 됩니다!

[judges.txt 형식]
  외부, 박종국, 일.월건축사사무소
  예비, 심상우, (주)지오건축사사무소
  ('#'으로 시작하는 줄과 빈 줄은 무시됩니다)
"""

from playwright.sync_api import sync_playwright
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
import sys
import threading
import queue as _queue_module
import json
import base64
import tempfile
import shutil

# ============================================================
# 설정값
# ============================================================
JUDGES_FILE = "judges.txt"
AUTH_FILE = "auth_state.json"   # 로그인 세션 저장 파일
FILES_DIR = "공모 파일"          # 업로드할 파일 폴더명
ORG_FILE = "발주처.txt"          # 발주처 이름 파일

BROWSER_WIDTH = 1920
BROWSER_HEIGHT = 1080

SEARCH_WAIT_MS = 1000       # 검색 결과 로딩 대기
ACTION_WAIT_MS = 500        # 각 동작 사이 대기

SERVER_PORT = 8765          # HTML 도구 연동용 로컬 서버 포트

SCRIPT_DIR = Path(__file__).parent

# 서버 모드용 전역 큐
_trigger_queue: "_queue_module.Queue" = _queue_module.Queue()


# ============================================================
# 로컬 HTTP 서버 (HTML 도구 연동)
# ============================================================

class _CompHandler(BaseHTTPRequestHandler):
    """공모결과정리도구.html 의 '공모 정보 입력하기' 버튼 요청을 처리"""

    def log_message(self, format, *args):
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
        if self.path == "/start-competition":
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                data = json.loads(raw)
                _trigger_queue.put(("http", data))
                resp = json.dumps({"ok": True}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._cors()
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                self.send_response(500)
                self._cors()
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()


def start_local_server() -> HTTPServer:
    """백그라운드 스레드에서 HTTP 서버 시작"""
    server = HTTPServer(("localhost", SERVER_PORT), _CompHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


def _keyboard_thread_func():
    """터미널 입력을 큐에 전달하는 백그라운드 스레드"""
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            _trigger_queue.put(("keyboard", line.strip()))
        except Exception:
            break


def save_notice_files_to_temp(notice_files: list) -> Path:
    """base64 인코딩된 파일들을 임시 폴더에 저장하고 폴더 경로 반환"""
    tmp_dir = Path(tempfile.mkdtemp(prefix="scorer_upload_"))
    for f in notice_files:
        filename = f.get("filename", "file")
        data_b64 = f.get("data", "")
        try:
            file_bytes = base64.b64decode(data_b64)
            (tmp_dir / filename).write_bytes(file_bytes)
        except Exception as e:
            print(f"  ⚠️  파일 저장 실패 ({filename}): {e}")
    return tmp_dir


# ============================================================
def load_judges_from_file(filepath: str) -> list:
    """judges.txt 파일에서 심사위원 정보를 읽음"""
    path = SCRIPT_DIR / filepath

    if not path.exists():
        sample = """# 심사위원 정보 파일
# 형식: 구분(외부/예비), 이름, 소속
# # 으로 시작하는 줄은 주석입니다

외부, 박종국, 일.월건축사사무소
외부, 손상현, 울산대학교
예비, 심상우, (주)지오건축사사무소
외부, 우세진, 울산과학대학교
외부, 이경일, 금강건축사사무소
예비, 이관호, 울산과학대학교
외부, 최강림, 경성대학교
"""
        path.write_text(sample, encoding="utf-8-sig")
        print(f"📝 '{filepath}' 파일이 없어서 예시 파일을 생성했어요.")
        print(f"   파일 위치: {path.absolute()}")
        return []

    judges = []
    with open(path, encoding="utf-8-sig") as f:
        for line_no, raw_line in enumerate(f, 1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 3:
                print(f"⚠️  {line_no}번째 줄 형식 오류 (건너뜀): {line}")
                continue

            judge_type, name, affiliation = parts[0], parts[1], ",".join(parts[2:]).strip()
            if judge_type not in ("외부", "예비"):
                print(f"⚠️  {line_no}번째 줄 구분값 오류 '{judge_type}' (건너뜀)")
                continue

            judges.append({
                "type": judge_type,
                "name": name,
                "affiliation": affiliation,
            })

    return judges


def normalize(text: str) -> str:
    """소속 매칭용 정규화 — 공백/특수문자 제거"""
    if not text:
        return ""
    result = "".join(text.split())
    for ch in "()（）.,·ㆍ・[]{}":
        result = result.replace(ch, "")
    return result.lower()


def affiliation_similarity(a: str, b: str) -> float:
    """두 소속명 유사도 (0~1). 한 쪽이 다른 쪽을 포함하면 1.0"""
    a_norm = normalize(a)
    b_norm = normalize(b)
    if not a_norm or not b_norm:
        return 0.0
    if a_norm in b_norm or b_norm in a_norm:
        return 1.0
    common = sum(1 for c in set(a_norm) if c in b_norm)
    return common / max(len(set(a_norm)), len(set(b_norm)))


def auto_accept_dialogs(page):
    """모든 JavaScript 확인 팝업을 자동으로 '확인'"""
    page.on("dialog", lambda dialog: dialog.accept())


def add_judge(page, judge: dict) -> tuple[bool, str]:
    """한 명의 심사위원을 추가"""
    name = judge["name"]
    affiliation = judge["affiliation"]
    is_backup = judge["type"] == "예비"

    print(f"  → 검색: {name} ({affiliation})")

    # ── 1) Search 박스에 이름 입력 ──
    # addJury() 후 DataTable이 재초기화되는 동안 잠깐 사라질 수 있으므로
    # 즉시 체크하지 않고 나타날 때까지 최대 5초 대기
    try:
        search_box = page.locator('input[aria-controls="dataTable"]')
        search_box.wait_for(state="visible", timeout=5000)
        search_box.click()
        search_box.fill("")
        search_box.fill(name)
    except Exception as e:
        return False, "검색 박스를 찾지 못함 (페이지가 심사위원 관리 페이지인지 확인해주세요)"

    page.wait_for_timeout(SEARCH_WAIT_MS)

    # ── 2) 검색 결과에서 적합한 행 찾기 ──
    try:
        rows = page.locator('#dataTable tbody tr')
        row_count = rows.count()

        if row_count == 0:
            return False, "검색 결과가 없음"

        # 빈 결과 메시지 처리
        if row_count == 1:
            first_row_text = rows.nth(0).inner_text().strip()
            if "No data" in first_row_text or ("데이터" in first_row_text and "없" in first_row_text):
                return False, "검색 결과가 없음"

        target_row_index = -1

        if row_count == 1:
            # 결과가 1명이면 그냥 선택 (이름 같으면 같은 곳)
            target_row_index = 0
            print(f"     검색결과 1명 → 자동 선택")
        else:
            # 결과가 여러 명이면 소속 유사도로 매칭
            print(f"     검색결과 {row_count}명 → 소속으로 매칭 중")
            best_score = 0.0
            candidates = []

            for i in range(row_count):
                row = rows.nth(i)
                row_text = row.inner_text()
                candidates.append(row_text)
                score = affiliation_similarity(affiliation, row_text)
                if score > best_score:
                    best_score = score
                    target_row_index = i

            if best_score < 0.3:
                preview = " | ".join(c.replace("\n", " ")[:60] for c in candidates[:3])
                return False, f"동명이인 중 소속 매칭 실패. 후보: {preview}"

            print(f"     매칭 (유사도 {best_score:.0%})")

        # ── 3) "선택" 버튼 클릭 ──
        target_row = rows.nth(target_row_index)
        select_btn = target_row.locator(
            'button:has-text("선택"), a:has-text("선택"), input[value="선택"]'
        ).first

        # 버튼이 실제로 있는지 먼저 확인 (없으면 30초 기다리지 않고 바로 실패)
        if select_btn.count() == 0:
            row_preview = target_row.inner_text()[:80].replace("\n", " ")
            return False, f"'선택' 버튼이 없음. 행 내용: {row_preview}"

        # 버튼이 보이고 클릭 가능해질 때까지 최대 5초만 대기
        try:
            select_btn.wait_for(state="visible", timeout=5000)
        except Exception:
            row_preview = target_row.inner_text()[:80].replace("\n", " ")
            return False, f"'선택' 버튼이 화면에 안 보임. 행 내용: {row_preview}"

        # 클릭도 5초 제한
        select_btn.click(timeout=5000)
        page.wait_for_timeout(ACTION_WAIT_MS)

    except Exception as e:
        err = str(e)
        if "Timeout" in err:
            return False, f"선택 버튼 클릭 시간 초과 (사이트 반응 느림 또는 버튼 구조 다름)"
        return False, f"선택 중 오류: {err}"

    # ── 4) 예비 처리 ──
    if is_backup:
        try:
            print(f"     → 예비로 변경 중...")
            page.wait_for_timeout(ACTION_WAIT_MS)  # 좌측 목록 갱신 대기

            # 방금 '선택'한 사람은 좌측 목록 맨 아래에 추가됨
            # → 좌측 테이블의 마지막 행에서 예비 변경
            left_row = find_left_table_last_row(page, name)

            if left_row is None:
                return False, f"좌측 목록에서 '{name}' 행을 찾지 못함 (선택은 됐을 수 있음 — 수동 확인 필요)"

            # 그 행에서 "변경하기" 버튼들 찾기
            # 헤더 순서: [예비 여부] [불참 여부] [추가 여부] [삭제하기]
            # → 첫 번째 "변경하기"가 예비 여부
            change_btns = left_row.locator('button:has-text("변경하기")')
            btn_count = change_btns.count()

            if btn_count >= 1:
                change_btns.nth(0).click()  # 첫 번째 = 예비 여부
                page.wait_for_timeout(ACTION_WAIT_MS)  # 확인 팝업은 자동 처리됨
                print(f"     → 예비 변경 완료")
            else:
                row_html_preview = left_row.inner_text()[:100].replace("\n", " ")
                return False, f"'변경하기' 버튼을 못 찾음. 행 내용: {row_html_preview}"

        except Exception as e:
            return False, f"예비 변경 중 오류: {e}"

    return True, "성공"


def get_left_table(page):
    """좌측 심사위원 목록 테이블 반환 (못 찾으면 None). class="table-hover" 로 식별."""
    try:
        table = page.locator("table.table-hover")
        if table.count() > 0:
            return table.first
    except Exception:
        pass
    return None


def find_left_table_last_row(page, expected_name: str = ""):
    """
    좌측 목록 테이블의 '마지막 데이터 행'을 반환
    방금 '선택'한 심사위원은 맨 아래에 추가되므로 마지막 행이 그 사람

    expected_name이 주어지면, 마지막 행에 그 이름이 실제로 있는지 확인
    (있으면 그대로 반환, 없으면 이름으로 다시 찾아봄)
    """
    table = get_left_table(page)

    if table is not None:
        try:
            # tbody 안의 행들 (없으면 table 직속 tr)
            body_rows = table.locator("tbody tr")
            if body_rows.count() == 0:
                body_rows = table.locator("tr")
                # 첫 행이 헤더일 수 있으니 헤더 제외는 아래에서 처리

            row_count = body_rows.count()
            if row_count > 0:
                last_row = body_rows.nth(row_count - 1)
                last_row_text = last_row.inner_text()

                # 마지막 행에 예상 이름이 있으면 확실 → 반환
                if not expected_name or expected_name in last_row_text:
                    return last_row

                # 마지막 행에 이름이 없으면 → 이름으로 행 찾기 시도
                named_row = table.locator(f'tr:has-text("{expected_name}")').last
                if named_row.count() > 0:
                    return named_row

                # 그래도 없으면 일단 마지막 행 반환
                return last_row
        except Exception:
            pass

    # 좌측 테이블을 못 찾은 경우 — 이름 기반 대체 검색
    if expected_name:
        try:
            all_rows = page.locator(f'tr:has-text("{expected_name}")')
            for i in range(all_rows.count()):
                row = all_rows.nth(i)
                has_select = row.locator('button:has-text("선택"), a:has-text("선택")').count() > 0
                has_change = row.locator('button:has-text("변경하기"), a:has-text("변경하기")').count() > 0
                if has_change and not has_select:
                    return row
        except Exception:
            pass

    return None


def get_registered_names(page) -> set:
    """좌측 테이블에 이미 등록된 심사위원 이름 목록 반환"""
    table = get_left_table(page)
    if table is None:
        return set()
    try:
        name_cells = table.locator("tbody tr td:nth-child(3)")
        names = {t.strip() for t in name_cells.all_inner_texts() if t.strip()}
        return names
    except Exception:
        return set()


def sort_judges(judges: list) -> list:
    """외부 먼저, 각 그룹 내 가나다순"""
    type_order = {"외부": 0, "예비": 1}
    return sorted(judges, key=lambda j: (type_order.get(j["type"], 2), j["name"]))


def run_one_competition(page, judges_override: list = None) -> bool:
    """
    심사위원을 모두 입력
    judges_override: HTML 도구에서 전달받은 심사위원 목록. None이면 judges.txt에서 읽음.
    return: 정상 진행 여부 (False면 심각한 문제로 중단)

    순서가 중요하므로, 한 명이 실패하면 일시정지하고 사용자에게 물어봄:
      - 엔터: 실패한 사람 건너뛰고 다음 사람부터 계속 (수동 처리는 사용자가)
      - r:    화면을 고친 뒤 그 사람 재시도
      - q:    전체 중단
    """
    # 심사위원 목록 결정: override 우선, 없으면 파일에서 읽기
    if judges_override is not None:
        judges = judges_override
    else:
        judges = load_judges_from_file(JUDGES_FILE)
    if not judges:
        print(f"❌ '{JUDGES_FILE}'에서 심사위원 정보를 읽을 수 없습니다.")
        print(f"   파일을 확인하고 다시 시도해주세요.")
        return True  # 메뉴로 돌아감

    sorted_judges = sort_judges(judges)

    # 이미 등록된 심사위원 확인
    registered = get_registered_names(page)
    if registered:
        print(f"\n이미 등록된 심사위원 {len(registered)}명 발견 → 자동으로 건너뜁니다:")
        for n in sorted(registered):
            print(f"  - {n}")

    print(f"\n총 {len(sorted_judges)}명의 심사위원을 입력합니다 (외부 → 예비, 가나다순):")
    for idx, j in enumerate(sorted_judges, 1):
        already = " ✓ 이미등록" if j["name"] in registered else ""
        print(f"  {idx}. [{j['type']}] {j['name']} - {j['affiliation']}{already}")
    print()

    results = []
    idx = 0
    while idx < len(sorted_judges):
        judge = sorted_judges[idx]
        human_no = idx + 1

        # 이미 등록된 경우 건너뜀
        if judge["name"] in registered:
            print(f"[{human_no}/{len(sorted_judges)}] {judge['name']} → 이미 등록됨, 건너뜁니다")
            results.append((judge, True, "이미 등록됨 (건너뜀)"))
            idx += 1
            continue

        print(f"[{human_no}/{len(sorted_judges)}] {judge['name']} 처리 중...")

        success = False
        msg = ""
        connection_lost = False

        try:
            success, msg = add_judge(page, judge)
        except Exception as e:
            err_text = str(e).lower()
            # 브라우저/컨텍스트 자체가 닫힌 경우만 전체 중단
            # (단순 타임아웃·페이지 오류는 "closed" 포함해도 일시정지로 처리)
            is_browser_dead = (
                ("browser" in err_text and "closed" in err_text)
                or ("context" in err_text and "closed" in err_text)
                or "crash" in err_text
            )
            if is_browser_dead:
                print(f"  ❌ 브라우저 연결이 끊어졌습니다: {e}")
                results.append((judge, False, "브라우저 연결 끊김"))
                _print_summary(results, sorted_judges)
                return False  # 심각한 문제 — 전체 중단
            else:
                success = False
                msg = f"예외: {e}"

        if success:
            print(f"  ✅ 완료")
            results.append((judge, True, msg))
            idx += 1
            # 다음 사람으로
            try:
                page.wait_for_timeout(ACTION_WAIT_MS)
            except Exception:
                print(f"  ❌ 브라우저 연결이 끊어졌습니다.")
                _print_summary(results, sorted_judges)
                return False
            continue

        # ── 실패한 경우: 일시정지하고 사용자에게 물어봄 ──
        print(f"  ❌ 실패: {msg}")
        print()
        print("  " + "⏸ " * 12)
        print(f"  일시정지: [{judge['type']}] {judge['name']} ({judge['affiliation']}) 추가에 실패했습니다.")
        print(f"  순서가 중요하므로 멈췄습니다. 브라우저에서 직접 처리하거나 화면을 조정해주세요.")
        print()
        print(f"  이어서 할 작업을 선택하세요:")
        print(f"    [엔터]  → 이 사람({judge['name']})은 건너뛰고, 다음 사람부터 계속")
        print(f"             (실패한 사람은 직접 추가하시면 됩니다)")
        print(f"    [r]     → 화면을 고친 뒤, 이 사람({judge['name']})을 다시 시도")
        print(f"    [s]     → 이 사람은 '내가 이미 수동으로 추가함'으로 표시하고 다음으로")
        print(f"    [q]     → 전체 중단하고 결과 요약 보기")
        print("  " + "⏸ " * 12)

        try:
            choice = input("  >>> 선택: ").strip().lower()
        except Exception:
            choice = "q"

        if choice == "q":
            results.append((judge, False, f"{msg} (사용자 중단)"))
            print("  >>> 전체 중단합니다.")
            _print_summary(results, sorted_judges)
            return True  # 정상 종료 (메뉴로 돌아감)

        elif choice == "r":
            # 재시도 — idx 그대로 두고 루프 반복
            print(f"  >>> '{judge['name']}' 다시 시도합니다...")
            continue

        elif choice == "s":
            # 사용자가 수동으로 추가했다고 표시
            results.append((judge, True, "사용자가 수동으로 추가함"))
            print(f"  >>> '{judge['name']}'을(를) 수동 추가 처리하고 다음으로 넘어갑니다.")
            idx += 1
            continue

        else:
            # 엔터 (또는 그 외) — 건너뛰고 다음 사람
            results.append((judge, False, f"{msg} (건너뜀 — 수동 처리 필요)"))
            print(f"  >>> '{judge['name']}'을(를) 건너뛰고 다음 사람으로 넘어갑니다.")
            idx += 1
            continue

    _print_summary(results, sorted_judges)
    return True


def _print_summary(results: list, all_judges: list):
    """결과 요약 출력"""
    print("\n" + "=" * 60)
    print("결과 요약")
    print("=" * 60)
    success_count = sum(1 for _, s, _ in results if s)
    print(f"성공: {success_count} / {len(all_judges)}")
    for judge, success, msg in results:
        mark = "✅" if success else "❌"
        print(f"  {mark} [{judge['type']}] {judge['name']} ({judge['affiliation']}) - {msg}")

    processed_names = {j["name"] for j, _, _ in results}
    unprocessed = [j for j in all_judges if j["name"] not in processed_names]
    if unprocessed:
        print(f"\n⏭️  처리되지 않은 심사위원 ({len(unprocessed)}명):")
        for judge in unprocessed:
            print(f"  - [{judge['type']}] {judge['name']} ({judge['affiliation']})")


def load_organization_from_file(filepath: str) -> str:
    """발주처.txt에서 발주처 이름 한 줄 읽기"""
    path = SCRIPT_DIR / filepath
    if not path.exists():
        path.write_text("# 발주처 이름을 한 줄로 입력하세요\n# 예) 충청남도 당진시\n", encoding="utf-8")
        print(f"📝 '{filepath}' 파일이 없어서 생성했습니다. 이름을 입력하고 다시 시도해주세요.")
        return ""
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    return ""


# 검색 시 제거할 행정 접미사 (긴 것부터 순서대로)
ADMIN_SUFFIXES = [
    "특별자치시", "특별자치도", "특별시", "광역시",
    "시청", "군청", "구청", "도청",
    "시", "군", "구", "도",
]

def extract_search_keyword(name: str) -> str:
    """발주처 이름에서 핵심 검색 키워드 추출 (행정 접미사 제거)"""
    for suffix in ADMIN_SUFFIXES:
        if name.endswith(suffix):
            keyword = name[: -len(suffix)].strip()
            if keyword:
                return keyword
    return name


def search_org_and_select(page, search_term: str, original_name: str) -> bool:
    """DataTable에서 검색어로 발주처 검색 후 유사도 기반 선택. 성공 여부 반환."""
    search_box = page.locator('input[aria-controls="dataTable"]')
    search_box.wait_for(state="visible", timeout=5000)
    search_box.click()
    search_box.fill("")
    search_box.fill(search_term)
    page.wait_for_timeout(SEARCH_WAIT_MS)

    rows = page.locator('#dataTable tbody tr')
    row_count = rows.count()
    if row_count == 0:
        return False

    first_text = rows.nth(0).inner_text().strip()
    if "No data" in first_text:
        return False

    # 결과가 1개면 바로 선택, 여러 개면 유사도로 매칭
    if row_count == 1:
        target_row = rows.nth(0)
        print(f"     검색결과 1개 → 자동 선택")
    else:
        print(f"     검색결과 {row_count}개 → 유사도 매칭 중")
        best_score, best_idx = 0.0, 0
        for i in range(row_count):
            score = affiliation_similarity(original_name, rows.nth(i).inner_text())
            if score > best_score:
                best_score, best_idx = score, i
        target_row = rows.nth(best_idx)
        print(f"     매칭 (유사도 {best_score:.0%}): {target_row.inner_text().strip()[:40]}")

    select_btn = target_row.locator('button:has-text("선택")')
    if select_btn.count() == 0:
        return False  # 선택 버튼 없음 = 실제 결과 없는 빈 행
    select_btn.first.wait_for(state="visible", timeout=5000)
    select_btn.first.click(timeout=5000)
    page.wait_for_timeout(ACTION_WAIT_MS)
    return True


def run_organization_input(page, comp_id: str, agency_override: str = None):
    """발주처 관리 페이지에서 발주처 검색 후 선택
    agency_override: HTML 도구에서 전달받은 발주처 이름. None이면 발주처.txt에서 읽음.
    """
    if agency_override:
        name = agency_override
    else:
        name = load_organization_from_file(ORG_FILE)
    if not name:
        print(f"  ❌ '{ORG_FILE}'에서 발주처 이름을 읽을 수 없습니다. 파일을 확인해주세요.")
        return

    print(f"  발주처: {name}")

    # 발주처 관리 페이지로 이동
    url = f"https://scorer.co.kr/admin/competition/{comp_id}/organization_manage"
    print(f"  → {url} 로 이동 중...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
    except Exception as e:
        print(f"  ❌ 페이지 이동 실패: {e}")
        return

    # 이미 등록된 발주처 확인 (유사도 기반)
    try:
        registered_cells = page.locator("table:not(#dataTable) td b")
        for i in range(registered_cells.count()):
            registered_name = registered_cells.nth(i).inner_text().strip()
            if affiliation_similarity(name, registered_name) >= 0.8:
                print(f"  ✓ 이미 등록됨 ({registered_name}), 건너뜁니다")
                return
    except Exception:
        pass

    # ── 검색: 먼저 원본 이름으로, 실패하면 핵심 키워드로 재시도 ──
    try:
        search_box = page.locator('input[aria-controls="dataTable"]')

        print(f"     '{name}' 으로 검색 중...")
        found = search_org_and_select(page, name, name)

        if not found:
            keyword = extract_search_keyword(name)
            if keyword != name:
                print(f"     결과 없음 → '{keyword}' 으로 재검색 중...")
                found = search_org_and_select(page, keyword, name)

        if not found:
            print(f"  ❌ '{name}'을(를) DB에서 찾지 못했습니다. '발주처 새로 만들기'로 직접 추가해주세요.")
            return

        print(f"  ✅ 발주처 '{name}' 추가 완료")

    except Exception as e:
        print(f"  ❌ 발주처 선택 중 오류: {e}")


def upload_files(page, comp_id: str, files_dir_override: Path = None) -> tuple[bool, str]:
    """파일 관리 페이지에 파일을 업로드
    files_dir_override: HTML 도구에서 전달받은 파일을 저장한 임시 폴더. None이면 '공모 파일' 폴더 사용.
    """
    files_dir = files_dir_override if files_dir_override is not None else (SCRIPT_DIR / FILES_DIR)

    # 폴더 없으면 생성 후 안내 (files_dir_override가 없을 때만)
    if not files_dir.exists() and files_dir_override is None:
        files_dir.mkdir()
        return False, f"'공모 파일' 폴더가 없어서 새로 만들었습니다. 파일을 넣고 다시 시도해주세요.\n   위치: {files_dir}"

    # 업로드할 파일 목록 (숨김 파일 제외)
    files = sorted([f for f in files_dir.iterdir() if f.is_file() and not f.name.startswith(".")])
    if not files:
        return False, f"'공모 파일' 폴더에 파일이 없습니다. ({files_dir})"

    print(f"  업로드할 파일 {len(files)}개:")
    for f in files:
        print(f"    - {f.name}")

    # 파일 관리 페이지로 이동
    url = f"https://scorer.co.kr/admin/file_manage/{comp_id}"
    print(f"  → {url} 로 이동 중...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
    except Exception as e:
        return False, f"파일 관리 페이지 이동 실패: {e}"

    # 파일 선택
    try:
        file_input = page.locator('input[type="file"]')
        file_input.wait_for(state="attached", timeout=5000)
        file_input.set_input_files([str(f) for f in files])
        page.wait_for_timeout(500)
    except Exception as e:
        return False, f"파일 선택 실패: {e}"

    # 저장하기 클릭
    try:
        save_btn = page.locator('button[type="submit"]')
        save_btn.click()
        page.wait_for_timeout(2000)  # 업로드 완료 대기
    except Exception as e:
        return False, f"저장하기 버튼 클릭 실패: {e}"

    return True, f"{len(files)}개 파일 업로드 완료"


def navigate_to_competition(page, comp_id: str) -> bool:
    """공모 ID로 심사위원 관리 페이지 이동. 로그인 필요 시 안내 후 재시도."""
    url = f"https://scorer.co.kr/admin/competition/{comp_id}/jury_manage"
    print(f">>> {url} 로 이동 중...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
    except Exception as e:
        print(f"❌ 페이지 이동 실패: {e}")
        return False

    # 로그인 페이지로 리다이렉트됐는지 확인
    if "login" in page.url or "signin" in page.url or "auth" in page.url:
        print()
        print("⚠️  로그인 세션이 만료되었습니다.")
        print(">>> 브라우저에서 카카오톡으로 다시 로그인해주세요.")
        print(">>> 로그인 완료 후 엔터를 눌러주세요.")
        input(">>> [엔터] ")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(1000)
        except Exception as e:
            print(f"❌ 페이지 이동 실패: {e}")
            return False

    return True


def _open_browser_and_login(p, auth_path: Path):
    """브라우저를 열고 세션 로드/로그인 처리 후 (browser, context, page) 반환"""
    browser = p.chromium.launch(
        headless=False,
        args=[f'--window-size={BROWSER_WIDTH},{BROWSER_HEIGHT}']
    )
    has_saved_session = auth_path.exists()

    if has_saved_session:
        print(f"💾 저장된 로그인 세션을 발견했습니다. 불러옵니다.")
        context = browser.new_context(
            no_viewport=True,
            storage_state=str(auth_path)
        )
    else:
        context = browser.new_context(no_viewport=True)

    page = context.new_page()
    auto_accept_dialogs(page)

    print()
    print(">>> 브라우저가 열렸습니다.")
    print(">>> ⚠️  지금 열린 이 브라우저 창에서만 작업하세요!")
    print(">>>    (다른 크롬 창 사용 금지, 새 탭 열지 말기, 창 닫지 말기)")

    if not has_saved_session:
        print()
        print(">>> 카카오톡으로 로그인이 필요합니다.")
        print(">>> 브라우저에서 로그인 완료 후 엔터를 눌러주세요.")
        input(">>> [엔터] ")
        try:
            context.storage_state(path=str(auth_path))
            print(f"💾 로그인 세션을 저장했습니다. 다음부터는 자동 로그인됩니다.")
        except Exception as e:
            print(f"⚠️  세션 저장 실패 (무시하고 계속): {e}")

    return browser, context, page


def _run_terminal_mode(page, context, auth_path: Path):
    """터미널 직접 입력 모드: 기존 방식 그대로"""
    # ── 작업 모드 선택 ──
    MODE_LABELS = {
        "1": "전체  (심사위원 + 파일 업로드 + 발주처)",
        "2": "심사위원만",
        "3": "파일 업로드만",
        "4": "발주처만",
    }
    print("\n어떤 작업을 할까요?")
    for key, label in MODE_LABELS.items():
        print(f"  [{key}] {label}")
    print("─" * 60)
    while True:
        mode = input(">>> 번호 선택: ").strip()
        if mode in MODE_LABELS:
            break
        print("  1~4 중에서 입력해주세요.")
    print(f"✅ 선택: {MODE_LABELS[mode]}\n")

    do_judges = mode in ("1", "2")
    do_files  = mode in ("1", "3")
    do_org    = mode in ("1", "4")

    competition_no = 1
    while True:
        print("\n" + "─" * 60)
        print(f"공모 ID를 입력하세요.  (종료: q)")
        print("─" * 60)
        comp_id = input(">>> 공모 ID: ").strip()

        if comp_id.lower() == "q":
            print("\n>>> 종료합니다. 수고하셨습니다! 👋")
            break

        if not comp_id.isdigit():
            print("⚠️  숫자만 입력해주세요.")
            continue

        print("\n" + "█" * 60)
        print(f"█ {competition_no}번째 공모 (ID: {comp_id})")
        print("█" * 60)

        # ── 심사위원 ──
        if do_judges:
            if not navigate_to_competition(page, comp_id):
                continue
            try:
                context.storage_state(path=str(auth_path))
            except Exception:
                pass
            ok = run_one_competition(page)
            if not ok:
                print("\n❌ 브라우저 연결이 끊어져서 종료합니다.")
                print("   스크립트를 다시 실행해주세요.")
                break

        # ── 파일 업로드 ──
        if do_files:
            print(f"\n[파일 업로드]")
            success, msg = upload_files(page, comp_id)
            print(f"  {'✅' if success else '❌'} {msg}")

        # ── 발주처 ──
        if do_org:
            print(f"\n[발주처 입력]")
            run_organization_input(page, comp_id)

        competition_no += 1


def _run_server_mode(page, context, auth_path: Path):
    """HTML 도구 연동 모드: 로컬 서버 대기 후 HTTP로 받은 데이터로 자동 실행"""
    server = start_local_server()
    print(f"\n🌐 로컬 서버 시작됨 (포트 {SERVER_PORT})")
    print("   공모결과정리도구.html 에서 '공모 정보 입력하기' 버튼을 누르면 자동으로 실행됩니다.")
    print("   종료하려면 [q] + 엔터를 누르세요.\n")

    # 키보드 입력 스레드 (q 입력 감지용)
    kb_thread = threading.Thread(target=_keyboard_thread_func, daemon=True)
    kb_thread.start()

    competition_no = 1
    while True:
        print("⏳ HTML 도구에서 버튼을 기다리는 중...  (종료: q + 엔터)")
        source, data = _trigger_queue.get()

        # 키보드 입력 처리
        if source == "keyboard":
            if str(data).lower() == "q":
                print("\n>>> 종료합니다. 수고하셨습니다! 👋")
                break
            # q 외 다른 입력은 무시
            continue

        # ── HTTP 트리거 ──
        assert source == "http"
        comp_id   = str(data.get("competition_id", "")).strip()
        agency    = data.get("agency", "").strip()
        judges_raw = data.get("judges", [])
        notice_files_data = data.get("notice_files", [])

        if not comp_id or not comp_id.isdigit():
            print(f"❌ 잘못된 공모 ID: '{comp_id}'")
            continue

        print(f"\n{'█' * 60}")
        print(f"█ {competition_no}번째 공모 (ID: {comp_id})")
        if agency:
            print(f"█ 발주처: {agency}")
        print(f"{'█' * 60}")

        # judges 변환: HTML의 {name, org, type} → auto_judge.py의 {name, affiliation, type}
        judges = [
            {
                "name": j.get("name", "").strip(),
                "affiliation": j.get("org", "").strip(),
                "type": j.get("type", "외부"),
            }
            for j in judges_raw
            if j.get("name", "").strip()
        ]

        # ── 심사위원 ──
        if judges:
            print(f"\n[심사위원 입력] {len(judges)}명")
            if not navigate_to_competition(page, comp_id):
                competition_no += 1
                continue
            try:
                context.storage_state(path=str(auth_path))
            except Exception:
                pass
            ok = run_one_competition(page, judges_override=judges)
            if not ok:
                print("\n❌ 브라우저 연결이 끊어졌습니다. 종료합니다.")
                break
        else:
            print("\n[심사위원 입력] 전달받은 심사위원 없음, 건너뜁니다.")

        # ── 파일 업로드 ──
        if notice_files_data:
            print(f"\n[파일 업로드] {len(notice_files_data)}개")
            tmp_dir = None
            try:
                tmp_dir = save_notice_files_to_temp(notice_files_data)
                success, msg = upload_files(page, comp_id, files_dir_override=tmp_dir)
                print(f"  {'✅' if success else '❌'} {msg}")
            finally:
                if tmp_dir and tmp_dir.exists():
                    shutil.rmtree(tmp_dir, ignore_errors=True)
        else:
            print("\n[파일 업로드] 전달받은 파일 없음, 건너뜁니다.")

        # ── 발주처 ──
        if agency:
            print(f"\n[발주처 입력]")
            run_organization_input(page, comp_id, agency_override=agency)
        else:
            print("\n[발주처 입력] 전달받은 발주처 없음, 건너뜁니다.")

        competition_no += 1

    try:
        server.shutdown()
    except Exception:
        pass


def main():
    print("=" * 60)
    print("공모 정보 자동 입력 스크립트")
    print("=" * 60)

    # ── 실행 방식 선택 ──
    print("\n실행 방식을 선택하세요:")
    print("  [1] 터미널 직접 입력  (공모 ID를 직접 입력, 파일에서 정보 읽기)")
    print("  [2] HTML 도구 연동   (공모결과정리도구.html 에서 버튼으로 자동 실행)")
    print("─" * 60)
    while True:
        run_mode = input(">>> 번호 선택: ").strip()
        if run_mode in ("1", "2"):
            break
        print("  1 또는 2를 입력해주세요.")

    auth_path = SCRIPT_DIR / AUTH_FILE

    with sync_playwright() as p:
        browser, context, page = _open_browser_and_login(p, auth_path)
        try:
            if run_mode == "1":
                _run_terminal_mode(page, context, auth_path)
            else:
                _run_server_mode(page, context, auth_path)
        finally:
            # 종료
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
