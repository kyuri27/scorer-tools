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
import sys

# ============================================================
# 설정값
# ============================================================
JUDGES_FILE = "judges.txt"
AUTH_FILE = "auth_state.json"   # 로그인 세션 저장 파일

BROWSER_WIDTH = 1920
BROWSER_HEIGHT = 1080

SEARCH_WAIT_MS = 1000       # 검색 결과 로딩 대기
ACTION_WAIT_MS = 500        # 각 동작 사이 대기

SCRIPT_DIR = Path(__file__).parent


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


def run_one_competition(page) -> bool:
    """
    judges.txt를 읽어서 한 공모의 심사위원을 모두 입력
    return: 정상 진행 여부 (False면 심각한 문제로 중단)

    순서가 중요하므로, 한 명이 실패하면 일시정지하고 사용자에게 물어봄:
      - 엔터: 실패한 사람 건너뛰고 다음 사람부터 계속 (수동 처리는 사용자가)
      - r:    화면을 고친 뒤 그 사람 재시도
      - q:    전체 중단
    """
    # judges.txt 읽기 (매번 새로 읽음 — 파일 수정사항 반영)
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


def main():
    print("=" * 60)
    print("심사위원 자동 입력 스크립트")
    print("=" * 60)

    auth_path = SCRIPT_DIR / AUTH_FILE
    has_saved_session = auth_path.exists()

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[f'--window-size={BROWSER_WIDTH},{BROWSER_HEIGHT}']
        )

        # 저장된 세션이 있으면 불러오기
        if has_saved_session:
            print(f"💾 저장된 로그인 세션을 발견했습니다. 불러옵니다.")
            print(f"   (로그인이 풀려있으면 브라우저에서 다시 로그인하면 됩니다)")
            context = browser.new_context(
                no_viewport=True,
                storage_state=str(auth_path)
            )
        else:
            context = browser.new_context(
                no_viewport=True
            )

        page = context.new_page()
        auto_accept_dialogs(page)

        # ── 최초 안내 ──
        print()
        print(">>> 브라우저가 열렸습니다.")
        print(">>> ⚠️  지금 열린 이 브라우저 창에서만 작업하세요!")
        print(">>>    (다른 크롬 창 사용 금지, 새 탭 열지 말기, 창 닫지 말기)")
        print(">>>")
        if has_saved_session:
            print(">>> 1) 사이트가 이미 로그인되어 있는지 확인하세요")
            print(">>>    (로그인이 풀렸으면 카톡으로 다시 로그인)")
        else:
            print(">>> 1) 사이트 접속 → 카톡으로 로그인")
            print(">>>    (이번 한 번만 로그인하면 다음부터는 자동입니다)")
        print(">>> 2) 첫 공모의 '심사위원 관리하기' 페이지로 이동")
        print(">>> 3) 준비되면 이 터미널에서 엔터를 눌러주세요")
        input(">>> [엔터] ")

        # 로그인 세션 저장 (다음 실행 때 재사용)
        try:
            context.storage_state(path=str(auth_path))
            print(f"💾 로그인 세션을 '{AUTH_FILE}'에 저장했습니다.")
            print(f"   다음 실행부터는 로그인이 유지됩니다.")
        except Exception as e:
            print(f"⚠️  세션 저장 실패 (무시하고 계속): {e}")

        # ── 반복 루프: 공모를 계속 처리 ──
        competition_no = 1
        while True:
            print("\n" + "█" * 60)
            print(f"█ {competition_no}번째 공모 입력 시작")
            print("█" * 60)

            ok = run_one_competition(page)

            if not ok:
                # 브라우저 연결이 끊어진 경우
                print("\n❌ 브라우저 연결이 끊어져서 종료합니다.")
                print("   스크립트를 다시 실행해주세요.")
                print("   (로그인 세션은 저장되어 있어서 카톡 인증은 안 해도 됩니다)")
                break

            # ── 다음 작업 메뉴 ──
            print("\n" + "─" * 60)
            print("다음에 무엇을 할까요?")
            print("  [엔터] 다음 공모 입력하기")
            print("         → 브라우저에서 다음 공모 페이지로 이동하고,")
            print("           judges.txt 파일을 수정해서 저장한 뒤 엔터")
            print("  [q + 엔터] 종료")
            print("─" * 60)
            choice = input(">>> 선택: ").strip().lower()

            if choice == "q":
                print("\n>>> 종료합니다. 수고하셨습니다! 👋")
                break

            # 세션 갱신 저장 (로그인 상태 최신화)
            try:
                context.storage_state(path=str(auth_path))
            except Exception:
                pass

            competition_no += 1

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
