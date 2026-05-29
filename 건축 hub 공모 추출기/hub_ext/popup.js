const BUILD_DATE = '2026.05.30';

let extractedData = null;
let cachedUrl = null;

// ── 공모명 정제 ──
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
  name = name.replace(/(설계공모|건축설계공모|제안공모|공모|건립사업|사업|건립)$/, '');
  name = name.replace(/\s+/g, ' ').trim().replace(/[\s·,]+$/, '').trim();
  const extras = found.filter(k => k !== '신축');
  if (extras.length > 0) name += `(${extras.join(', ')})`;
  return name;
}

// ── 유틸리티 ──
function field(key, val) {
  return `<div class="field"><div class="key">${key}</div><div class="val">${val}</div></div>`;
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  fallbackCopy(text);
  return Promise.resolve();
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ── 캐시 초기화 ──
async function clearCache() {
  await chrome.storage.session.remove(['hub_extractedData', 'hub_cachedUrl']);
  extractedData = null;
  cachedUrl = null;
  document.getElementById('result').innerHTML = '';
  document.getElementById('status').innerHTML =
    '<div class="status success">🗑 캐시 초기화됨. 다시 추출하세요.</div>';
}

// ── 추출 ──
async function extract() {
  const btn = document.getElementById('extractBtn');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 추출 중... (수상작 순차 클릭 포함)';
  statusEl.innerHTML = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // 항상 최신 content.js 재주입
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extract' });
    if (!response || !response.success) throw new Error(response ? response.error : '응답 없음');

    extractedData = response.data;
    cachedUrl = tab.url;
    await chrome.storage.session.set({ hub_extractedData: extractedData, hub_cachedUrl: tab.url });

    renderResult(extractedData);
    statusEl.innerHTML = '<div class="status success">✅ 추출 완료!</div>';
  } catch (e) {
    statusEl.innerHTML = `<div class="status error">❌ 오류: ${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🔍 공모 정보 추출';
  }
}

// ── 결과 렌더링 ──
function renderResult(data) {
  document.getElementById('extractBtn').innerHTML = '🔄 다시 추출';
  document.getElementById('extractBtn').disabled = false;

  const competitionName = data['설계공모명'] || data['공모명'] || '';
  const noticeNo   = data['공모번호']    || data['공고번호'] || '';
  const agency     = data['발주기관']    || data['주최']     || data['발주처'] || data['주관기관'] || data['주관'] || '';
  const location   = data['위치']        || data['대지위치'] || data['소재지'] || '';
  const scale      = data['건축규모']    || data['연면적']   || data['건축연면적'] || data['규모'] || '';
  const buildType  = data['건축물주용도'] || data['건축물용도'] || data['용도'] || '';
  const buildAction = data['건축행위']   || '';
  const budget     = data['총사업비']    || '';
  const designCost = data['설계비']      || data['설계용역비'] || '';
  const judges        = data['심사위원_목록'] || [];
  const awards        = data['수상작품_목록'] || [];
  const attachedFiles = data['첨부파일_목록'] || [];
  const schedule      = data['일정_정보']   || {};
  const noticeDate   = data['공고일자']  || schedule['공고일시'] || data['공고일'] || '';
  const announceDate = schedule['발표일'] || schedule['당선작발표'] || '';

  let html = '<div class="result-section">';

  // 공모 개요
  html += '<h3>📋 공모 개요</h3>';
  if (competitionName) html += field('공모명', competitionName);
  if (noticeNo)        html += field('공모번호', noticeNo);
  if (agency)          html += field('발주기관', agency);
  if (location)        html += field('위치', location);
  if (buildType)       html += field('건축물용도', buildType);
  if (buildAction)     html += field('건축행위', buildAction);
  if (scale)           html += field('건축규모', scale);
  if (budget)          html += field('총사업비', budget);
  if (designCost)      html += field('설계비', `<b style="color:#0e7490;">${designCost}</b>`);
  if (noticeDate)      html += field('공고일자', noticeDate);
  if (announceDate)    html += field('당선작 발표일', `<b style="color:#0e7490;">${announceDate}</b>`);

  // 일정 (공고일시/발표일 제외한 나머지, 너무 긴 값은 제외)
  const schedKeys = Object.keys(schedule).filter(k =>
    k !== '공고일시' && k !== '발표일' && schedule[k] && schedule[k].length <= 150
  );
  if (schedKeys.length > 0) {
    html += '<h3 style="margin-top:10px;">📅 일정</h3>';
    schedKeys.forEach(k => { html += field(k, schedule[k]); });
  }

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
    awards.forEach(a => {
      html += `<div class="award-item">`;
      if (a.imgSrc) {
        html += `<img src="${a.imgSrc}" class="award-thumb" alt="${a.awardType}" onerror="this.style.display='none'">`;
      }
      html += `<div class="award-info">
        <div class="award-type">${a.awardType || '-'}</div>
        <div class="award-office">${a.officeName || '-'}</div>
        ${a.representative ? `<div class="award-designer">대표자: ${a.representative}</div>` : ''}
        ${a.coParticipants ? `<div class="award-designer" style="color:#6b7280;">공동: ${a.coParticipants}</div>` : ''}
      </div></div>`;
    });
    const hasImages = awards.some(a => a.imgSrc);
    if (hasImages) {
      html += `<div class="actions" style="margin-top:6px;">
        <button class="secondary" id="downloadImgZipBtn">📦 수상작 이미지 ZIP</button>
      </div>`;
    }
  }

  html += '</div>';

  // 첨부파일
  if (attachedFiles.length > 0) {
    html += '<h3 style="margin-top:10px;">📎 첨부파일</h3>';
    attachedFiles.forEach(f => {
      html += `<div class="field">
        <div class="val" style="font-size:11px; color:#374151;">${f.fileName}</div>
      </div>`;
    });
    html += `<div class="actions" style="margin-top:6px;">
      <button class="green" id="downloadAttachedBtn">📦 첨부파일 ZIP 다운로드</button>
    </div>`;
  }

  // 정리도구용 복사
  html += `<div class="actions" style="margin-top:8px;">
    <button id="copyToolBtn">🔗 정리도구용 복사</button>
  </div>`;

  document.getElementById('result').innerHTML = html;

  document.getElementById('copyToolBtn').addEventListener('click', copyForTool);
  if (judges.length > 0) {
    document.getElementById('downloadTxtBtn').addEventListener('click', downloadJudgesTxt);
  }
  const imgBtn = document.getElementById('downloadImgZipBtn');
  if (imgBtn) imgBtn.addEventListener('click', downloadAwardImages);
  const attBtn = document.getElementById('downloadAttachedBtn');
  if (attBtn) attBtn.addEventListener('click', downloadAttachedFiles);
}

// ── 심사위원 TXT 다운로드 ──
function downloadJudgesTxt() {
  const judges = extractedData['심사위원_목록'] || [];
  const cName = (extractedData['공모명'] || '공모').replace(/\s+/g, '_');
  const lines = judges.map(j => {
    const type = j.type && j.type.includes('예비') ? '예비' : (j.type || '외부');
    return `${type}, ${j.name}, ${j.org || ''}`;
  });
  const text = lines.join('\n');
  const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: `심사위원_${cName}.txt`, conflictAction: 'overwrite', saveAs: false },
    () => { URL.revokeObjectURL(url); showToast('✅ TXT 다운로드 완료'); }
  );
}

// ── 첨부파일 ZIP 다운로드 ──
async function downloadAttachedFiles() {
  const btn = document.getElementById('downloadAttachedBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 수집 중...';

  const files = extractedData['첨부파일_목록'] || [];
  const cName = (extractedData['설계공모명'] || extractedData['공모명'] || '공모').replace(/\s+/g, '_');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 팝업에서 진행상황 표시 (페이지 변수 주기적으로 읽기)
  const progressTimer = setInterval(async () => {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => window.__hubAttachProgress ?? 0,
      });
      const cur = r?.result || 0;
      if (cur > 0) btn.innerHTML = `<span class="spinner"></span> ${cur}/${files.length} 수집 중...`;
    } catch {}
  }, 400);

  // executeScript 한 번으로 전체 파일 순차 수집 (개별 호출 오버헤드 제거)
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (fileCount) => {
      const isFileCt = c => /octet-stream|\/pdf|officedocument|hwp|zip/i.test(c);
      const isFileCd = d => /attachment|filename/i.test(d);

      // 인터셉터 1회 설치
      const origCOU    = URL.createObjectURL;
      const origOpen   = XMLHttpRequest.prototype.open;
      const origSend   = XMLHttpRequest.prototype.send;
      const origFetch  = window.fetch;
      const origSubmit = HTMLFormElement.prototype.submit;
      const origWOpen  = window.open;
      const origAClick = HTMLAnchorElement.prototype.click;

      // 파일별 캡처 상태
      let blobPromise = null, blobCaptured = false;
      let xhrDataPromise = null, xhrCaptured = false;
      let fetchDataPromise = null, fetchCaptured = false;
      let formUrl = null, formBody = null, formMethod = 'GET';
      let windowOpenUrl = null, capturedFileName = null;

      const resetCapture = () => {
        blobPromise = null; blobCaptured = false;
        xhrDataPromise = null; xhrCaptured = false;
        fetchDataPromise = null; fetchCaptured = false;
        formUrl = null; formBody = null; formMethod = 'GET';
        windowOpenUrl = null; capturedFileName = null;
      };
      const anyCaptured = () => blobCaptured || xhrCaptured || fetchCaptured || windowOpenUrl || formUrl;

      URL.createObjectURL = function(blob) {
        const url = origCOU.call(URL, blob);
        if (!blobPromise && blob.size > 500) {
          blobCaptured = true;
          blobPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(blob); });
        }
        return url;
      };
      HTMLAnchorElement.prototype.click = function() {
        const href = this.href || '';
        if (href.startsWith('blob:') || (href.startsWith('http') && href !== location.href)) {
          if (!windowOpenUrl && !href.startsWith('blob:')) windowOpenUrl = href;
          return;
        }
        origAClick.call(this);
      };
      HTMLFormElement.prototype.submit = function() {
        if (formUrl) return;
        const method = (this.method || 'GET').toUpperCase();
        const fd = new FormData(this); formMethod = method;
        if (method === 'POST') { formUrl = this.action; formBody = fd; }
        else { formUrl = this.action + '?' + new URLSearchParams(fd).toString(); }
      };
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
            if (this.response instanceof ArrayBuffer && this.response.byteLength > 0) xhrDataPromise = Promise.resolve(new Uint8Array(this.response));
            else if (this.response instanceof Blob && this.response.size > 0) xhrDataPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.readAsArrayBuffer(this.response); });
          }
        });
        return origSend.call(this, b);
      };
      window.fetch = async function(url, opts) {
        const resp = await origFetch.call(this, url, opts);
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
      window.open = function(url, ...a) { if (url && url !== 'about:blank') { windowOpenUrl = String(url); return null; } return origWOpen.call(window, url, ...a); };

      // 파일별 순차 수집
      window.__hubAttachProgress = 0;
      const results = [];
      for (let idx = 0; idx < fileCount; idx++) {
        window.__hubAttachProgress = idx + 1;
        resetCapture();
        const dlBtn = document.querySelector(`[data-hub-attached="${idx}"]`);
        if (!dlBtn) { results.push(null); continue; }

        dlBtn.click();
        // 캡처될 때까지 최대 2.5초 대기 (80ms × 30회)
        for (let t = 0; t < 30; t++) {
          await new Promise(r => setTimeout(r, 80));
          if (anyCaptured()) break;
        }
        if (blobCaptured || xhrCaptured || fetchCaptured) await new Promise(r => setTimeout(r, 100));

        let fileData = null, fileName = capturedFileName;
        if (blobPromise)      { const b = await blobPromise;      if (b?.length > 0) fileData = b; }
        if (!fileData && xhrDataPromise)   { const b = await xhrDataPromise;   if (b?.length > 0) fileData = b; }
        if (!fileData && fetchDataPromise) { const b = await fetchDataPromise; if (b?.length > 0) fileData = b; }
        if (!fileData && formUrl) {
          try {
            const opts = { credentials: 'include', method: formMethod };
            if (formMethod === 'POST' && formBody) opts.body = formBody;
            const resp = await origFetch.call(window, formUrl, opts);
            if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) fileData = new Uint8Array(buf); }
          } catch {}
        }
        if (!fileData && windowOpenUrl) {
          try {
            const resp = await origFetch.call(window, windowOpenUrl, { credentials: 'include' });
            if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) fileData = new Uint8Array(buf); }
          } catch {}
        }
        if (fileData) {
          // Array.from 대신 base64로 인코딩 → IPC JSON 직렬화 속도 대폭 향상
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < fileData.length; i += chunk)
            binary += String.fromCharCode(...fileData.subarray(i, i + chunk));
          results.push({ base64: btoa(binary), fileName });
        } else {
          results.push(null);
        }
      }

      // 인터셉터 복원
      URL.createObjectURL = origCOU; HTMLAnchorElement.prototype.click = origAClick;
      HTMLFormElement.prototype.submit = origSubmit;
      XMLHttpRequest.prototype.open = origOpen; XMLHttpRequest.prototype.send = origSend;
      window.fetch = origFetch; window.open = origWOpen;

      return results;
    },
    args: [files.length],
  });

  clearInterval(progressTimer);
  btn.innerHTML = '<span class="spinner"></span> ZIP 생성 중...';
  await new Promise(r => setTimeout(r, 30)); // 브라우저 렌더링 틈

  const results = result?.result || [];
  const zipFiles = [], failLog = [];
  results.forEach((r, i) => {
    if (r?.base64) {
      const binary = atob(r.base64);
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      zipFiles.push({ name: r.fileName || files[i]?.fileName || `파일_${i + 1}`, data: bytes });
    } else {
      failLog.push(files[i]?.fileName || `파일_${i + 1}`);
    }
  });

  if (zipFiles.length > 0) {
    const zipBytes = buildZip(zipFiles);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `첨부파일_${cName}.zip`; a.click();
    URL.revokeObjectURL(url);
    btn.disabled = false;
    btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
    const msg = `✅ ${zipFiles.length}개 ZIP 완료!` + (failLog.length ? `\n⚠️ 실패: ${failLog.join(', ')}` : '');
    showToast(msg);
  } else {
    btn.disabled = false;
    btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
    showToast('⚠️ 파일을 가져오지 못했습니다.\n직접 다운로드해 주세요.');
  }
}

// ── 수상작 이미지 ZIP 다운로드 ──
async function downloadAwardImages() {
  const btn = document.getElementById('downloadImgZipBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 다운로드 중...';

  const awards  = extractedData['수상작품_목록'] || [];
  const cName   = (extractedData['설계공모명'] || extractedData['공모명'] || '공모').replace(/\s+/g, '_');

  try {
    const files = [];
    for (let i = 0; i < awards.length; i++) {
      const a = awards[i];
      if (!a.imgSrc) continue;
      try {
        const resp = await fetch(a.imgSrc);
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        const ct  = resp.headers.get('content-type') || '';
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg';
        const label = (a.awardType || `수상작_${i + 1}`).replace(/\s+/g, '_');
        files.push({ name: `${label}.${ext}`, data: new Uint8Array(buf) });
      } catch { /* 개별 실패 무시 */ }
    }
    if (files.length === 0) { showToast('⚠️ 다운로드할 이미지가 없습니다.'); return; }

    const zipBytes = buildZip(files);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `수상작품_${cName}.zip`; a.click();
    URL.revokeObjectURL(url);
    showToast(`✅ ${files.length}개 이미지 ZIP 완료!`);
  } catch (e) {
    showToast('❌ 오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📦 수상작 이미지 ZIP';
  }
}

// ── 정리도구용 JSON 복사 ──
async function copyForTool() {
  if (!extractedData) return;
  const btn = document.getElementById('copyToolBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 준비 중...';

  const d = extractedData;

  const judges = (d['심사위원_목록'] || []).map(j => ({
    type: j.type || '외부',
    name: j.name,
    org:  j.org  || '',
    pos:  j.pos  || '',
    qual: j.qual || '',
  }));

  // 수상작 이미지 base64 변환 후 awardType별로 묶기
  // 1단계: 원시 목록 구성 (대표자 + 공동참여자 전부 평탄화)
  const rawAwards = [];
  for (const a of (d['수상작품_목록'] || [])) {
    let imgBase64 = '', imgMime = 'image/jpeg';
    if (a.imgSrc) {
      try {
        const resp = await fetch(a.imgSrc);
        if (resp.ok) {
          const buf   = await resp.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary  = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          imgBase64 = btoa(binary);
          imgMime   = resp.headers.get('content-type') || 'image/jpeg';
        }
      } catch { /* 이미지 변환 실패 무시 */ }
    }

    // 대표자 (이미지 포함)
    rawAwards.push({
      awardType: a.awardType,
      office:    a.officeName,
      designer:  a.representative,
      imgBase64,
      imgMime,
      imgSrc:    a.imgSrc || null,
    });

    // 공동참여자: "사무소명(대표자명)" 또는 "사무소명 대표자명" 패턴 처리
    if (a.coParticipants) {
      const coList = a.coParticipants.split(/[,/·]/).map(s => s.trim()).filter(Boolean);
      for (const co of coList) {
        // 우선: "건축사사무소이움(유성욱)" → office: "건축사사무소이움", designer: "유성욱"
        const parenMatch = co.match(/^(.+?)\(([가-힣]{2,4})\)$/);
        if (parenMatch) {
          rawAwards.push({ awardType: a.awardType, office: parenMatch[1].trim(), designer: parenMatch[2], imgBase64: '', imgMime: '', imgSrc: null });
        } else {
          // 차선: "사무소명 대표자명" → 마지막 한글 2~4자가 대표자
          const m = co.match(/^(.+?)\s+([가-힣]{2,4})$/);
          rawAwards.push({ awardType: a.awardType, office: m ? m[1].trim() : co, designer: m ? m[2].trim() : '', imgBase64: '', imgMime: '', imgSrc: null });
        }
      }
    }
  }

  // 2단계: awardType 순서를 유지하면서 묶기
  const awardMap = new Map(); // awardType → { offices[], designers[], imgBase64, imgMime, imgSrc }
  for (const r of rawAwards) {
    if (!awardMap.has(r.awardType)) {
      awardMap.set(r.awardType, { offices: [], designers: [], imgBase64: r.imgBase64, imgMime: r.imgMime, imgSrc: r.imgSrc });
    }
    const g = awardMap.get(r.awardType);
    if (r.office)   g.offices.push(r.office);
    if (r.designer) g.designers.push(r.designer);
    // 이미지는 처음 등장한 것 사용 (이미 Map 생성 시 설정됨)
  }

  const awards = Array.from(awardMap.entries()).map(([awardType, g]) => {
    const entry = {
      awardType,
      num:     '',
      office:  g.offices.join(', '),
      designer: g.designers.join(', '),
    };
    if (g.imgBase64) {
      entry.imgBase64 = g.imgBase64;
      entry.imgMime   = g.imgMime;
    } else if (g.imgSrc) {
      entry.imgSrc = g.imgSrc;
    }
    return entry;
  });

  const schedule = d['일정_정보'] || {};
  const toolData = {
    competitionName:  cleanCompetitionName(d['설계공모명'] || d['공모명'] || ''),
    buildType:        d['건축물주용도'] || d['건축물용도'] || d['시설용도'] || d['용도'] || '',
    noticeNo:         d['공모번호']    || d['공고번호'] || '',
    agency:           d['발주기관']    || d['주최']     || d['발주처'] || d['주관기관'] || d['주관'] || '',
    location:         d['위치']        || d['대지위치'] || d['소재지'] || '',
    scale:            d['건축규모']    || d['연면적']   || d['건축연면적'] || d['규모'] || '',
    budget:           d['총사업비']    || '',
    constructionCost: d['공사비']      || '',
    designCost:       d['설계비']      || d['설계용역비'] || '',
    noticeDate:       d['공고일자']    || schedule['공고일시'] || d['공고일'] || '',
    announceDate:     schedule['발표일'] || '',
    chairperson:      '',
    judges_planned:   judges,
    judges_attended:  [],
    awards,
    files: [],
  };

  await copyToClipboard(JSON.stringify(toolData));
  showToast('✅ 정리도구용 JSON 복사됨!\n(이미지 포함)');

  btn.disabled = false;
  btn.innerHTML = '🔗 정리도구용 복사';
}

// ── 순수 JS ZIP 빌더 (Store 방식) ──
function buildZip(files) {
  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc  = crc32(file.data);
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
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true); central.set(nameBytes, 46);
    centralHeaders.push(central);
    offset += local.length;
  }

  const centralSize = centralHeaders.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);

  const zip = new Uint8Array(offset + centralSize + 22);
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

// ── 초기화 ──
async function init() {
  document.getElementById('buildDate').textContent = BUILD_DATE;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const main = document.getElementById('main');

  if (!tab.url?.includes('hub.go.kr')) {
    main.innerHTML = `
      <div class="not-supported">
        <div class="icon">🏛️</div>
        <div>hub.go.kr 페이지에서 사용해주세요.</div>
      </div>`;
    return;
  }

  main.innerHTML = `
    <button id="extractBtn">🔍 공모 정보 추출</button>
    <div id="status"></div>
    <div id="result"></div>`;
  document.getElementById('extractBtn').addEventListener('click', extract);

  // 이전 결과 캐시 복원
  const stored = await chrome.storage.session.get(['hub_extractedData', 'hub_cachedUrl']);
  if (stored.hub_cachedUrl === tab.url && stored.hub_extractedData) {
    extractedData = stored.hub_extractedData;
    cachedUrl = stored.hub_cachedUrl;
    renderResult(extractedData);
    document.getElementById('status').innerHTML = `
      <div class="status success" style="display:flex; justify-content:space-between; align-items:center;">
        <span>✅ 이전 추출 결과 (URL 동일)</span>
        <button onclick="clearCache()" style="width:auto; padding:2px 8px; font-size:11px; background:#6b7280;">초기화</button>
      </div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
