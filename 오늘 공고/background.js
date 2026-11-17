// 아이콘 클릭 시 전용 탭 열기 (이미 열려있으면 포커스)
chrome.action.onClicked.addListener(async () => {
  const extUrl = chrome.runtime.getURL('index.html');
  const [existing] = await chrome.tabs.query({ url: extUrl });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: extUrl });
  }
});

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

const CACHE_KEY = 'seumterList';
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedList() {
  const s = await chrome.storage.session.get(CACHE_KEY);
  const c = s[CACHE_KEY];
  if (c && Date.now() - c.ts < CACHE_TTL) return c.list;
  return null;
}

async function setCachedList(list) {
  await chrome.storage.session.set({ [CACHE_KEY]: { list, ts: Date.now() } });
}

const LIST_PAGE = 'https://www.eais.go.kr/moct/awp/aia01/AWPAIA01L01';

async function fetchAllPages() {
  // 항상 새 탭으로 열기 (기존 탭 상태와 무관하게 신선한 데이터 확보)
  const tab = await chrome.tabs.create({ url: LIST_PAGE, active: false });
  const openedTab = true;
  // 로딩 완료 대기 — 이미 complete인 경우·탭이 닫힌 경우·20초 초과 시에도 멈추지 않도록
  try {
    await new Promise((resolve, reject) => {
      const finish = (err) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        err ? reject(err) : resolve();
      };
      const onUpdated = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') finish();
      };
      const onRemoved = (tabId) => {
        if (tabId === tab.id) finish(new Error('세움터 탭이 닫혔습니다'));
      };
      const timer = setTimeout(() => finish(new Error('세움터 페이지 로딩 시간 초과')), 20000);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      chrome.tabs.get(tab.id).then(t => { if (t.status === 'complete') finish(); }).catch(() => {});
    });
  } catch (e) {
    chrome.tabs.remove(tab.id).catch(() => {});
    throw e;
  }

  const target = { tabId: tab.id };
  let allItems = [];
  let totalCount = null;
  let done = false;
  const requestIds = {};

  return new Promise(async (resolve, reject) => {

    const onEvent = async (source, method, params) => {
      if (source.tabId !== tab.id || done) return;

      if (method === 'Network.responseReceived' &&
          params.response.url.includes('AWPAIA01R02') &&
          params.response.status === 200) {
        requestIds[params.requestId] = true;
      }

      if (method === 'Network.loadingFinished' && requestIds[params.requestId]) {
        delete requestIds[params.requestId];
        try {
          const { body } = await chrome.debugger.sendCommand(
            target, 'Network.getResponseBody', { requestId: params.requestId }
          );
          const json = JSON.parse(body);
          const items = Array.isArray(json.dataList) ? json.dataList : (json.dataList?.list || []);

          if (items.length > 0) {
            if (totalCount === null) totalCount = items[0].totalCount || items.length;
            allItems = [...allItems, ...items];

            if (allItems.length >= totalCount) {
              done = true;
              cleanup();
              resolve(allItems);
            } else {
              // 더 보기 버튼 클릭
              await wait(500);
              await chrome.scripting.executeScript({
                target,
                world: 'MAIN',
                func: () => {
                  for (const btn of document.querySelectorAll('button')) {
                    if (btn.textContent.includes('더 보기')) { btn.click(); return; }
                  }
                }
              });
            }
          }
        } catch(e) { /* 파싱 실패 무시 */ }
      }
    };

    const cleanup = () => {
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.detach(target).catch(() => {});
      if (openedTab) chrome.tabs.remove(tab.id).catch(() => {});
    };

    try {
      await chrome.debugger.attach(target, '1.3');
      await chrome.debugger.sendCommand(target, 'Network.enable');
      chrome.debugger.onEvent.addListener(onEvent);

      // 탭 새로고침 → Vue 앱 초기 XHR 자동 발생
      await chrome.tabs.reload(tab.id);

      // 30초 타임아웃
      setTimeout(() => {
        if (!done) {
          done = true;
          cleanup();
          if (allItems.length > 0) resolve(allItems);
          else reject(new Error('timeout'));
        }
      }, 30000);

    } catch(e) {
      cleanup();
      reject(new Error('debugger_error: ' + e.message));
    }
  });
}

// ─── 나라장터 ───────────────────────────────────────────
const G2B_API = 'https://www.g2b.go.kr/jn/pnp/pnpe/BidPbac/selectBidPbacScrollTypeList.do';
const G2B_CACHE_KEY = 'g2bList';
const G2B_TEMPLATE_KEY = 'g2bReqTemplate'; // chrome.storage.local에 영구 저장
let g2bFetching = false;

async function getG2bCache() {
  const s = await chrome.storage.session.get(G2B_CACHE_KEY);
  const c = s[G2B_CACHE_KEY];
  if (c && Date.now() - c.ts < CACHE_TTL) return c.list;
  return null;
}

// 저장된 템플릿으로 g2b 탭에서 XHR 직접 호출
// - 탭 로딩 중에만 포커스 필요, XHR 전송 후에는 화면 안 봐도 됨
async function fetchG2bDirect(dateYMD) {
  const s = await chrome.storage.local.get(G2B_TEMPLATE_KEY);
  const tmpl = s[G2B_TEMPLATE_KEY];
  if (!tmpl) return null;

  let winId = null;
  try {
    let body = tmpl.body;
    body = body.replace(/"inqStrDt"\s*:\s*"\d{8}"/g, `"inqStrDt":"${dateYMD}"`);
    body = body.replace(/"inqEndDt"\s*:\s*"\d{8}"/g, `"inqEndDt":"${dateYMD}"`);
    body = body.replace(/inqStrDt=\d{8}/g, `inqStrDt=${dateYMD}`);
    body = body.replace(/inqEndDt=\d{8}/g, `inqEndDt=${dateYMD}`);

    // 작은 팝업으로 g2b 로드 (focused:true → 페이지 정상 렌더링)
    const win = await chrome.windows.create({
      url: 'https://www.g2b.go.kr',
      type: 'popup', width: 400, height: 300, left: 50, top: 50, focused: true
    });
    winId = win.id;
    const tab = win.tabs[0];

    await new Promise(resolve => {
      const onUpdated = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    await wait(1000); // JS 초기화 여유

    // XHR 주입 후 즉시 전송 — 이후 탭 포커스 불필요
    const [{result: list}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (url, body, headers) => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        for (const [k, v] of Object.entries(headers || {})) {
          try { xhr.setRequestHeader(k, v); } catch(e) {}
        }
        xhr.onload = () => {
          try {
            if (xhr.responseText.trim().startsWith('<')) {
              reject('HTML 응답 (인증오류): ' + xhr.responseText.slice(0, 80));
              return;
            }
            const json = JSON.parse(xhr.responseText);
            // 응답 구조 확인용 로그
            console.log('[G2B Direct] 응답 키:', Object.keys(json), '/ result 타입:', typeof json.result, Array.isArray(json.result));
            let list = json.result ?? json.list ?? json.data ?? json.items;
            if (!Array.isArray(list) && list && typeof list === 'object') {
              list = list.list ?? list.data ?? list.items ?? list.bidPbacList;
            }
            resolve(Array.isArray(list) ? list : []);
          } catch(e) { reject('JSON 파싱 실패: ' + xhr.responseText.slice(0, 80)); }
        };
        xhr.onerror = () => reject('network error');
        xhr.timeout = 20000;
        xhr.ontimeout = () => reject('timeout');
        xhr.send(body);
      }),
      args: [G2B_API, body, tmpl.headers]
    });

    chrome.windows.remove(winId).catch(() => {});
    if (!Array.isArray(list)) { console.log('[G2B Direct] 결과 배열 아님'); return null; }
    console.log(`[G2B Direct] 성공 (${list.length}건)`);
    return list;
  } catch(e) {
    if (winId) chrome.windows.remove(winId).catch(() => {});
    console.log('[G2B Direct] 실패:', e.message);
    return null;
  }
}

async function fetchG2bList(dateYMD) {
  // 템플릿 있으면 직접 호출
  const direct = await fetchG2bDirect(dateYMD);
  if (direct !== null) return direct;
  // 별도 팝업 창으로 열기 — 화면 우측 하단 구석에 작게
  const win = await chrome.windows.create({
    url: 'https://www.g2b.go.kr',
    type: 'popup',
    width: 900,
    height: 650,
    left: 50,
    top: 50,
    focused: true,
  });
  const tab = win.tabs[0];
  const openedTab = true;
  await new Promise(resolve => {
    const onUpdated = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  await wait(3000);

  const target = { tabId: tab.id };
  let done = false;
  let capturing = false;
  const networkIds = {};
  const requestInfo = {}; // requestId → { url, headers, postData }

  return new Promise(async (resolve, reject) => {
    const onEvent = async (source, method, params) => {
      if (source.tabId !== tab.id || done) return;

      // 요청 정보 저장 — g2b.go.kr POST 요청 전체 기록
      if (method === 'Network.requestWillBeSent' &&
          params.request.url.includes('g2b.go.kr') &&
          params.request.method === 'POST') {
        requestInfo[params.requestId] = {
          url: params.request.url,
          headers: params.request.headers,
          postData: params.request.postData,
        };
      }

      if (!capturing) return;

      // g2b.go.kr 200 응답 전부 캡처 시도 (URL 필터 없음)
      if (method === 'Network.responseReceived' &&
          params.response.url.includes('g2b.go.kr') &&
          params.response.status === 200) {
        networkIds[params.requestId] = true;
      }

      if (method === 'Network.loadingFinished' && networkIds[params.requestId]) {
        const reqId = params.requestId;
        delete networkIds[reqId];
        try {
          const { body } = await chrome.debugger.sendCommand(
            target, 'Network.getResponseBody', { requestId: reqId }
          );
          if (!body || body.trim().startsWith('<') || body.trim().startsWith('(')) return;
          const json = JSON.parse(body);
          // 입찰 목록 데이터인지 확인 (배열이 있고 입찰 관련 키 포함)
          const list = json.result ?? json.list ?? json.data ?? json.items ?? [];
          if (!Array.isArray(list) || list.length === 0) return;
          const sample = list[0];
          // 입찰공고 데이터 키 확인 (다른 API 응답과 구분)
          const isBidData = sample && (
            'bidPbancNm' in sample || 'bidPbancNo' in sample ||
            'bidPbancUntyNoOrd' in sample || 'prcsDt' in sample
          );
          if (!isBidData) return;

          // 성공한 요청 파라미터 템플릿 저장
          const req = requestInfo[reqId];
          if (req?.postData) {
            const safeHeaders = {};
            for (const [k, v] of Object.entries(req.headers || {})) {
              if (/^content-type$/i.test(k)) safeHeaders[k] = v;
            }
            chrome.storage.session.set({
              [G2B_TEMPLATE_KEY]: { body: req.postData, headers: safeHeaders }
            });
          }

          t(`응답 수신 완료 (${list.length}건)`);
          done = true;
          cleanup();
          resolve(list);
        } catch(e) {}
      }
    };

    const cleanup = () => {
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.detach(target).catch(() => {});
      if (openedTab) chrome.tabs.remove(tab.id).catch(() => {});
    };

    // 요소가 화면에 보일 때까지 폴링 (DOM에 있어도 hidden이면 무시)
    async function waitForVisible(selector, timeout = 10000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const [{result}] = await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: (sel) => {
            const el = document.querySelector(sel);
            return !!(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
          },
          args: [selector]
        });
        if (result) return true;
        await wait(300);
      }
      return false;
    }

    try {
      await chrome.debugger.attach(target, '1.3');
      await chrome.debugger.sendCommand(target, 'Network.enable');
      chrome.debugger.onEvent.addListener(onEvent);

      const t = (label) => console.log(`[G2B] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const t0 = Date.now();
      t('시작');

      // 0. 페이지 로드 완료 대기
      for (let i = 0; i < 20; i++) {
        await wait(300);
        const [{result: ready}] = await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: () => document.readyState === 'complete'
        });
        if (ready) break;
      }
      // 팝업 닫기 — 닫기 버튼(.w2window_close)이 있으면 클릭, 최대 6초 대기
      // (.w2window_close 버튼의 존재 = 팝업이 열려있다는 증거)
      for (let i = 0; i < 12; i++) {
        await wait(500);
        const [{result: clicked}] = await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: () => {
            const btns = Array.from(document.querySelectorAll('.w2window_close, .w2window_close_act'));
            const visible = btns.filter(el => {
              const cs = getComputedStyle(el);
              return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
            });
            visible.forEach(el => el.click());
            return visible.length;
          }
        });
        if (clicked === 0) break; // 닫기 버튼 없으면 팝업 없는 것 → 종료
        await wait(400);
      }
      t('팝업닫기 완료');

      // 1. 입찰공고목록 이동 — 탭 URL로 이미 있는지 확인 후 필요시만 이동
      const alreadyOnList = tab.url?.includes('BidPbac') || tab.url?.includes('bidPbac') || tab.url?.includes('PbancLst');
      if (!alreadyOnList) {
        await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: () => {
            const link = Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === '입찰공고목록');
            if (link) link.click();
          }
        });
        // 탭 로드 완료 이벤트로 대기
        await new Promise(resolve => {
          const onUpdated = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
          setTimeout(resolve, 15000); // 최대 15초
        });
        await wait(800); // 렌더링 여유
      }
      t('입찰공고목록 로드 완료');

      // 2. 상세조건 버튼 클릭
      await chrome.scripting.executeScript({
        target, world: 'MAIN',
        func: () => {
          const btn = document.querySelector('[id*="btnSearchToggle"]');
          if (btn) btn.click();
        }
      });

      // 3. 낙찰방법 select가 DOM에 생길 때까지 폴링 (최대 6초)
      for (let i = 0; i < 20; i++) {
        await wait(300);
        const [{result: found}] = await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: () => !!document.querySelector('select[id*="sbxScsbdMthdCd"]')
        });
        if (found) break;
      }
      t('상세조건 열림');
      await chrome.scripting.executeScript({
        target, world: 'MAIN',
        func: () => {
          const sel = document.querySelector('select[id*="sbxScsbdMthdCd"]');
          if (!sel) return;
          const opt = Array.from(sel.options).find(o => o.text.trim() === '설계공모');
          if (!opt) return;
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await wait(300);
      t('낙찰방법 설정 완료');

      // 4. 날짜 직접 입력 (캘린더 팝업 없이)
      // w2 date input은 readonly지만 value 직접 세팅 + change 이벤트로 동작
      const dateSet = await chrome.scripting.executeScript({
        target, world: 'MAIN',
        func: (dateYMD) => {
          const formatted = `${dateYMD.slice(0,4)}/${dateYMD.slice(4,6)}/${dateYMD.slice(6,8)}`;
          // 게시일자 시작/종료 input 찾기 (id 패턴 다양하게)
          const inputs = Array.from(document.querySelectorAll('input[id*="InqStrDt"], input[id*="inqStrDt"], input[id*="InqEndDt"], input[id*="inqEndDt"], input[id*="strDt"], input[id*="endDt"]'));
          let set = 0;
          inputs.forEach(inp => {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            nativeSetter?.call(inp, formatted);
            inp.value = formatted;
            ['input', 'change', 'blur'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles: true })));
            set++;
          });
          return set;
        },
        args: [dateYMD]
      });

      t(`날짜 직접입력 (결과: ${dateSet[0]?.result}개)`);

      // 직접 입력 실패 시 캘린더 팝업 사용
      if (!dateSet[0]?.result) {
        await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: () => {
            const btn = document.querySelector('[id*="tacBidPbancLst"] [id$="btnCal"]') ||
                        document.querySelector('[id*="btnCal"]');
            if (btn) btn.click();
          }
        });
        await wait(800);
        await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: (dateYMD) => {
            const today = new Date();
            const todayYMD = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
            if (dateYMD === todayYMD) {
              Array.from(document.querySelectorAll('button, input[type="button"]'))
                .filter(b => (b.value || b.textContent).trim() === '현재일')
                .forEach(b => b.click());
            } else {
              const y = parseInt(dateYMD.slice(0,4)), m = parseInt(dateYMD.slice(4,6)), d = parseInt(dateYMD.slice(6,8));
              document.querySelectorAll('select').forEach(sel => {
                const opts = Array.from(sel.options).map(o => o.text.trim());
                if (opts.some(o => /^\d{4}$/.test(o))) {
                  const o = Array.from(sel.options).find(o => parseInt(o.text) === y);
                  if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
                }
                if (opts.some(o => /^(1[0-2]|[1-9])월?$/.test(o))) {
                  const o = Array.from(sel.options).find(o => parseInt(o.text) === m);
                  if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
                }
              });
              Array.from(document.querySelectorAll('td, span'))
                .filter(el => el.textContent.trim() === String(d) &&
                  !el.classList.contains('disabled') && !el.classList.contains('other'))
                .forEach(c => c.click());
            }
          },
          args: [dateYMD]
        });
        await wait(300);
        // 선택완료
        await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: () => {
            const btn = Array.from(document.querySelectorAll('button, input[type="button"]'))
              .find(b => (b.value || b.textContent).trim() === '선택완료');
            if (btn) btn.click();
          }
        });
        await wait(300);
        t('캘린더 팝업으로 날짜 설정 완료');
      }

      // 7. XHR 인터셉터 주입 — 검색 클릭 전에 설치해서 응답+요청 파라미터 모두 저장
      await chrome.scripting.executeScript({
        target, world: 'MAIN',
        func: () => {
          window.__g2bResult = undefined;
          window.__g2bReqBody = undefined;
          window.__g2bReqContentType = undefined;
          const origOpen = XMLHttpRequest.prototype.open;
          const origSend = XMLHttpRequest.prototype.send;
          const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
          XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._g2bUrl = url;
            this._g2bHeaders = {};
            return origOpen.call(this, method, url, ...rest);
          };
          XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
            if (this._g2bHeaders) this._g2bHeaders[k] = v;
            return origSetHeader.call(this, k, v);
          };
          XMLHttpRequest.prototype.send = function(data) {
            if (this._g2bUrl && this._g2bUrl.includes('selectBidPbacScrollTypeList')) {
              window.__g2bReqBody = data;
              window.__g2bReqHeaders = this._g2bHeaders || {};
              this.addEventListener('load', () => {
                try {
                  const json = JSON.parse(this.responseText);
                  const list = json.result ?? json.list ?? json.data ?? json.items ?? [];
                  if (Array.isArray(list)) window.__g2bResult = list;
                } catch(e) {}
              });
            }
            return origSend.call(this, data);
          };
        }
      });

      // 8. 검색 버튼 클릭
      t('검색 시작');
      await chrome.scripting.executeScript({
        target, world: 'MAIN',
        func: () => {
          const btn =
            document.getElementById('mf_wfm_container_tacBidPbancLst_contents_tab2_body_btnS0004') ||
            document.querySelector('[id*="tacBidPbancLst"][id$="btnS0004"]') ||
            document.querySelector('[id*="tacBidPbancLst"] .btn_cm_srch') ||
            document.querySelector('[id*="btnS0004"]') ||
            Array.from(document.querySelectorAll('button, input[type="button"]'))
              .find(b => (b.textContent || b.value || '').trim() === '검색' && b.offsetParent !== null);
          if (btn) btn.click();
        }
      });

      // 9. window.__g2bResult 폴링 (최대 30초)
      for (let i = 0; i < 60; i++) {
        await wait(500);
        const [{result: xhrResult}] = await chrome.scripting.executeScript({
          target, world: 'MAIN',
          func: () => window.__g2bResult
        });
        if (xhrResult !== undefined) {
          t(`XHR 결과 수신 (${xhrResult.length}건)`);
          // 요청 파라미터 템플릿 저장 → 다음 실행부터 직접 API 호출
          try {
            const [{result: reqBody}] = await chrome.scripting.executeScript({
              target, world: 'MAIN', func: () => window.__g2bReqBody
            });
            const [{result: reqHeaders}] = await chrome.scripting.executeScript({
              target, world: 'MAIN', func: () => window.__g2bReqHeaders
            });
            if (reqBody) {
              await chrome.storage.local.set({
                [G2B_TEMPLATE_KEY]: { body: reqBody, headers: reqHeaders || {} }
              });
              t('템플릿 저장 완료 → 다음부터 직접 API 호출');
            }
          } catch(e) {}
          done = true;
          cleanup();
          resolve(xhrResult);
          return;
        }
      }

      done = true;
      cleanup();
      reject(new Error('나라장터 응답 없음 (30초 타임아웃)'));

    } catch(e) {
      cleanup();
      reject(new Error('g2b_error: ' + e.message));
    }
  });
}

// ─── 건축허브 ────────────────────────────────────────────
const HUB_URL = 'https://www.hub.go.kr/portal/dps/dsr/idx-dsr-selectDesignPbpPbancList.do?intYn=N';
const HUB_CACHE_KEY = 'hubList';
let hubFetching = false;

async function fetchHubList() {
  const tab = await chrome.tabs.create({ url: HUB_URL, active: false });
  await new Promise(resolve => {
    const onUpdated = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  await wait(2000);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const items = [];
      const allEls = document.querySelectorAll('li, tr, article, .item, .card, [class*="list"] > *');
      allEls.forEach(row => {
        const text = row.textContent || '';
        // 공고일
        const announceMatch = text.match(/공고일[^\d]*(\d{4}-\d{2}-\d{2})/);
        const pblancDe = announceMatch ? announceMatch[1] : '';
        // 등록일 / 게시일 / 접수시작일
        const uploadMatch = text.match(/(?:등록일|게시일|접수시작)[^\d]*(\d{4}-\d{2}-\d{2})/);
        const uploadDe = uploadMatch ? uploadMatch[1] : '';

        if (!pblancDe && !uploadDe) return;

        const titleEl = row.querySelector('a') ||
          row.querySelector('[class*="tit"], [class*="title"], [class*="subject"], strong');
        const title = titleEl?.textContent?.trim();
        const link  = row.querySelector('a')?.href || '';
        const regionEl = row.querySelector('[class*="region"], [class*="area"], [class*="loc"]');
        const region = regionEl?.textContent?.trim() || '';
        if (title && title.length > 3) items.push({ title, link, region, pblancDe, uploadDe });
      });

      const seen = new Set();
      return items.filter(i => { if (seen.has(i.title)) return false; seen.add(i.title); return true; });
    }
  });

  chrome.tabs.remove(tab.id).catch(() => {});
  return results[0]?.result || [];
}

// ─── 서울시 설계공모 ──────────────────────────────────────
const SEOUL_CACHE_KEY = 'seoulList';
let seoulFetching = false;

async function fetchSeoulList() {
  const SEOUL_LIST_URL = 'https://project.seoul.go.kr/view/viewListCptt.do';
  const SEOUL_API_URL  = 'https://project.seoul.go.kr/view/viewMoreListCptt.json';

  const tab = await chrome.tabs.create({ url: SEOUL_LIST_URL, active: false });
  await Promise.race([
    new Promise(resolve => {
      const onUpdated = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    }),
    wait(15000)
  ]);
  await wait(1000);

  // 탭 URL 확인 (리디렉션 여부)
  const tabInfo = await chrome.tabs.get(tab.id);
  if (!tabInfo.url?.includes('project.seoul.go.kr')) {
    chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error('서울시 페이지 로드 실패 (URL: ' + tabInfo.url + ')');
  }

  // 탭 내부에서 same-origin XHR 실행 → 쿠키 자동 전송
  let result;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (apiUrl) => {
        window.__seoulResult = undefined;
        window.__seoulError = undefined;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl, true);
        xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.setRequestHeader('Accept', 'application/json, text/javascript, */*; q=0.01');
        xhr.withCredentials = true;
        xhr.onload = function() {
          const t = xhr.responseText.trim();
          if (t.startsWith('<')) {
            window.__seoulError = 'HTML 응답 (status=' + xhr.status + ')';
            return;
          }
          try {
            const json = JSON.parse(t);
            window.__seoulResult = json?.cpttMstListVO?.cpttMstVOs ?? [];
          } catch(e) {
            window.__seoulError = '파싱 실패: ' + e.message;
          }
        };
        xhr.onerror = () => { window.__seoulError = 'XHR 네트워크 오류'; };
        xhr.send(JSON.stringify({ sortOrdr: 'REG_SCH_END_DT' }));
      },
      args: [SEOUL_API_URL]
    });

    // 결과 폴링 (최대 12초)
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await wait(600);
      const poll = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => ({ result: window.__seoulResult, error: window.__seoulError })
      });
      const r = poll[0]?.result;
      if (r?.error !== undefined) throw new Error(r.error);
      if (r?.result !== undefined) { result = r.result; break; }
    }
    if (result === undefined) throw new Error('서울시 응답 타임아웃');
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  return result;
}

// ─── 세움터 ─────────────────────────────────────────────
// 백그라운드에서 fetch 진행 중 여부
let fetching = false;
let fetchingSince = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_CACHE') {
    getCachedList().then(list => sendResponse({ ok: !!list, list, fetching }));
    return true;
  }

  if (msg.type === 'FETCH_LIST') {
    // 캐시 있으면 즉시 반환
    getCachedList().then(list => {
      if (list) { sendResponse({ ok: true, list }); return; }

      // 90초 넘게 진행 중이면 멈춘 것으로 보고 플래그 해제
      if (fetching && Date.now() - fetchingSince > 90000) fetching = false;
      if (fetching) { sendResponse({ ok: false, error: 'fetching' }); return; }

      // 새로 fetch
      fetching = true;
      fetchingSince = Date.now();
      fetchAllPages()
        .then(async list => {
          await setCachedList(list);
          fetching = false;
          sendResponse({ ok: true, list });
        })
        .catch(e => {
          fetching = false;
          sendResponse({ ok: false, error: e.message });
        });
    });
    return true;
  }

  if (msg.type === 'FETCH_HUB') {
    const dateYMD = msg.dateYMD;
    chrome.storage.session.get(HUB_CACHE_KEY).then(async s => {
      const c = s[HUB_CACHE_KEY];
      if (c && Date.now() - c.ts < CACHE_TTL) { sendResponse({ ok: true, list: c.list }); return; }
      if (hubFetching) { sendResponse({ ok: false, error: 'fetching' }); return; }
      hubFetching = true;
      try {
        const list = await fetchHubList();
        await chrome.storage.session.set({ [HUB_CACHE_KEY]: { list, ts: Date.now() } });
        hubFetching = false;
        sendResponse({ ok: true, list });
      } catch(e) {
        hubFetching = false;
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  if (msg.type === 'FETCH_SEOUL') {
    chrome.storage.session.get(SEOUL_CACHE_KEY).then(s => {
      const c = s[SEOUL_CACHE_KEY];
      if (c && Date.now() - c.ts < CACHE_TTL) {
        sendResponse({ ok: true, list: c.list });
        return;
      }
      // 즉시 응답해서 포트 닫힘 방지, 팝업은 스토리지 폴링
      sendResponse({ ok: false, error: 'fetching' });
      if (seoulFetching) return;
      seoulFetching = true;
      fetchSeoulList()
        .then(list => chrome.storage.session.set({ [SEOUL_CACHE_KEY]: { list, ts: Date.now() } }))
        .catch(e => chrome.storage.session.set({ [SEOUL_CACHE_KEY]: { error: e.message, ts: Date.now() } }))
        .finally(() => { seoulFetching = false; });
    });
    return true;
  }

  if (msg.type === 'FETCH_G2B') {
    const dateYMD = msg.dateYMD;
    getG2bCache().then(async cached => {
      if (cached) { sendResponse({ ok: true, list: cached }); return; }
      if (g2bFetching) { sendResponse({ ok: false, error: 'fetching' }); return; }
      g2bFetching = true;
      try {
        const list = await fetchG2bList(dateYMD);
        await chrome.storage.session.set({ [G2B_CACHE_KEY]: { list, ts: Date.now() } });
        g2bFetching = false;
        sendResponse({ ok: true, list });
      } catch(e) {
        g2bFetching = false;
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }
});
