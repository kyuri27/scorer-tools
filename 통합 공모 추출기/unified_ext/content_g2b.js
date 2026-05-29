let _fileEls = [];

function extractData() {
  _fileEls = [];
  const result = {};

  // ── th/td 쌍 추출 ──
  function getCellValue(td) {
    const input = td.querySelector('input, select, textarea');
    if (input) {
      return (input.value || input.getAttribute('title') || '').trim();
    }
    return td.textContent.trim().replace(/\s+/g, ' ');
  }

  function isLabelCell(el) {
    if (el.tagName === 'TH') return true;
    const cls = (el.className || '').toLowerCase();
    return /\b(th|label|tit|title|head|key)\b/.test(cls);
  }

  const allResults = {};

  document.querySelectorAll('table').forEach(table => {
    const ths = Array.from(table.querySelectorAll('th')).map(t => t.textContent.trim());
    if (ths.some(t => t.includes('파일명') || t.includes('파일크기'))) return;

    Array.from(table.querySelectorAll('tr')).forEach(tr => {
      const cells = Array.from(tr.children);
      for (let i = 0; i < cells.length - 1; i++) {
        const labelEl = cells[i];
        if (!isLabelCell(labelEl)) continue;

        let j = i + 1;
        while (j < cells.length && isLabelCell(cells[j])) j++;
        if (j >= cells.length) continue;

        const key = labelEl.textContent.trim().replace(/\s+/g, ' ');
        if (!key || key.length > 30) continue;

        const val = getCellValue(cells[j]);
        if (!val) continue;

        if (!(key in allResults)) allResults[key] = val;
      }
    });
  });

  Object.assign(result, allResults);

  // ── 공고명 보정 ──
  if (!result['공고명'] || result['공고명'].length > 60) {
    const captions = Array.from(document.querySelectorAll('caption'));
    for (const cap of captions) {
      const t = cap.textContent.trim();
      if (t.includes('건축설계') || t.includes('용역') || t.includes('공모')) {
        result['공고명'] = t;
        break;
      }
    }
  }

  // ── 입찰진행정보 테이블 파싱 ──
  const schedule = {};
  document.querySelectorAll('table').forEach(table => {
    const allTrs = Array.from(table.querySelectorAll('tr'));
    if (allTrs.length === 0) return;

    let headerRow = null;
    for (const tr of allTrs) {
      const cells = Array.from(tr.querySelectorAll('th, td'));
      if (cells.some(c => c.textContent.trim() === '진행명')) {
        headerRow = tr; break;
      }
    }
    if (!headerRow) return;

    const headers = Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim());
    const nameIdx  = headers.findIndex(h => h === '진행명');
    const startIdx = headers.findIndex(h => h.includes('시작일시'));
    const endIdx   = headers.findIndex(h => h.includes('종료일시'));
    const placeIdx = headers.findIndex(h => h.includes('장소'));

    const headerIdx = allTrs.indexOf(headerRow);
    allTrs.slice(headerIdx + 1).forEach(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length <= nameIdx) return;
      const name  = tds[nameIdx]?.textContent.trim().replace(/\s+/g, ' ') || '';
      const start = startIdx >= 0 ? tds[startIdx]?.textContent.trim().replace(/\s+/g, ' ') || '' : '';
      const end   = endIdx   >= 0 ? tds[endIdx]?.textContent.trim().replace(/\s+/g, ' ')   || '' : '';
      const place = placeIdx >= 0 ? tds[placeIdx]?.textContent.trim().replace(/\s+/g, ' ') || '' : '';

      if (name.includes('참가신청') || name.includes('참가등록')) {
        schedule['참가등록마감'] = end || start;
      } else if (name.includes('평가') && !name.includes('제출')) {
        if (start) schedule['평가일시'] = start;
        if (place) schedule['평가장소'] = place;
      } else if (name.includes('평가제출') || (name.includes('평가') && name.includes('제출'))) {
        if (end)   schedule['평가제출마감'] = end;
        if (place) schedule['평가제출장소'] = place;
      }
    });
  });
  result['일정_정보'] = schedule;

  // ── 파일첨부 섹션 추출 ──
  const attachedFiles = [];
  const FILE_EXT_RE = /\.(pdf|hwp|hwpx|xlsx|xls|docx|doc|pptx|ppt|zip|alz|egg|png|jpg)(\b|$)/i;
  const diagnostics = { strategy: null, scwinKeys: [], shadowRoots: 0, nobrCount: 0 };

  function queryShadowAll(selector, root) {
    const results = [];
    const traverse = (node) => {
      try {
        for (const el of node.querySelectorAll(selector)) results.push(el);
        for (const el of node.querySelectorAll('*')) {
          if (el.shadowRoot) {
            diagnostics.shadowRoots++;
            traverse(el.shadowRoot);
          }
        }
      } catch(e) {}
    };
    traverse(root || document);
    return results;
  }

  // 전략 0: WebSquare scwin 객체에서 그리드 데이터 직접 읽기
  (function tryWebSquare() {
    try {
      const scwin = window.scwin || {};
      const allKeys = Object.keys(scwin);
      diagnostics.scwinKeys = allKeys.slice(0, 30);

      const gridCandidates = [];
      for (const key of allKeys) {
        const obj = scwin[key];
        if (!obj || typeof obj !== 'object') continue;
        if (typeof obj.getRowCount === 'function' ||
            typeof obj.getDataList === 'function' ||
            typeof obj.getList === 'function' ||
            typeof obj.getColumnValue === 'function' ||
            typeof obj.getCellData === 'function') {
          gridCandidates.push({ key, obj });
        }
      }

      const ids = ['grdFile', 'grdFileList', 'gridFile', 'grdAtchFile', 'grdAtchFileList',
                   'grd_file', 'grdAtchFileInfo', 'grdNtceFileInfo'];
      for (const id of ids) {
        let g = null;
        try { g = window.w2?.getObject?.(id) || window.w2?.getObjectById?.(id) || null; } catch(e) {}
        if (g && !gridCandidates.find(c => c.key === id)) gridCandidates.push({ key: id, obj: g });
      }

      for (const { key, obj } of gridCandidates) {
        const rows = (typeof obj.getDataList === 'function' && obj.getDataList()) ||
                     (typeof obj.getList === 'function' && obj.getList()) ||
                     (Array.isArray(obj.data) && obj.data) || [];
        if (Array.isArray(rows) && rows.length > 0) {
          rows.forEach(row => {
            const fileName = row['orgnAtchFileNm'] || row['atchFileNm'] || row['fileNm'] ||
                             row['orignFileNm']    || row['origFileNm'] || row['fileName'] || '';
            const category = row['atchFileDscr']   || row['fileDscr']  || row['fileType']  ||
                             row['ntceFileCn']     || row['fileSe']    || '';
            if (fileName) attachedFiles.push({ category, fileName });
          });
          if (attachedFiles.length > 0) { diagnostics.strategy = 'websquare_datalist_' + key; return; }
        }

        const rowCount = typeof obj.getRowCount === 'function' ? (obj.getRowCount() || 0) : 0;
        if (rowCount > 0) {
          for (let i = 0; i < rowCount; i++) {
            const getVal = (col) => {
              try {
                if (typeof obj.getColumnValue === 'function') return obj.getColumnValue(i, col) || '';
                if (typeof obj.getCellData    === 'function') return obj.getCellData(i, col)    || '';
                if (typeof obj.getValue       === 'function') return obj.getValue(i, col)       || '';
              } catch(e) {}
              return '';
            };
            const fileName = getVal('orgnAtchFileNm') || getVal('atchFileNm') || getVal('fileNm') ||
                             getVal('orignFileNm')    || getVal('origFileNm') || getVal('fileName');
            const category = getVal('atchFileDscr')   || getVal('fileDscr')  || getVal('fileType') ||
                             getVal('ntceFileCn')     || getVal('fileSe');
            if (fileName) attachedFiles.push({ category, fileName });
          }
          if (attachedFiles.length > 0) { diagnostics.strategy = 'websquare_rowcol_' + key; return; }
        }
      }
    } catch(e) { diagnostics.scwinError = e.message; }
  })();

  // 전략 1: Shadow DOM 포함 DOM 전체에서 파일 확장자를 가진 요소 탐색
  if (attachedFiles.length === 0) {
    const seen = new Set();

    let fileSection = null;
    const allEls = Array.from(document.querySelectorAll('*'));
    for (const el of allEls) {
      if (el.children.length === 0 && /^파일\s*첨부/.test(el.textContent.trim())) {
        let p = el.parentElement;
        for (let i = 0; i < 20 && p; i++) {
          const txt = p.textContent;
          if (FILE_EXT_RE.test(txt)) { fileSection = p; break; }
          p = p.parentElement;
        }
        if (fileSection) break;
      }
    }
    const searchRoot = fileSection || document;

    const candidates = queryShadowAll('nobr, span, input[type="text"][readonly]', searchRoot);
    diagnostics.nobrCount = queryShadowAll('nobr', searchRoot).length;

    for (const el of candidates) {
      const text = (el.value || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!FILE_EXT_RE.test(text) || seen.has(text)) continue;
      if (text.length > 200) continue;
      seen.add(text);

      let category = '';
      let tr = null;
      try { tr = el.closest('tr'); } catch(e) {}
      if (!tr) {
        let p = el.parentElement;
        while (p) { if (p.tagName === 'TR') { tr = p; break; } p = p.parentElement; }
      }
      if (tr) {
        const tds = Array.from(tr.querySelectorAll('td, th'));
        for (const td of tds) {
          if (td.contains(el)) continue;
          const t = (td.value || td.textContent || '').trim().replace(/\s+/g, ' ');
          if (t && !FILE_EXT_RE.test(t) && t.length < 40 &&
              !['선택', '파일', '파일명', '파일크기', '구분', '번호', '순번', 'No', '다운로드'].includes(t)) {
            category = t; break;
          }
        }
      }
      attachedFiles.push({ category, fileName: text });
    }
    if (attachedFiles.length > 0) diagnostics.strategy = 'dom_shadow';
  }

  // 전략 2: <a> 링크에 파일 확장자
  if (attachedFiles.length === 0) {
    const seen = new Set();
    document.querySelectorAll('a').forEach(a => {
      const text = a.textContent.trim().replace(/\s+/g, ' ');
      if (!FILE_EXT_RE.test(text) || seen.has(text)) return;
      if (a.closest('nav, header, footer')) return;
      seen.add(text);
      let category = '';
      const tr = a.closest('tr');
      if (tr) {
        const tds = Array.from(tr.querySelectorAll('td, th'));
        const aIdx = tds.findIndex(td => td.contains(a));
        for (let i = aIdx - 1; i >= 0; i--) {
          const t = tds[i].textContent.trim();
          if (t && !FILE_EXT_RE.test(t)) { category = t; break; }
        }
      }
      a.setAttribute('data-g2b-file', _fileEls.length);
      _fileEls.push(a);
      attachedFiles.push({ category, fileName: text });
    });
    if (attachedFiles.length > 0) diagnostics.strategy = 'anchor';
  }

  // 전체 다운로드 버튼 마킹
  const dlBtn = document.querySelector('input[class*="grid_file_down"]')
    || Array.from(document.querySelectorAll('input[type="button"]'))
        .find(el => (el.value || '').replace(/\s/g,'').includes('다운로드') && el.closest('[id*="File"],[id*="file"],[id*="grd"]'));
  if (dlBtn) dlBtn.setAttribute('data-g2b-download-all', '1');

  result['첨부파일_목록'] = attachedFiles;
  result['_diagnostics'] = diagnostics;
  result['_url'] = window.location.href;
  result['_extractedAt'] = new Date().toLocaleString('ko-KR');
  return result;
}

if (window.__g2bMsgHandler) {
  chrome.runtime.onMessage.removeListener(window.__g2bMsgHandler);
}
window.__g2bMsgHandler = (request, sender, sendResponse) => {
  if (request.action === 'extract') {
    try {
      sendResponse({ success: true, data: extractData() });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  } else if (request.action === 'clickFile') {
    const el = _fileEls[request.index];
    if (el) { el.click(); sendResponse({ success: true }); }
    else sendResponse({ success: false, error: '요소 없음' });
  }
  return true;
};
chrome.runtime.onMessage.addListener(window.__g2bMsgHandler);
