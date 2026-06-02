// 페이지 내 다운로드 요소 참조 (extractData 호출 시 갱신)
// var 사용: 스크립트 재주입 시 let/const 중복 선언 에러 방지
if (!window.__seumterState) window.__seumterState = { attachedFileEls: [], judgeResultEls: [] };
var _attachedFileEls = window.__seumterState.attachedFileEls;
var _judgeResultEls  = window.__seumterState.judgeResultEls;

function extractData() {
  _attachedFileEls = window.__seumterState.attachedFileEls = [];
  _judgeResultEls  = window.__seumterState.judgeResultEls  = [];
  const result = {};

  // ── 공모 개요 th-td 추출 ──
  document.querySelectorAll('th').forEach(th => {
    const key = th.textContent.trim();
    const td = th.nextElementSibling;
    if (key && td && td.tagName === 'TD') {
      result[key] = td.textContent.trim().replace(/\s+/g, ' ');
    }
  });

  const titleEl = document.querySelector('.contest_title, h3, h2, .title');
  if (titleEl) result['공모명_원본'] = titleEl.textContent.trim();

  // ── 일정 정보 추출 ──
  const schedule = {};

  document.querySelectorAll('th.blue_dot').forEach(th => {
    const key = th.textContent.trim();
    const td = th.nextElementSibling;
    if (!td) return;
    const val = td.textContent.trim().replace(/\s+/g, ' ');
    const dateMatch = val.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/);
    const rawDate = dateMatch ? dateMatch[0].replace(/[./]/g, '-') : val;
    if (key.includes('당선작') || key.includes('발표')) {
      schedule['당선작발표일'] = rawDate;
    } else if (key.includes('작품심사') || key.includes('심사')) {
      schedule['심사일'] = rawDate;
    } else if (key.includes('작품접수') || key.includes('접수')) {
      schedule['작품접수'] = val;
    } else if (key.includes('공고')) {
      schedule['공고일시'] = rawDate;
    } else if (key.includes('참가등록') || key.includes('정기등록')) {
      schedule['참가등록'] = val;
    }
  });

  result['일정_정보'] = schedule;
  result['당선작발표일'] = schedule['당선작발표일'] || '';

  // ── 심사위원 추출 ──
  const judges = [];
  const seenNames = new Set();

  const judgeTable = document.querySelector('.content3_left_table table, .content3_left_table .border_block');
  if (judgeTable) {
    const thead = judgeTable.querySelector('thead');
    const tbody = judgeTable.querySelector('tbody');
    if (thead && tbody) {
      const headers = Array.from(thead.querySelectorAll('th, td')).map(c => c.textContent.trim());
      const typeIdx = headers.findIndex(h => h.includes('구분'));
      const nameIdx = headers.findIndex(h => h === '성명' || h === '이름');
      const orgIdx  = headers.findIndex(h => h.includes('소속'));
      const posIdx  = headers.findIndex(h => h.includes('직급') || h.includes('직위'));
      const qualIdx = headers.findIndex(h => h.includes('자격'));

      const dataRows = Array.from(tbody.querySelectorAll('tr'));
      const grid = [];
      dataRows.forEach((row, ri) => {
        if (!grid[ri]) grid[ri] = [];
        const cells = row.querySelectorAll('td');
        let ci = 0, cellIdx = 0;
        while (cellIdx < cells.length) {
          while (grid[ri][ci] !== undefined) ci++;
          const cell = cells[cellIdx];
          const rowspan = parseInt(cell.getAttribute('rowspan') || '1');
          const colspan = parseInt(cell.getAttribute('colspan') || '1');
          const text = cell.textContent.trim().replace(/\s+/g, ' ');
          for (let r = 0; r < rowspan; r++) {
            for (let c = 0; c < colspan; c++) {
              if (!grid[ri + r]) grid[ri + r] = [];
              grid[ri + r][ci + c] = text;
            }
          }
          ci += colspan;
          cellIdx++;
        }
      });

      grid.forEach(row => {
        if (!row || row.length < 2) return;
        const name = nameIdx >= 0 ? (row[nameIdx] || '').trim() : '';
        if (!name || !/^[가-힣]{2,4}$/.test(name)) return;
        if (seenNames.has(name)) return;
        seenNames.add(name);
        judges.push({
          type: typeIdx >= 0 ? (row[typeIdx] || '').trim() : '',
          name,
          org:  orgIdx  >= 0 ? (row[orgIdx]  || '').trim() : '',
          pos:  posIdx  >= 0 ? (row[posIdx]  || '').trim() : '',
          qual: qualIdx >= 0 ? (row[qualIdx] || '').trim() : '',
        });
      });
    }
  }

  if (judges.length === 0) {
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
        if (!name || !/^[가-힣]{2,4}$/.test(name)) return;
        if (seenNames.has(name)) return;
        seenNames.add(name);
        judges.push({
          type: typeIdx >= 0 ? (row[typeIdx] || '').trim() : '',
          name,
          org:  orgIdx  >= 0 ? (row[orgIdx]  || '').trim() : '',
          pos:  posIdx  >= 0 ? (row[posIdx]  || '').trim() : '',
          qual: qualIdx >= 0 ? (row[qualIdx] || '').trim() : '',
        });
      });
    });
  }

  result['심사위원_목록'] = judges;

  // ── 수상작품 추출 ──
  const awards = [];
  document.querySelectorAll('.content7_prize').forEach(prize => {
    const img = prize.querySelector('img');
    const imgSrc = img ? img.src : '';
    const expEl = prize.querySelector('.content7_exp');
    let awardType = '', officeName = '', designer = '';
    if (expEl) {
      const spanEl = expEl.querySelector('span');
      if (spanEl) awardType = spanEl.textContent.trim();
      const blueP = expEl.querySelector('p.color_blue');
      if (blueP) officeName = blueP.textContent.trim();
      const allP = Array.from(expEl.querySelectorAll('p'));
      for (const p of allP) {
        const text = p.textContent.trim();
        if (text.startsWith('대표설계자')) {
          designer = text.replace(/^대표설계자\s*:\s*/, '').trim();
          break;
        }
      }
    }
    if (imgSrc || awardType) awards.push({ awardType, officeName, designer, imgSrc });
  });
  result['수상작품_목록'] = awards;

  // ── 첨부파일 추출 ──
  const attachedFiles = [];
  const fileCategorySet = new Set(['공고문', '설계지침서', '기타', '기술제안서', '도면', '설계도서', '안내문', '기타서류']);
  const fileExtRe = /\.(pdf|hwp|hwpx|xlsx|docx|pptx|jpg|png|zip)/i;

  const content6El = document.querySelector('.content_opt.content6, .content6, [class*="content6"]');
  const fileSearchRoot = content6El || document;
  const allDownloadBtns = Array.from(fileSearchRoot.querySelectorAll('button.download'));

  allDownloadBtns.forEach(btn => {
    const trEl = btn.closest('tr');
    let rowEl = trEl;
    if (!rowEl) {
      let el = btn.parentElement;
      for (let i = 0; i < 5 && el; i++) {
        if (el.querySelectorAll('button.download').length === 1) { rowEl = el; break; }
        el = el.parentElement;
      }
      if (!rowEl) rowEl = btn.parentElement;
    }

    let fileName = '';
    const candidateCells = Array.from(rowEl.querySelectorAll('td, th, span, div, p'))
      .filter(c => !c.querySelector('button'));
    for (const c of candidateCells) {
      const t = c.textContent.trim().replace(/\s+/g, ' ');
      if (fileExtRe.test(t) && !fileCategorySet.has(t)) { fileName = t; break; }
    }
    if (!fileName) {
      const m = rowEl.textContent.replace(/\s+/g, ' ').trim().match(/\S+\.(pdf|hwp|hwpx|xlsx|docx|pptx|jpg|png|zip)\b/i);
      if (m) fileName = m[0];
    }
    if (!fileName) return;

    let category = '';
    for (const c of Array.from(rowEl.querySelectorAll('td, th, span, div'))) {
      if (c.children.length === 0 && fileCategorySet.has(c.textContent.trim())) {
        category = c.textContent.trim(); break;
      }
    }
    if (!category && trEl) {
      let sib = trEl.previousElementSibling;
      for (let i = 0; i < 15 && sib && !category; i++) {
        for (const c of Array.from(sib.querySelectorAll('td, th'))) {
          if (fileCategorySet.has(c.textContent.trim())) { category = c.textContent.trim(); break; }
        }
        sib = sib.previousElementSibling;
      }
    }
    if (!category && !trEl) {
      let sib = rowEl.previousElementSibling;
      for (let i = 0; i < 15 && sib && !category; i++) {
        const t = sib.textContent.trim();
        if (fileCategorySet.has(t)) { category = t; break; }
        sib = sib.previousElementSibling;
      }
    }
    if (!category) return;

    const ext = (fileName.match(/\.([a-zA-Z0-9]+)(?:\s.*)?$/) || [])[1]?.toLowerCase() || 'pdf';
    btn.setAttribute('data-seumter-attached', _attachedFileEls.length);
    _attachedFileEls.push(btn);
    attachedFiles.push({ category, fileName, downloadUrl: '', ext });
  });

  result['_debug'] = {
    content6Found: !!content6El,
    btnDownloadCount: allDownloadBtns.length,
    attachedCount: attachedFiles.length,
  };
  result['첨부파일_목록'] = attachedFiles;

  // ── 심사결과 파일 추출 ──
  const judgeResultFiles = [];
  const resultKeywords = [
    { keys: ['투표결과', '평가점수'], label: '심사위원별투표결과' },
    { keys: ['평가사유서'], label: '심사위원별평가사유서' },
  ];

  document.querySelectorAll('a, button, [onclick], div, td, li').forEach(el => {
    const text = el.textContent.trim().replace(/\s+/g, ' ');
    if (text.length < 5 || text.length > 80) return;
    if (!text.includes('심사위원')) return;
    const textNoSpace = text.replace(/\s/g, '');

    const matched = resultKeywords.filter(({ keys }) => keys.some(k => textNoSpace.includes(k)));
    if (matched.length !== 1) return;

    const { label } = matched[0];
    if (judgeResultFiles.some(f => f.label === label)) return;

    const clickTarget = el.querySelector('a') || el;
    const href = (clickTarget.tagName === 'A' && clickTarget.href && !clickTarget.href.startsWith('javascript:'))
      ? clickTarget.href : '';
    clickTarget.setAttribute('data-seumter-judge', _judgeResultEls.length);
    _judgeResultEls.push(clickTarget);
    judgeResultFiles.push({ label, fileName: text, downloadUrl: href, ext: 'pdf' });
  });
  result['심사결과_파일_목록'] = judgeResultFiles;

  // ── 심사결과 공고 바로가기 버튼 감지 (클릭은 별도 액션에서 수행) ──
  const goBtn = Array.from(document.querySelectorAll('button, a')).find(el => {
    if (el.hasAttribute('data-seumter-judge')) return false;
    const text = el.textContent.replace(/\s+/g, '');
    return text.includes('바로가기') && (text.includes('심사결과') || text.includes('공고'));
  });
  if (goBtn) goBtn.setAttribute('data-seumter-result-notice', '1');
  result['심사결과공고_링크'] = '';
  result['_hasResultNoticeBtn'] = !!goBtn;

  result['_url'] = window.location.href;
  result['_extractedAt'] = new Date().toLocaleString('ko-KR');
  return result;
}

if (window.__seumterMsgHandler) {
  chrome.runtime.onMessage.removeListener(window.__seumterMsgHandler);
}
window.__seumterMsgHandler = (request, sender, sendResponse) => {
  if (request.action === 'extract') {
    try {
      sendResponse({ success: true, data: extractData() });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  } else if (request.action === 'clickAttached') {
    const el = _attachedFileEls[request.index];
    if (el) { el.click(); sendResponse({ success: true }); }
    else sendResponse({ success: false, error: '요소 없음' });
  } else if (request.action === 'clickJudgeResult') {
    const el = _judgeResultEls[request.index];
    if (el) { el.click(); sendResponse({ success: true }); }
    else sendResponse({ success: false, error: '요소 없음' });
  } else if (request.action === 'clickResultNotice') {
    const btn = document.querySelector('[data-seumter-result-notice]');
    if (btn) btn.click();
    sendResponse({ success: !!btn });
  }
  return true;
};
chrome.runtime.onMessage.addListener(window.__seumterMsgHandler);
