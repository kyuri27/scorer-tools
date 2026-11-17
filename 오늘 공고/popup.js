const DETAIL_PAGE = 'https://www.eais.go.kr/moct/awp/aia01/AWPAIA01V01';

let currentFilter = 'today';

function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function pickerYMD() {
  const val = document.getElementById('date-picker').value; // yyyy-MM-dd
  if (!val) return todayYMD();
  return val.replace(/-/g, '');
}

function ymdToLabel(ymd) {
  const days = ['일','월','화','수','목','금','토'];
  const d = new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`);
  return `${ymd.slice(0,4)}.${ymd.slice(4,6)}.${ymd.slice(6,8)} (${days[d.getDay()]})`;
}

function formatDate(str) {
  if (!str) return '-';
  str = String(str);
  if (str.length >= 8) return `${str.slice(0,4)}.${str.slice(4,6)}.${str.slice(6,8)}`;
  return str;
}

function calcDDay(dttStr) {
  if (!dttStr) return null;
  const s = String(dttStr).slice(0, 8);
  const target = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.ceil((target - now) / 86400000);
}

function dDayBadge(diff) {
  if (diff === null) return '';
  if (diff < 0)  return `<span class="d-day d-done">마감</span>`;
  if (diff === 0) return `<span class="d-day d-near">D-DAY</span>`;
  if (diff <= 7)  return `<span class="d-day d-near">D-${diff}</span>`;
  return `<span class="d-day d-far">D-${diff}</span>`;
}

function statusTag(diff) {
  if (diff === null) return '<span class="tag tag-open">진행중</span>';
  if (diff < 0)  return '<span class="tag tag-closed">마감</span>';
  if (diff <= 3) return '<span class="tag tag-soon">마감임박</span>';
  return '<span class="tag tag-open">진행중</span>';
}

// ─── 업로드 완료 체크 ────────────────────────────────────
function uploadDoneKey(id) { return `upload_done_${id}`; }
function isUploadDone(id) { return localStorage.getItem(uploadDoneKey(id)) === '1'; }
function toggleUploadDone(id) {
  if (isUploadDone(id)) localStorage.removeItem(uploadDoneKey(id));
  else localStorage.setItem(uploadDoneKey(id), '1');
}
function uploadDoneBtn(id) {
  const done = isUploadDone(id);
  return `<button class="upload-done-btn ${done ? 'done' : ''}" data-id="${id}" title="업로드 완료 표시">${done ? '✅ 업로드 완료' : '○ 업로드 완료'}</button>`;
}

function fetchList(progStatNm) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'FETCH_LIST', progStatNm }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.ok) return resolve(res.list);
      if (res?.error === 'fetching') {
        // 백그라운드가 fetch 중 → 2초마다 캐시 폴링 (최대 60초)
        const pollStart = Date.now();
        pollTimer = setInterval(() => {
          chrome.runtime.sendMessage({ type: 'GET_CACHE' }, r => {
            if (r?.ok && r.list) {
              stopPolling();
              resolve(r.list);
            } else if (r && !r.fetching) {
              // 백그라운드 fetch가 실패로 끝남 → 다시 요청해서 실제 오류 받기
              stopPolling();
              fetchList(progStatNm).then(resolve, reject);
            } else if (Date.now() - pollStart > 60000) {
              stopPolling();
              reject(new Error('세움터 응답 대기 시간 초과 — 다시 시도해 주세요'));
            }
          });
        }, 2000);
        return;
      }
      reject(new Error(res?.error || '알 수 없는 오류'));
    });
  });
}

let pollTimer = null;

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function load() {
  stopPolling();
  const container = document.getElementById('container');
  const summary = document.getElementById('summary');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>불러오는 중... (처음엔 20~30초 소요)</div>';
  summary.innerHTML = '';

  // date-picker는 헤더에 항상 표시

  try {
    let list = [];

    if (currentFilter === 'today') {
      const ymd = pickerYMD();
      const all = await fetchList('progRegist');
      const seen = new Set();
      list = all.filter(item => {
        const matchUpload = String(item.pssrpPblancNoNm || '').startsWith(ymd);
        const matchAnnounce = String(item.pssrpPblancDt || '').startsWith(ymd);
        if (!matchUpload && !matchAnnounce) return false;
        const key = item.pssrpPblancSeqno;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      summary.innerHTML = `<strong>${ymdToLabel(ymd)}</strong> 공고 <strong>${list.length}건</strong>`;
      render(list, all);

    } else {
      list = await fetchList('progRegist');
      summary.innerHTML = `진행중 공모 <strong>${list.length}건</strong>`;
      render(list);
    }
  } catch (e) {
    container.innerHTML = `
      <div class="error">
        ⚠️ 데이터를 불러오지 못했습니다.
        <div class="error-help">${e.message}</div>
        <button class="retry-btn" id="retry">다시 시도</button>
      </div>`;
    document.getElementById('retry')?.addEventListener('click', load);
  }
}

let _lastAll = [];

function render(list, all) {
  if (all) _lastAll = all;
  const container = document.getElementById('container');
  if (!list.length) {
    container.innerHTML = `<div class="empty">해당 날짜의 공고가 없습니다.</div>`;
    return;
  }

  container.innerHTML = list.map(item => {
    const title  = item.pssrpPblancNm || item.pssrpBlancNe || '(제목 없음)';
    const no     = item.pssrpPblancSeqno || item.pssrpBlancSqno || '';
    const org    = item.pssrpKikNm || item.pssrpBlancAddr || '';
    const region = item.pssrpSideCdNm || item.pssrpAdresSideCdNm || '';
    const announceDate = formatDate(item.pssrpPblancDt || item.regStrDtt);
    const submitClose  = item.changPssrpSubmitCloseDat || formatDate(item.pssrpSubmitCloseDatt || item.pssrpPblancSubmitCloseDtt);
    const LIST_PAGE = 'https://www.eais.go.kr/moct/awp/aia01/AWPAIA01L01';
    const link = item.pssrpLinkPath || LIST_PAGE;
    const diff   = calcDDay(item.pssrpSubmitCloseDatt || item.pssrpSubmitCloseDate);
    // 업로드 날짜: pssrpPblancNoNm 앞 8자리
    const uploadYmd = String(item.pssrpPblancNoNm || '').slice(0, 8);
    const uploadLabel = uploadYmd.length === 8
      ? `${parseInt(uploadYmd.slice(4,6))}월 ${parseInt(uploadYmd.slice(6,8))}일 업로드`
      : '';

    return `
      <div class="card">
        <div class="card-main">
          <div class="card-no">${no}</div>
          <div class="card-title">${title}</div>
          ${uploadLabel ? `<div style="display:inline-block;margin-bottom:6px;padding:2px 9px;background:#fff3cd;color:#856404;border-radius:10px;font-size:11px;font-weight:600;">📤 ${uploadLabel}</div>` : ''}
          <div class="card-meta">
            ${statusTag(diff)}
            <span>🏢 ${org}</span>
            ${region ? `<span>📍 ${region}</span>` : ''}
            <span>📅 공고 ${announceDate}</span>
            ${submitClose ? `<span>📮 제출마감 ${submitClose}</span>` : ''}
          </div>
        </div>
        <div class="card-right">
          ${dDayBadge(diff)}
          <a class="link-btn" href="${link}" target="_blank">바로가기</a>
          ${uploadDoneBtn(no || title)}
        </div>
      </div>`;
  }).join('');

  // 업로드 완료 버튼 이벤트
  container.querySelectorAll('.upload-done-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      toggleUploadDone(id);
      btn.classList.toggle('done');
      btn.textContent = isUploadDone(id) ? '✅ 업로드 완료' : '○ 업로드 완료';
    });
  });
}

// 탭 버튼
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    load();
  });
});

// 날짜 변경 시 저장 + 필터 재적용
document.getElementById('date-picker').addEventListener('change', () => {
  localStorage.setItem('seumterDate', document.getElementById('date-picker').value);
  chrome.storage.session.remove('g2bList').catch(() => {});
  chrome.storage.session.remove('hubList').catch(() => {});
  chrome.storage.session.remove('seoulList').catch(() => {});
  if (currentFilter === 'today') { load(); loadG2b(); loadHub(); loadSeoul(); }
});

document.getElementById('refresh-btn').addEventListener('click', load);

// ─── 나라장터 ────────────────────────────────────────────
function formatWon(n) {
  if (!n) return '-';
  return Math.round(n / 10000).toLocaleString() + '만원';
}

async function loadG2b() {
  const container = document.getElementById('g2b-container');
  const summary = document.getElementById('g2b-summary');
  if (!container) return;
  container.innerHTML = '<div class="loading"><div class="spinner"></div>불러오는 중...</div>';
  summary.innerHTML = '';

  const ymd = pickerYMD();

  try {
    const list = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_G2B', dateYMD: ymd }, res => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.ok) return resolve(res.list);
        reject(new Error(res?.error || '오류'));
      });
    });

    const dateLabel = ymdToLabel(ymd);
    summary.innerHTML = `<strong>${dateLabel}</strong> 설계공모 <strong>${list.length}건</strong>`;

    if (!list.length) {
      container.innerHTML = '<div class="empty">해당 날짜의 공고가 없습니다.</div>';
      return;
    }

    container.innerHTML = list.map(item => {
      const title = item.bidPbancNm || '(제목 없음)';
      const no = item.bidPbancUntyNoOrd || '';
      const org = item.oderInstUntyGrpNm || item.dmstNm || '';
      const date = item.prcsDt ? item.prcsDt.slice(0, 16) : '-';
      const budget = formatWon(item.prspPrce || item.alotBgtAmt);
      const status = item.pbancSttsNm || '';
      // R26BK01485707 - 000 → bidPbancNo / bidPbancOrd
      const noMatch = no.match(/^(.+?)\s*-\s*(\d+)$/);
      const link = noMatch
        ? `https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=${noMatch[1].trim()}&bidPbancOrd=${noMatch[2]}`
        : 'https://www.g2b.go.kr';

      return `
        <div class="card">
          <div class="card-main">
            <div class="card-no">${no}</div>
            <div class="card-title">${title.replace(/&#40;/g,'(').replace(/&#41;/g,')').replace(/&lt;br\/&gt;/g,'')}</div>
            <div class="card-meta">
              <span class="tag tag-open">${status}</span>
              <span>🏢 ${org}</span>
              <span>📅 ${date}</span>
              <span>💰 ${budget}</span>
            </div>
          </div>
          <div class="card-right">
            <a class="link-btn" href="${link}" target="_blank">바로가기</a>
            ${uploadDoneBtn(no || title)}
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.upload-done-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        toggleUploadDone(id);
        btn.classList.toggle('done');
        btn.textContent = isUploadDone(id) ? '✅ 업로드 완료' : '○ 업로드 완료';
      });
    });

  } catch(e) {
    container.innerHTML = `<div class="error">⚠️ ${e.message}<br><button class="retry-btn" id="g2b-retry">다시 시도</button></div>`;
    document.getElementById('g2b-retry')?.addEventListener('click', loadG2b);
  }
}

document.getElementById('g2b-refresh')?.addEventListener('click', () => {
  chrome.storage.session.remove('g2bList').catch(() => {});
  loadG2b();
});
document.getElementById('hub-refresh')?.addEventListener('click', () => {
  chrome.storage.session.remove('hubList').catch(() => {});
  loadHub();
});

loadG2b();

// ─── 건축허브 ────────────────────────────────────────────
async function loadHub() {
  const container = document.getElementById('hub-container');
  const summary   = document.getElementById('hub-summary');
  if (!container) return;
  container.innerHTML = '<div class="loading"><div class="spinner"></div>불러오는 중...</div>';
  summary.innerHTML = '';

  const ymd = pickerYMD();

  try {
    const list = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_HUB', dateYMD: ymd }, res => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.ok) return resolve(res.list);
        reject(new Error(res?.error || '오류'));
      });
    });

    // 날짜 필터: 공고일 또는 등록일(업로드일)이 선택 날짜인 항목
    const dateStr = `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`;
    const seen = new Set();
    const filtered = list.filter(item => {
      const match = item.pblancDe === dateStr || item.uploadDe === dateStr;
      if (!match) return false;
      if (seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    });

    summary.innerHTML = `<strong>${ymdToLabel(ymd)}</strong> 건축허브 공모 <strong>${filtered.length}건</strong>`;

    if (!filtered.length) {
      container.innerHTML = '<div class="empty">해당 날짜의 공고가 없습니다.</div>';
      return;
    }

    container.innerHTML = filtered.map(item => {
      const uploadBadge = item.uploadDe && item.uploadDe !== item.pblancDe
        ? `<div style="display:inline-block;margin-bottom:6px;padding:2px 9px;background:#fff3cd;color:#856404;border-radius:10px;font-size:11px;font-weight:600;">📤 ${item.uploadDe.slice(5).replace('-','월 ')}일 업로드</div>`
        : '';
      return `
      <div class="card">
        <div class="card-main">
          <div class="card-title">${item.title}</div>
          ${uploadBadge}
          <div class="card-meta">
            ${item.region ? `<span>📍 ${item.region}</span>` : ''}
            ${item.pblancDe ? `<span>📅 공고 ${item.pblancDe}</span>` : ''}
          </div>
        </div>
        <div class="card-right">
          <a class="link-btn" href="${item.link}" target="_blank">바로가기</a>
          ${uploadDoneBtn(item.title)}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.upload-done-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        toggleUploadDone(id);
        btn.classList.toggle('done');
        btn.textContent = isUploadDone(id) ? '✅ 업로드 완료' : '○ 업로드 완료';
      });
    });

  } catch(e) {
    container.innerHTML = `<div class="error">⚠️ ${e.message}<br><button class="retry-btn" id="hub-retry">다시 시도</button></div>`;
    document.getElementById('hub-retry')?.addEventListener('click', loadHub);
  }
}

loadHub();

// ─── 서울시 설계공모 ──────────────────────────────────────
function epochToDateStr(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadSeoul() {
  const container = document.getElementById('seoul-container');
  const summary   = document.getElementById('seoul-summary');
  if (!container) return;
  container.innerHTML = '<div class="loading"><div class="spinner"></div>불러오는 중...</div>';
  summary.innerHTML = '';

  const ymd = pickerYMD();
  const dateStr = `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`;

  try {
    const list = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_SEOUL' }, res => {
        if (chrome.runtime.lastError) { /* 무시 — 스토리지 폴링으로 처리 */ }
        if (res?.ok) return resolve(res.list);
        // 'fetching' 또는 포트 닫힘 → 스토리지 폴링
        const deadline = Date.now() + 40000;
        const poll = setInterval(() => {
          chrome.storage.session.get('seoulList').then(s => {
            const c = s['seoulList'];
            if (!c || Date.now() - c.ts > 60000) return; // 오래된 캐시 무시
            if (Date.now() > deadline) { clearInterval(poll); reject(new Error('서울시 타임아웃')); return; }
            if (c.error) { clearInterval(poll); reject(new Error(c.error)); return; }
            if (c.list) { clearInterval(poll); resolve(c.list); }
          });
          if (Date.now() > deadline) { clearInterval(poll); reject(new Error('서울시 타임아웃')); }
        }, 1000);
      });
    });

    // 업로드일(crtDt) 기준 필터
    const filtered = list.filter(item => epochToDateStr(item.crtDt) === dateStr);

    summary.innerHTML = `<strong>${ymdToLabel(ymd)}</strong> 서울시 공모 <strong>${filtered.length}건</strong> (전체 ${list.length}건)`;

    if (!list.length) {
      container.innerHTML = '<div class="empty">공모 데이터를 불러오지 못했습니다.</div>';
      return;
    }
    if (!filtered.length) {
      container.innerHTML = '<div class="empty">해당 날짜의 공고가 없습니다.<br><small style="color:#aaa">전체 ${list.length}건 중 업로드일·등록마감일 기준</small></div>';
      return;
    }

    container.innerHTML = filtered.map(item => {
      const title = item.titleKr || '(제목 없음)';
      const org   = item.prmtrKr || '';
      const uploadDate = epochToDateStr(item.crtDt);
      const regEnd  = epochToDateStr(item.regSchEndDt);
      const subEnd  = epochToDateStr(item.subSchEndDt);
      const seq = item.cpttMstSeq;

      const uploadBadge = uploadDate === dateStr
        ? `<div style="display:inline-block;margin-bottom:6px;padding:2px 9px;background:#fff3cd;color:#856404;border-radius:10px;font-size:11px;font-weight:600;">📤 ${uploadDate.slice(5).replace('-','월 ')}일 업로드</div>`
        : '';

      const regDiff = regEnd ? calcDDay(regEnd.replace(/-/g,'')) : null;

      return `
      <div class="card">
        <div class="card-main">
          <div class="card-title">${title}</div>
          ${uploadBadge}
          <div class="card-meta">
            ${org ? `<span>🏢 ${org}</span>` : ''}
            ${regEnd ? `<span>📋 등록마감 ${regEnd}</span>` : ''}
            ${subEnd ? `<span>📮 접수마감 ${subEnd}</span>` : ''}
          </div>
        </div>
        <div class="card-right">
          ${dDayBadge(regDiff)}
          <a class="link-btn" href="https://project.seoul.go.kr/view/viewListCptt.do" target="_blank">바로가기</a>
          ${uploadDoneBtn(String(seq || title))}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.upload-done-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        toggleUploadDone(id);
        btn.classList.toggle('done');
        btn.textContent = isUploadDone(id) ? '✅ 업로드 완료' : '○ 업로드 완료';
      });
    });

  } catch(e) {
    container.innerHTML = `<div class="error">⚠️ ${e.message}<br><button class="retry-btn" id="seoul-retry">다시 시도</button></div>`;
    document.getElementById('seoul-retry')?.addEventListener('click', loadSeoul);
  }
}

document.getElementById('seoul-refresh')?.addEventListener('click', () => {
  chrome.storage.session.remove('seoulList').catch(() => {});
  loadSeoul();
});


loadSeoul();

// 날짜 초기값 = 저장된 날짜 or 오늘
const _d = new Date();
const _pad = n => String(n).padStart(2,'0');
// 항상 오늘 날짜로 초기화
document.getElementById('date-picker').value =
  `${_d.getFullYear()}-${_pad(_d.getMonth()+1)}-${_pad(_d.getDate())}`;

document.getElementById('today-label').textContent =
  `${_d.getFullYear()}.${_pad(_d.getMonth()+1)}.${_pad(_d.getDate())} (${['일','월','화','수','목','금','토'][_d.getDay()]})`;

load();
