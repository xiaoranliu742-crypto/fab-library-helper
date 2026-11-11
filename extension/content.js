/* Copyright (c) 2026 jushan. MIT License. */
(async function () {
  'use strict';
  if (document.getElementById('fab-free-helper-root')) return;
  const Core = globalThis.FabFreeCore;
  const host = document.createElement('div');
  host.id = 'fab-free-helper-root';
  host.style.cssText = 'all:initial;position:fixed;top:16px;left:max(8px,calc(50% - 190px));width:min(400px,calc(100vw - 16px));z-index:2147483646;color-scheme:dark;';
  const ui = host.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>
    :host{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#edecf6}
    *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.42}
    button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid #b6c6ff;outline-offset:3px}
    [hidden]{display:none!important}.shell{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#edecf6;background:rgba(20,20,29,.97);border:1px solid #343440;border-radius:23px;box-shadow:0 16px 50px #0005;overflow:hidden;backdrop-filter:blur(20px)}
    .bar{height:44px;display:flex;align-items:center;padding:0 9px 0 11px;gap:8px;touch-action:none;user-select:none}
    .grip{color:#696b7c;cursor:grab;padding:5px 3px;font-size:17px;line-height:1}
    .dot{width:7px;height:7px;flex:none;border-radius:50%;background:#8bf0af;box-shadow:0 0 9px #8bf0af33}.dot.warn{background:#ffbc79}
    .summary{color:#e2e1eb;font-size:12px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:none;border:0;text-align:left;padding:7px 0}
    .count{font-size:11px;color:#9ff1bc;background:#1e342b;border-radius:7px;padding:1px 7px;font-variant-numeric:tabular-nums;flex:none}
    .icon{background:transparent;color:#aaa9bb;border:0;border-radius:7px;font-size:18px;line-height:1;padding:5px 7px}
    .body{padding:2px 18px 16px;border-top:1px solid #ffffff0b}.heading{display:flex;align-items:center;justify-content:space-between;margin:15px 0 13px}
    h1{font-size:15px;font-weight:650;margin:0;letter-spacing:.2px}.badge{font-size:10px;letter-spacing:1px;color:#a8a7bd;border:1px solid #41414e;border-radius:5px;padding:1px 5px}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.stat{background:#ffffff05;border:1px solid #ffffff09;border-radius:11px;padding:9px 10px}.num{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}.label{font-size:11px;color:#9695a9}.green{color:#9ff1bc}.amber{color:#ffc588}
    .track{height:3px;background:#31313e;border-radius:3px;overflow:hidden;margin:15px 0 10px}.fill{height:100%;width:0;background:#9ff1bc}
    .message{font-size:12px;color:#aaa9bb;min-height:35px;overflow-wrap:anywhere;margin:0 0 12px}.message.error{color:#ffc588}
    .settings{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}.field{display:grid;gap:5px;font-size:11px;color:#a6a5b7}
    select{width:100%;background:#21212d;color:#dddce9;border:1px solid #383846;border-radius:8px;padding:7px 8px;min-width:0}
    .check{display:flex;align-items:center;gap:7px;color:#b3b1c3;font-size:12px;margin:10px 0 13px}.check input{accent-color:#9ff1bc;width:14px;height:14px}
    .actions{display:flex;gap:8px}.btn{border:1px solid #41414f;border-radius:9px;padding:9px 12px;background:#262631;color:#dfdeeb}.primary{flex:1;background:#a1f0bc;color:#12331e;border-color:#a1f0bc;font-weight:650}.stop{background:#3e2d23;color:#ffd1a1;border-color:#6a4a32}
    .list-head{display:flex;align-items:center;justify-content:space-between;margin:18px 0 8px;color:#a3a1b5;font-size:11px}.link-btn{border:0;background:none;color:#c4c2d4;padding:0;font-size:11px}.link-btn:disabled{opacity:.35}
    .list{max-height:min(280px,33vh);overflow:auto;scrollbar-width:thin;scrollbar-color:#414151 transparent}.row{display:flex;gap:8px;padding:10px 1px;border-top:1px solid #ffffff09;align-items:flex-start}.mark{width:18px;flex:none;text-align:center;color:#9693aa}.meta{min-width:0;flex:1}.name{display:block;color:#d2d0e0;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.name:hover{color:#b5f3cd}.note{font-size:10px;color:#8c8a9e;overflow-wrap:anywhere;margin-top:3px}.state{font-size:10px;white-space:nowrap;color:#9b98ac}
    .empty{padding:20px 5px;text-align:center;color:#9b98ac;font-size:12px}.footer{font-size:10px;color:#777487;margin-top:12px;display:flex;justify-content:space-between;gap:12px}
    @media(prefers-reduced-transparency:reduce){.shell{backdrop-filter:none;background:#14141d}}
    @media(max-width:430px){.body{padding:2px 12px 14px}.bar{gap:5px}.stat{padding:8px}.num{font-size:19px}}
  </style><section class="shell" aria-label="Fab 免费素材助手">
    <header class="bar"><span class="grip" title="拖动悬浮面板" aria-hidden="true">⠿</span><span class="dot"></span>
    <button class="summary" id="summary" aria-expanded="true" aria-controls="body">Fab 免费素材助手</button>
    <span class="count" id="counter">0/0</span><button class="icon" id="toggle" aria-label="收起面板" aria-expanded="true" aria-controls="body">⌃</button></header>
    <div class="body" id="body"><div class="heading"><h1>免费素材，一键入库</h1><span class="badge">FAB</span></div>
    <div class="stats"><div class="stat"><div class="num green" id="claimed">0</div><div class="label">已入库</div></div><div class="stat"><div class="num" id="owned">0</div><div class="label">已拥有</div></div><div class="stat"><div class="num" id="skipped">0</div><div class="label">已跳过</div></div><div class="stat"><div class="num amber" id="failed">0</div><div class="label">失败</div></div></div>
    <div class="track" role="progressbar" aria-label="入库进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div></div>
    <p class="message" id="message" role="status" aria-live="polite">正在扫描当前网页…</p>
    <div class="settings"><label class="field">领取授权<select id="license"><option value="auto">自动 · 只选零元授权</option><option value="professional">Professional · 专业</option><option value="personal">Personal · 个人</option></select></label>
    <label class="field">领取后间隔<select id="delay"><option value="500">0.5 秒 · 快速</option><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="4000">4 秒</option><option value="8000">8 秒</option></select></label></div>
    <label class="check"><input type="checkbox" id="scroll">自动向下滚动，继续处理新加载的素材</label>
    <div class="actions"><button class="btn primary" id="start">开始入库</button><button class="btn stop" id="pause" disabled>暂停</button><button class="btn" id="scan">重新扫描</button></div>
    <div class="list-head"><span id="found">当前网页 · 0 项</span><span><button class="link-btn" id="retry" disabled>重试失败</button>　<button class="link-btn" id="export" disabled>导出结果 ↗</button></span></div>
    <div class="list" id="list"></div><div class="footer"><span>仅领取已核对的零元授权</span><span>by jushan · v1.1.1</span></div>
    </div></section>`;
  document.documentElement.append(host);
  const $ = selector => ui.querySelector(selector);
  const items = new Map();
  let running = false, stopRequested = false, expanded = true, routeDirty = false;
  let route = location.pathname + location.search, message = '', error = false;
  const labels = { pending: '待核对', processing: '核对中', claimed: '已入库', owned: '已拥有', skipped: '已跳过', failed: '失败' };
  const marks = { pending: '·', processing: '◌', claimed: '✓', owned: '✓', skipped: '—', failed: '!' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const client = new Core.Client({ fetch: window.fetch.bind(window), cookie: () => document.cookie });
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    const all = [...items.values()];
    const counts = { claimed: 0, owned: 0, skipped: 0, failed: 0 };
    for (const item of all) if (item.status in counts) counts[item.status]++;
    const done = Object.values(counts).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(counts)) $('#' + key).textContent = counts[key];
    $('#counter').textContent = done + '/' + all.length;
    $('#summary').textContent = running ? (stopRequested ? '正在暂停 · 等待当前结果' : '正在入库 · ' + counts.claimed + ' 项成功') : 'Fab 助手 · ' + (done ? '已入库 ' + counts.claimed + ' 项' : '发现 ' + all.length + ' 项素材');
    $('#message').textContent = message;
    $('#message').classList.toggle('error', error);
    $('.dot').classList.toggle('warn', error);
    const pct = all.length ? Math.round(100 * done / all.length) : 0;
    $('.fill').style.width = pct + '%';
    $('.track').setAttribute('aria-valuenow', pct);
    $('#start').disabled = running || !all.some(i => i.status === 'pending');
    $('#start').textContent = done ? '继续入库' : '开始入库';
    $('#pause').disabled = !running || stopRequested;
    $('#scan').disabled = running;
    $('#retry').disabled = running || !counts.failed;
    $('#export').disabled = !all.length;
    for (const el of [$('#license'), $('#delay'), $('#scroll')]) el.disabled = running;
    $('#found').textContent = '当前网页 · ' + all.length + ' 项';
    const visible = all.filter(i => i.status === 'processing').concat(all.filter(i => i.status !== 'processing').slice(-60));
    $('#list').innerHTML = visible.length ? visible.map(i => `<div class="row"><span class="mark ${i.status === 'claimed' ? 'green' : ''}">${marks[i.status]}</span><div class="meta"><a class="name" href="${escape(i.href)}" target="_blank" rel="noopener noreferrer" title="${escape(i.name)}">${escape(i.name)}</a><div class="note">${escape(i.note || (i.hint === 'free' ? '网页标记免费 · 入库前再次核对价格' : i.hint === 'owned' ? '网页标记已拥有 · 将核对账号状态' : '将核对价格与拥有状态'))}</div></div><span class="state">${labels[i.status]}</span></div>`).join('') : '<div class="empty">当前页面尚未发现素材卡片。<br>请打开卖家页或搜索结果，等待加载后重新扫描。</div>';
  }
  function setMessage(text, isError = false) { message = text; error = isError; render(); }
  function discover(announce = false) {
    let added = 0;
    for (const item of Core.scan(document)) if (!items.has(item.id)) { items.set(item.id, item); added++; }
    if (announce) setMessage(items.size ? `已发现 ${items.size} 项素材。点击开始后会逐项核对价格和拥有状态。` : '没有发现素材链接。请确认当前页面已经加载素材卡片。');
    else if (added) render();
    return added;
  }
  function open(value) {
    expanded = value;
    $('#body').hidden = !expanded;
    $('#toggle').textContent = expanded ? '⌃' : '⌄';
    $('#toggle').setAttribute('aria-label', expanded ? '收起面板' : '展开面板');
    for (const el of [$('#toggle'), $('#summary')]) el.setAttribute('aria-expanded', String(expanded));
  }
  const shouldStop = () => stopRequested || location.pathname + location.search !== route || !chrome.runtime.id;
  async function waitInterruptibly(ms) {
    const until = Date.now() + ms;
    while (!shouldStop() && Date.now() < until) await sleep(Math.min(150, until - Date.now()));
  }
  async function run() {
    if (running) return;
    running = true; stopRequested = false;
    const preference = $('#license').value, delay = Number($('#delay').value), autoScroll = $('#scroll').checked;
    let emptyRounds = 0;
    discover();
    setMessage('开始核对当前网页的素材…');
    try {
      while (!shouldStop()) {
        let item = [...items.values()].find(i => i.status === 'pending');
        // Re-scan only after the known queue drains, not after every asset.
        if (!item) { discover(); item = [...items.values()].find(i => i.status === 'pending'); }
        if (!item) {
          if (!autoScroll || emptyRounds >= 5) break;
          setMessage('正在向下滚动，等待新素材加载…');
          window.scrollBy({ top: Math.max(500, window.innerHeight * .85), behavior: 'instant' });
          await waitInterruptibly(1600);
          if (shouldStop()) break;
          emptyRounds = discover() ? 0 : emptyRounds + 1;
          continue;
        }
        emptyRounds = 0;
        item.status = 'processing'; item.note = '';
        setMessage('正在核对：' + item.name);
        try {
          Object.assign(item, await client.claim(item, preference, shouldStop));
        } catch (e) {
          if (e instanceof Core.Paused) { item.status = 'pending'; break; }
          item.status = 'failed'; item.note = e.message;
          if (e.halt) { stopRequested = true; setMessage(e.message, true); }
        }
        render();
        // No claim was submitted for owned/paid items; don't add the full claim cooldown.
        await waitInterruptibly(['owned', 'skipped'].includes(item.status) ? Math.min(delay, 100) : delay);
      }
      if (!error) setMessage(shouldStop() ? '已暂停。已提交的项目会完成状态核对，之后不再领取下一项。' : autoScroll ? '本轮已完成：连续多次滚动未发现新素材。可继续滚动后重新扫描。' : '当前已加载素材处理完成。向下滚动后可重新扫描，或开启自动滚动。');
    } catch (e) { setMessage('任务已停止：' + e.message, true); }
    finally {
      running = false;
      if (routeDirty) { items.clear(); routeDirty = false; discover(true); }
      render();
    }
  }

  $('#summary').addEventListener('click', () => open(!expanded));
  $('#toggle').addEventListener('click', () => open(!expanded));
  ui.addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
  $('#scan').addEventListener('click', () => discover(true));
  $('#start').addEventListener('click', run);
  $('#pause').addEventListener('click', () => { stopRequested = true; setMessage('正在暂停，等待当前项目的状态核对完成…'); });
  $('#retry').addEventListener('click', () => { for (const item of items.values()) if (item.status === 'failed') { item.status = 'pending'; item.note = ''; } run(); });
  $('#export').addEventListener('click', () => {
    const data = { exportedAt: new Date().toISOString(), page: location.origin + location.pathname,
      results: [...items.values()].map(({ id, name, href, status, note }) => ({ id, name, href, status, note })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'fab-results-' + Date.now() + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  async function saveSettings() {
    try { await chrome.storage.local.set({ fabHelperSettings: { license: $('#license').value, delay: $('#delay').value, scroll: $('#scroll').checked } }); }
    catch { setMessage('扩展设置未能保存。如刚更新扩展，请刷新网页。', true); }
  }
  for (const id of ['license', 'delay', 'scroll']) $('#' + id).addEventListener('change', saveSettings);
  try {
    const { fabHelperSettings: saved } = await chrome.storage.local.get('fabHelperSettings');
    if (saved) {
      if (['auto', 'professional', 'personal'].includes(saved.license)) $('#license').value = saved.license;
      if (['500', '1000', '2000', '4000', '8000'].includes(String(saved.delay))) $('#delay').value = String(saved.delay);
      $('#scroll').checked = saved.scroll === true;
    }
  } catch { /* Defaults work even if local settings are unavailable. */ }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.type === 'FAB_HELPER_OPEN') { open(true); respond({ ok: true }); }
  });
  // Drag only the handle, preserving normal keyboard/click behavior on controls.
  $('.grip').addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = host.getBoundingClientRect(), dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    const move = p => {
      host.style.left = Math.max(8, Math.min(innerWidth - host.offsetWidth - 8, p.clientX - dx)) + 'px';
      host.style.top = Math.max(8, Math.min(innerHeight - 52, p.clientY - dy)) + 'px';
    };
    const end = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end, { once: true });
  });
  let scanTimer;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { if (!running && !routeDirty) discover(); }, 500);
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    const next = location.pathname + location.search;
    if (next !== route) {
      stopRequested = true; route = next;
      if (running) { routeDirty = true; setMessage('页面已切换，正在停止上一页的任务…'); }
      else { items.clear(); discover(true); }
    }
  }, 800);
  window.addEventListener('beforeunload', () => { stopRequested = true; });
  discover(true);
})();
