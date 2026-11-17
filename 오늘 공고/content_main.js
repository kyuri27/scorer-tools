// MAIN world — Vue 앱 XHR 가로채기 + 캐시 저장
window.__seumterCache = window.__seumterCache || {};

const TARGET = 'AWPAIA01R02';
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  this._su = url;
  return origOpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function(data) {
  if (this._su && this._su.includes(TARGET)) {
    const body = data;
    this.addEventListener('load', () => {
      try {
        const json = JSON.parse(this.responseText);
        const list = json.dataList?.list || [];
        const bodyObj = JSON.parse(body || '{}');
        const key = bodyObj.pssrpProgStatNm || 'unknown';
        window.__seumterCache[key] = { list, ts: Date.now() };
      } catch(e) {}
    });
  }
  return origSend.call(this, data);
};

// background → CustomEvent로 fresh fetch 요청 수신
window.addEventListener('__seumter_fetch__', e => {
  const { key, body } = e.detail;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `https://www.eais.go.kr/awp/${TARGET}`);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = () => {
    try {
      const json = JSON.parse(xhr.responseText);
      const list = json.dataList?.list || [];
      window.__seumterCache[key] = { list, ts: Date.now() };
    } catch(e) {}
  };
  xhr.send(JSON.stringify(body));
});
