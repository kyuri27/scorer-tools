const BUILD_DATE = '2026.05.30';

// 현재 사이트 모드: 'seumter' | 'g2b' | 'hub' | 'ai'
let siteMode = 'ai';
let extractedData = null;
let cachedUrl = null;

// ═══════════════════════════════════════════════════
// 공통 유틸리티
// ═══════════════════════════════════════════════════

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

function pick(data, ...keys) {
  for (const k of keys) {
    if (data[k] && data[k].trim()) return data[k].trim();
  }
  return '';
}

function parseAmount(str) {
  if (!str) return '';
  return str.replace(/[^\d]/g, '');
}

function field(key, val) {
  return `<div class="field"><div class="key">${key}</div><div class="val">${val}</div></div>`;
}

function dateToYYMMDD(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1].slice(2)}${m[2]}${m[3]}` : '';
}

function normalizeDate(str) {
  if (!str) return '';
  const m = str.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : str;
}

// ── ZIP 관련 ──

async function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
      eocdOffset = i; break;
    }
  }
  if (eocdOffset === -1) throw new Error('EOCD not found');
  const cdCount  = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014B50) break;
    const flags          = view.getUint16(pos + 8,  true);
    const compression    = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen        = view.getUint16(pos + 28, true);
    const extraLen       = view.getUint16(pos + 30, true);
    const commentLen     = view.getUint16(pos + 32, true);
    const localOffset    = view.getUint32(pos + 42, true);
    const encoding = (flags & 0x0800) ? 'utf-8' : 'euc-kr';
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
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, date.time, true); lv.setUint16(12, date.date, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30); local.set(file.data, 30 + nameBytes.length);
    localHeaders.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, date.time, true);
    cv.setUint16(14, date.date, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true);
    cv.setUint32(24, size, true); cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralHeaders.push(central);
    offset += local.length;
  }
  const centralSize = centralHeaders.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
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

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'status success';
  toast.style.marginTop = '6px';
  toast.textContent = msg;
  document.getElementById('result').appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showPersistentStatus(msg) {
  const el = document.createElement('div');
  el.className = 'status success';
  el.style.cssText = 'margin-top:6px; white-space:pre-wrap; font-size:11px;';
  el.textContent = msg;
  document.getElementById('result').appendChild(el);
}

// ── API 키 / 설정 패널 ──

async function loadApiKey() {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  return geminiApiKey || '';
}
async function saveApiKey(key) {
  await chrome.storage.local.set({ geminiApiKey: key.trim() });
}

function initSettings() {
  const btn    = document.getElementById('settingsBtn');
  const panel  = document.getElementById('settingsPanel');
  const input  = document.getElementById('apiKeyInput');
  const saveBtn = document.getElementById('saveApiKeyBtn');
  const status = document.getElementById('apiKeyStatus');

  btn.addEventListener('click', async () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      const key = await loadApiKey();
      input.value = key;
      status.textContent = key ? '✅ API 키 저장됨' : '';
    }
  });

  saveBtn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) { status.textContent = '⚠️ 키를 입력해주세요'; return; }
    await saveApiKey(key);
    status.textContent = '✅ 저장됐습니다';
    setTimeout(() => panel.classList.add('hidden'), 800);
  });
}

// ═══════════════════════════════════════════════════
// 세움터 전용
// ═══════════════════════════════════════════════════

async function clearCacheSeumter() {
  await chrome.storage.session.remove(['extractedData', 'cachedUrl']);
  extractedData = null; cachedUrl = null;
  document.getElementById('result').innerHTML = '';
  document.getElementById('status').innerHTML =
    '<div class="status success">🗑 캐시 초기화됨. 다시 추출하세요.</div>';
}

async function extractSeumter() {
  const btn = document.getElementById('extractBtn');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 추출 중...';
  statusEl.innerHTML = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_seumter.js'] });
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extract' });
    if (!response || !response.success) throw new Error(response ? response.error : '응답 없음');
    extractedData = response.data;
    cachedUrl = tab.url;
    await chrome.storage.session.set({ extractedData, cachedUrl: tab.url });
    renderResultSeumter(extractedData);
    statusEl.innerHTML = '<div class="status success">✅ 추출 완료!</div>';
  } catch (e) {
    statusEl.innerHTML = `<div class="status error">❌ 오류: ${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🔍 공모 정보 추출';
  }
}

function renderResultSeumter(data) {
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
  html += '<h3>📋 공모 개요</h3>';
  if (competitionName) html += field('공모명', competitionName);
  if (noticeNo)        html += field('공모번호', noticeNo);
  if (agency)          html += field('공고기관', agency);
  if (location)        html += field('위치', location);
  if (scale)           html += field('건축연면적', scale);
  if (budget)          html += field('총사업비', budget);
  if (noticeDate)      html += field('공고일시', noticeDate);
  if (announceDate)    html += field('당선작 발표일', `<b style="color:#2563eb;">${announceDate}</b>`);

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

  if (awards.length > 0) {
    html += '<h3 style="margin-top:10px;">🏆 수상작품</h3>';
    awards.forEach(a => {
      html += `<div class="award-item">`;
      if (a.imgSrc) html += `<img src="${a.imgSrc}" class="award-thumb" alt="${a.awardType}">`;
      html += `<div class="award-info">
        <div class="award-type">${a.awardType || '-'}</div>
        <div class="award-office">${a.officeName || '-'}</div>
        ${a.designer ? `<div class="award-designer">대표설계자: ${a.designer}</div>` : ''}
      </div></div>`;
    });
  }

  if (attachedFiles.length > 0) {
    html += '<h3 style="margin-top:10px;">📎 첨부파일</h3>';
    attachedFiles.forEach(f => {
      html += `<div class="field">
        <div class="key">${f.category}</div>
        <div class="val" style="font-size:10px; color:#6b7280;">${f.fileName}</div>
      </div>`;
    });
  }

  if (judgeResultFiles.length > 0) {
    html += '<h3 style="margin-top:10px;">📊 심사결과 파일</h3>';
    judgeResultFiles.forEach(f => {
      html += `<div class="field">
        <div class="val" style="font-size:10px; color:#6b7280;">${f.label}</div>
      </div>`;
    });
  }

  html += '</div>';

  if (awards.length > 0) {
    html += `<div class="actions" style="margin-top:6px;">
      <button class="green" id="downloadZipBtn">📦 수상작 이미지 ZIP 다운로드</button>
    </div>`;
  }
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
  if (awards.length > 0) {
    document.getElementById('downloadZipBtn').addEventListener('click', downloadAwardImages);
  }
  if (attachedFiles.length > 0) {
    document.getElementById('downloadAttachedBtn').addEventListener('click', () => downloadAllAttachedSeumter(data));
  }
  if (judgeResultFiles.length > 0) {
    document.getElementById('downloadJudgeResultBtn').addEventListener('click', () => downloadJudgeResultFiles(data));
  }
  document.getElementById('copyToolBtn').addEventListener('click', copyForToolSeumter);
  if (judges.length > 0) {
    document.getElementById('downloadTxtBtn').addEventListener('click', downloadJudgesTxt);
  }
}

function downloadJudgesTxt() {
  const judges = extractedData['심사위원_목록'] || [];
  const lines = judges.map(j => {
    const type = j.type && j.type.includes('예비') ? '예비' : (j.type || '외부');
    return `${type}, ${j.name}, ${j.org || ''}`;
  });
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: 'judges.txt', conflictAction: 'overwrite', saveAs: false },
    () => { URL.revokeObjectURL(url); showToast('✅ TXT 다운로드 완료'); }
  );
}

async function copyForToolSeumter() {
  if (!extractedData) return;
  const btn = document.getElementById('copyToolBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 준비 중...';

  const judges = (extractedData['심사위원_목록'] || []).map(j => ({
    type: j.type || '외부', name: j.name, org: j.org || '', pos: j.pos || '', qual: j.qual || '',
  }));
  const name = extractedData['설계공모명'] || extractedData['공모명'] || extractedData['공모명_원본'] || '';
  const cleanName = cleanCompetitionName(name);

  const awards = [];
  for (const a of (extractedData['수상작품_목록'] || [])) {
    let imgBase64 = '', imgMime = 'image/jpeg';
    if (a.imgSrc) {
      try {
        const resp = await fetch(a.imgSrc);
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        imgBase64 = btoa(binary);
        imgMime = resp.headers.get('content-type') || 'image/jpeg';
      } catch {}
    }
    awards.push({ awardType: a.awardType, office: a.officeName, designer: a.designer, num: '', imgBase64, imgMime });
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

  copyToClipboard(JSON.stringify(toolData))
    .then(() => showToast('✅ 정리도구용 JSON 복사됨!\n(이미지 포함)'))
    .catch(() => showToast('❌ 클립보드 복사 실패'));
  btn.disabled = false;
  btn.innerHTML = '🔗 정리도구용 복사';
}

async function downloadAwardImages() {
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
      } catch {}
    }
    if (files.length === 0) { showToast('다운로드할 이미지가 없습니다.'); return; }
    await downloadZipBundle(files, `수상작품_${competitionName}.zip`);
    showToast(`✅ ${files.length}개 이미지 ZIP 다운로드 완료!`);
  } catch (e) {
    showToast('오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📦 수상작 이미지 ZIP 다운로드';
  }
}

async function captureFileFromPageSeumter(tabId, elType, idx) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (elType, idx) => {
      let btn;
      if (elType === 'attached') {
        const root = document.querySelector('.content_opt.content6, .content6, [class*="content6"]') || document;
        btn = document.querySelector(`[data-seumter-attached="${idx}"]`)
           || Array.from(root.querySelectorAll('button.download'))[idx]
           || Array.from(document.querySelectorAll('button.download'))[idx];
      } else {
        const judgeKeywords = ['투표결과', '평가점수', '평가사유서'];
        btn = document.querySelector(`[data-seumter-judge="${idx}"]`)
           || Array.from(document.querySelectorAll('button, a, td, div, li')).filter(el => {
                const t = el.textContent.replace(/\s/g, '');
                if (!t.includes('심사위원')) return false;
                return judgeKeywords.filter(k => t.includes(k)).length === 1;
              })[idx];
      }
      if (!btn) return { _dbg: `btn_not_found_${elType}_${idx}` };

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
        } catch {}
      }

      let xhrUrl = null, xhrDataPromise = null, xhrCaptured = false;
      let fetchDataPromise = null, fetchCaptured = false;
      let windowOpenUrl = null, locationUrl = null;
      let blobPromise = null, blobCaptured = false;

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;
      const origCOU = URL.createObjectURL;
      const origAClick = HTMLAnchorElement.prototype.click;
      const origWindowOpen = window.open;
      const origAssign = location.assign.bind(location);
      const origReplace = location.replace.bind(location);
      let origHrefDesc = null;

      const isFileCt = c => c.includes('octet-stream') || c.includes('/pdf') || c.includes('officedocument') || c.includes('hwp') || c.includes('zip');
      const isFileCd = d => d.includes('attachment') || d.includes('filename');
      const anyCaptured = () => blobCaptured || xhrCaptured || fetchCaptured || windowOpenUrl || locationUrl;

      XMLHttpRequest.prototype.open = function(m, url, ...r) { this.__u = String(url); return origOpen.call(this, m, url, ...r); };
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
              xhrDataPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(this.response); });
            } else { xhrUrl = this.__u; xhrCaptured = false; }
          }
        });
        return origSend.call(this, b);
      };
      window.fetch = async function(url, options) {
        const resp = await origFetch.call(this, url, options);
        if (!fetchCaptured) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          const cd = (resp.headers.get('content-disposition') || '').toLowerCase();
          if (isFileCd(cd) || isFileCt(ct)) { fetchCaptured = true; fetchDataPromise = resp.clone().arrayBuffer().then(buf => new Uint8Array(buf)); }
        }
        return resp;
      };
      URL.createObjectURL = function(blob) {
        const url = origCOU.call(URL, blob);
        if (!blobPromise && blob.size > 500) {
          blobCaptured = true;
          blobPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(blob); });
        }
        return url;
      };
      HTMLAnchorElement.prototype.click = function() { if (anyCaptured()) return; origAClick.call(this); };
      window.open = function(url, ...args) { if (url && url !== 'about:blank' && url !== '') { windowOpenUrl = String(url); return null; } return origWindowOpen.call(window, url, ...args); };
      try {
        origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (origHrefDesc?.configurable) {
          Object.defineProperty(Location.prototype, 'href', { ...origHrefDesc,
            set(url) { const s = String(url); if (!locationUrl && s !== location.href && (s.startsWith('http') || s.startsWith('/'))) { locationUrl = s; return; } origHrefDesc.set.call(this, url); }, configurable: true });
        }
      } catch {}
      location.assign = function(url) { if (!locationUrl) locationUrl = String(url); };
      location.replace = function(url) { if (!locationUrl) locationUrl = String(url); };

      btn.click();
      for (let t = 0; t < 30; t++) { await new Promise(r => setTimeout(r, 100)); if (anyCaptured() || xhrUrl) break; }
      if (blobCaptured || xhrDataPromise || fetchDataPromise) await new Promise(r => setTimeout(r, 200));

      XMLHttpRequest.prototype.open = origOpen; XMLHttpRequest.prototype.send = origSend;
      window.fetch = origFetch; URL.createObjectURL = origCOU;
      HTMLAnchorElement.prototype.click = origAClick; window.open = origWindowOpen;
      location.assign = origAssign; location.replace = origReplace;
      try { if (origHrefDesc) Object.defineProperty(Location.prototype, 'href', origHrefDesc); } catch {}

      if (blobPromise) { const b = await blobPromise; if (b?.length > 0) return { data: Array.from(b), _dbg: 'blob' }; }
      if (xhrDataPromise) { const b = await xhrDataPromise; if (b?.length > 0) return { data: Array.from(b), _dbg: 'xhr_body' }; }
      if (fetchDataPromise) { const b = await fetchDataPromise; if (b?.length > 0) return { data: Array.from(b), _dbg: 'fetch_body' }; }
      for (const url of [locationUrl, windowOpenUrl, xhrUrl].filter(Boolean)) {
        try {
          const fullUrl = new URL(url, location.origin).href;
          const resp = await origFetch.call(window, fullUrl, { credentials: 'include' });
          if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'refetch' }; }
        } catch {}
      }
      return { _dbg: 'nothing_captured' };
    },
    args: [elType, idx],
  });
  return result?.result ?? { _dbg: 'script_null' };
}

async function _cdpCapture(tabId, fileCount) {
  const results = [];
  const seenRequests = [];
  let attached = false;
  try {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch { try { await chrome.debugger.detach({ tabId }); } catch {} await chrome.debugger.attach({ tabId }, '1.3'); }
    attached = true;
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', { patterns: [{ requestStage: 'Response' }] });

    const resolvers = [];
    const SKIP = ['text/html', 'javascript', 'text/css', 'application/json', 'image/', 'font/'];

    const onEv = async (src, method, params) => {
      if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
      const { requestId, request = {}, responseHeaders = [], responseStatusCode } = params;
      const h = (n) => (responseHeaders.find(h => h.name.toLowerCase() === n)?.value || '').toLowerCase();
      const ct = h('content-type'), cd = h('content-disposition');
      const urlShort = (request.url || '').replace(/^https?:\/\//, '').slice(0, 60);
      seenRequests.push(`[${responseStatusCode}] ct=${ct.slice(0,35)} cd=${cd.slice(0,25)} url=${urlShort}`);

      const isFile = cd.includes('attachment') || cd.includes('filename') ||
        ct.includes('/pdf') || ct.includes('octet-stream') || ct.includes('hwp') ||
        ct.includes('x-download') || ct.includes('force-download') || ct.includes('msdownload') ||
        ct.includes('application/zip') || (!SKIP.some(s => ct.includes(s)) && ct.startsWith('application/'));

      if (isFile && resolvers.length > 0) {
        const resolveCapture = resolvers.shift();
        const fileUrl = request.url, fileMethod = (request.method || 'GET').toUpperCase();
        const postData = request.postData || null, reqHeaders = request.headers || {};
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
            requestId, responseCode: 204, responseHeaders: [{ name: 'content-length', value: '0' }], body: ''
          });
        } catch { try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }); } catch {} }

        (async () => {
          let base64 = null, fileName = null;
          try {
            const fetchOpts = { credentials: 'include', method: fileMethod };
            if (fileMethod === 'POST' && postData) {
              fetchOpts.body = postData;
              const reqCt = reqHeaders['content-type'] || reqHeaders['Content-Type'];
              if (reqCt) fetchOpts.headers = { 'Content-Type': reqCt };
            }
            const resp = await fetch(fileUrl, fetchOpts);
            if (resp.ok) {
              const respCd = resp.headers.get('content-disposition') || '';
              const fnMatch = respCd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;\r\n]+)/i)
                           || respCd.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
              if (fnMatch) { try { fileName = decodeURIComponent(fnMatch[1].trim()); } catch { fileName = fnMatch[1].trim(); } }
              const buf = await resp.arrayBuffer();
              if (buf.byteLength > 0) {
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
                base64 = btoa(binary);
              }
            }
          } catch {}
          resolveCapture({ base64, fileName });
        })();
      } else {
        try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId }); } catch {}
      }
    };
    chrome.debugger.onEvent.addListener(onEv);

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

    const resolved = await Promise.all(
      captureEntries.map(({ capturePromise, prevSeen }) =>
        Promise.race([capturePromise, new Promise(r => setTimeout(() => r(null), 90000))])
          .then(result => ({ base64: result?.base64 ?? null, fileName: result?.fileName ?? null, _seen: seenRequests.slice(prevSeen) }))
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

async function downloadJudgeResultFiles(data) {
  const files = data['심사결과_파일_목록'] || [];
  const name = data['설계공모명'] || data['공모명'] || data['공모명_원본'] || '';
  const cleanName = cleanCompetitionName(name);
  const btn = document.getElementById('downloadJudgeResultBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 수집 중...`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const zipFiles = [], failLog = [];
  let rawResults = null;

  if (chrome.debugger) {
    rawResults = await _cdpCapture(tab.id, files.length);
  } else {
    try {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'captureJudgeFiles', tabId: tab.id, fileCount: files.length },
          (r) => { chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r); });
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
                     : files[i].label === '심사위원별평가사유서' ? '평가사유서_' : '';
        const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
        if (isZip) {
          try {
            const innerFiles = await parseZip(bytes);
            for (const { name, data } of innerFiles) zipFiles.push({ name: `${prefix}${name}`, data });
          } catch {
            zipFiles.push({ name: `${prefix}${r.fileName || files[i].label + '.zip'}`, data: bytes });
          }
        } else {
          zipFiles.push({ name: `${prefix}${r.fileName || files[i].label + '.pdf'}`, data: bytes });
        }
      } else {
        const seen = r?._seen?.join('\n  ') || '(없음)';
        failLog.push(`${files[i].label}: ${r?._err || 'timeout'}\n  seen:\n  ${seen}`);
      }
    }
  }

  btn.disabled = false;
  btn.innerHTML = '📦 심사결과 파일 ZIP 다운로드';
  if (zipFiles.length > 0) await downloadZipBundle(zipFiles, `심사결과파일_${cleanName}.zip`);
  const summary = zipFiles.length > 0 ? `✅ 심사결과 ZIP ${zipFiles.length}개 완료` : '⚠️ ZIP 생성 실패';
  const failMsg = failLog.length > 0 ? `\n실패 (${failLog.join(' / ')})` : '';
  showPersistentStatus(summary + failMsg);
}

async function downloadAllAttachedSeumter(data) {
  const files = data['첨부파일_목록'] || [];
  const name = data['설계공모명'] || data['공모명'] || data['공모명_원본'] || '';
  const cleanName = cleanCompetitionName(name);
  const yymmdd = dateToYYMMDD((data['일정_정보'] || {})['공고일시'] || '');
  const btn = document.getElementById('downloadAttachedBtn');
  btn.disabled = true;

  const zipFiles = [], failLog = [];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  for (let i = 0; i < files.length; i++) {
    btn.innerHTML = `<span class="spinner"></span> ${i + 1}/${files.length} 수집 중...`;
    let captured = null;
    try { captured = await captureFileFromPageSeumter(tab.id, 'attached', i); } catch {}
    if (captured?.data?.length > 0) {
      zipFiles.push({ name: files[i].fileName, data: new Uint8Array(captured.data) });
    } else {
      failLog.push(`${i + 1}번: ${captured?._dbg || '?'}`);
      try { await chrome.tabs.sendMessage(tab.id, { action: 'clickAttached', index: i }); } catch {}
      await new Promise(r => setTimeout(r, 700));
    }
  }

  btn.disabled = false;
  btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
  if (zipFiles.length > 0) await downloadZipBundle(zipFiles, `첨부파일_${cleanName}_${yymmdd}.zip`);
  const summary = zipFiles.length > 0 ? `✅ ZIP ${zipFiles.length}개 완료` : '⚠️ ZIP 생성 실패';
  const failMsg = failLog.length > 0 ? `\n개별 다운로드 (${failLog.join(' / ')})` : '';
  showPersistentStatus(summary + failMsg);
}

// ═══════════════════════════════════════════════════
// 건축 Hub 전용
// ═══════════════════════════════════════════════════

async function clearCacheHub() {
  await chrome.storage.session.remove(['hub_extractedData', 'hub_cachedUrl']);
  extractedData = null; cachedUrl = null;
  document.getElementById('result').innerHTML = '';
  document.getElementById('status').innerHTML =
    '<div class="status success">🗑 캐시 초기화됨. 다시 추출하세요.</div>';
}

async function extractHub() {
  const btn = document.getElementById('extractBtn');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 추출 중... (수상작 순차 클릭 포함)';
  statusEl.innerHTML = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_hub.js'] });
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extract' });
    if (!response || !response.success) throw new Error(response ? response.error : '응답 없음');
    extractedData = response.data;
    cachedUrl = tab.url;
    await chrome.storage.session.set({ hub_extractedData: extractedData, hub_cachedUrl: tab.url });
    renderResultHub(extractedData);
    statusEl.innerHTML = '<div class="status success">✅ 추출 완료!</div>';
  } catch (e) {
    statusEl.innerHTML = `<div class="status error">❌ 오류: ${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🔍 공모 정보 추출';
  }
}

function renderResultHub(data) {
  document.getElementById('extractBtn').innerHTML = '🔄 다시 추출';
  document.getElementById('extractBtn').disabled = false;

  const schedule      = data['일정_정보'] || {};
  const judges        = data['심사위원_목록'] || [];
  const awards        = data['수상작품_목록'] || [];
  const attachedFiles = data['첨부파일_목록'] || [];
  const competitionName = data['설계공모명'] || data['공모명'] || '';
  const noticeNo     = data['공모번호']    || data['공고번호'] || '';
  const agency       = data['발주기관']    || data['주최']    || data['발주처'] || data['주관기관'] || data['주관'] || '';
  const location     = data['위치']        || data['대지위치'] || data['소재지'] || '';
  const buildType    = data['건축물주용도'] || data['건축물용도'] || data['용도'] || '';
  const buildAction  = data['건축행위']    || '';
  const scale        = data['건축규모']    || data['연면적']  || data['건축연면적'] || data['규모'] || '';
  const budget       = data['총사업비']    || '';
  const designCost   = data['설계비']      || data['설계용역비'] || '';
  const noticeDate   = data['공고일자']    || schedule['공고일시'] || data['공고일'] || '';
  const announceDate = schedule['발표일']  || schedule['당선작발표'] || '';

  let html = '<div class="result-section">';
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

  if (judges.length > 0) {
    html += '<h3 style="margin-top:10px;">👥 심사위원</h3>';
    judges.forEach(j => {
      const isReserve = j.type && j.type.includes('예비');
      const typeLabel = isReserve ? '예비' : (j.type || '외부');
      const pillClass = isReserve ? 'pill-reserve' : 'pill-external';
      html += `<div class="judge-item">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span><span class="name">${j.name}</span> <span class="pill ${pillClass}">${typeLabel}</span></span>
        </div>
        <div class="sub">${j.org || ''}${j.pos ? ' · ' + j.pos : ''}${j.qual ? ' · ' + j.qual : ''}</div>
      </div>`;
    });
    html += `<div class="actions" style="margin-top:6px;">
      <button class="green" id="downloadTxtBtn">📄 심사위원 TXT 다운로드</button>
    </div>`;
  }

  if (awards.length > 0) {
    html += '<h3 style="margin-top:10px;">🏆 수상작품</h3>';
    awards.forEach(a => {
      html += `<div class="award-item">`;
      if (a.imgSrc) html += `<img src="${a.imgSrc}" class="award-thumb" alt="${a.awardType}" onerror="this.style.display='none'">`;
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

  html += '</div>';
  html += `<div class="actions" style="margin-top:8px;">
    <button id="copyToolBtn">🔗 정리도구용 복사</button>
  </div>`;

  document.getElementById('result').innerHTML = html;
  document.getElementById('copyToolBtn').addEventListener('click', copyForToolHub);
  if (judges.length > 0) {
    document.getElementById('downloadTxtBtn').addEventListener('click', downloadJudgesTxtHub);
  }
  const imgBtn = document.getElementById('downloadImgZipBtn');
  if (imgBtn) imgBtn.addEventListener('click', downloadAwardImagesHub);
  const attBtn = document.getElementById('downloadAttachedBtn');
  if (attBtn) attBtn.addEventListener('click', downloadAttachedFilesHub);
}

function downloadJudgesTxtHub() {
  const judges = extractedData['심사위원_목록'] || [];
  const cName = (extractedData['설계공모명'] || extractedData['공모명'] || '공모').replace(/\s+/g, '_');
  const lines = judges.map(j => {
    const type = j.type && j.type.includes('예비') ? '예비' : (j.type || '외부');
    return `${type}, ${j.name}, ${j.org || ''}`;
  });
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: `심사위원_${cName}.txt`, conflictAction: 'overwrite', saveAs: false },
    () => { URL.revokeObjectURL(url); showToast('✅ TXT 다운로드 완료'); }
  );
}

async function downloadAwardImagesHub() {
  const btn = document.getElementById('downloadImgZipBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 다운로드 중...';
  const awards = extractedData['수상작품_목록'] || [];
  const cName  = (extractedData['설계공모명'] || extractedData['공모명'] || '공모').replace(/\s+/g, '_');
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
      } catch {}
    }
    if (files.length === 0) { showToast('⚠️ 다운로드할 이미지가 없습니다.'); return; }
    await downloadZipBundle(files, `수상작품_${cName}.zip`);
    showToast(`✅ ${files.length}개 이미지 ZIP 완료!`);
  } catch (e) {
    showToast('❌ 오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📦 수상작 이미지 ZIP';
  }
}

async function downloadAttachedFilesHub() {
  const btn = document.getElementById('downloadAttachedBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 수집 중...';

  const files = extractedData['첨부파일_목록'] || [];
  const cName = (extractedData['설계공모명'] || extractedData['공모명'] || '공모').replace(/\s+/g, '_');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 팝업에서 진행상황 표시
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

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (fileCount) => {
      const isFileCt = c => /octet-stream|\/pdf|officedocument|hwp|zip/i.test(c);
      const isFileCd = d => /attachment|filename/i.test(d);

      const origCOU = URL.createObjectURL, origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send, origFetch = window.fetch;
      const origSubmit = HTMLFormElement.prototype.submit, origWOpen = window.open;
      const origAClick = HTMLAnchorElement.prototype.click;

      let blobPromise = null, blobCaptured = false;
      let xhrDataPromise = null, xhrCaptured = false;
      let fetchDataPromise = null, fetchCaptured = false;
      let formUrl = null, formBody = null, formMethod = 'GET';
      let windowOpenUrl = null, capturedFileName = null;

      const resetCapture = () => {
        blobPromise = null; blobCaptured = false; xhrDataPromise = null; xhrCaptured = false;
        fetchDataPromise = null; fetchCaptured = false; formUrl = null; formBody = null;
        formMethod = 'GET'; windowOpenUrl = null; capturedFileName = null;
      };
      const anyCaptured = () => blobCaptured || xhrCaptured || fetchCaptured || windowOpenUrl || formUrl;

      URL.createObjectURL = function(blob) {
        const url = origCOU.call(URL, blob);
        if (!blobPromise && blob.size > 500) { blobCaptured = true; blobPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(blob); }); }
        return url;
      };
      HTMLAnchorElement.prototype.click = function() {
        const href = this.href || '';
        if (href.startsWith('blob:') || (href.startsWith('http') && href !== location.href)) { if (!windowOpenUrl && !href.startsWith('blob:')) windowOpenUrl = href; return; }
        origAClick.call(this);
      };
      HTMLFormElement.prototype.submit = function() {
        if (formUrl) return;
        const method = (this.method || 'GET').toUpperCase(); const fd = new FormData(this); formMethod = method;
        if (method === 'POST') { formUrl = this.action; formBody = fd; } else { formUrl = this.action + '?' + new URLSearchParams(fd).toString(); }
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
          if (isFileCd(cd) || isFileCt(ct)) { fetchCaptured = true; const fnM = cd.match(/filename\*?\s*=\s*(?:utf-8'')?([^;\r\n]+)/i); if (fnM) try { capturedFileName = decodeURIComponent(fnM[1].trim()); } catch {} fetchDataPromise = resp.clone().arrayBuffer().then(buf => new Uint8Array(buf)); }
        }
        return resp;
      };
      window.open = function(url, ...a) { if (url && url !== 'about:blank') { windowOpenUrl = String(url); return null; } return origWOpen.call(window, url, ...a); };

      window.__hubAttachProgress = 0;
      const results = [];
      for (let idx = 0; idx < fileCount; idx++) {
        window.__hubAttachProgress = idx + 1;
        resetCapture();
        const dlBtn = document.querySelector(`[data-hub-attached="${idx}"]`);
        if (!dlBtn) { results.push(null); continue; }
        dlBtn.click();
        for (let t = 0; t < 30; t++) { await new Promise(r => setTimeout(r, 80)); if (anyCaptured()) break; }
        if (blobCaptured || xhrCaptured || fetchCaptured) await new Promise(r => setTimeout(r, 100));

        let fileData = null, fileName = capturedFileName;
        if (blobPromise)      { const b = await blobPromise;      if (b?.length > 0) fileData = b; }
        if (!fileData && xhrDataPromise)   { const b = await xhrDataPromise;   if (b?.length > 0) fileData = b; }
        if (!fileData && fetchDataPromise) { const b = await fetchDataPromise; if (b?.length > 0) fileData = b; }
        if (!fileData && formUrl) {
          try { const opts = { credentials: 'include', method: formMethod }; if (formMethod === 'POST' && formBody) opts.body = formBody; const resp = await origFetch.call(window, formUrl, opts); if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) fileData = new Uint8Array(buf); } } catch {}
        }
        if (!fileData && windowOpenUrl) {
          try { const resp = await origFetch.call(window, windowOpenUrl, { credentials: 'include' }); if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) fileData = new Uint8Array(buf); } } catch {}
        }
        if (fileData) {
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < fileData.length; i += chunk)
            binary += String.fromCharCode(...fileData.subarray(i, i + chunk));
          results.push({ base64: btoa(binary), fileName });
        } else {
          results.push(null);
        }
      }

      URL.createObjectURL = origCOU; HTMLAnchorElement.prototype.click = origAClick;
      HTMLFormElement.prototype.submit = origSubmit; XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend; window.fetch = origFetch; window.open = origWOpen;
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
    await downloadZipBundle(zipFiles, `첨부파일_${cName}.zip`);
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

async function copyForToolHub() {
  if (!extractedData) return;
  const btn = document.getElementById('copyToolBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 준비 중...';

  const d = extractedData;
  const judges = (d['심사위원_목록'] || []).map(j => ({
    type: j.type || '외부', name: j.name, org: j.org || '', pos: j.pos || '', qual: j.qual || '',
  }));

  // 수상작 이미지 base64 변환 + awardType별 묶기
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
      } catch {}
    }
    rawAwards.push({ awardType: a.awardType, office: a.officeName, designer: a.representative, imgBase64, imgMime, imgSrc: a.imgSrc || null });
    if (a.coParticipants) {
      const coList = a.coParticipants.split(/[,/·]/).map(s => s.trim()).filter(Boolean);
      for (const co of coList) {
        const parenMatch = co.match(/^(.+?)\(([가-힣]{2,4})\)$/);
        if (parenMatch) {
          rawAwards.push({ awardType: a.awardType, office: parenMatch[1].trim(), designer: parenMatch[2], imgBase64: '', imgMime: '', imgSrc: null });
        } else {
          const m = co.match(/^(.+?)\s+([가-힣]{2,4})$/);
          rawAwards.push({ awardType: a.awardType, office: m ? m[1].trim() : co, designer: m ? m[2].trim() : '', imgBase64: '', imgMime: '', imgSrc: null });
        }
      }
    }
  }

  const awardMap = new Map();
  for (const r of rawAwards) {
    if (!awardMap.has(r.awardType)) awardMap.set(r.awardType, { offices: [], designers: [], imgBase64: r.imgBase64, imgMime: r.imgMime, imgSrc: r.imgSrc });
    const g = awardMap.get(r.awardType);
    if (r.office)   g.offices.push(r.office);
    if (r.designer) g.designers.push(r.designer);
  }
  const awards = Array.from(awardMap.entries()).map(([awardType, g]) => {
    const entry = { awardType, num: '', office: g.offices.join(', '), designer: g.designers.join(', ') };
    if (g.imgBase64) { entry.imgBase64 = g.imgBase64; entry.imgMime = g.imgMime; }
    else if (g.imgSrc) { entry.imgSrc = g.imgSrc; }
    return entry;
  });

  const schedule = d['일정_정보'] || {};
  const toolData = {
    competitionName:  cleanCompetitionName(d['설계공모명'] || d['공모명'] || ''),
    buildType:        d['건축물주용도'] || d['건축물용도'] || d['시설용도'] || d['용도'] || '',
    noticeNo:         d['공모번호']    || d['공고번호'] || '',
    agency:           d['발주기관']    || d['주최']    || d['발주처'] || d['주관기관'] || d['주관'] || '',
    location:         d['위치']        || d['대지위치'] || d['소재지'] || '',
    scale:            d['건축규모']    || d['연면적']  || d['건축연면적'] || d['규모'] || '',
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

  copyToClipboard(JSON.stringify(toolData))
    .then(() => showToast('✅ 정리도구용 JSON 복사됨!\n(이미지 포함)'))
    .catch(() => showToast('❌ 클립보드 복사 실패'));
  btn.disabled = false;
  btn.innerHTML = '🔗 정리도구용 복사';
}

// ═══════════════════════════════════════════════════
// 나라장터 전용
// ═══════════════════════════════════════════════════

async function clearCacheG2B() {
  await chrome.storage.session.remove(['g2b_extractedData', 'g2b_cachedUrl']);
  extractedData = null; cachedUrl = null;
  document.getElementById('result').innerHTML = '';
  document.getElementById('status').innerHTML =
    '<div class="status success">🗑 캐시 초기화됨. 다시 추출하세요.</div>';
}

async function extractG2B() {
  const btn = document.getElementById('extractBtn');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 추출 중...';
  statusEl.innerHTML = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content_g2b.js'] });
    await new Promise(r => setTimeout(r, 300));

    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    statusEl.innerHTML = `<div class="status success">🔍 프레임 ${frames.length}개 탐색 중...</div>`;

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

    let merged = {}, fileData = [];
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

    if (Object.keys(merged).length === 0) throw new Error('데이터를 찾을 수 없습니다');
    extractedData = merged;
    cachedUrl = tab.url;
    await chrome.storage.session.set({ g2b_extractedData: extractedData, g2b_cachedUrl: tab.url });
    renderResultG2B(extractedData);
    statusEl.innerHTML = '<div class="status success">✅ 추출 완료!</div>';
  } catch (e) {
    statusEl.innerHTML = `<div class="status error">❌ 오류: ${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🔍 공고 정보 추출';
  }
}

function renderResultG2B(data) {
  document.getElementById('extractBtn').innerHTML = '🔄 다시 추출';
  document.getElementById('extractBtn').disabled = false;

  const d = data;
  const schedule = d['일정_정보'] || {};
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
  }

  html += '</div>';

  if (attachedFiles.length > 0) {
    html += `<div class="actions" style="margin-top:8px;">
      <button id="downloadAttachedBtn">📦 첨부파일 ZIP 다운로드</button>
    </div>`;
  }
  html += `<div class="actions" style="margin-top:6px;">
    <button id="copyToolBtn">🔗 정리도구용 복사</button>
  </div>`;

  document.getElementById('result').innerHTML = html;
  if (attachedFiles.length > 0) {
    document.getElementById('downloadAttachedBtn').onclick = () => downloadAllAttachedG2B(data);
  }
  document.getElementById('copyToolBtn').onclick = copyForToolG2B;
}

async function copyForToolG2B() {
  if (!extractedData) return;
  const btn = document.getElementById('copyToolBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 준비 중...';

  const d = extractedData;
  const schedule = d['일정_정보'] || {};
  const noticeName = stripG2BAnnotations(pick(d, '공고명'));
  const cleanName  = cleanCompetitionName(noticeName);

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
    _source:          'narajangter',
    _regDeadline:     pick(d, '참가등록마감일시') || schedule['참가등록마감'] || '',
    _evalDate:        schedule['평가일시'] || '',
    _evalPlace:       schedule['평가장소'] || pick(d, '평가장소') || '',
    _estimatedCost:   parseAmount(pick(d, '추정가격')),
  };

  copyToClipboard(JSON.stringify(toolData))
    .then(() => showToast('✅ 정리도구용 JSON 복사됨!'))
    .catch(() => showToast('❌ 클립보드 복사 실패'));
  btn.disabled = false;
  btn.innerHTML = '🔗 정리도구용 복사';
}

async function captureFileFromPageG2B(tabId, idx) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (idx) => {
      const link = document.querySelector(`[data-g2b-file="${idx}"]`);
      if (!link) return { _dbg: `link_not_found_${idx}` };

      const directHref = link.tagName === 'A' && link.href &&
        !link.href.startsWith('javascript:') && !link.href.startsWith('blob:') &&
        !link.href.startsWith('#') && link.href !== location.href;
      if (directHref) {
        try {
          const resp = await fetch(link.href, { credentials: 'include' });
          if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'direct_href' }; }
        } catch {}
      }

      let xhrUrl = null, xhrDataPromise = null, xhrCaptured = false;
      let fetchDataPromise = null, fetchCaptured = false;
      let windowOpenUrl = null, locationUrl = null;
      let blobPromise = null, blobCaptured = false;
      let formUrl = null, formBody = null, formMethod = 'GET';

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;
      const origCOU = URL.createObjectURL;
      const origAClick = HTMLAnchorElement.prototype.click;
      const origWindowOpen = window.open;
      const origSubmit = HTMLFormElement.prototype.submit;

      const isFileCt = c => c.includes('octet-stream') || c.includes('/pdf') || c.includes('officedocument') || c.includes('hwp') || c.includes('zip');
      const isFileCd = d => d.includes('attachment') || d.includes('filename');
      const anyCaptured = () => blobCaptured || xhrCaptured || fetchCaptured || windowOpenUrl || locationUrl || formUrl;

      HTMLFormElement.prototype.submit = function() {
        if (formUrl) return;
        const method = (this.method || 'GET').toUpperCase();
        const action = this.action || location.href;
        const fd = new FormData(this);
        formMethod = method;
        if (method === 'POST') { formUrl = action; formBody = fd; }
        else { const params = new URLSearchParams(fd).toString(); formUrl = action + (params ? '?' + params : ''); }
      };
      XMLHttpRequest.prototype.open = function(m, url, ...r) { this.__u = String(url); return origOpen.call(this, m, url, ...r); };
      XMLHttpRequest.prototype.send = function(b) {
        this.addEventListener('load', function() {
          if (xhrCaptured) return;
          const d = (this.getResponseHeader('content-disposition') || '').toLowerCase();
          const c = (this.getResponseHeader('content-type') || '').toLowerCase();
          if (isFileCd(d) || isFileCt(c)) {
            xhrCaptured = true;
            if (this.response instanceof ArrayBuffer && this.response.byteLength > 0) { xhrDataPromise = Promise.resolve(new Uint8Array(this.response)); }
            else if (this.response instanceof Blob && this.response.size > 0) { xhrDataPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(this.response); }); }
            else { xhrUrl = this.__u; xhrCaptured = false; }
          }
        });
        return origSend.call(this, b);
      };
      window.fetch = async function(url, options) {
        const resp = await origFetch.call(this, url, options);
        if (!fetchCaptured) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          const cd = (resp.headers.get('content-disposition') || '').toLowerCase();
          if (isFileCd(cd) || isFileCt(ct)) { fetchCaptured = true; fetchDataPromise = resp.clone().arrayBuffer().then(buf => new Uint8Array(buf)); }
        }
        return resp;
      };
      URL.createObjectURL = function(blob) {
        const url = origCOU.call(URL, blob);
        if (!blobPromise && blob.size > 500) { blobCaptured = true; blobPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(blob); }); }
        return url;
      };
      HTMLAnchorElement.prototype.click = function() {
        if (anyCaptured()) return;
        const href = this.href;
        if (href && !href.startsWith('javascript:') && !href.startsWith('#') && !href.startsWith('blob:') && href !== location.href) { if (!windowOpenUrl) windowOpenUrl = href; return; }
        origAClick.call(this);
      };
      window.open = function(url, ...args) { if (url && url !== 'about:blank' && url !== '') { windowOpenUrl = String(url); return null; } return origWindowOpen.call(window, url, ...args); };
      let origHrefDesc = null;
      try {
        origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (origHrefDesc?.configurable) {
          Object.defineProperty(Location.prototype, 'href', { ...origHrefDesc,
            set(url) { const s = String(url); if (!locationUrl && s !== location.href && (s.startsWith('http') || s.startsWith('/'))) { locationUrl = s; return; } origHrefDesc.set.call(this, url); }, configurable: true });
        }
      } catch {}
      location.assign  = function(url) { if (!locationUrl) locationUrl = String(url); };
      location.replace = function(url) { if (!locationUrl) locationUrl = String(url); };

      link.click();
      for (let t = 0; t < 40; t++) { await new Promise(r => setTimeout(r, 100)); if (anyCaptured() || xhrUrl) break; }
      if (blobCaptured || xhrDataPromise || fetchDataPromise) await new Promise(r => setTimeout(r, 200));

      HTMLFormElement.prototype.submit = origSubmit; XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend; window.fetch = origFetch; URL.createObjectURL = origCOU;
      HTMLAnchorElement.prototype.click = origAClick; window.open = origWindowOpen;
      try { if (origHrefDesc) Object.defineProperty(Location.prototype, 'href', origHrefDesc); } catch {}

      if (blobPromise) { const b = await blobPromise; if (b?.length > 0) return { data: Array.from(b), _dbg: 'blob' }; }
      if (xhrDataPromise) { const b = await xhrDataPromise; if (b?.length > 0) return { data: Array.from(b), _dbg: 'xhr_body' }; }
      if (fetchDataPromise) { const b = await fetchDataPromise; if (b?.length > 0) return { data: Array.from(b), _dbg: 'fetch_body' }; }
      if (formUrl) {
        try {
          const fetchOpts = { credentials: 'include', method: formMethod };
          if (formMethod === 'POST' && formBody) fetchOpts.body = formBody;
          const resp = await origFetch.call(window, formUrl, fetchOpts);
          if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'form_submit' }; }
        } catch {}
      }
      for (const url of [locationUrl, windowOpenUrl, xhrUrl].filter(Boolean)) {
        try {
          const fullUrl = new URL(url, location.origin).href;
          const resp = await origFetch.call(window, fullUrl, { credentials: 'include' });
          if (resp.ok) { const buf = await resp.arrayBuffer(); if (buf.byteLength > 0) return { data: Array.from(new Uint8Array(buf)), _dbg: 'refetch' }; }
        } catch {}
      }
      return { _dbg: 'nothing_captured' };
    },
    args: [idx],
  });
  return result?.result ?? { _dbg: 'script_null' };
}

async function captureBulkDownloadG2B(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
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

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;
      const origCOU = URL.createObjectURL;
      const origAClick = HTMLAnchorElement.prototype.click;
      const origWindowOpen = window.open;
      const origSubmit = HTMLFormElement.prototype.submit;

      const isFileCt = c => c.includes('octet-stream') || c.includes('/pdf') || c.includes('officedocument') || c.includes('hwp') || c.includes('zip') || c.includes('x-download');
      const isFileCd = d => d.includes('attachment') || d.includes('filename');
      const anyCaptured = () => blobCaptured || xhrCaptured || fetchCaptured || windowOpenUrl || locationUrl || formUrl;

      HTMLFormElement.prototype.submit = function() {
        if (formUrl) return;
        const method = (this.method || 'GET').toUpperCase();
        const action = this.action || location.href;
        const fd = new FormData(this);
        formMethod = method;
        if (method === 'POST') { formUrl = action; formBody = fd; }
        else { const p = new URLSearchParams(fd).toString(); formUrl = action + (p ? '?' + p : ''); }
      };
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
        e.preventDefault(); e.stopPropagation();
      };
      document.addEventListener('submit', submitEventHandler, true);
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
            if (this.response instanceof ArrayBuffer && this.response.byteLength > 0) { xhrDataPromise = Promise.resolve(new Uint8Array(this.response)); }
            else if (this.response instanceof Blob && this.response.size > 0) { xhrDataPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(this.response); }); }
            else { xhrUrl = this.__u; xhrCaptured = false; }
          }
        });
        return origSend.call(this, b);
      };
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
      URL.createObjectURL = function(blob) {
        const url = origCOU.call(URL, blob);
        if (!blobPromise && blob.size > 500) { blobCaptured = true; blobPromise = new Promise(res => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => res(null); fr.readAsArrayBuffer(blob); }); }
        return url;
      };
      HTMLAnchorElement.prototype.click = function() {
        if (anyCaptured()) return;
        const href = this.href;
        if (href && !href.startsWith('javascript:') && !href.startsWith('#') && !href.startsWith('blob:') && href !== location.href) { if (!windowOpenUrl) windowOpenUrl = href; return; }
        origAClick.call(this);
      };
      window.open = function(url, ...args) { if (url && url !== 'about:blank') { windowOpenUrl = String(url); return null; } return origWindowOpen.call(window, url, ...args); };
      let origHrefDesc = null;
      try {
        origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (origHrefDesc?.configurable) {
          Object.defineProperty(Location.prototype, 'href', { ...origHrefDesc, set(url) { const s = String(url); if (!locationUrl && s !== location.href) { locationUrl = s; return; } origHrefDesc.set.call(this, url); }, configurable: true });
        }
      } catch {}

      // alert 억제 (파일 미선택 시 "다운로드 할 파일이 없습니다" 팝업 방지)
      const origAlert = window.alert;
      window.alert = () => {};

      // ── 파일 전체 선택 (WebSquare + DOM 다중 전략) ──
      const fileGridIds = ['grdFile','grdFileList','gridFile','grdAtchFile','grdAtchFileList',
                           'grd_file','grdAtchFileInfo','grdNtceFileInfo','grdAtchFileLst'];
      let wsSelected = false;
      // 전략 A: WebSquare 그리드 API
      for (const gid of fileGridIds) {
        let g = null;
        try { g = window.scwin?.[gid] ?? window.w2?.getObjectById?.(gid); } catch(e) {}
        if (!g) continue;
        try {
          const checkAllMethods = ['setCheckAll','checkAll','selectAll','setAllChecked','setCheckedAll'];
          for (const m of checkAllMethods) {
            if (typeof g[m] === 'function') { g[m](true); wsSelected = true; break; }
          }
          if (!wsSelected) {
            const rc = typeof g.getRowCount === 'function' ? (g.getRowCount() || 0) : 0;
            if (rc > 0) {
              for (let i = 0; i < rc; i++) {
                for (const m of ['setCheck','setChecked','setRowChecked','checkRow']) {
                  if (typeof g[m] === 'function') { try { g[m](i, true); } catch(e) {} break; }
                }
              }
              wsSelected = true;
            }
          }
        } catch(e) {}
        if (wsSelected) { await new Promise(r => setTimeout(r, 150)); break; }
      }
      // 전략 B: DOM 헤더 체크박스 클릭
      if (!wsSelected) {
        const fileSection = btn.closest('[id*="File"],[id*="file"],[id*="grd"],[id*="attach"]') || btn.parentElement;
        const headerCbs = Array.from((fileSection || document).querySelectorAll(
          'thead input[type="checkbox"], th input[type="checkbox"], thead [class*="chk"], thead [class*="check"]'
        ));
        for (const hcb of headerCbs) { hcb.click(); wsSelected = true; }
        if (wsSelected) await new Promise(r => setTimeout(r, 150));
      }
      // 전략 C: 일반 checkbox fallback
      if (!wsSelected) {
        Array.from(document.querySelectorAll('input[type="checkbox"]')).forEach(cb => {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('click',  { bubbles: true }));
        });
        await new Promise(r => setTimeout(r, 150));
      }

      btn.click();
      for (let t = 0; t < 50; t++) { await new Promise(r => setTimeout(r, 100)); if (anyCaptured() || xhrUrl) break; }
      if (blobCaptured || xhrDataPromise || fetchDataPromise) await new Promise(r => setTimeout(r, 300));

      window.alert = origAlert;
      document.removeEventListener('submit', submitEventHandler, true);
      HTMLFormElement.prototype.submit = origSubmit; XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend; window.fetch = origFetch; URL.createObjectURL = origCOU;
      HTMLAnchorElement.prototype.click = origAClick; window.open = origWindowOpen;
      try { if (origHrefDesc) Object.defineProperty(Location.prototype, 'href', origHrefDesc); } catch {}

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
        } catch {}
      }
      return { _dbg: 'nothing_captured' };
    },
  });
  return result?.result ?? { _dbg: 'script_null' };
}

async function downloadAllAttachedG2B(data) {
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
  const beforeDownloads = await new Promise(r => chrome.downloads.search({ orderBy: ['-startTime'], limit: 10 }, r));
  const beforeIds = new Set(beforeDownloads.map(d => d.id));
  let messageShown = false;

  const finishWithNative = async (item) => {
    if (messageShown) return;
    messageShown = true;
    await new Promise(r => setTimeout(r, 700));
    const [updated] = await new Promise(r => chrome.downloads.search({ id: item.id }, r));
    const d = updated || item;
    const name = d.filename?.split('/').pop()?.split('\\').pop()
      || (d.url ? decodeURIComponent(d.url.split('/').pop().split('?')[0]) : '') || '파일';
    showPersistentStatus(`✅ 다운로드 완료 (브라우저 기본 저장)\n${name}`);
    btn.disabled = false;
    btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
  };

  const nativeDownloadPromise = new Promise(resolve => {
    const onCreated = (item) => {
      if (!beforeIds.has(item.id)) { chrome.downloads.onCreated.removeListener(onCreated); resolve(item); }
    };
    chrome.downloads.onCreated.addListener(onCreated);
    setTimeout(() => { chrome.downloads.onCreated.removeListener(onCreated); resolve(null); }, 10000);
  });
  nativeDownloadPromise.then(item => { if (item) finishWithNative(item); });

  const captured = await captureBulkDownloadG2B(tab.id);
  if (messageShown) return;

  if (captured?.data?.length > 0) {
    messageShown = true;
    const bytes = new Uint8Array(captured.data);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
    try {
      if (isZip && files.length > 1) {
        const innerFiles = await parseZip(bytes);
        if (innerFiles.length > 0) { await downloadZipBundle(innerFiles, zipName); showPersistentStatus(`✅ ZIP ${innerFiles.length}개 완료`); }
        else { await downloadZipBundle([{ name: zipName, data: bytes }], zipName); showPersistentStatus('✅ ZIP 다운로드 완료 (원본)'); }
      } else {
        const fileName = captured.fileName || files[0]?.fileName || '첨부파일';
        await downloadZipBundle([{ name: fileName, data: bytes }], zipName);
        showPersistentStatus('✅ 파일 다운로드 완료');
      }
    } catch {
      await downloadZipBundle([{ name: zipName, data: bytes }], zipName);
      showPersistentStatus('✅ ZIP 다운로드 완료 (원본)');
    }
    btn.disabled = false;
    btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
  } else {
    await Promise.race([nativeDownloadPromise, new Promise(r => setTimeout(r, 2000))]);
    if (!messageShown) {
      showPersistentStatus(`⚠️ 캡처 실패 (${captured?._dbg || '?'})\n페이지의 다운로드 버튼을 직접 눌러주세요.`);
      btn.disabled = false;
      btn.innerHTML = '📦 첨부파일 ZIP 다운로드';
    }
  }
}

// ═══════════════════════════════════════════════════
// AI 추출 전용
// ═══════════════════════════════════════════════════

async function callGemini(apiKey, pageText) {
  const prompt = `다음은 건축 설계공모 관련 웹페이지의 텍스트입니다. 아래 JSON 형식에 맞춰 공모 정보를 추출해주세요. 없는 값은 빈 문자열("")로 두고, JSON만 반환하세요.

{
  "competitionName": "공모명 (설계공모/공모/사업 등 접미사 제거)",
  "buildType": "건축물 용도",
  "noticeNo": "공고번호",
  "agency": "발주처/공고기관",
  "location": "위치",
  "scale": "연면적/규모",
  "budget": "총사업비",
  "constructionCost": "공사비",
  "designCost": "설계비",
  "noticeDate": "공고일 (YYYY-MM-DD)",
  "announceDate": "당선작 발표일 (YYYY-MM-DD)",
  "chairperson": "심사위원장",
  "judges_planned": [{"type": "외부/내부/예비", "name": "이름", "org": "소속", "pos": "직급", "qual": "자격"}],
  "judges_attended": [],
  "awards": [{"awardType": "당선작/우수작 등", "office": "사무소명", "designer": "대표설계자", "coParticipants": "공동참여자", "num": "", "imgBase64": "", "imgMime": ""}],
  "contactOrg": "담당부서",
  "contactName": "담당자",
  "files": []
}

페이지 텍스트:
${pageText}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API 오류 ${resp.status}`);
  }
  const json = await resp.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 응답이 비어있습니다.');
  return JSON.parse(text);
}

let aiExtractedData = null;

// hub.go.kr 수상작 탭을 순차 클릭해 대표자/공동참여자 수집
async function collectHubAwards(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      // ── 타일 버튼 탐색 ──
      // DOM 확인 결과: BUTTON.btn > SPAN.icon (award 키워드 텍스트)
      // "btn" 클래스를 가진 button 중 span.icon 자식이 있는 것

      let tileButtons = Array.from(document.querySelectorAll('button'))
        .filter(btn => btn.querySelector('span.icon, span[class*="icon"]'));

      // fallback: span.icon 없을 경우 cursor:pointer 버튼으로 탐색
      if (tileButtons.length < 2) {
        tileButtons = Array.from(document.querySelectorAll('button'))
          .filter(btn => window.getComputedStyle(btn).cursor === 'pointer' &&
            btn.textContent.trim().length > 0 && btn.textContent.trim().length < 60);
        // 중복 제거: 같은 컨테이너 자식들만 (형제 버튼 그룹)
        if (tileButtons.length > 8) {
          // 같은 부모를 공유하는 버튼 그룹 중 가장 큰 그룹 선택
          const parentGroups = new Map();
          tileButtons.forEach(btn => {
            const p = btn.parentElement;
            if (!parentGroups.has(p)) parentGroups.set(p, []);
            parentGroups.get(p).push(btn);
          });
          let bestGroup = [];
          parentGroups.forEach(group => { if (group.length > bestGroup.length) bestGroup = group; });
          tileButtons = bestGroup;
        }
      }

      if (tileButtons.length === 0) return null;

      // ── 클릭 후 상세 패널 텍스트 추출 ──
      function getDetailText() {
        // 클래스명에 'detail' 포함한 요소 우선
        const detailEl = document.querySelector(
          '[class*="award-detail"]:not([class*="slider"]):not([class*="photo"]), [class*="detail-area"]'
        );
        if (detailEl && detailEl.textContent.includes('대표자')) {
          return detailEl.textContent.trim().replace(/\s+/g, ' ');
        }
        // fallback: 대표자 텍스트를 포함한 가장 작은 요소
        const cands = Array.from(document.querySelectorAll('*')).filter(el =>
          el !== document.body && el !== document.documentElement &&
          el.textContent.includes('대표자') && el.children.length < 20
        );
        cands.sort((a, b) => a.textContent.length - b.textContent.length);
        return cands[0]?.textContent.trim().replace(/\s+/g, ' ') || '';
      }

      const collected = [];
      for (const btn of tileButtons) {
        // awardType: span.icon 텍스트 우선, 없으면 버튼 전체 텍스트 앞부분
        const iconSpan = btn.querySelector('span.icon, span[class*="icon"]');
        const awardType = (iconSpan ? iconSpan.textContent : btn.textContent).trim();

        btn.click();
        await new Promise(r => setTimeout(r, 900));

        const detailText = getDetailText();
        const repMatch = detailText.match(/대표자\s*:?\s*([가-힣·\s]{2,20}?)(?:\s{2,}|공동|$)/);
        const coMatch  = detailText.match(/공동참여자\s*:?\s*(.+?)(?:\s{2,}|대표자|$)/);

        collected.push({
          awardType,
          officeName:     '',   // Gemini가 pageText에서 추출
          representative: repMatch ? repMatch[1].trim() : '',
          coParticipants: coMatch  ? coMatch[1].trim()  : '',
        });
      }
      return collected;
    }
  });
  return Array.isArray(result?.result) ? result.result : null;
}

async function clearCacheAI() {
  await chrome.storage.session.remove(['ai_extractedData', 'ai_cachedUrl']);
  aiExtractedData = null;
  document.getElementById('result').innerHTML = '';
  document.getElementById('status').innerHTML =
    '<div class="status success">🗑 캐시 초기화됨. 다시 추출하세요.</div>';
  // 추출 버튼 복원
  document.getElementById('aiExtractBtn').disabled = false;
  document.getElementById('aiExtractBtn').innerHTML = '🤖 AI로 추출';
}

function renderResultAI(data) {
  const v = (val) => val || '';
  const judges = data.judges_planned || [];
  const awards = data.awards || [];

  let html = '<div class="result-section">';
  html += '<h3>📋 공모 개요</h3>';
  if (v(data.competitionName)) html += field('공모명',   v(data.competitionName));
  if (v(data.buildType))       html += field('건축물 용도', v(data.buildType));
  if (v(data.noticeNo))        html += field('공고번호', v(data.noticeNo));
  if (v(data.agency))          html += field('발주처',   v(data.agency));
  if (v(data.location))        html += field('위치',     v(data.location));
  if (v(data.scale))           html += field('규모',     v(data.scale));
  if (v(data.budget))          html += field('총사업비', v(data.budget));
  if (v(data.constructionCost))html += field('공사비',   v(data.constructionCost));
  if (v(data.designCost))      html += field('설계비',   `<b style="color:#059669;">${v(data.designCost)}</b>`);
  if (v(data.noticeDate))      html += field('공고일',   v(data.noticeDate));
  if (v(data.announceDate))    html += field('발표일',   `<b style="color:#2563eb;">${v(data.announceDate)}</b>`);
  if (v(data.contactOrg))      html += field('담당부서', v(data.contactOrg));
  if (v(data.contactName))     html += field('담당자',   v(data.contactName));

  if (judges.length > 0) {
    html += '<h3 style="margin-top:10px;">👥 심사위원</h3>';
    judges.forEach(j => {
      const isReserve = j.type?.includes('예비');
      html += `<div class="judge-item">
        <div><span class="name">${j.name || '-'}</span>
          <span class="pill ${isReserve ? 'pill-reserve' : 'pill-external'}">${j.type || '외부'}</span>
        </div>
        <div class="sub">${j.org || ''}${j.pos ? ' · ' + j.pos : ''}${j.qual ? ' · ' + j.qual : ''}</div>
      </div>`;
    });
  }

  if (awards.length > 0) {
    html += '<h3 style="margin-top:10px;">🏆 수상작품</h3>';
    awards.forEach(a => {
      html += `<div class="judge-item">
        <div class="name">${a.awardType || '-'}</div>
        <div class="sub">${a.office || ''}${a.designer ? ' · 대표 ' + a.designer : ''}${a.coParticipants ? ' · 공동 ' + a.coParticipants : ''}</div>
      </div>`;
    });
  }

  html += '</div>';
  html += `<div class="actions" style="margin-top:8px;">
    <button id="copyToolBtn">🔗 정리도구용 복사</button>
  </div>`;

  document.getElementById('result').innerHTML = html;
  document.getElementById('copyToolBtn').addEventListener('click', () => {
    copyToClipboard(JSON.stringify(data, null, 2))
      .then(() => showToast('✅ JSON 복사됨!'))
      .catch(() => showToast('❌ 클립보드 복사 실패'));
  });
}

async function extractWithAI() {
  const apiKey = await loadApiKey();
  if (!apiKey) {
    document.getElementById('settingsPanel').classList.remove('hidden');
    document.getElementById('apiKeyStatus').textContent = '⚠️ API 키를 먼저 입력해주세요';
    return;
  }
  const btn = document.getElementById('aiExtractBtn');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> AI 분석 중...';
  statusEl.innerHTML = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body.innerText.slice(0, 30000)
    });
    let pageText = result?.result || '';
    if (!pageText) throw new Error('페이지 텍스트를 가져올 수 없습니다.');

    // hub.go.kr: 수상작 타일을 순차 클릭해 대표자/공동참여자 수집
    if (tab.url?.includes('hub.go.kr')) {
      btn.innerHTML = '<span class="spinner"></span> 수상작 수집 중...';
      const awardDetails = await collectHubAwards(tab.id);
      if (awardDetails && awardDetails.length > 0) {
        pageText += '\n\n[수상작별 대표자/공동참여자 (자동 수집)]\n' +
          awardDetails.map(a =>
            `${a.awardType} | ${a.officeName} | 대표자: ${a.representative} | 공동참여자: ${a.coParticipants}`
          ).join('\n');
      }
      btn.innerHTML = '<span class="spinner"></span> AI 분석 중...';
    }

    const data = await callGemini(apiKey, pageText);

    // 캐시 저장
    aiExtractedData = data;
    await chrome.storage.session.set({ ai_extractedData: data, ai_cachedUrl: tab.url });

    statusEl.innerHTML = '<div class="status success">✅ 추출 완료!</div>';
    renderResultAI(data);
    btn.innerHTML = '🔄 다시 추출';
    btn.disabled = false;
  } catch (e) {
    statusEl.innerHTML = `<div class="status error">❌ 오류: ${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🤖 AI로 추출';
  }
}

async function downloadPageImages() {
  const btn = document.getElementById('downloadImagesBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 수집 중...';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth >= 150 && img.naturalHeight >= 150)
        .map(img => img.src)
        .filter(src => src.startsWith('http'))
    });
    const urls = result?.result || [];
    if (urls.length === 0) { showToast('⚠️ 150px 이상 이미지가 없습니다.'); return; }

    const zipFiles = [];
    for (let i = 0; i < urls.length; i++) {
      btn.innerHTML = `<span class="spinner"></span> ${i + 1}/${urls.length}`;
      try {
        const resp = await fetch(urls[i]);
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        const ct = resp.headers.get('content-type') || '';
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : 'jpg';
        zipFiles.push({ name: `image_${String(i + 1).padStart(2, '0')}.${ext}`, data: new Uint8Array(buf) });
      } catch {}
    }
    if (zipFiles.length > 0) {
      const hostname = new URL(tab.url).hostname.replace('www.', '');
      await downloadZipBundle(zipFiles, `images_${hostname}.zip`);
      showToast(`✅ ${zipFiles.length}개 이미지 ZIP 완료`);
    } else {
      showToast('⚠️ 이미지를 가져오지 못했습니다.');
    }
  } catch (e) {
    showToast(`❌ 오류: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🖼️ 이미지 ZIP';
  }
}

// ═══════════════════════════════════════════════════
// 초기화
// ═══════════════════════════════════════════════════

async function init() {
  document.getElementById('buildDate').textContent = BUILD_DATE;
  initSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const main = document.getElementById('main');
  const header = document.getElementById('siteHeader');
  const headerTitle = document.getElementById('headerTitle');
  const headerSub   = document.getElementById('headerSub');

  if (tab.url?.includes('eais.go.kr')) {
    siteMode = 'seumter';
    document.body.setAttribute('data-mode', 'seumter');
    header.style.background = '#2563eb';
    headerTitle.textContent = '📋 세움터 공모 추출기';
    headerSub.textContent   = '공모 상세 페이지에서 정보를 자동 추출합니다';

    main.innerHTML = `
      <button id="extractBtn">🔍 공모 정보 추출</button>
      <div id="status"></div>
      <div id="result"></div>`;
    document.getElementById('extractBtn').addEventListener('click', extractSeumter);

    const stored = await chrome.storage.session.get(['extractedData', 'cachedUrl']);
    if (stored.cachedUrl === tab.url && stored.extractedData) {
      extractedData = stored.extractedData;
      cachedUrl = stored.cachedUrl;
      renderResultSeumter(extractedData);
      document.getElementById('status').innerHTML = `
        <div class="status success" style="display:flex; justify-content:space-between; align-items:center;">
          <span>✅ 이전 추출 결과 (URL 동일)</span>
          <button onclick="clearCacheSeumter()" style="width:auto; padding:2px 8px; font-size:11px; background:#6b7280;">초기화</button>
        </div>`;
    }

  } else if (tab.url?.includes('hub.go.kr')) {
    siteMode = 'hub';
    document.body.setAttribute('data-mode', 'hub');
    header.style.background = '#0e7490';
    headerTitle.textContent = '🏛️ 건축 Hub 공모 추출기';
    headerSub.textContent   = 'hub.go.kr 공모 정보를 자동 추출합니다';

    main.innerHTML = `
      <button id="extractBtn">🔍 공모 정보 추출</button>
      <div id="status"></div>
      <div id="result"></div>`;
    document.getElementById('extractBtn').addEventListener('click', extractHub);

    const stored = await chrome.storage.session.get(['hub_extractedData', 'hub_cachedUrl']);
    if (stored.hub_cachedUrl === tab.url && stored.hub_extractedData) {
      extractedData = stored.hub_extractedData;
      cachedUrl = stored.hub_cachedUrl;
      renderResultHub(extractedData);
      document.getElementById('status').innerHTML = `
        <div class="status success" style="display:flex; justify-content:space-between; align-items:center;">
          <span>✅ 이전 추출 결과 (URL 동일)</span>
          <button onclick="clearCacheHub()" style="width:auto; padding:2px 8px; font-size:11px; background:#6b7280;">초기화</button>
        </div>`;
    }

  } else if (tab.url?.includes('g2b.go.kr')) {
    siteMode = 'g2b';
    document.body.setAttribute('data-mode', 'g2b');
    header.style.background = '#059669';
    headerTitle.textContent = '📋 나라장터 공모 추출기';
    headerSub.textContent   = '입찰공고 상세 페이지에서 정보를 자동 추출합니다';

    main.innerHTML = `
      <button id="extractBtn">🔍 공고 정보 추출</button>
      <div id="status"></div>
      <div id="result"></div>`;
    document.getElementById('extractBtn').addEventListener('click', extractG2B);

    const stored = await chrome.storage.session.get(['g2b_extractedData', 'g2b_cachedUrl']);
    if (stored.g2b_cachedUrl === tab.url && stored.g2b_extractedData) {
      extractedData = stored.g2b_extractedData;
      cachedUrl = stored.g2b_cachedUrl;
      renderResultG2B(extractedData);
      document.getElementById('status').innerHTML = `
        <div class="status success" style="display:flex; justify-content:space-between; align-items:center;">
          <span>✅ 이전 추출 결과 (URL 동일)</span>
          <button onclick="clearCacheG2B()" style="width:auto; padding:2px 8px; font-size:11px; background:#6b7280;">초기화</button>
        </div>`;
    }

  } else {
    siteMode = 'ai';
    document.body.setAttribute('data-mode', 'ai');
    header.style.background = '#7c3aed';
    headerTitle.textContent = '🤖 공모 정보 AI 추출기';
    headerSub.textContent   = '현재 페이지에서 공모 정보를 AI로 추출합니다';

    main.innerHTML = `
      <button id="aiExtractBtn">🤖 AI로 추출</button>
      <div class="actions" style="margin-top:8px;">
        <button class="secondary" id="downloadImagesBtn">🖼️ 이미지 ZIP</button>
      </div>
      <div id="status"></div>
      <div id="result"></div>`;
    document.getElementById('aiExtractBtn').addEventListener('click', extractWithAI);
    document.getElementById('downloadImagesBtn').addEventListener('click', downloadPageImages);

    // 캐시 복원
    const stored = await chrome.storage.session.get(['ai_extractedData', 'ai_cachedUrl']);
    if (stored.ai_cachedUrl === tab.url && stored.ai_extractedData) {
      aiExtractedData = stored.ai_extractedData;
      renderResultAI(aiExtractedData);
      document.getElementById('aiExtractBtn').innerHTML = '🔄 다시 추출';
      document.getElementById('status').innerHTML = `
        <div class="status success" style="display:flex; justify-content:space-between; align-items:center;">
          <span>✅ 이전 추출 결과 (URL 동일)</span>
          <button onclick="clearCacheAI()" style="width:auto; padding:2px 8px; font-size:11px; background:#6b7280;">초기화</button>
        </div>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
