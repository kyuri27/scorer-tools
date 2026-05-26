let extractedData = null;
let cachedUrl = null;

// 공모명 정제: 접미사 제거 + 건축행위 괄호 처리
// - 신축은 기본값이라 제거만
// - 그 외 건축행위(증축/개축/리모델링 등)는 이름 뒤 괄호로 이동
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
  // 접미사 제거 (건립 포함)
  name = name.replace(/(설계공모|건축설계공모|제안공모|공모|건립사업|사업|건립)$/, '');
  // 공백/구두점 정리
  name = name.replace(/\s+/g, ' ').trim().replace(/[\s·,]+$/, '').trim();
  // 신축 외 건축행위 → 괄호 추가
  const extras = found.filter(k => k !== '신축');
  if (extras.length > 0) name += `(${extras.join(', ')})`;
  return name;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const main = document.getElementById('main');

  if (!tab.url || !tab.url.includes('eais.go.kr')) {
    main.innerHTML = `
      <div class="not-seumter">
        <div class="icon">🏗️</div>
        <div><b>세움터 공모 페이지</b>에서 실행해 주세요</div>
        <div style="font-size:11px; margin-top:6px; color:#9ca3af;">eais.go.kr 주소에서만 작동합니다</div>
      </div>`;
    return;
  }

  main.innerHTML = `
    <button id="extractBtn">🔍 공모 정보 추출</button>
    <div id="status"></div>
    <div id="result"></div>`;
  document.getElementById('extractBtn').addEventListener('click', extract);

  // chrome.storage.session으로 캐시 복원
  const stored = await chrome.storage.session.get(['extractedData', 'cachedUrl']);
  if (stored.cachedUrl === tab.url && stored.extractedData) {
    extractedData = stored.extractedData;
    cachedUrl = stored.cachedUrl;
    renderResult(extractedData);
    document.getElementById('status').innerHTML = `
      <div class="status success" style="display:flex; justify-content:space-between; align-items:center;">
        <span>✅ 이전 추출 결과 (URL 동일)</span>
        <button onclick="clearCache()" style="width:auto; padding:2px 8px; font-size:11px; background:#6b7280;">초기화</button>
      </div>`;
  }
}

async function clearCache() {
  await chrome.storage.session.remove(['extractedData', 'cachedUrl']);
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
    // 항상 최신 content.js 재주입 (확장 업데이트 후 페이지 새로고침 없이도 동작)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extract' });
    if (!response || !response.success) throw new Error(response ? response.error : '응답 없음');
    extractedData = response.data;
    cachedUrl = tab.url;
    // 팝업 닫혀도 유지되도록 storage.session에 저장
    await chrome.storage.session.set({ extractedData, cachedUrl: tab.url });
    renderResult(extractedData);
    statusEl.innerHTML = '<div class="status success">✅ 추출 완료!</div>';
  } catch (e) {
    statusEl.innerHTML = `<div class="status error">❌ 오류: ${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🔍 공모 정보 추출';
  }
}

function renderResult(data) {
  document.getElementById('extractBtn').innerHTML = '🔄 다시 추출';
  document.getElementById('extractBtn').disabled = false;

  const competitionName  = data['설계공모명'] || data['공모명'] || data['공모명_원본'] || '';
  const noticeNo         = data['공모번호'] || data['공고번호'] || '';
  const agency           = data['공고기관'] || '';
  const scale            = data['건축연면적'] || data['건축규모'] || '';
  const location         = data['위치'] || data['소재지'] || '';
  const budget           = data['총사업비'] || '';
  const judges           = data['심사위원_목록'] || [];
  const awards           = data['수상작품_목록'] || [];
  const attachedFiles    = data['첨부파일_목록'] || [];
  const judgeResultFiles = data['심사결과_파일_목록'] || [];
  const schedule         = data['일정_정보'] || {};
  const announceDate     = data['당선작발표일'] || schedule['당선작발표일'] || '';
  const noticeDate       = schedule['공고일시'] || '';
  const cleanName        = cleanCompetitionName(competitionName);

  let html = '<div class="result-section">';

  // 공모 개요
  html += '<h3>📋 공모 개요</h3>';
  if (competitionName) html += field('공모명', competitionName);
  if (noticeNo)        html += field('공모번호', noticeNo);
  if (agency)          html += field('공고기관', agency);
  if (location)        html += field('위치', location);
  if (scale)           html += field('건축연면적', scale);
  if (budget)          html += field('총사업비', budget);
  if (noticeDate)      html += field('공고일시', noticeDate);
  if (announceDate)    html += field('당선작 발표일', `<b style="color:#2563eb;">${announceDate}</b>`);

  // 심사위원
  if (judges.length > 0) {
    html += '<h3 style="margin-top:10px;">👥 심사위원</h3>';
    judges.forEach(j => {
      const isReserve = j.type && j.type.includes('예비');
      const typeLabel = isReserve ? '예비' : (j.type || '외부');
      const pillClass = isReserve ? 'pill-reserve' : 'pill-external';
      html += `<div class="judge-item">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span><span class="name">${j.name}</span> <span class="pill ${pillClass}">${typeLabel}</span></span>
        </div>
        <div class="sub">${j.org || ''}${j.pos ? ' · ' + j.pos : ''}${j.qual ? ' · ' + j.qual : ''}</div>
      </div>`;
    });
    html += `<div class="actions" style="margin-top:6px;">
      <button class="green" id="downloadTxtBtn">📄 심사위원 TXT 다운로드</button>
    </div>`;
  }

  // 수상작품
  if (awards.length > 0) {
    html += '<h3 style="margin-top:10px;">🏆 수상작품</h3>';
    awards.forEach((a, i) => {
      html += `<div class="award-item">`;
      if (a.imgSrc) html += `<img src="${a.imgSrc}" class="award-thumb" alt="${a.awardType}">`;
      html += `<div class="award-info">
        <div class="award-type">${a.awardType || '-'}</div>
        <div class="award-office">${a.officeName || '-'}</div>
        ${a.designer ? `<div class="award-designer">대표설계자: ${a.designer}</div>` : ''}
      </div></div>`;
    });
  }

  // 첨부파일
  if (attachedFiles.length > 0) {
    html += '<h3 style="margin-top:10px;">📎 첨부파일</h3>';
    attachedFiles.forEach(f => {
      html += `<div class="field">
        <div class="key">${f.category}</div>
        <div class="val" style="font-size:10px; color:#6b7280;">${f.fileName}</div>
      </div>`;
    });
  }

  // 심사결과 파일
  if (judgeResultFiles.length > 0) {
    html += '<h3 style="margin-top:10px;">📊 심사결과 파일</h3>';
    judgeResultFiles.forEach(f => {
      html += `<div class="field">
        <div class="val" style="font-size:10px; color:#6b7280;">${f.label}</div>
      </div>`;
    });
  }

  html += '</div>';

  // 버튼 영역 (순서: 첨부파일 → 심사결과 → 정리도구용 복사 → 원본 데이터 확인)
  if (attachedFiles.length > 0) {
    html += `<div class="actions" style="margin-top:6px;">
      <button class="green" id="downloadAttachedBtn">📦 첨부파일 ZIP 다운로드</button>
    </div>`;
  }
  if (judgeResultFiles.length > 0) {
    html += `<div class="actions" style="margin-top:6px;">
      <button class="green" id="downloadJudgeResultBtn">📦 심사결과 파일 ZIP 다운로드</button>
    </div>`;
  }
  html += `<div class="actions" style="margin-top:6px;">
    <button class="green" id="copyToolBtn">🔗 정리도구용 복사</button>
  </div>`;

  document.getElementById('result').innerHTML = html;
  if (attachedFiles.length > 0) {
    document.getElementById('downloadAttachedBtn').addEventListener('click', () => downloadAllAttached(data));
  }
  if (judgeResultFiles.length > 0) {
    document.getElementById('downloadJudgeResultBtn').addEventListener('click', () => downloadJudgeResultFiles(data));
  }
  document.getElementById('copyToolBtn').addEventListener('click', copyForTool);
  if (judges.length > 0) {
    document.getElementById('downloadTxtBtn').addEventListener('click', downloadJudgesTxt);
  }
}

function downloadJudgesTxt() {
  const judges = extractedData['심사위원_목록'] || [];
  const competitionName = (extractedData['설계공모명'] || extractedData['공모명'] || '공모').replace(/\s+/g, '_');

  const lines = judges.map(j => {
    const type = j.type && j.type.includes('예비') ? '예비' : (j.type || '외부');
    return `${type}, ${j.name}, ${j.org || ''}`;
  });

  const text = lines.join('\n');
  const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: 'judges.txt', conflictAction: 'overwrite', saveAs: false },
    () => { URL.revokeObjectURL(url); showToast('✅ TXT 다운로드 완료'); }
  );
}

function field(key, val) {
  return `<div class="field"><div class="key">${key}</div><div class="val">${val}</div></div>`;
}

async function copyForTool() {
  if (!extractedData) return;

  const btn = document.getElementById('copyToolBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 준비 중...';

  const judges = (extractedData['심사위원_목록'] || []).map(j => ({
    type: j.type || '외부',
    name: j.name,
    org:  j.org  || '',
    pos:  j.pos  || '',
    qual: j.qual || '',
  }));
  const name = extractedData['설계공모명'] || extractedData['공모명'] || extractedData['공모명_원본'] || '';
  const cleanName = cleanCompetitionName(name);

  // 이미지를 base64로 변환 (확장프로그램은 CORS 없이 세움터 이미지 접근 가능)
  const awards = [];
  for (const a of (extractedData['수상작품_목록'] || [])) {
    let imgBase64 = '';
    let imgMime = 'image/jpeg';
    if (a.imgSrc) {
      try {
        const resp = await fetch(a.imgSrc);
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        imgBase64 = btoa(binary);
        imgMime = resp.headers.get('content-type') || 'image/jpeg';
      } catch (e) {
        console.warn('이미지 변환 실패:', e);
      }
    }
    awards.push({
      awardType: a.awardType, office: a.officeName, designer: a.designer,
      num: '',
      imgBase64, imgMime
    });
  }

  const d = extractedData;
  const toolData = {
    competitionName: cleanName,
    buildType:    d['건축물주요도'] || '',
    noticeNo:     d['공모번호']  || d['공고번호'] || '',
    agency:       d['공고기관']  || '',
    location:     d['위치']      || d['소재지']  || '',
    scale:        d['건축연면적'] || d['건축규모'] || d['건축물 규모'] || d['건축물규모'] || '',
    budget:       d['총사업비']  || '',
    constructionCost: d['예정 공사비'] || d['예정공사비'] || '',
    designCost:   d['예정 설계비'] || d['예정설계비'] || '',
    contactOrg:   d['소속'] || '',
    contactName:  d['이름'] || '',
    noticeDate:   d['일정_정보']?.['공고일시'] || '',
    announceDate: d['당선작발표일'] || d['일정_정보']?.['당선작발표일'] || '',
    chairperson: '',
    judges_planned: judges, judges_attended: [],
    awards, files: []
  };

  navigator.clipboard.writeText(JSON.stringify(toolData, null, 2))
    .then(() => showToast('✅ 정리도구용 JSON 복사됨!\n(이미지 포함)'))
    .catch(() => showToast('❌ 클립보드 복사 실패'));

  btn.disabled = false;
  btn.innerHTML = '🔗 정리도구용 복사';
}

// ── ZIP 생성 (순수 JS, 라이브러리 없음) ──
async function downloadZip() {
  const btn = document.getElementById('downloadZipBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 이미지 다운로드 중...';

  const awards = extractedData['수상작품_목록'] || [];
  const competitionName = (extractedData['설계공모명'] || extractedData['공모명'] || '공모').replace(/\s+/g, '_');

  try {
    const files = [];
    for (let i = 0; i < awards.length; i++) {
      const a = awards[i];
      if (!a.imgSrc) continue;
      try {
        const resp = await fetch(a.imgSrc);
        const buf = await resp.arrayBuffer();
        const ext = a.imgSrc.includes('.png') ? 'png' : 'jpg';
        const label = (a.awardType || `수상작_${i+1}`).replace(/\s+/g, '_');
        const office = (a.officeName || '').replace(/[\\/:"*?<>|]/g, '').trim();
        files.push({ name: `${label}_${office}.${ext}`, data: new Uint8Array(buf) });
      } catch (e) {
        console.warn('이미지 fetch 실패:', a.imgSrc, e);
      }
    }

    if (files.length === 0) {
      showToast('다운로드할 이미지가 없습니다.');
      btn.disabled = false;
      btn.innerHTML = '📦 수상작 이미지 ZIP 다운로드';
      return;
    }

    const zipBytes = buildZip(files);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `수상작품_${competitionName}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`✅ ${files.length}개 이미지 ZIP 다운로드 완료!`);
  } catch (e) {
    showToast('오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📦 수상작 이미지 ZIP 다운로드';
  }
}

// ── 순수 JS ZIP 빌더 (Deflate 없이 Store 방식) ──
function buildZip(files) {
  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    const date = dosDateTime(new Date());

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);  // signature
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0, true);           // flags
    lv.setUint16(8, 0, true);           // compression (store)
    lv.setUint16(10, date.time, true);  // mod time
    lv.setUint16(12, date.date, true);  // mod date
    lv.setUint32(14, crc, true);        // crc32
    lv.setUint32(18, size, true);       // compressed size
    lv.setUint32(22, size, true);       // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // name length
    lv.setUint16(28, 0, true);          // extra length
    local.set(nameBytes, 30);
    local.set(file.data, 30 + nameBytes.length);
    localHeaders.push(local);

    // Central directory entry
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);  // signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0, true);           // flags
    cv.setUint16(10, 0, true);          // compression
    cv.setUint16(12, date.time, true);
    cv.setUint16(14, date.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);          // extra length
    cv.setUint16(32, 0, true);          // comment length
    cv.setUint16(34, 0, true);          // disk start
    cv.setUint16(36, 0, true);          // internal attr
    cv.setUint32(38, 0, true);          // external attr
    cv.setUint32(42, offset, true);     // local header offset
    central.set(nameBytes, 46);
    centralHeaders.push(central);

    offset += local.length;
  }

  const centralSize = centralHeaders.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + centralSize + 22;
  const zip = new Uint8Array(total);
  let pos = 0;
  localHeaders.forEach(h => { zip.set(h, pos); pos += h.length; });
  centralHeaders.forEach(c => { zip.set(c, pos); pos += c.length; });
  zip.set(eocd, pos);
  return zip;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dateToYYMMDD(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1].slice(2)}${m[2]}${m[3]}` : '';
}

// 메인 월드에서 버튼 클릭 → XHR/blob 가로채기 → 파일 데이터 반환 (다운로드 억제)
async function captureFileFromPage(tabId, elType, idx) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (elType, idx) => {
      // 첨부파일: content6 안의 button.download 순서로 탐색 (속성보다 robust)
      // 심사결과: data-seumter-judge 속성으로 탐색
      let btn;
      if (elType === 'attached') {
        const root = document.querySelector('.content_opt.content6, .content6, [class*="content6"]') || document;
        btn = document.querySelector(`[data-seumter-attached="${idx}"]`)
           || Array.from(root.querySelectorAll('button.download'))[idx]
           || Array.from(document.querySelectorAll('button.download'))[idx];
      } else {
        // data-seumter-judge 속성 우선, 없으면 키워드 단독 매칭 요소 탐색
        // (content.js와 동일하게 복수 키워드 포함 부모 컨테이너 제외)
        const judgeKeywords = ['투표결과', '평가점수', '평가사유서'];
        btn = document.querySelector(`[data-seumter-judge="${idx}"]`)
           || Array.from(document.querySelectorAll('button, a, td, div, li')).filter(el => {
                const t = el.textContent.replace(/\s/g, '');
                if (!t.includes('심사위원')) return false;
                const hits = judgeKeywords.filter(k => t.includes(k));
                return hits.length === 1; // 단독 키워드만 포함한 요소
              })[idx];
      }
      if (!btn) return { _dbg: `btn_not_found_${elType}_${idx}` };

      // ── 경로 0: <a href="직접URL"> 이면 클릭 없이 바로 fetch ──
      const directHref = btn.tagName === 'A' && btn.href &&
        !btn.href.startsWith('javascript:') && !btn.href.startsWith('blob:') &&
        !btn.href.startsWith('#') && btn.href !== location.href;
      if (directHref) {
        try {
          const resp = await fetch(btn.href, { credentials: 'include' });
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'direct_href' };
          }
        } catch (e) {}
      }

      let xhrUrl = null;
      let xhrDataPromise = null;
      let xhrCaptured = false;
      let fetchDataPromise = null;
      let fetchCaptured = false;
      let windowOpenUrl = null;
      let blobPromise = null;
      let blobCaptured = false;

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;
      const origCOU = URL.createObjectURL;
      const origAClick = HTMLAnchorElement.prototype.click;
      const origWindowOpen = window.open;
      const origAssign = location.assign.bind(location);
      const origReplace = location.replace.bind(location);
      let origHrefDesc = null;
      let locationUrl = null;

      const isFileCt = c => c.includes('octet-stream') || c.includes('/pdf') ||
        c.includes('officedocument') || c.includes('hwp') || c.includes('zip');
      const isFileCd = d => d.includes('attachment') || d.includes('filename');
      const anyCaptured = () => blobCaptured || xhrCaptured || fetchCaptured || windowOpenUrl || locationUrl;

      // 1. XHR 가로채기 — 응답 본문 직접 캡처
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
              xhrUrl = this.__u;
              xhrCaptured = false;
            }
          }
        });
        return origSend.call(this, b);
      };

      // 2. fetch() API 가로채기
      window.fetch = async function(url, options) {
        const resp = await origFetch.call(this, url, options);
        if (!fetchCaptured) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          const cd = (resp.headers.get('content-disposition') || '').toLowerCase();
          if (isFileCd(cd) || isFileCt(ct)) {
            fetchCaptured = true;
            const clone = resp.clone();
            fetchDataPromise = clone.arrayBuffer().then(buf => new Uint8Array(buf));
          }
        }
        return resp;
      };

      // 3. URL.createObjectURL 가로채기
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

      // 4. <a>.click() 억제 — 캡처됐거나 location 네비게이션으로 처리될 때
      HTMLAnchorElement.prototype.click = function() {
        if (anyCaptured()) return;
        origAClick.call(this);
      };

      // 5. window.open 가로채기
      window.open = function(url, ...args) {
        if (url && url !== 'about:blank' && url !== '') {
          windowOpenUrl = String(url);
          return null;
        }
        return origWindowOpen.call(window, url, ...args);
      };

      // 6. location 네비게이션 가로채기 (location.href = url 방식 다운로드 대응)
      try {
        origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (origHrefDesc?.configurable) {
          Object.defineProperty(Location.prototype, 'href', {
            ...origHrefDesc,
            set(url) {
              const s = String(url);
              if (!locationUrl && s !== location.href && (s.startsWith('http') || s.startsWith('/'))) {
                locationUrl = s;
                return; // 네비게이션 억제
              }
              origHrefDesc.set.call(this, url);
            },
            configurable: true,
          });
        }
      } catch(e) {}
      location.assign = function(url) { if (!locationUrl) locationUrl = String(url); };
      location.replace = function(url) { if (!locationUrl) locationUrl = String(url); };

      btn.click();
      // 캡처될 때까지 100ms씩 폴링 (최대 3초)
      for (let t = 0; t < 30; t++) {
        await new Promise(r => setTimeout(r, 100));
        if (anyCaptured() || xhrUrl) break;
      }
      if (blobCaptured || xhrDataPromise || fetchDataPromise) await new Promise(r => setTimeout(r, 200));

      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
      window.fetch = origFetch;
      URL.createObjectURL = origCOU;
      HTMLAnchorElement.prototype.click = origAClick;
      window.open = origWindowOpen;
      location.assign = origAssign;
      location.replace = origReplace;
      try {
        if (origHrefDesc) Object.defineProperty(Location.prototype, 'href', origHrefDesc);
      } catch(e) {}

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
      if (locationUrl) {
        try {
          const fullUrl = new URL(locationUrl, location.origin).href;
          const resp = await origFetch.call(window, fullUrl, { credentials: 'include' });
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            return { data: Array.from(new Uint8Array(buf)), _dbg: 'location_refetch' };
          }
          return { _dbg: `location_fail_${resp.status}` };
        } catch(e) {
          return { _dbg: `location_err_${e.message}` };
        }
      }
      if (windowOpenUrl) {
        try {
          const fullUrl = new URL(windowOpenUrl, location.origin).href;
          const resp = await origFetch.call(window, fullUrl, { credentials: 'include' });
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            return { data: Array.from(new Uint8Array(buf)), _dbg: 'window_open_refetch' };
          }
          return { _dbg: `window_open_fail_${resp.status}` };
        } catch (e) {
          return { _dbg: `window_open_err_${e.message}` };
        }
      }
      if (xhrUrl) {
        try {
          const fullUrl = new URL(xhrUrl, location.origin).href;
          const resp = await origFetch.call(window, fullUrl, { credentials: 'include' });
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            return { data: Array.from(new Uint8Array(buf)), _dbg: 'xhr_refetch' };
          }
          return { _dbg: `xhr_fail_${resp.status}` };
        } catch (e) {
          return { _dbg: `xhr_err_${e.message}` };
        }
      }
      return { _dbg: 'nothing_captured' };
    },
    args: [elType, idx],
  });
  return result?.result ?? { _dbg: 'script_null' };
}

async function fetchBlob(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.arrayBuffer();
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

async function downloadAllAttached(data) {
  const files = data['첨부파일_목록'] || [];
  const name = data['설계공모명'] || data['공모명'] || data['공모명_원본'] || '';
  const cleanName = cleanCompetitionName(name);
  const yymmdd = dateToYYMMDD((data['일정_정보'] || {})['공고일시'] || '');
  const btn = document.getElementById('downloadAttachedBtn');
  btn.disabled = true;

  const zipFiles = [];
  const failLog = [];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    btn.innerHTML = `<span class="spinner"></span> ${i + 1}/${files.length} 수집 중...`;
    const newName = f.fileName;

    let captured = null;
    try { captured = await captureFileFromPage(tab.id, 'attached', i); } catch {}

    if (captured?.data?.length > 0) {
      zipFiles.push({ name: newName, data: new Uint8Array(captured.data) });
      continue;
    }

    // 캡처 실패 — 원본 클릭 (파일명 변경 불가)
    failLog.push(`${i + 1}번: ${captured?._dbg || '?'}`);
    try { await chrome.tabs.sendMessage(tab.id, { action: 'clickAttached', index: i }); } catch {}
    await new Promise(r => setTimeout(r, 700));
  }

  btn.disabled = false;
  btn.innerHTML = '📦 첨부파일 ZIP 다운로드';

  if (zipFiles.length > 0) {
    await downloadZipBundle(zipFiles, `첨부파일_${cleanName}_${yymmdd}.zip`);
  }
  const summary = zipFiles.length > 0
    ? `✅ ZIP ${zipFiles.length}개 완료`
    : '⚠️ ZIP 생성 실패';
  const failMsg = failLog.length > 0
    ? `\n개별 다운로드 (${failLog.join(' / ')})`
    : '';
  showPersistentStatus(summary + failMsg);
}

function showPersistentStatus(msg) {
  const el = document.createElement('div');
  el.className = 'status success';
  el.style.cssText = 'margin-top:6px; white-space:pre-wrap; font-size:11px;';
  el.textContent = msg;
  document.getElementById('result').appendChild(el);
}

// CDP 파일 캡처 공통 로직 (popup 또는 background 양쪽에서 사용)
async function _cdpCapture(tabId, fileCount) {
  const results = [];
  const seenRequests = [];
  let attached = false;
  try {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      await chrome.debugger.attach({ tabId }, '1.3');
    }
    attached = true;

    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [{ requestStage: 'Response' }]
    });

    const resolvers = []; // 파일별 FIFO resolver — 순서 보장
    const SKIP = ['text/html', 'javascript', 'text/css', 'application/json', 'image/', 'font/'];

    const onEv = async (src, method, params) => {
      if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
      const { requestId, request = {}, responseHeaders = [], responseStatusCode } = params;
      const h = (n) => (responseHeaders.find(h => h.name.toLowerCase() === n)?.value || '').toLowerCase();
      const ct = h('content-type'), cd = h('content-disposition');
      const urlShort = (request.url || '').replace(/^https?:\/\//, '').slice(0, 60);
      seenRequests.push(`[${responseStatusCode}] ct=${ct.slice(0,35)} cd=${cd.slice(0,25)} url=${urlShort}`);

      const isFile =
        cd.includes('attachment') || cd.includes('filename') ||
        ct.includes('/pdf') || ct.includes('octet-stream') || ct.includes('hwp') ||
        ct.includes('x-download') || ct.includes('force-download') || ct.includes('msdownload') ||
        ct.includes('application/zip') ||
        (!SKIP.some(s => ct.includes(s)) && ct.startsWith('application/'));

      if (isFile && resolvers.length > 0) {
        const resolveCapture = resolvers.shift(); // 해당 파일의 resolver
        const fileUrl = request.url;
        const fileMethod = (request.method || 'GET').toUpperCase();
        const postData = request.postData || null;
        const reqHeaders = request.headers || {};

        // 즉시 204 반환 → 페이지 로딩 스피너 종료
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
            requestId, responseCode: 204,
            responseHeaders: [{ name: 'content-length', value: '0' }], body: ''
          });
        } catch {
          try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }); } catch {}
        }

        // 비동기 re-fetch (CDP 핸들러 블록하지 않음)
        (async () => {
          let base64 = null;
          let fileName = null;
          try {
            const fetchOpts = { credentials: 'include', method: fileMethod };
            if (fileMethod === 'POST' && postData) {
              fetchOpts.body = postData;
              const reqCt = reqHeaders['content-type'] || reqHeaders['Content-Type'];
              if (reqCt) fetchOpts.headers = { 'Content-Type': reqCt };
            }
            const resp = await fetch(fileUrl, fetchOpts);
            if (resp.ok) {
              // Content-Disposition에서 실제 파일명 추출
              const respCd = resp.headers.get('content-disposition') || '';
              const fnMatch = respCd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;\r\n]+)/i)
                           || respCd.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
              if (fnMatch) {
                try { fileName = decodeURIComponent(fnMatch[1].trim()); }
                catch { fileName = fnMatch[1].trim(); }
              }
              const buf = await resp.arrayBuffer();
              if (buf.byteLength > 0) {
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
                base64 = btoa(binary);
                seenRequests.push(`refetch: ${Math.round(buf.byteLength / 1024)}KB`);
              } else { seenRequests.push('refetch: empty'); }
            } else { seenRequests.push(`refetch_fail: ${resp.status}`); }
          } catch(e) { seenRequests.push(`refetch_err: ${e.message}`); }
          resolveCapture({ base64, fileName });
        })();
      } else {
        try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId }); } catch {}
      }
    };

    chrome.debugger.onEvent.addListener(onEv);

    // 버튼 순차 클릭 (CDP 인터셉트 순서 보장) + re-fetch는 병렬
    const captureEntries = [];
    for (let i = 0; i < fileCount; i++) {
      const prevSeen = seenRequests.length;
      const capturePromise = new Promise(r => resolvers.push(r));
      captureEntries.push({ capturePromise, prevSeen });
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: (idx) => {
          const KW = ['투표결과', '평가점수', '평가사유서'];
          const el = document.querySelector(`[data-seumter-judge="${idx}"]`) ||
            Array.from(document.querySelectorAll('*')).filter(el => {
              if (el.children.length > 5) return false;
              const t = el.textContent.replace(/\s/g, '');
              return t.length >= 5 && t.length <= 60 && t.includes('심사위원') &&
                KW.filter(k => t.includes(k)).length === 1;
            })[idx];
          if (el) el.click();
        },
        args: [i]
      });
      if (i < fileCount - 1) await new Promise(r => setTimeout(r, 600));
    }

    // 모든 re-fetch 병렬 수집
    const resolved = await Promise.all(
      captureEntries.map(({ capturePromise, prevSeen }) =>
        Promise.race([capturePromise, new Promise(r => setTimeout(() => r(null), 90000))])
          .then(result => ({
            base64: result?.base64 ?? null,
            fileName: result?.fileName ?? null,
            _seen: seenRequests.slice(prevSeen)
          }))
      )
    );
    results.push(...resolved);

    chrome.debugger.onEvent.removeListener(onEv);
    try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable', {}); } catch {}
  } catch(e) {
    while (results.length < fileCount) results.push({ base64: null, _err: e.message });
  } finally {
    if (attached) try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  return results;
}

// ZIP 내부 파일 목록 파싱 (DecompressionStream 네이티브 API 사용)
async function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of Central Directory 탐색 (뒤에서부터)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
      eocdOffset = i; break;
    }
  }
  if (eocdOffset === -1) throw new Error('EOCD not found');

  const cdCount  = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // Central Directory 파싱
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014B50) break;
    const flags            = view.getUint16(pos + 8,  true);
    const compression      = view.getUint16(pos + 10, true);
    const compressedSize   = view.getUint32(pos + 20, true);
    const nameLen          = view.getUint16(pos + 28, true);
    const extraLen         = view.getUint16(pos + 30, true);
    const commentLen       = view.getUint16(pos + 32, true);
    const localOffset      = view.getUint32(pos + 42, true);
    // bit 11이 설정된 경우만 UTF-8, 아니면 EUC-KR (한국 Windows ZIP 기본값)
    const encoding = (flags & 0x0800) ? 'utf-8' : 'euc-kr';
    const name = new TextDecoder(encoding).decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    entries.push({ name, compression, compressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // 각 파일 데이터 추출 + 압축 해제
  const result = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // 디렉토리
    const lhNameLen  = view.getUint16(entry.localOffset + 26, true);
    const lhExtraLen = view.getUint16(entry.localOffset + 28, true);
    const dataStart  = entry.localOffset + 30 + lhNameLen + lhExtraLen;
    const compressed = bytes.slice(dataStart, dataStart + entry.compressedSize);

    let data;
    if (entry.compression === 0) {
      data = compressed; // Store (무압축)
    } else if (entry.compression === 8) {
      // Deflate
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressed);
      writer.close();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      data = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }
    } else {
      continue; // 지원하지 않는 압축 방식은 건너뜀
    }
    result.push({ name: entry.name, data });
  }
  return result;
}

async function downloadJudgeResultFiles(data) {
  const files = data['심사결과_파일_목록'] || [];
  const name = data['설계공모명'] || data['공모명'] || data['공모명_원본'] || '';
  const cleanName = cleanCompetitionName(name);
  const btn = document.getElementById('downloadJudgeResultBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 수집 중...`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const zipFiles = [];
  const failLog = [];

  let rawResults = null;

  if (chrome.debugger) {
    // popup에서 직접 CDP 사용 (chrome.debugger 사용 가능한 경우)
    rawResults = await _cdpCapture(tab.id, files.length);
  } else {
    // background 서비스 워커로 위임 (fallback)
    try {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: 'captureJudgeFiles', tabId: tab.id, fileCount: files.length },
          (r) => { chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r); }
        );
      });
      if (resp?.success) rawResults = resp.data;
      else failLog.push(`오류: ${resp?.error || 'background 응답 없음'}`);
    } catch(e) {
      const msg = e.message || '';
      failLog.push(msg.includes('Receiving end') || msg.includes('establish connection')
        ? '확장프로그램을 재로드해주세요 (chrome://extensions → ↺ 버튼)'
        : `오류: ${msg}`);
    }
  }

  if (rawResults) {
    for (let i = 0; i < files.length; i++) {
      const r = rawResults[i];
      if (r?.base64) {
        const raw = atob(r.base64);
        const bytes = new Uint8Array(raw.length);
        for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j);

        const prefix = files[i].label === '심사위원별투표결과' ? '투표결과_'
                     : files[i].label === '심사위원별평가사유서' ? '평가사유서_'
                     : '';
        const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;

        if (isZip) {
          // 원본이 ZIP — 내부 파일을 꺼내서 메인 ZIP에 flat merge
          try {
            const innerFiles = await parseZip(bytes);
            for (const { name, data } of innerFiles) {
              zipFiles.push({ name: `${prefix}${name}`, data });
            }
          } catch (e) {
            // 파싱 실패 시 원본 그대로 저장
            const fileName = r.fileName || `${files[i].label}.zip`;
            zipFiles.push({ name: `${prefix}${fileName}`, data: bytes });
          }
        } else {
          const fileName = r.fileName || `${files[i].label}.pdf`;
          zipFiles.push({ name: `${prefix}${fileName}`, data: bytes });
        }
      } else {
        const seen = r?._seen?.join('\n  ') || '(없음)';
        failLog.push(`${files[i].label}: ${r?._err || 'timeout'}\n  seen:\n  ${seen}`);
      }
    }
  }

  btn.disabled = false;
  btn.innerHTML = '📦 심사결과 파일 ZIP 다운로드';

  if (zipFiles.length > 0) {
    await downloadZipBundle(zipFiles, `심사결과파일_${cleanName}.zip`);
  }
  const summary = zipFiles.length > 0 ? `✅ 심사결과 ZIP ${zipFiles.length}개 완료` : '⚠️ ZIP 생성 실패';
  const failMsg = failLog.length > 0 ? `\n실패 (${failLog.join(' / ')})` : '';
  showPersistentStatus(summary + failMsg);
}

async function _unused_legacy(data) {
  const files = data['심사결과_파일_목록'] || [];
  const name = data['설계공모명'] || data['공모명'] || data['공모명_원본'] || '';
  const cleanName = cleanCompetitionName(name);
  const btn = document.getElementById('downloadJudgeResultBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 수집 중...`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let allResults = [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (fileCount) => {
        const judgeKeywords = ['투표결과', '평가점수', '평가사유서'];
        const origFetch = window.fetch;
        const origAClick = HTMLAnchorElement.prototype.click;
        const origWindowOpen = window.open;

        // 버튼을 클릭 전에 모두 미리 찾아둠 (Vue 재렌더 영향 없음)
        function findBtn(idx) {
          return document.querySelector(`[data-seumter-judge="${idx}"]`) ||
            Array.from(document.querySelectorAll('*')).filter(el => {
              if (el.children.length > 5) return false;
              const t = el.textContent.replace(/\s/g, '');
              if (t.length < 5 || t.length > 60 || !t.includes('심사위원')) return false;
              return judgeKeywords.filter(k => t.includes(k)).length === 1;
            })[idx];
        }
        const buttons = Array.from({ length: fileCount }, (_, i) => findBtn(i));

        const results = [];

        for (let fileIdx = 0; fileIdx < fileCount; fileIdx++) {
          const btn = buttons[fileIdx];
          if (!btn) { results.push({ _dbg: `btn_not_found_${fileIdx}` }); continue; }

          let capturedUrl = null;
          let capturedFormData = null;
          let blobCaptured = false;
          let blobPromise = null;
          const fired = [];
          const origCOU = URL.createObjectURL;
          const origROU = URL.revokeObjectURL;

          // 진단: 버튼 정보 수집
          const btnInfo = {
            tag: btn.tagName,
            href: btn.href || btn.getAttribute('href') || '',
            onclick: (btn.getAttribute('onclick') || '').slice(0, 80),
            type: btn.getAttribute('type') || '',
            inForm: !!btn.closest('form'),
            formAction: btn.closest('form')?.action || '',
            formMethod: btn.closest('form')?.method || '',
          };

          // ① form submit (GET/POST 모두)
          const captureSubmit = (e) => {
            fired.push('submit');
            e.preventDefault();
            const form = e.target;
            const fd = new FormData(form);
            if ((form.method || 'get').toLowerCase() === 'post') {
              capturedUrl = form.action;
              capturedFormData = fd;
            } else {
              const params = new URLSearchParams(fd).toString();
              capturedUrl = form.action + (params ? '?' + params : '');
            }
          };
          document.addEventListener('submit', captureSubmit, true);

          // ② document capture (appended anchor + dispatchEvent)
          const captureClick = (e) => {
            const a = e.target?.closest?.('a');
            if (!a) { fired.push('click_non_anchor'); return; }
            const href = a.href || '';
            if (!href || href.startsWith('javascript:') || href === location.href) {
              fired.push(`click_skip`); return;
            }
            fired.push(`click_anchor`);
            if (!capturedUrl) capturedUrl = href;
            e.preventDefault();
            e.stopImmediatePropagation();
          };
          document.addEventListener('click', captureClick, true);

          // ③ location.href setter
          let origHrefDesc = null;
          try {
            origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
            if (origHrefDesc?.configurable) {
              Object.defineProperty(Location.prototype, 'href', {
                ...origHrefDesc,
                set(url) {
                  const s = String(url);
                  fired.push(`loc_href`);
                  if (s !== location.href) { capturedUrl = capturedUrl || s; return; }
                  origHrefDesc.set.call(this, url);
                },
                configurable: true,
              });
            }
          } catch(e) { fired.push(`href_setup_err`); }

          // ④ window.open
          window.open = (url, ...args) => {
            fired.push(`window_open`);
            if (url && url !== 'about:blank') { capturedUrl = capturedUrl || String(url); return null; }
            return origWindowOpen.call(window, url, ...args);
          };

          // ⑤ HTMLAnchorElement.prototype.click (detached anchor)
          HTMLAnchorElement.prototype.click = function() {
            const href = this.href || '';
            fired.push(`a_proto_click_${href ? 'has_href' : 'no_href'}`);
            if (blobCaptured) return; // blob 이미 캡처됨 — 다운로드 억제
            if (href && !href.startsWith('javascript:') && href !== location.href) {
              capturedUrl = capturedUrl || href;
              return;
            }
            origAClick.call(this);
          };

          // ⑥ URL.createObjectURL — blob 즉시 revoke로 자연 다운로드 방지
          URL.createObjectURL = function(blob) {
            const url = origCOU.call(URL, blob);
            if (!blobCaptured && blob.size > 500) {
              blobCaptured = true;
              fired.push('blob_createObjectURL');
              blobPromise = new Promise(res => {
                const fr = new FileReader();
                fr.onload = () => res(new Uint8Array(fr.result));
                fr.onerror = () => res(null);
                fr.readAsArrayBuffer(blob);
              });
              origROU.call(URL, url); // 즉시 revoke → 앵커 클릭 시 다운로드 실패
            }
            return url;
          };

          btn.click();

          for (let t = 0; t < 30; t++) {
            await new Promise(r => setTimeout(r, 100));
            if (capturedUrl || capturedFormData || blobCaptured) break;
          }
          if (blobCaptured) await new Promise(r => setTimeout(r, 200));

          document.removeEventListener('submit', captureSubmit, true);
          document.removeEventListener('click', captureClick, true);
          try { if (origHrefDesc) Object.defineProperty(Location.prototype, 'href', origHrefDesc); } catch(e) {}
          window.open = origWindowOpen;
          HTMLAnchorElement.prototype.click = origAClick;
          URL.createObjectURL = origCOU;

          const diagStr = `[${btnInfo.tag} href=${btnInfo.href.slice(0,30)} form=${btnInfo.inForm} fired=${fired.join(',')}]`;

          if (blobCaptured && blobPromise) {
            const bytes = await blobPromise;
            if (bytes?.length > 0) { results.push({ data: Array.from(bytes), _dbg: 'blob_captured' }); }
            else results.push({ _dbg: `blob_empty${diagStr}` });
          } else if (capturedFormData) {
            try {
              const resp = await origFetch.call(window, capturedUrl, {
                method: 'POST', body: capturedFormData, credentials: 'include',
              });
              if (resp.ok) {
                const buf = await resp.arrayBuffer();
                if (buf.byteLength > 0) { results.push({ data: Array.from(new Uint8Array(buf)), _dbg: 'form_post' }); }
                else results.push({ _dbg: `form_post_empty${diagStr}` });
              } else results.push({ _dbg: `form_post_fail_${resp.status}${diagStr}` });
            } catch(e) { results.push({ _dbg: `form_err${diagStr}` }); }
          } else if (capturedUrl) {
            try {
              const fullUrl = new URL(capturedUrl, location.origin).href;
              const resp = await origFetch.call(window, fullUrl, { credentials: 'include' });
              if (resp.ok) {
                const ct = (resp.headers.get('content-type') || '').toLowerCase();
                const buf = await resp.arrayBuffer();
                if (ct.includes('text/html') && buf.byteLength < 500_000)
                  results.push({ _dbg: `html_page${diagStr}` });
                else if (buf.byteLength > 0)
                  results.push({ data: Array.from(new Uint8Array(buf)), _dbg: 'url_fetch' });
                else results.push({ _dbg: `empty${diagStr}` });
              } else results.push({ _dbg: `fail_${resp.status}${diagStr}` });
            } catch(e) { results.push({ _dbg: `err_${e.message}${diagStr}` }); }
          } else {
            results.push({ _dbg: `nothing_captured${diagStr}` });
          }

          if (fileIdx < fileCount - 1) await new Promise(r => setTimeout(r, 400));
        }

        return results;
      },
      args: [files.length],
    });
    allResults = res?.result ?? [];
  } catch(e) {
    allResults = files.map(() => ({ _dbg: `script_err_${e.message}` }));
  }

  const zipFiles = [];
  const failLog = [];
  for (let i = 0; i < files.length; i++) {
    const r = allResults[i];
    const f = files[i];
    if (r?.data?.length > 0) {
      zipFiles.push({ name: `${f.label}.pdf`, data: new Uint8Array(r.data) });
    } else {
      failLog.push(`${f.label}: ${r?._dbg || '?'}`);
      try { await chrome.tabs.sendMessage(tab.id, { action: 'clickJudgeResult', index: i }); } catch {}
      await new Promise(r => setTimeout(r, 400));
    }
  }

  btn.disabled = false;
  btn.innerHTML = '📦 심사결과 파일 ZIP 다운로드';

  if (zipFiles.length > 0) {
    await downloadZipBundle(zipFiles, `심사결과파일_${cleanName}.zip`);
  }
  const summary = zipFiles.length > 0 ? `✅ 심사결과 ZIP ${zipFiles.length}개 완료` : '⚠️ ZIP 생성 실패';
  const failMsg = failLog.length > 0 ? `\n실패 (${failLog.join(' / ')})` : '';
  showPersistentStatus(summary + failMsg);
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
