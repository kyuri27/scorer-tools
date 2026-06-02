const AUTHOR     = '김규리';
const CREATED    = '2026.05';
const BUILD_DATE = '2026.05.27';

let extractedData = null;
let cachedUrl = null;

// 나라장터 공고명에 시스템이 붙이는 주석 괄호 제거
// 예: (긴급공고)(최종 공고가 아닙니다.)(변경공고)(재공고) 등
function stripG2BAnnotations(name) {
  if (!name) return '';
  return name
    .replace(/\(긴급공고\)/g, '')
    .replace(/\(최종\s*공고가\s*아닙니다\.?\)/g, '')
    .replace(/\(변경공고\)/g, '')
    .replace(/\(재공고\)/g, '')
    .replace(/\(취소공고\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 공모명 정제: 세움터 정리도구와 동일한 규칙 적용
function cleanCompetitionName(raw) {
  if (!raw) return '';
  const kwAll = ['리모델링', '대수선', '용도변경', '재건축', '증축', '개축', '재축', '이전', '철거', '신축'];
  const found = [];
  let name = raw;
  for (const kw of kwAll) {
    if (name.includes(kw)) {
      found.push(kw);
      name = name.replace(new RegExp(kw + '(?:사업|공사)?', 'g'), ' ');
    }
  }
  name = name.replace(/(건축설계용역|설계용역|건축설계공모|설계공모|제안공모|공모|건립사업|사업|건립)$/, '');
  name = name.replace(/\s+/g, ' ').trim().replace(/[\s·,]+$/, '').trim();
  const extras = found.filter(k => k !== '신축');
  if (extras.length > 0) name += `(${extras.join(', ')})`;
  return name;
}

// 나라장터 th/td에서 특정 키를 우선순위대로 가져오기
function pick(data, ...keys) {
  for (const k of keys) {
    if (data[k] && data[k].trim()) return data[k].trim();
  }
  return '';
}

// 금액 문자열에서 숫자만 추출 (쉼표·원 제거)
function parseAmount(str) {
  if (!str) return '';
  return str.replace(/[^\d]/g, '');
}

async function init() {
  document.getElementById('buildDate').textContent = BUILD_DATE;
  document.getElementById('authorInfo').textContent = `${AUTHOR} · ${CREATED}`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const main = document.getElementById('main');

  if (!tab.url || !tab.url.includes('g2b.go.kr')) {
    main.innerHTML = `
      <div class="not-g2b">
        <div class="icon">🏛️</div>
        <div><b>나라장터 공고 페이지</b>에서 실행해 주세요</div>
        <div style="font-size:11px; margin-top:6px; color:#9ca3af;">g2b.go.kr 주소에서만 작동합니다</div>
      </div>`;
    return;
  }

  main.innerHTML = `
    <button id="extractBtn">🔍 공고 정보 추출</button>
    <div id="status"></div>
    <div id="result"></div>`;
  document.getElementById('extractBtn').addEventListener('click', extract);

  // 캐시 복원
  const stored = await chrome.storage.session.get(['g2b_extractedData', 'g2b_cachedUrl']);
  if (stored.g2b_cachedUrl === tab.url && stored.g2b_extractedData) {
    extractedData = stored.g2b_extractedData;
    cachedUrl = stored.g2b_cachedUrl;
    renderResult(extractedData);
    document.getElementById('status').innerHTML = `
      <div class="status success" style="display:flex; justify-content:space-between; align-items:center;">
        <span>✅ 이전 추출 결과 (URL 동일)</span>
        <button onclick="clearCache()" style="width:auto; padding:2px 8px; font-size:11px; background:#6b7280;">초기화</button>
      </div>`;
  }
}

async function clearCache() {
  await chrome.storage.session.remove(['g2b_extractedData', 'g2b_cachedUrl']);
  extractedData = null;
  cachedUrl = null;
  document.getElementById('result').innerHTML = '';
  document.getElementById('status').innerHTML =
    '<div class="status success">🗑 캐시 초기화됨. 다시 추출하세요.</div>';
}

async function extract() {
  const btn = document.getElementById('extractBtn');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 추출 중...';
  statusEl.innerHTML = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 모든 프레임에 content.js 주입
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    // 주입 후 리스너 등록 대기
    await new Promise(r => setTimeout(r, 300));

    // 전체 프레임 목록 가져오기
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    statusEl.innerHTML = `<div class="status success">🔍 프레임 ${frames.length}개 탐색 중...</div>`;

    // 각 프레임에서 데이터 수집
    const results = await Promise.allSettled(
      frames.map(f =>
        new Promise(resolve => {
          chrome.tabs.sendMessage(tab.id, { action: 'extract' }, { frameId: f.frameId }, resp => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(resp);
          });
        })
      )
    );

    // 진단: 각 프레임에서 무엇을 찾았는지 로그
    const diagLines = results.map((r, i) => {
      const data = r.value?.data;
      const fileCount = data?.['첨부파일_목록']?.length ?? 0;
      const diag = data?.['_diagnostics'];
      const diagStr = diag
        ? ` shadow:${diag.shadowRoots} nobr:${diag.nobrCount} scwin:[${(diag.scwinKeys||[]).slice(0,3).join(',')}]`
        : '';
      const url = frames[i]?.url?.slice(0, 60) ?? '?';
      return `[${frames[i]?.frameId}] files:${fileCount}${diagStr} ${r.status} ${url}`;
    });
    console.log('[G2B 추출 진단]\n' + diagLines.join('\n'));

    // 프레임별 결과 병합
    let merged = {};
    let fileData = [];

    for (const r of results) {
      const data = r.value?.data;
      if (!data) continue;
      const files = data['첨부파일_목록'] || [];
      if (files.length > 0 && fileData.length === 0) fileData = files;
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('_') || k === '첨부파일_목록' || k === '일정_정보') continue;
        if (v && !merged[k]) merged[k] = v;
      }
      if (!merged['일정_정보'] || Object.keys(merged['일정_정보']).length === 0) {
        if (data['일정_정보'] && Object.keys(data['일정_정보']).length > 0)
          merged['일정_정보'] = data['일정_정보'];
      }
    }

    merged['첨부파일_목록'] = fileData;
    merged['_url'] = tab.url;
    merged['_diagFrames'] = diagLines;
    merged['_allDiagnostics'] = results.map(r => r.value?.data?.['_diagnostics'] || null);

    if (Object.keys(merged).length === 0) throw new Error('데이터를 찾을 수 없습니다');

    extractedData = merged;
    cachedUrl = tab.url;
    await chrome.storage.session.set({ g2b_extractedData: extractedData, g2b_cachedUrl: tab.url });
    renderResult(extractedData);
    statusEl.innerHTML = '<div class="status success">✅ 추출 완료!</div>';
  } catch (e) {
    statusEl.innerHTML = `<div class="status error">❌ 오류: ${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🔍 공고 정보 추출';
  }
}

function renderResult(data) {
  document.getElementById('extractBtn').innerHTML = '🔄 다시 추출';
  document.getElementById('extractBtn').disabled = false;

  const d = data;
  const schedule = d['일정_정보'] || {};

  // 공고기관: 담당자정보 섹션의 th '공고기관' 값
  const agency       = pick(d, '공고기관');
  const noticeName   = stripG2BAnnotations(pick(d, '공고명'));
  const noticeNo     = pick(d, '입찰공고번호');
  const location     = pick(d, '공사현장');
  const designCost   = pick(d, '설계비');
  const totalCost    = pick(d, '사업금액 (추정가격 + 부가가치세)', '사업금액');
  const estCost      = pick(d, '추정가격');
  const noticeDate   = pick(d, '게시일시');
  const regDeadline  = pick(d, '참가등록마감일시') || schedule['참가등록마감'] || '';
  const manager      = pick(d, '공고담당자');
  const evalMethod   = pick(d, '심사방식');
  const evalDate     = schedule['평가일시'] || '';
  const evalPlace    = schedule['평가장소'] || pick(d, '평가장소');
  const attachedFiles = d['첨부파일_목록'] || [];

  let html = '<div class="result-section">';

  html += '<h3>📋 공고 개요</h3>';
  if (noticeName)    html += field('공고명', noticeName);
  if (noticeNo)      html += field('공고번호', noticeNo);
  if (agency)        html += field('공고기관', agency);
  if (location)      html += field('위치', location);
  if (designCost)    html += field('설계비', `<b style="color:#059669;">${designCost}</b>`);
  if (totalCost && totalCost !== designCost) html += field('사업금액', totalCost);
  if (estCost)       html += field('추정가격', estCost);

  html += '<h3 style="margin-top:10px;">📅 일정</h3>';
  if (noticeDate)    html += field('공고일시', noticeDate);
  if (regDeadline)   html += field('참가등록마감', `<b style="color:#dc2626;">${regDeadline}</b>`);
  if (evalDate)      html += field('평가일시', evalDate);
  if (evalPlace)     html += field('평가장소', evalPlace);
  if (evalMethod)    html += field('심사방식', evalMethod);
  if (manager)       html += field('담당자', manager);

  if (attachedFiles.length > 0) {
    html += '<h3 style="margin-top:10px;">📎 첨부파일</h3>';
    attachedFiles.forEach(f => {
      html += `<div class="file-item">
        <div class="file-cat">${f.category || '파일'}</div>
        <div class="file-name">${f.fileName}</div>
      </div>`;
    });
  } else {
    // 진단 정보 표시
    const diagFrames = (d['_diagFrames'] || []).join('\n');
    // 프레임별 _diagnostics 수집
    const diagDetails = (d['_allDiagnostics'] || []).map((diag, i) => {
      if (!diag) return '';
      const parts = [];
      if (diag.strategy) parts.push(`전략: ${diag.strategy}`);
      if (diag.shadowRoots > 0) parts.push(`shadowRoots: ${diag.shadowRoots}`);
      if (diag.nobrCount !== undefined) parts.push(`nobr: ${diag.nobrCount}`);
      if (diag.scwinKeys?.length > 0) parts.push(`scwin: [${diag.scwinKeys.slice(0,5).join(',')}...]`);
      if (diag.scwinError) parts.push(`err: ${diag.scwinError}`);
      return parts.length ? `  프레임${i}: ${parts.join(' | ')}` : '';
    }).filter(Boolean).join('\n');

    html += `<div class="field" style="margin-top:10px;">
      <div class="key">📎 첨부파일 (미감지)</div>
      <div class="val" style="font-size:10px; color:#9ca3af; white-space:pre-wrap;">${diagFrames}${diagDetails ? '\n' + diagDetails : ''}</div>
    </div>`;
  }

  html += '</div>';

  // 버튼 영역
  if (attachedFiles.length > 0) {
    html += `<div class="actions" style="margin-top:8px;">
      <button class="blue" id="downloadAttachedBtn">📦 첨부파일 ZIP 다운로드</button>
    </div>`;
  }

  html += `<div class="actions" style="margin-top:6px;">
    <button id="copyToolBtn">🔗 정리도구용 복사</button>
  </div>`;

  document.getElementById('result').innerHTML = html;

  if (attachedFiles.length > 0) {
    // onclick 사용: addEventListener 누적으로 인한 중복 실행 방지
    document.getElementById('downloadAttachedBtn').onclick = () => downloadAllAttached(data);
  }
  document.getElementById('copyToolBtn').onclick = copyForTool;
}

function field(key, val) {
  return `<div class="field"><div class="key">${key}</div><div class="val">${val}</div></div>`;
}

async function copyForTool() {
  if (!extractedData) return;
  const btn = document.getElementById('copyToolBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 준비 중...';

  const d = extractedData;
  const schedule = d['일정_정보'] || {};
  const noticeName = stripG2BAnnotations(pick(d, '공고명'));
  const cleanName  = cleanCompetitionName(noticeName);

  // 날짜 정규화: "2026/05/11 18:09:11" → "2026-05-11"
  function normalizeDate(str) {
    if (!str) return '';
    const m = str.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : str;
  }

  const toolData = {
    competitionName:  cleanName,
    buildType:        '',
    noticeNo:         pick(d, '입찰공고번호'),
    agency:           pick(d, '공고기관'),
    location:         pick(d, '공사현장'),
    scale:            '',
    budget:           parseAmount(pick(d, '설계비')),
    constructionCost: '',
    designCost:       parseAmount(pick(d, '설계비')),
    contactOrg:       pick(d, '공고기관'),
    contactName:      pick(d, '공고담당자').replace(/\s*\(.*\)/, '').trim(),
    noticeDate:       normalizeDate(pick(d, '게시일시')),
    announceDate:     '',
    chairperson:      '',
    judges_planned:   [],
    judges_attended:  [],
    awards:           [],
    files:            [],
    // 나라장터 전용 추가 필드
    _source:          'narajangter',
    _regDeadline:     pick(d, '참가등록마감일시') || schedule['참가등록마감'] || '',
    _evalDate:        schedule['평가일시'] || '',
    _evalPlace:       schedule['평가장소'] || pick(d, '평가장소') || '',
    _estimatedCost:   parseAmount(pick(d, '추정가격')),
  };

  navigator.clipboard.writeText(JSON.stringify(toolData))
    .then(() => showToast('✅ 정리도구용 JSON 복사됨!'))
    .catch(() => showToast('❌ 클립보드 복사 실패'));

  btn.disabled = false;
  btn.innerHTML = '🔗 정리도구용 복사';
}

// ── 파일 캡처: 나라장터는 form.submit() 방식이 주 경로 ──
// 우선순위: form.submit → XHR → fetch → blob → window.open → location.href
async function captureFileFromPage(tabId, idx) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (idx) => {
      const link = document.querySelector(`[data-g2b-file="${idx}"]`);
      if (!link) return { _dbg: `link_not_found_${idx}` };

      // 직접 href가 있으면 바로 fetch
      const directHref = link.tagName === 'A' && link.href &&
        !link.href.startsWith('javascript:') && !link.href.startsWith('blob:') &&
        !link.href.startsWith('#') && link.href !== location.href;
      if (directHref) {
        try {
          const resp = await fetch(link.href, { credentials: 'include' });
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'direct_href' };
          }
        } catch (e) {}
      }

      let xhrUrl = null, xhrDataPromise = null, xhrCaptured = false;
      let fetchDataPromise = null, fetchCaptured = false;
      let windowOpenUrl = null, locationUrl = null;
      let blobPromise = null, blobCaptured = false;
      // 나라장터 전용: form.submit() 가로채기
      let formUrl = null, formBody = null, formMethod = 'GET';

      const origOpen       = XMLHttpRequest.prototype.open;
      const origSend       = XMLHttpRequest.prototype.send;
      const origFetch      = window.fetch;
      const origCOU        = URL.createObjectURL;
      const origAClick     = HTMLAnchorElement.prototype.click;
      const origWindowOpen = window.open;
      const origSubmit     = HTMLFormElement.prototype.submit;

      const isFileCt = c => c.includes('octet-stream') || c.includes('/pdf') ||
        c.includes('officedocument') || c.includes('hwp') || c.includes('zip');
      const isFileCd = d => d.includes('attachment') || d.includes('filename');
      const anyCaptured = () =>
        blobCaptured || xhrCaptured || fetchCaptured ||
        windowOpenUrl || locationUrl || formUrl;

      // ① form.submit() 가로채기 (나라장터 fn_egov_downFile 주 경로)
      HTMLFormElement.prototype.submit = function() {
        if (formUrl) return; // 이미 캡처됨
        const method = (this.method || 'GET').toUpperCase();
        const action = this.action || location.href;
        const fd = new FormData(this);
        formMethod = method;
        if (method === 'POST') {
          formUrl  = action;
          formBody = fd;
        } else {
          const params = new URLSearchParams(fd).toString();
          formUrl = action + (params ? '?' + params : '');
        }
      };

      // ② XHR 가로채기
      XMLHttpRequest.prototype.open = function(m, url, ...r) {
        this.__u = String(url);
        return origOpen.call(this, m, url, ...r);
      };
      XMLHttpRequest.prototype.send = function(b) {
        this.addEventListener('load', function() {
          if (xhrCaptured) return;
          const d = (this.getResponseHeader('content-disposition') || '').toLowerCase();
          const c = (this.getResponseHeader('content-type') || '').toLowerCase();
          if (isFileCd(d) || isFileCt(c)) {
            xhrCaptured = true;
            if (this.response instanceof ArrayBuffer && this.response.byteLength > 0) {
              xhrDataPromise = Promise.resolve(new Uint8Array(this.response));
            } else if (this.response instanceof Blob && this.response.size > 0) {
              xhrDataPromise = new Promise(res => {
                const fr = new FileReader();
                fr.onload = () => res(new Uint8Array(fr.result));
                fr.onerror = () => res(null);
                fr.readAsArrayBuffer(this.response);
              });
            } else {
              xhrUrl = this.__u; xhrCaptured = false;
            }
          }
        });
        return origSend.call(this, b);
      };

      // ③ fetch() 가로채기
      window.fetch = async function(url, options) {
        const resp = await origFetch.call(this, url, options);
        if (!fetchCaptured) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          const cd = (resp.headers.get('content-disposition') || '').toLowerCase();
          if (isFileCd(cd) || isFileCt(ct)) {
            fetchCaptured = true;
            fetchDataPromise = resp.clone().arrayBuffer().then(buf => new Uint8Array(buf));
          }
        }
        return resp;
      };

      // ④ blob URL 가로채기
      URL.createObjectURL = function(blob) {
        const url = origCOU.call(URL, blob);
        if (!blobPromise && blob.size > 500) {
          blobCaptured = true;
          blobPromise = new Promise(res => {
            const fr = new FileReader();
            fr.onload = () => res(new Uint8Array(fr.result));
            fr.onerror = () => res(null);
            fr.readAsArrayBuffer(blob);
          });
        }
        return url;
      };

      // ⑤ <a>.click() 가로채기 — href가 있으면 URL 캡처 후 native 클릭 억제
      HTMLAnchorElement.prototype.click = function() {
        if (anyCaptured()) return;
        const href = this.href;
        if (href && !href.startsWith('javascript:') && !href.startsWith('#') &&
            !href.startsWith('blob:') && href !== location.href) {
          if (!windowOpenUrl) windowOpenUrl = href;
          return; // native 클릭 억제, re-fetch 경로로 처리
        }
        origAClick.call(this);
      };

      // ⑥ window.open 가로채기
      window.open = function(url, ...args) {
        if (url && url !== 'about:blank' && url !== '') {
          windowOpenUrl = String(url); return null;
        }
        return origWindowOpen.call(window, url, ...args);
      };

      // ⑦ location.href 가로채기
      let origHrefDesc = null;
      try {
        origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (origHrefDesc?.configurable) {
          Object.defineProperty(Location.prototype, 'href', {
            ...origHrefDesc,
            set(url) {
              const s = String(url);
              if (!locationUrl && s !== location.href && (s.startsWith('http') || s.startsWith('/'))) {
                locationUrl = s; return;
              }
              origHrefDesc.set.call(this, url);
            },
            configurable: true,
          });
        }
      } catch(e) {}
      location.assign  = function(url) { if (!locationUrl) locationUrl = String(url); };
      location.replace = function(url) { if (!locationUrl) locationUrl = String(url); };

      link.click();
      // 최대 4초 대기
      for (let t = 0; t < 40; t++) {
        await new Promise(r => setTimeout(r, 100));
        if (anyCaptured() || xhrUrl) break;
      }
      if (blobCaptured || xhrDataPromise || fetchDataPromise) await new Promise(r => setTimeout(r, 200));

      // 후처리 복원
      HTMLFormElement.prototype.submit = origSubmit;
      XMLHttpRequest.prototype.open    = origOpen;
      XMLHttpRequest.prototype.send    = origSend;
      window.fetch                     = origFetch;
      URL.createObjectURL              = origCOU;
      HTMLAnchorElement.prototype.click = origAClick;
      window.open                      = origWindowOpen;
      try { if (origHrefDesc) Object.defineProperty(Location.prototype, 'href', origHrefDesc); } catch(e) {}

      // 결과 반환 (우선순위: blob > xhr body > fetch body > form/url re-fetch)
      if (blobPromise) {
        const bytes = await blobPromise;
        if (bytes?.length > 0) return { data: Array.from(bytes), _dbg: 'blob' };
      }
      if (xhrDataPromise) {
        const bytes = await xhrDataPromise;
        if (bytes?.length > 0) return { data: Array.from(bytes), _dbg: 'xhr_body' };
      }
      if (fetchDataPromise) {
        const bytes = await fetchDataPromise;
        if (bytes?.length > 0) return { data: Array.from(bytes), _dbg: 'fetch_body' };
      }

      // form.submit() 캡처 → re-fetch
      if (formUrl) {
        try {
          const fetchOpts = { credentials: 'include', method: formMethod };
          if (formMethod === 'POST' && formBody) fetchOpts.body = formBody;
          const resp = await origFetch.call(window, formUrl, fetchOpts);
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'form_submit' };
          }
        } catch(e) {}
      }

      // 기타 URL re-fetch
      for (const url of [locationUrl, windowOpenUrl, xhrUrl].filter(Boolean)) {
        try {
          const fullUrl = new URL(url, location.origin).href;
          const resp = await origFetch.call(window, fullUrl, { credentials: 'include' });
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'refetch' };
          }
        } catch(e) {}
      }
      return { _dbg: 'nothing_captured' };
    },
    args: [idx],
  });
  return result?.result ?? { _dbg: 'script_null' };
}

async function downloadAllAttached(data) {
  const files = data['첨부파일_목록'] || [];
  if (files.length === 0) return;

  const noticeName = stripG2BAnnotations(pick(data, '공고명'));
  const cleanName  = cleanCompetitionName(noticeName);
  const noticeDate = pick(data, '게시일시');
  const yymmdd = (() => {
    const m = noticeDate.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m ? `${m[1].slice(2)}${m[2].padStart(2,'0')}${m[3].padStart(2,'0')}` : '';
  })();
  const zipName = `첨부파일_${cleanName}${yymmdd ? '_' + yymmdd : ''}.zip`;

  const btn = document.getElementById('downloadAttachedBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 수집 중...';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 다운로드 목록 기록 + 네이티브 감지 리스너 미리 등록
  const beforeDownloads = await new Promise(r => chrome.downloads.search({ orderBy: ['-startTime'], limit: 10 }, r));
  const beforeIds = new Set(beforeDownloads.map(d => d.id));
  let messageShown = false;

  // 네이티브 다운로드 감지 시 즉시 UI 업데이트 (captureBulkDownload 완료를 기다리지 않음)
  const finishWithNative = async (item) => {
    if (messageShown) return;
    messageShown = true;
    await new Promise(r => setTimeout(r, 700));
    const [updated] = await new Promise(r => chrome.downloads.search({ id: item.id }, r));
    const d = updated || item;
    const name = d.filename?.split('/').pop()?.split('\\').pop()
      || (d.url ? decodeURIComponent(d.url.split('/').pop().split('?')[0]) : '')
      || '파일';
    showPersistentStatus(`✅ 다운로드 완료 (브라우저 기본 저장)\n${name}`);
    btn.disabled = false;
    btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
  };

  const nativeDownloadPromise = new Promise(resolve => {
    const onCreated = (item) => {
      if (!beforeIds.has(item.id)) {
        chrome.downloads.onCreated.removeListener(onCreated);
        resolve(item);
      }
    };
    chrome.downloads.onCreated.addListener(onCreated);
    setTimeout(() => { chrome.downloads.onCreated.removeListener(onCreated); resolve(null); }, 10000);
  });
  // 감지되는 즉시 처리 (병렬 - captureBulkDownload를 기다리지 않음)
  nativeDownloadPromise.then(item => { if (item) finishWithNative(item); });

  // 바이트 캡처 시도 (병렬로 실행)
  const captured = await captureBulkDownload(tab.id);

  if (messageShown) return; // 네이티브 경로로 이미 처리 완료

  if (captured?.data?.length > 0) {
    messageShown = true; // downloadZipBundle의 blob 다운로드를 네이티브로 오인 방지
    const bytes = new Uint8Array(captured.data);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
    try {
      if (isZip && files.length > 1) {
        const innerFiles = await parseZip(bytes);
        if (innerFiles.length > 0) {
          await downloadZipBundle(innerFiles, zipName);
          showPersistentStatus(`✅ ZIP ${innerFiles.length}개 완료`);
        } else {
          await downloadZipBundle([{ name: zipName, data: bytes }], zipName);
          showPersistentStatus('✅ ZIP 다운로드 완료 (원본)');
        }
      } else {
        const fileName = captured.fileName || files[0]?.fileName || '첨부파일';
        await downloadZipBundle([{ name: fileName, data: bytes }], zipName);
        showPersistentStatus('✅ 파일 다운로드 완료');
      }
    } catch(e) {
      await downloadZipBundle([{ name: zipName, data: bytes }], zipName);
      showPersistentStatus('✅ ZIP 다운로드 완료 (원본)');
    }
    btn.disabled = false;
    btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
  } else {
    // 아직 네이티브 감지 중이면 최대 2초 더 대기
    await Promise.race([nativeDownloadPromise, new Promise(r => setTimeout(r, 2000))]);
    if (!messageShown) {
      showPersistentStatus(`⚠️ 캡처 실패 (${captured?._dbg || '?'})\n페이지의 다운로드 버튼을 직접 눌러주세요.`);
      btn.disabled = false;
      btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
    }
  }
}

// 나라장터 전체 다운로드 버튼 클릭 → 응답 캡처 (전체 프레임 대상)
async function captureBulkDownload(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  // 파일 다운로드 버튼이 있는 프레임 탐색
  let targetFrameId = 0;
  for (const f of frames) {
    const [chk] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [f.frameId] },
      world: 'MAIN',
      func: () => !!document.querySelector('[data-g2b-download-all], input[class*="grid_file_down"]'),
    }).catch(() => [{ result: false }]);
    if (chk?.result) { targetFrameId = f.frameId; break; }
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [targetFrameId] },
    world: 'MAIN',
    func: async () => {
      const btn =
        document.querySelector('[data-g2b-download-all]') ||
        document.querySelector('input[class*="grid_file_down"]') ||
        Array.from(document.querySelectorAll('input[type="button"]'))
          .find(el => el.value?.includes('다운로드') && el.closest('[id*="grdFile"], [id*="file"], [id*="File"]'));
      if (!btn) return { _dbg: 'bulk_btn_not_found' };

      let formUrl = null, formBody = null, formMethod = 'GET';
      let xhrUrl = null, xhrDataPromise = null, xhrCaptured = false;
      let fetchDataPromise = null, fetchCaptured = false;
      let blobPromise = null, blobCaptured = false;
      let windowOpenUrl = null, locationUrl = null;
      let capturedFileName = null;

      const origOpen       = XMLHttpRequest.prototype.open;
      const origSend       = XMLHttpRequest.prototype.send;
      const origFetch      = window.fetch;
      const origCOU        = URL.createObjectURL;
      const origAClick     = HTMLAnchorElement.prototype.click;
      const origWindowOpen = window.open;
      const origSubmit     = HTMLFormElement.prototype.submit;

      const isFileCt = c =>
        c.includes('octet-stream') || c.includes('/pdf') || c.includes('officedocument') ||
        c.includes('hwp') || c.includes('zip') || c.includes('x-download');
      const isFileCd = d => d.includes('attachment') || d.includes('filename');
      const anyCaptured = () =>
        blobCaptured || xhrCaptured || fetchCaptured || windowOpenUrl || locationUrl || formUrl;

      // form.submit() 가로채기 (JS 호출 방식)
      HTMLFormElement.prototype.submit = function() {
        if (formUrl) return;
        const method = (this.method || 'GET').toUpperCase();
        const action = this.action || location.href;
        const fd = new FormData(this);
        formMethod = method;
        if (method === 'POST') { formUrl = action; formBody = fd; }
        else { const p = new URLSearchParams(fd).toString(); formUrl = action + (p ? '?' + p : ''); }
      };

      // submit 이벤트 가로채기 (type=submit 버튼 클릭 방식)
      const submitEventHandler = (e) => {
        if (formUrl) return;
        const form = e.target;
        if (!(form instanceof HTMLFormElement)) return;
        const method = (form.method || 'GET').toUpperCase();
        const action = form.action || location.href;
        const fd = new FormData(form);
        formMethod = method;
        if (method === 'POST') { formUrl = action; formBody = fd; }
        else { const p = new URLSearchParams(fd).toString(); formUrl = action + (p ? '?' + p : ''); }
        e.preventDefault();
        e.stopPropagation();
      };
      document.addEventListener('submit', submitEventHandler, true);

      // XHR 가로채기
      XMLHttpRequest.prototype.open = function(m, url, ...r) { this.__u = String(url); return origOpen.call(this, m, url, ...r); };
      XMLHttpRequest.prototype.send = function(b) {
        this.addEventListener('load', function() {
          if (xhrCaptured) return;
          const d = (this.getResponseHeader('content-disposition') || '').toLowerCase();
          const c = (this.getResponseHeader('content-type') || '').toLowerCase();
          if (isFileCd(d) || isFileCt(c)) {
            xhrCaptured = true;
            const fnM = d.match(/filename\*?\s*=\s*(?:utf-8'')?([^;\r\n]+)/i);
            if (fnM) try { capturedFileName = decodeURIComponent(fnM[1].trim()); } catch {}
            if (this.response instanceof ArrayBuffer && this.response.byteLength > 0) {
              xhrDataPromise = Promise.resolve(new Uint8Array(this.response));
            } else if (this.response instanceof Blob && this.response.size > 0) {
              xhrDataPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(this.response); });
            } else { xhrUrl = this.__u; xhrCaptured = false; }
          }
        });
        return origSend.call(this, b);
      };

      // fetch() 가로채기
      window.fetch = async function(url, options) {
        const resp = await origFetch.call(this, url, options);
        if (!fetchCaptured) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          const cd = (resp.headers.get('content-disposition') || '').toLowerCase();
          if (isFileCd(cd) || isFileCt(ct)) {
            fetchCaptured = true;
            const fnM = cd.match(/filename\*?\s*=\s*(?:utf-8'')?([^;\r\n]+)/i);
            if (fnM) try { capturedFileName = decodeURIComponent(fnM[1].trim()); } catch {}
            fetchDataPromise = resp.clone().arrayBuffer().then(buf => new Uint8Array(buf));
          }
        }
        return resp;
      };

      // blob URL 가로채기
      URL.createObjectURL = function(blob) {
        const url = origCOU.call(URL, blob);
        if (!blobPromise && blob.size > 500) {
          blobCaptured = true;
          blobPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(blob); });
        }
        return url;
      };
      HTMLAnchorElement.prototype.click = function() {
        if (anyCaptured()) return;
        const href = this.href;
        if (href && !href.startsWith('javascript:') && !href.startsWith('#') &&
            !href.startsWith('blob:') && href !== location.href) {
          if (!windowOpenUrl) windowOpenUrl = href;
          return;
        }
        origAClick.call(this);
      };
      window.open = function(url, ...args) { if (url && url !== 'about:blank') { windowOpenUrl = String(url); return null; } return origWindowOpen.call(window, url, ...args); };
      let origHrefDesc = null;
      try {
        origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (origHrefDesc?.configurable) {
          Object.defineProperty(Location.prototype, 'href', { ...origHrefDesc, set(url) { const s = String(url); if (!locationUrl && s !== location.href) { locationUrl = s; return; } origHrefDesc.set.call(this, url); }, configurable: true });
        }
      } catch(e) {}

      // alert 억제 (파일 미선택 시 "다운로드 할 파일이 없습니다" 팝업 방지)
      const origAlert = window.alert;
      window.alert = () => {};

      // 파일 체크박스 전체 선택 (다중 전략)
      // 전략 1: id에 grdFile/file/File/attach 포함하는 컨테이너의 체크박스
      let cbs = Array.from(document.querySelectorAll(
        '[id*="grdFile"] input[type="checkbox"], [id*="file"] input[type="checkbox"], ' +
        '[id*="File"] input[type="checkbox"], [id*="attach"] input[type="checkbox"], ' +
        '[id*="Attach"] input[type="checkbox"]'
      ));
      // 전략 2: 버튼 부모를 올라가며 체크박스 탐색
      if (cbs.length === 0) {
        let el = btn.parentElement;
        for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
          const found = Array.from(el.querySelectorAll('input[type="checkbox"]'));
          if (found.length > 0) { cbs = found; break; }
        }
      }
      // 전략 3: 페이지 전체 체크박스 (최후 수단)
      if (cbs.length === 0) {
        cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      }
      cbs.forEach(cb => {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('click',  { bubbles: true }));
      });
      if (cbs.length > 0) await new Promise(r => setTimeout(r, 200));

      btn.click();
      for (let t = 0; t < 50; t++) {
        await new Promise(r => setTimeout(r, 100));
        if (anyCaptured() || xhrUrl) break;
      }
      if (blobCaptured || xhrDataPromise || fetchDataPromise) await new Promise(r => setTimeout(r, 300));

      // 복원
      window.alert = origAlert;
      document.removeEventListener('submit', submitEventHandler, true);
      HTMLFormElement.prototype.submit    = origSubmit;
      XMLHttpRequest.prototype.open       = origOpen;
      XMLHttpRequest.prototype.send       = origSend;
      window.fetch                        = origFetch;
      URL.createObjectURL                 = origCOU;
      HTMLAnchorElement.prototype.click   = origAClick;
      window.open                         = origWindowOpen;
      try { if (origHrefDesc) Object.defineProperty(Location.prototype, 'href', origHrefDesc); } catch(e) {}

      if (blobPromise)      { const b = await blobPromise;      if (b?.length > 0) return { data: Array.from(b), fileName: capturedFileName, _dbg: 'blob' }; }
      if (xhrDataPromise)   { const b = await xhrDataPromise;   if (b?.length > 0) return { data: Array.from(b), fileName: capturedFileName, _dbg: 'xhr' }; }
      if (fetchDataPromise) { const b = await fetchDataPromise; if (b?.length > 0) return { data: Array.from(b), fileName: capturedFileName, _dbg: 'fetch' }; }

      for (const url of [formUrl, locationUrl, windowOpenUrl, xhrUrl].filter(Boolean)) {
        try {
          const fetchOpts = { credentials: 'include', method: formMethod };
          if (formMethod === 'POST' && formBody && url === formUrl) fetchOpts.body = formBody;
          const resp = await origFetch.call(window, new URL(url, location.origin).href, fetchOpts);
          if (resp.ok) {
            const cd = resp.headers.get('content-disposition') || '';
            const fnM = cd.match(/filename\*?\s*=\s*(?:utf-8'')?([^;\r\n]+)/i);
            if (fnM) try { capturedFileName = decodeURIComponent(fnM[1].trim()); } catch {}
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), fileName: capturedFileName, _dbg: 'refetch' };
          }
        } catch(e) {}
      }
      return { _dbg: 'nothing_captured' };
    },
  });
  return result?.result ?? { _dbg: 'script_null' };
}

// ZIP 내부 파일 파싱 (Deflate 지원)
async function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('EOCD not found');
  const cdCount  = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014B50) break;
    const flags       = view.getUint16(pos + 8,  true);
    const compression = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen     = view.getUint16(pos + 28, true);
    const extraLen    = view.getUint16(pos + 30, true);
    const commentLen  = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const encoding    = (flags & 0x0800) ? 'utf-8' : 'euc-kr';
    const name = new TextDecoder(encoding).decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    entries.push({ name, compression, compressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  const result = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const lhNameLen  = view.getUint16(entry.localOffset + 26, true);
    const lhExtraLen = view.getUint16(entry.localOffset + 28, true);
    const dataStart  = entry.localOffset + 30 + lhNameLen + lhExtraLen;
    const compressed = bytes.slice(dataStart, dataStart + entry.compressedSize);
    let data;
    if (entry.compression === 0) {
      data = compressed;
    } else if (entry.compression === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressed); writer.close();
      const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      data = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }
    } else { continue; }
    result.push({ name: entry.name, data });
  }
  return result;
}

// ── 순수 JS ZIP 빌더 (Store 방식) ──
function buildZip(files) {
  const encoder = new TextEncoder();
  const localHeaders = [], centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    const date = dosDateTime(new Date());

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, date.time, true); lv.setUint16(12, date.date, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30); local.set(file.data, 30 + nameBytes.length);
    localHeaders.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, date.time, true); cv.setUint16(14, date.date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralHeaders.push(central);
    offset += local.length;
  }

  const centralSize = centralHeaders.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);

  const zip = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  localHeaders.forEach(h => { zip.set(h, pos); pos += h.length; });
  centralHeaders.forEach(c => { zip.set(c, pos); pos += c.length; });
  zip.set(eocd, pos);
  return zip;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function downloadZipBundle(zipFiles, zipName) {
  const zipBytes = buildZip(zipFiles);
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = zipName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function showPersistentStatus(msg) {
  const el = document.createElement('div');
  el.className = 'status success';
  el.style.cssText = 'margin-top:6px; white-space:pre-wrap; font-size:11px;';
  el.textContent = msg;
  document.getElementById('result').appendChild(el);
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'status success';
  toast.style.marginTop = '6px';
  toast.textContent = msg;
  document.getElementById('result').appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

document.addEventListener('DOMContentLoaded', init);
