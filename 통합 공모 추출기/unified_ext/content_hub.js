// hub.go.kr 건축 공모 추출기 - 콘텐츠 스크립트

let _tileEls = [];

async function extractData() {
  _tileEls = [];
  const result = {};

  // ── 1. 공모명 ──
  const titleSelectors = [
    'h2.tit', 'h1.tit', '.tit_area h2', '.tit_area h1',
    '.contest-title', '.view_tit', '.content_tit', 'h1', 'h2', '.tit'
  ];
  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      if (text.length > 3 && text.length < 200) {
        result['공모명'] = text;
        break;
      }
    }
  }

  // ── 2. 레이아웃 종류에 관계없이 라벨-값 쌍 추출 ──
  // hub.go.kr은 div.th + div 형태의 row 구조 사용
  const allFields = {};

  function isLabelCell(el) {
    if (el.tagName === 'TH') return true;
    const cls = (el.className || '').toLowerCase();
    // "th" 클래스를 단독으로 가진 요소 (예: <div class="th">)
    return /(?:^|\s)th(?:\s|$)/.test(cls);
  }

  function extractRowCells(container) {
    const cells = Array.from(container.children);
    for (let i = 0; i < cells.length - 1; i++) {
      if (!isLabelCell(cells[i])) continue;
      let j = i + 1;
      while (j < cells.length && isLabelCell(cells[j])) j++;
      if (j >= cells.length) continue;
      const key = cells[i].textContent.trim().replace(/\s+/g, ' ');
      if (!key || key.length > 40) continue;
      const val = cells[j].textContent.trim().replace(/\s+/g, ' ');
      if (val && !(key in allFields)) allFields[key] = val;
    }
  }

  // table > tr 구조
  document.querySelectorAll('table tr').forEach(tr => extractRowCells(tr));

  // div.row 구조 (hub.go.kr 방식: DIV.th + DIV 형태)
  document.querySelectorAll('.row').forEach(row => extractRowCells(row));

  Object.assign(result, allFields);

  // hub.go.kr 특화: '설계공모명' 값을 공모명으로 우선 적용
  if (allFields['설계공모명']) result['공모명'] = allFields['설계공모명'];

  // ── 3. 일정 정보 ──
  const schedule = {};
  const schedKwMap = [
    { keys: ['공고일자', '공고'],            field: '공고일시' },
    { keys: ['당선작발표', '당선작 발표'],   field: '발표일' },       // 반드시 '발표' catch-all 보다 앞에
    { keys: ['참가등록', '참가신청', '참가접수'], field: '참가등록' },
    { keys: ['공모안제출', '작품제출', '작품접수'], field: '작품제출' },
    { keys: ['제안서발표'],                  field: '심사일' },        // '심사' 단독 제외 (심사위원공개 방지)
  ];
  // ※ '발표' 단독 / '심사' 단독 키워드는 의도치 않은 매핑 방지를 위해 제외

  // 방법 1: div.th + 다음 형제 (값이 너무 길면 제외)
  document.querySelectorAll('th, .th').forEach(th => {
    const key = th.textContent.trim().replace(/\s+/g, ' ');
    const next = th.nextElementSibling;
    if (!next) return;
    const val = next.textContent.trim().replace(/\s+/g, ' ');
    if (!val || val.length > 150) return; // 참가방법 같은 긴 텍스트 제외
    for (const { keys, field } of schedKwMap) {
      if (keys.some(k => key.includes(k)) && !schedule[field]) {
        schedule[field] = val;
        break;
      }
    }
  });

  // 방법 2: 구분/일정 헤더를 가진 스케줄 테이블 파싱
  document.querySelectorAll('table').forEach(table => {
    const ths = Array.from(table.querySelectorAll('th')).map(t => t.textContent.trim());
    if (!ths.some(t => t === '구분') && !ths.some(t => t.includes('구분'))) return;
    if (!ths.some(t => t === '일정') && !ths.some(t => t.includes('일정'))) return;

    Array.from(table.querySelectorAll('tr')).forEach(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 2) return;
      const key = tds[0].textContent.trim().replace(/\s+/g, ' ');
      const val = tds[1].textContent.trim().replace(/\s+/g, ' ');
      if (!key || !val) return;
      for (const { keys, field } of schedKwMap) {
        if (keys.some(k => key.includes(k)) && !schedule[field]) {
          schedule[field] = val;
          break;
        }
      }
    });
  });

  result['일정_정보'] = schedule;

  // ── 4. 심사위원 (rowspan 처리) ──
  const judges = [];
  const seenJudgeNames = new Set();

  document.querySelectorAll('table').forEach(table => {
    const allRows = Array.from(table.querySelectorAll('tr'));
    let headerRowIdx = -1, headers = [];
    for (let i = 0; i < allRows.length; i++) {
      const cells = Array.from(allRows[i].querySelectorAll('th, td')).map(c => c.textContent.trim());
      if (cells.some(c => c === '성명' || c === '이름')) {
        headerRowIdx = i; headers = cells; break;
      }
    }
    if (headerRowIdx === -1) return;

    const nameIdx = headers.findIndex(h => h === '성명' || h === '이름');
    const typeIdx = headers.findIndex(h => h.includes('구분'));
    const orgIdx  = headers.findIndex(h => h.includes('소속'));
    const posIdx  = headers.findIndex(h => h.includes('직급') || h.includes('직위'));
    const qualIdx = headers.findIndex(h => h.includes('자격'));

    const dataRows = allRows.slice(headerRowIdx + 1);
    const grid = [];
    dataRows.forEach((row, ri) => {
      if (!grid[ri]) grid[ri] = [];
      const cells = row.querySelectorAll('td');
      let ci = 0, cellIdx = 0;
      while (cellIdx < cells.length) {
        while (grid[ri][ci] !== undefined) ci++;
        const cell = cells[cellIdx];
        const rs = parseInt(cell.getAttribute('rowspan') || '1');
        const cs = parseInt(cell.getAttribute('colspan') || '1');
        const text = cell.textContent.trim().replace(/\s+/g, ' ');
        for (let r = 0; r < rs; r++) {
          for (let c = 0; c < cs; c++) {
            if (!grid[ri + r]) grid[ri + r] = [];
            grid[ri + r][ci + c] = text;
          }
        }
        ci += cs; cellIdx++;
      }
    });

    grid.forEach(row => {
      if (!row || row.length < 2) return;
      const name = (row[nameIdx] || '').trim();
      if (!name || !/^[가-힣]{2,5}$/.test(name)) return;
      if (seenJudgeNames.has(name)) return;
      seenJudgeNames.add(name);
      judges.push({
        type: typeIdx >= 0 ? (row[typeIdx] || '').trim() : '',
        name,
        org:  orgIdx  >= 0 ? (row[orgIdx]  || '').trim() : '',
        pos:  posIdx  >= 0 ? (row[posIdx]  || '').trim() : '',
        qual: qualIdx >= 0 ? (row[qualIdx] || '').trim() : '',
      });
    });
  });
  // ── 4-2. hub.go.kr 특화: .name 클래스 기반 심사위원 카드 추출 ──
  // 콘솔 확인 결과: 이름 leaf 요소의 부모가 class="name"
  // 구조: div.cont > div.name(이름) + 다음형제(소속 / 직위)
  if (judges.length === 0) {
    document.querySelectorAll('.name').forEach(nameContainer => {
      // .name 요소 자체이거나 그 안의 leaf 텍스트에서 이름 추출
      const rawText = nameContainer.textContent.trim().replace(/\s+/g, ' ');
      // 이름은 앞쪽 한글 2~5자, 뒤에 "(예비)" 같은 부가 텍스트가 붙을 수 있음
      const nameMatch = rawText.match(/^([가-힣]{2,5})/);
      if (!nameMatch) return;
      const name = nameMatch[1];
      if (seenJudgeNames.has(name)) return;

      // "(예비)" 포함 여부로 예비위원 판별
      const isReserve = rawText.includes('예비');

      // 다음 형제 요소에서 소속(+직위) 추출
      const nextSib = nameContainer.nextElementSibling;
      if (!nextSib) return;
      const orgText = nextSib.textContent.trim().replace(/\s+/g, ' ');
      if (!orgText || orgText.length > 60) return;

      // "소속 / 직위" → 소속만 추출 (사용자 요청: 이름+소속만 필요)
      const org = orgText.includes('/') ? orgText.split('/')[0].trim() : orgText;
      if (!org) return;

      seenJudgeNames.add(name);
      judges.push({ type: isReserve ? '예비' : '', name, org, pos: '', qual: '' });
    });
  }

  result['심사위원_목록'] = judges;

  // ── 5. 수상작품 (타일 순차 클릭) ──
  const awards = [];

  // 타일 버튼: BUTTON > SPAN.icon 구조
  const tileButtons = Array.from(document.querySelectorAll('button'))
    .filter(btn => btn.querySelector('span.icon, span[class*="icon"]'));

  function getAwardDetail() {
    // 현재 활성 슬라이드 이미지
    const activeImg = document.querySelector('.slick-current img, .slick-slide.slick-active img');
    const imgSrc = activeImg ? (activeImg.src || '') : '';

    // 대표자를 포함한 후보 요소 수집 (body/html 제외)
    const candidates = Array.from(document.querySelectorAll('*')).filter(el =>
      el !== document.body && el !== document.documentElement &&
      el.textContent.includes('대표자')
    );

    // 공동참여자도 포함한 요소 우선, 없으면 대표자만 있는 요소
    const withBoth = candidates.filter(el => el.textContent.includes('공동참여자'));
    const pool = withBoth.length > 0 ? withBoth : candidates;
    pool.sort((a, b) => a.textContent.length - b.textContent.length);

    const text = pool[0]?.textContent.trim().replace(/\s+/g, ' ') || '';
    return { text, imgSrc };
  }

  for (let i = 0; i < tileButtons.length; i++) {
    const btn = tileButtons[i];
    btn.setAttribute('data-hub-tile', String(i));
    _tileEls.push(btn);

    const iconSpan = btn.querySelector('span.icon, span[class*="icon"]');
    const awardType = (iconSpan ? iconSpan.textContent : btn.textContent).trim();

    btn.click();
    await new Promise(r => setTimeout(r, 900));

    const { text: detailText, imgSrc } = getAwardDetail();

    // 대표자: "대표자  이름" 또는 "대표자 이름 |" 형태 처리
    const repMatch = detailText.match(/대표자\s*:?\s*([가-힣·\s]{2,20}?)(?:\s{2,}|\s*\||\s*공동|$)/);
    // 공동참여자: 여러 개면 콤마(,) 또는 세미콜론으로 구분되어 있을 수 있음 → 그대로 캡처
    const coMatch  = detailText.match(/공동참여자\s*:?\s*(.+?)(?:\s{2,}|\s*대표자|$)/);

    // officeName: 버튼 전체 텍스트에서 awardType 제거
    const btnText = btn.textContent.trim().replace(/\s+/g, ' ');
    let officeName = btnText.replace(new RegExp(awardType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim();

    let representative = repMatch ? repMatch[1].trim() : '';

    // representative가 없는 경우: officeName 끝의 "(이름)" 패턴에서 추출
    // 예) "건축사사무소이움(유성욱)" → officeName: "건축사사무소이움", representative: "유성욱"
    if (!representative) {
      const parenMatch = officeName.match(/\(([가-힣]{2,4})\)$/);
      if (parenMatch) {
        representative = parenMatch[1];
        officeName = officeName.replace(/\s*\([가-힣]{2,4}\)$/, '').trim();
      }
    }

    awards.push({
      awardType,
      officeName,
      representative,
      coParticipants: coMatch  ? coMatch[1].trim()  : '',
      imgSrc,
    });
  }
  result['수상작품_목록'] = awards;

  // ── 6. 첨부파일 ──
  const attachedFiles = [];
  const seenFileNames = new Set();
  const FILE_EXT = /\.(hwp|pdf|doc|docx|xls|xlsx|zip|ppt|pptx|hwpx)$/i;

  // hub.go.kr 첨부파일 영역: #idDesignPbpSbmsnDcmt 또는 .board-view
  const docArea = document.querySelector(
    '#idDesignPbpSbmsnDcmt, #idDesignPbpSbmsnDcmnt, [id*="SbmsnDcm"], .board-view'
  ) || document;

  // TR 행 기반 탐색 (파일명 셀 + 다운로드 버튼 셀)
  docArea.querySelectorAll('tr').forEach(tr => {
    const tds = Array.from(tr.querySelectorAll('td'));
    tds.forEach(td => {
      const text = td.textContent.trim().replace(/\s+/g, ' ');
      if (!FILE_EXT.test(text) || seenFileNames.has(text)) return;
      // 같은 행에서 다운로드 버튼 찾기
      const btn = tr.querySelector('button, a[onclick], a[href]:not([href="#"]):not([href=""])');
      if (!btn) return;
      btn.setAttribute('data-hub-attached', String(attachedFiles.length));
      seenFileNames.add(text);
      attachedFiles.push({ fileName: text });
    });
  });

  // fallback: TR 구조가 없을 때 — 파일명 요소 주변에서 버튼 탐색
  if (attachedFiles.length === 0) {
    docArea.querySelectorAll('*').forEach(el => {
      if (el.children.length > 0) return; // leaf만
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      if (!FILE_EXT.test(text) || seenFileNames.has(text)) return;
      // 부모/형제 범위에서 다운로드 버튼 탐색
      const container = el.closest('li, div, p') || el.parentElement;
      if (!container) return;
      const btn = container.querySelector('button, a[onclick]')
                || container.parentElement?.querySelector('button, a[onclick]');
      if (!btn) return;
      btn.setAttribute('data-hub-attached', String(attachedFiles.length));
      seenFileNames.add(text);
      attachedFiles.push({ fileName: text });
    });
  }

  result['첨부파일_목록'] = attachedFiles;

  result['_url'] = window.location.href;
  result['_extractedAt'] = new Date().toLocaleString('ko-KR');
  return result;
}

// ── 메시지 핸들러 ──
if (window.__hubMsgHandler) {
  chrome.runtime.onMessage.removeListener(window.__hubMsgHandler);
}
window.__hubMsgHandler = (request, sender, sendResponse) => {
  if (request.action === 'extract') {
    extractData()
      .then(data => sendResponse({ success: true, data }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true; // 비동기 응답을 위해 true 반환
  }
  return true;
};
chrome.runtime.onMessage.addListener(window.__hubMsgHandler);
