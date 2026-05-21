#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import sys
import json
import time
import base64
import threading
import unicodedata
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

BASE_DIR = Path(__file__).parent
IMAGE_DIR = BASE_DIR / "입상작 이미지"
UPLOAD_DIR = BASE_DIR / "업로드 파일"
AUTH_STATE = BASE_DIR / "auth_state.json"

_done_event = threading.Event()


# ── 유틸 ─────────────────────────────────────────────────

def nfc(s):
    return unicodedata.normalize("NFC", s)


def find_txt_file():
    all_files = [f for f in os.listdir(BASE_DIR)
                 if nfc(f).startswith("수상작목록") and nfc(f).endswith(".txt")]
    files = sorted([str(BASE_DIR / f) for f in all_files])
    if not files:
        print("❌ '수상작목록'으로 시작하는 txt 파일을 찾을 수 없습니다.")
        sys.exit(1)
    if len(files) > 1:
        print("📂 수상작목록 파일이 여러 개 발견되었습니다:")
        for i, f in enumerate(files, 1):
            print(f"  {i}. {Path(f).name}")
        while True:
            try:
                idx = int(input("사용할 파일 번호 입력: ").strip())
                if 1 <= idx <= len(files):
                    return files[idx - 1]
            except ValueError:
                pass
            print("올바른 번호를 입력하세요.")
    return files[0]


def parse_entries(filepath):
    entries = []
    with open(filepath, encoding="utf-8-sig") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if parts and parts[0].strip():
                entry_name = parts[0].strip()
                architect_name = parts[1].strip() if len(parts) > 1 else ""
                extra_info = parts[2].strip() if len(parts) > 2 else ""
                entries.append((entry_name, architect_name, extra_info))
    return entries


def find_image(entry_name):
    if not IMAGE_DIR.exists():
        return None
    for fname in os.listdir(IMAGE_DIR):
        name_only = Path(nfc(fname)).stem
        entry = nfc(entry_name)
        if name_only.startswith(entry + "_") or name_only == entry:
            return str(IMAGE_DIR / fname)
    return None


def clean_architect_name(name):
    for token in ["주식회사", "(주)", "㈜", "건축사사무소", "종합", "스튜디오"]:
        name = name.replace(token, "")
    return name.strip()


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


# ── Playwright 동작 함수들 ────────────────────────────────

def ensure_logged_in(page, context, url):
    page.goto(url)
    page.wait_for_load_state("load", timeout=15000)
    if "scorer.co.kr/admin" not in page.url:
        print("\n🔑 로그인이 필요합니다. 브라우저에서 카카오톡 로그인을 해주세요.")
        input("로그인 완료 후 엔터를 누르세요...")
        context.storage_state(path=str(AUTH_STATE))
        print("✅ 로그인 정보 저장 완료 (다음 실행부터 자동 로그인)")
        page.goto(url)
        page.wait_for_load_state("load", timeout=15000)


def create_entry(page, create_url, entry_name, img_path):
    page.goto(create_url)
    page.wait_for_load_state("load", timeout=15000)

    try:
        name_input = page.get_by_label("입상작명")
        name_input.wait_for(state="visible", timeout=3000)
    except Exception:
        name_input = page.locator("input[type='text']").first
        name_input.wait_for(state="visible", timeout=5000)
    name_input.fill(entry_name)

    file_input = page.locator("input[type='file']").first
    file_input.set_input_files(img_path)
    time.sleep(0.3)

    try:
        save_btn = page.get_by_role("button", name="저장하기")
        save_btn.wait_for(state="visible", timeout=5000)
        save_btn.click()
    except Exception:
        save_btn = page.locator("button[type='submit'], input[type='submit']").first
        save_btn.wait_for(state="visible", timeout=5000)
        save_btn.click()

    page.wait_for_load_state("load", timeout=15000)
    time.sleep(0.2)


def get_existing_entry_names(page, contest_url, entry_names=None):
    """
    등록된 입상작명 목록을 반환한다.
    entry_names: 입력할 예정인 항목명 리스트 (교차 검증용)
    """
    page.goto(contest_url)
    page.wait_for_load_state("networkidle", timeout=15000)

    # ── DataTables 전체 표시로 전환 ─────────────────────────
    try:
        length_sel = page.locator("select[name$='_length']").first
        length_sel.select_option("-1")
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass  # 전환 실패해도 계속 진행

    existing = set()

    # ── JS로 DOM 내 모든 행 수집 (숨겨진 행 포함) ───────────
    try:
        # 4번째 td(인덱스 3) 기준으로 수집
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
    except Exception as e:
        print(f"\n  [경고] JS 수집 실패({e}), locator 방식으로 재시도")
        rows = page.locator("table tbody tr")
        for i in range(rows.count()):
            cells = rows.nth(i).locator("td")
            if cells.count() >= 4:
                name = nfc(cells.nth(3).inner_text().strip())
                if name and not name.isdigit():
                    existing.add(name)

    # ── 교차 검증: entry_names 기준으로 페이지 텍스트 재확인 ─
    if entry_names:
        page_text = nfc(page.content())
        for en in entry_names:
            if nfc(en) in page_text and nfc(en) not in existing:
                print(f"  [보완] 페이지 텍스트에서 '{en}' 발견 → 기존 항목으로 추가")
                existing.add(nfc(en))

    # ── 디버그 출력 ─────────────────────────────────────────
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


def get_assigned_architect_names(page):
    assigned = []
    rows = page.locator("table tbody tr")
    for i in range(rows.count()):
        row = rows.nth(i)
        if row.locator("button:has-text('삭제하기')").count() > 0:
            name = row.inner_text().replace("삭제하기", "").strip()
            assigned.append(name)
    return assigned


def go_to_architect_manage(page, contest_url, entry_name):
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
        btns = row.locator("button, a").filter(has_text="관리하기")
        btns.last.click()

    page.wait_for_load_state("load", timeout=15000)


def click_select(row):
    btn = row.locator("button:has-text('선택'), a:has-text('선택'), input[value='선택']").first
    btn.wait_for(state="visible", timeout=5000)
    btn.click()
    time.sleep(0.2)


def select_architect(page, search_name, extra_info, original_name=""):
    search_box = page.locator("input[type='search']").first
    search_box.wait_for(state="visible", timeout=5000)
    search_box.fill(search_name)
    time.sleep(0.7)

    rows = page.locator("#dataTable tbody tr")
    count = rows.count()

    if count == 0 or (count == 1 and "No data" in rows.first.inner_text()):
        print(f"\n  ⚠️ '{search_name}' 검색 결과 없음.")
        pause_for_user()
        return

    if count == 1:
        click_select(rows.first)
        return

    disambig_keywords = [extra_info] if extra_info else []
    for kw in ["종합", "스튜디오"]:
        if kw in original_name:
            disambig_keywords.append(kw)

    for keyword in disambig_keywords:
        for i in range(count):
            if keyword in rows.nth(i).inner_text():
                click_select(rows.nth(i))
                return

    print(f"\n  ⚠️ '{search_name}' 동명 결과 {count}개, 자동 판별 불가.")
    pause_for_user()


# ── 파일 업로드 ──────────────────────────────────────────

def upload_files(page, contest_id):
    files = [str(UPLOAD_DIR / f) for f in os.listdir(UPLOAD_DIR)
             if not nfc(f).startswith(".")]
    if not files:
        print("  ⚠️ '업로드 파일' 폴더가 비어있습니다. 건너뜁니다.")
        return

    file_manage_url = f"https://scorer.co.kr/admin/file_manage/{contest_id}"
    page.goto(file_manage_url)
    page.wait_for_load_state("load", timeout=15000)

    file_input = page.locator("input[type='file']").first
    file_input.set_input_files(files)
    time.sleep(0.5)

    save_btn = page.get_by_role("button", name="저장하기")
    save_btn.wait_for(state="visible", timeout=5000)
    save_btn.click()
    page.wait_for_load_state("load", timeout=15000)

    print(f"  ✅ {len(files)}개 파일 업로드 완료")
    for f in files:
        print(f"     - {Path(f).name}")


# ── 핵심 자동화 로직 ──────────────────────────────────────

def _run_core(contest_id):
    contest_url = f"https://scorer.co.kr/admin/entry/{contest_id}"
    create_url = f"https://scorer.co.kr/admin/entry/create/{contest_id}"

    txt_file = find_txt_file()
    entries = parse_entries(txt_file)

    if not entries:
        print("❌ 입상작 목록이 비어있습니다.")
        return

    print(f"\n📋 '{Path(txt_file).name}' 에서 {len(entries)}개 입상작 발견\n")

    for entry_name, architect_name, extra_info in entries:
        img = find_image(entry_name)
        status = "✅" if img else "❌"
        arch_list = [a.strip() for a in architect_name.split(",") if a.strip()]
        extra_list = [e.strip() for e in extra_info.split(",") if e.strip()]
        keywords = [f"'{clean_architect_name(a)}'" for a in arch_list]
        arch_str = f"{architect_name}  →  검색키워드: {', '.join(keywords)}"
        if extra_list:
            arch_str += f"  (구분: {', '.join(extra_list)})"
        print(f"  {status} {entry_name:20s}  {arch_str}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)

        ctx_kwargs = {"no_viewport": True}
        if AUTH_STATE.exists():
            ctx_kwargs["storage_state"] = str(AUTH_STATE)

        context = browser.new_context(**ctx_kwargs)
        page = context.new_page()
        page.on("dialog", lambda d: d.accept())

        ensure_logged_in(page, context, contest_url)

        # ── 1단계: 입상작 전체 등록 ──────────────────────────
        print(f"\n{'─' * 50}")
        print(f"  1단계: 입상작 등록 ({len(entries)}개)")
        print(f"{'─' * 50}")

        print("기존 등록 항목 확인 중...")
        entry_name_list = [e[0] for e in entries]
        existing_entries = get_existing_entry_names(page, contest_url, entry_names=entry_name_list)
        if existing_entries:
            print(f"  ↳ 이미 등록된 {len(existing_entries)}개 발견 → 스킵")
        else:
            print("  ↳ 없음")

        created = []
        for i, (entry_name, architect_name, extra_info) in enumerate(entries, 1):
            img_path = find_image(entry_name)
            if not img_path:
                print(f"[{i}/{len(entries)}] {entry_name}  →  ⏭  이미지 없어 건너뜁니다")
                continue

            if nfc(entry_name) in existing_entries:
                print(f"[{i}/{len(entries)}] {entry_name}  →  ⏭  이미 등록됨, 건너뜁니다")
                created.append((entry_name, architect_name, extra_info))
                continue

            print(f"[{i}/{len(entries)}] {entry_name} ...", end="", flush=True)

            while True:
                try:
                    create_entry(page, create_url, entry_name, img_path)
                    print("  ✅")
                    created.append((entry_name, architect_name, extra_info))
                    break
                except PlaywrightTimeoutError as e:
                    print(f"\n  ❌ 시간 초과: {e}")
                except Exception as e:
                    err = str(e).lower()
                    if "browser" in err and "closed" in err:
                        print("\n❌ 브라우저가 닫혔습니다.")
                        sys.exit(1)
                    print(f"\n  ❌ 오류: {e}")

                action = pause_for_error()
                if action == "skip":
                    break

        # ── 2단계: 건축가 전체 관리 ──────────────────────────
        print(f"\n{'─' * 50}")
        print(f"  2단계: 건축가 관리 ({len(created)}개)")
        print(f"{'─' * 50}")

        arch_success = 0
        for i, (entry_name, architect_name, extra_info) in enumerate(created, 1):
            arch_list = [a.strip() for a in architect_name.split(",") if a.strip()]
            extra_list = [e.strip() for e in extra_info.split(",") if e.strip()]
            pairs = [(arch_list[j], extra_list[j] if j < len(extra_list) else "")
                     for j in range(len(arch_list))]

            keywords = [f"'{clean_architect_name(a)}'" for a, _ in pairs]
            print(f"[{i}/{len(created)}] {entry_name}  →  {', '.join(keywords)} ...", end="", flush=True)

            while True:
                try:
                    go_to_architect_manage(page, contest_url, entry_name)
                    assigned_names = get_assigned_architect_names(page)
                    expected = len(pairs)

                    if len(assigned_names) >= expected:
                        print("  ⏭  이미 전원 배정됨, 건너뜁니다")
                        arch_success += 1
                        break

                    if len(assigned_names) > 0:
                        print(f"\n  ⚠️ {len(assigned_names)}/{expected}명 배정됨. 나머지 추가 중...")

                    for arch, extra in pairs:
                        search_name = clean_architect_name(arch)
                        already = any(search_name in name for name in assigned_names)
                        if already:
                            print(f"     ⏭  '{search_name}' 이미 배정됨")
                        else:
                            print(f"     ➕ '{search_name}' 추가 중...", end="", flush=True)
                            select_architect(page, search_name, extra, arch)
                            print(" ✅")
                    print("  완료")
                    page.goto(contest_url)
                    page.wait_for_load_state("load", timeout=15000)
                    arch_success += 1
                    break
                except PlaywrightTimeoutError as e:
                    print(f"\n  ❌ 시간 초과: {e}")
                except Exception as e:
                    err = str(e).lower()
                    if "browser" in err and "closed" in err:
                        print("\n❌ 브라우저가 닫혔습니다.")
                        sys.exit(1)
                    print(f"\n  ❌ 오류: {e}")

                action = pause_for_error()
                if action == "skip":
                    break

        # ── 3단계: 파일 업로드 ───────────────────────────────
        if UPLOAD_DIR.exists():
            print(f"\n{'─' * 50}")
            print(f"  3단계: 파일 업로드")
            print(f"{'─' * 50}")
            upload_files(page, contest_id)
        else:
            print(f"\n  ℹ️  '업로드 파일' 폴더 없음 → 파일 업로드 건너뜁니다.")

        context.storage_state(path=str(AUTH_STATE))
        browser.close()

    print(f"\n{'=' * 50}")
    print(f"  완료!")
    print(f"  입상작 등록: {len(created)}/{len(entries)}개")
    print(f"  건축가 관리: {arch_success}/{len(created)}개")
    print(f"{'=' * 50}")


# ── HTTP 서버 ─────────────────────────────────────────────

def run_automation(competition_id, awards_txt, images=None, upload_files=None):
    """공모 결과 정리도구에서 호출: txt·이미지·파일 저장 후 자동입력 실행"""
    try:
        # 수상작목록.txt 저장
        awards_txt_path = BASE_DIR / "수상작목록.txt"
        with open(awards_txt_path, "w", encoding="utf-8-sig") as f:
            f.write(awards_txt)

        # 이미지 저장
        if images:
            IMAGE_DIR.mkdir(exist_ok=True)
            for img in images:
                with open(IMAGE_DIR / img["filename"], "wb") as f:
                    f.write(base64.b64decode(img["data"]))
            print(f"✅ 이미지 {len(images)}장 저장 완료")

        # 업로드 파일 저장
        if upload_files:
            UPLOAD_DIR.mkdir(exist_ok=True)
            for uf in upload_files:
                with open(UPLOAD_DIR / uf["filename"], "wb") as f:
                    f.write(base64.b64decode(uf["data"]))
            print(f"✅ 업로드 파일 {len(upload_files)}개 저장 완료")

        print(f"\n▶ 자동입력 시작 — 공모전 ID: {competition_id}")
        _run_core(str(competition_id))
    finally:
        _done_event.set()


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path == "/start":
            length = int(self.headers["Content-Length"])
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            threading.Thread(
                target=run_automation,
                args=(str(data["competition_id"]), data["awards_txt"]),
                kwargs={
                    "images": data.get("images", []),
                    "upload_files": data.get("upload_files", []),
                },
                daemon=True,
            ).start()

    def log_message(self, *args):
        pass  # 서버 로그 숨김


# ── 진입점 ────────────────────────────────────────────────

def run():
    print("=" * 50)
    print("  수상작 자동 입력 툴  |  스코어러")
    print("=" * 50)

    server = HTTPServer(("localhost", 8765), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print("\n공모 결과 정리도구에서 '🚀 공모 결과 입력하기'를 누르시거나")
    print("바로 시작하려면 's'를 입력하세요.")
    print("> ", end="", flush=True)

    def wait_for_input():
        choice = input().strip().lower()
        if choice == "s":
            print("\n공모전 ID를 입력하세요.  예) 5834")
            contest_id = input("> ").strip()
            try:
                _run_core(contest_id)
            finally:
                _done_event.set()

    threading.Thread(target=wait_for_input, daemon=True).start()

    _done_event.wait()
    server.shutdown()
    input("\n종료하려면 엔터를 누르세요...")


if __name__ == "__main__":
    run()
