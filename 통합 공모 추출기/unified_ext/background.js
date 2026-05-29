// 서비스 워커 fallback: popup에서 chrome.debugger가 없을 때 여기서 처리
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'captureJudgeFiles') return false;
  const { tabId, fileCount } = request;
  captureJudgeFiles(tabId, fileCount)
    .then(data => sendResponse({ success: true, data }))
    .catch(e => sendResponse({ success: false, error: e.message }));
  return true;
});

async function captureJudgeFiles(tabId, fileCount) {
  const results = [];
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

    const resolvers = [];
    const SKIP = ['text/html', 'javascript', 'text/css', 'application/json', 'image/', 'font/'];

    const onEv = async (src, method, params) => {
      if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
      const { requestId, request = {}, responseHeaders = [], responseStatusCode } = params;
      const h = (n) => (responseHeaders.find(h => h.name.toLowerCase() === n)?.value || '').toLowerCase();
      const ct = h('content-type'), cd = h('content-disposition');

      const isFile =
        cd.includes('attachment') || cd.includes('filename') ||
        ct.includes('/pdf') || ct.includes('octet-stream') || ct.includes('hwp') ||
        ct.includes('x-download') || ct.includes('force-download') || ct.includes('msdownload') ||
        ct.includes('application/zip') ||
        (!SKIP.some(s => ct.includes(s)) && ct.startsWith('application/'));

      if (isFile && resolvers.length > 0) {
        const resolveCapture = resolvers.shift();
        const fileUrl = request.url;
        const fileMethod = (request.method || 'GET').toUpperCase();
        const postData = request.postData || null;
        const reqHeaders = request.headers || {};

        try {
          await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
            requestId, responseCode: 204,
            responseHeaders: [{ name: 'content-length', value: '0' }], body: ''
          });
        } catch {
          try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }); } catch {}
        }

        (async () => {
          let base64 = null;
          try {
            const fetchOpts = { credentials: 'include', method: fileMethod };
            if (fileMethod === 'POST' && postData) {
              fetchOpts.body = postData;
              const reqCt = reqHeaders['content-type'] || reqHeaders['Content-Type'];
              if (reqCt) fetchOpts.headers = { 'Content-Type': reqCt };
            }
            const resp = await fetch(fileUrl, fetchOpts);
            if (resp.ok) {
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
          resolveCapture(base64);
        })();
      } else {
        try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId }); } catch {}
      }
    };

    chrome.debugger.onEvent.addListener(onEv);

    const capturePromises = [];
    for (let i = 0; i < fileCount; i++) {
      const capturePromise = new Promise(r => resolvers.push(r));
      capturePromises.push(capturePromise);
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

    const allBase64 = await Promise.all(
      capturePromises.map(p => Promise.race([p, new Promise(r => setTimeout(() => r(null), 90000))]))
    );
    allBase64.forEach(base64 => results.push({ base64 }));

    chrome.debugger.onEvent.removeListener(onEv);
    try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable', {}); } catch {}
  } catch(e) {
    while (results.length < fileCount) results.push({ base64: null, _err: e.message });
  } finally {
    if (attached) try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  return results;
}
