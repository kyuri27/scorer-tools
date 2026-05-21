#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import sys
import time
import unicodedata
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

BASE_DIR = Path(__file__).parent
IMAGE_DIR = BASE_DIR / "입상작 이미지"
AUTH_STATE = BASE_DIR / "auth_state.json"


def nfc(s):
    return unicodedata.normalize("NFC", s)


def find_txt_file():
    all_files = [f for f in os.listdir(BASE_DIR)
                 if nfc(f).startswith("수상작목록") and nfc(f).endswith(".txt")]
    files = sorted([str(BASE_DIR / f) for f in all_files])
    if not files:
        print("❌ '수상작목록'으로 시작하는 txt 파일을 찾을 수 없습니다.")
        print(f"   폴더: {BASE_DIR}")
        input("\n엔터를 눌러 종료합니다...")
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
    """(주), 주식회사, 건축사사무소 제거 후 핵심 키워드만 반환"""
    for token in ["주식회사", "(주)", "건축사사무소"]:
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


def ensure_logged_in(page, context, url):
    page.goto(url)
    page.wait_for_load_state("networkidle", timeout=15000)
    if "scorer.co.kr/admin" not in page.url:
        print("\n🔑 로그인이 필요합니다. 브라우저에서 카카오톡 로그인을 해주세요.")
        input("로그인 완료 후 엔터를 누르세요...")
        context.storage_state(path=str(AUTH_STATE))
        print("✅ 로그인 정보 저장 완료 (다음 실행부터 자동 로그인)")
        page.goto(url)
        page.wait_for_load_state("networkidle", timeout=15000)


def create_entry(page, create_url, entry_name, img_path):
    page.goto(create_url)
    page.wait_for_load_state("networkidle", timeout=15000)

    try:
        name_input = page.get_by_label("입상작명")
        name_input.wait_for(state="visible", timeout=3000)
    except Exception:
        name_input = page.locator("input[type='text']").first
        name_input.wait_for(state="visible", timeout=5000)
    name_input.fill(entry_name)

    file_input = page.locator("input[type='file']").first
    file_input.set_input_files(img_path)
    time.sleep(1)

    try:
        save_btn = page.get_by_role("button", name="저장하기")
        save_btn.wait_for(state="visible", timeout=5000)
        save_btn.click()
    except Exception:
        save_btn = page.locator("button[type='submit'], input[type='submit']").first
        save_btn.wait_for(state="visible", timeout=5000)
        save_btn.click()

    page.wait_for_load_state("networkidle", timeout=15000)
    time.sleep(0.5)


def go_to_architect_manage(page, contest_url, entry_name):
    page.goto(contest_url)
    page.wait_for_load_state("networkidle", timeout=15000)
    time.sleep(1)

    row = page.locator("table tbody tr").filter(has_text=entry_name).first
    row.wait_for(state="visible", timeout=5000)

    try:
        btn = row.locator("a[href*='architect_manage']").first
        btn.wait_for(state="visible", timeout=3000)
        btn.click()
    except Exception:
        btns = row.locator("button, a").filter(has_text="관리하기")
        btns.last.click()

    page.wait_for_load_state("networkidle", timeout=15000)


def select_architect(page, search_name, extra_info):
    search_box = page.locator("input[type='search']").first
    search_box.wait_for(state="visible", timeout=5000)
    search_box.fill(search_name)
    time.sleep(1.5)

    no_data = page.locator("table tbody td.dataTables_empty, table tbody tr td").filter(has_text="No data")
    rows = page.locator("table tbody tr").filter(has_not_text="No data available")

    if no_data.count() > 0 or rows.count() == 0:
        print(f"\n  ⚠️ '{search_name}' 검색 결과 없음.")
        pause_for_user()
        return

    count = rows.count()

    if count == 1:
        rows.first.locator("button, a").filter(has_text="선택").first.click()
        time.sleep(0.5)
        return

    if extra_info:
        for i in range(count):
            row = rows.nth(i)
            if extra_info in row.inner_text():
                row.locator("button, a").filter(has_text="선택").first.click()
                time.sleep(0.5)
                return

    print(f"\n  ⚠️ '{search_name}' 동명 결과 {count}개, 자동 판별 불가.")
    pause_for_user()


def run():
    print("=" * 50)
    print("  수상작 자동 입력 툴  |  스코어러")
    print("=" * 50)

    txt_file = find_txt_file()
    entries = parse_entries(txt_file)

    if not entries:
        print("❌ 입상작 목록이 비어있습니다.")
        input("\n엔터를 눌러 종료합니다...")
        sys.exit(1)

    print(f"\n📋 '{Path(txt_file).name}' 에서 {len(entries)}개 입상작 발견\n")

    for entry_name, architect_name, extra_info in entries:
        img = find_image(entry_name)
        status = "✅" if img else "❌"
        search_name = clean_architect_name(architect_name)
        arch_str = f"{architect_name}  →  검색키워드: '{search_name}'"
        if extra_info:
            arch_str += f"  (구분: {extra_info})"
        print(f"  {status} {entry_name:20s}  {arch_str}")

    print("\n공모전 URL을 입력하세요.")
    print("예) https://scorer.co.kr/admin/entry/5839")
    contest_url = input("> ").strip()
    if not contest_url.startswith("http"):
        contest_url = "https://" + contest_url

    contest_id = contest_url.rstrip("/").split("/")[-1]
    create_url = f"https://scorer.co.kr/admin/entry/create/{contest_id}"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)

        ctx_kwargs = {"no_viewport": True}
        if AUTH_STATE.exists():
            ctx_kwargs["storage_state"] = str(AUTH_STATE)

        context = browser.new_context(**ctx_kwargs)
        page = context.new_page()
        page.set_viewport_size({"width": 1920, "height": 1080})
        page.on("dialog", lambda d: d.accept())

        ensure_logged_in(page, context, contest_url)

        # ── 1단계: 입상작 전체 등록 ──────────────────────────
        print(f"\n{'─' * 50}")
        print(f"  1단계: 입상작 등록 ({len(entries)}개)")
        print(f"{'─' * 50}")

        created = []
        for i, (entry_name, architect_name, extra_info) in enumerate(entries, 1):
            img_path = find_image(entry_name)
            if not img_path:
                print(f"[{i}/{len(entries)}] {entry_name}  →  ⏭  이미지 없어 건너뜁니다")
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
            search_name = clean_architect_name(architect_name)
            print(f"[{i}/{len(created)}] {entry_name}  →  '{search_name}' ...", end="", flush=True)

            while True:
                try:
                    go_to_architect_manage(page, contest_url, entry_name)
                    select_architect(page, search_name, extra_info)
                    print("  ✅")
                    page.goto(contest_url)
                    page.wait_for_load_state("networkidle", timeout=15000)
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

        context.storage_state(path=str(AUTH_STATE))

        print(f"\n{'=' * 50}")
        print(f"  완료!")
        print(f"  입상작 등록: {len(created)}/{len(entries)}개")
        print(f"  건축가 관리: {arch_success}/{len(created)}개")
        print(f"{'=' * 50}")

        input("\n엔터를 누르면 브라우저가 닫힙니다...")
        browser.close()


if __name__ == "__main__":
    run()
