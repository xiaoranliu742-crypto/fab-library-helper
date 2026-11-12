// All requests in these tests are synthetic. No browser profile or live Fab page is accessed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Core = require('../extension/core.js');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const item = () => ({ id: A, name: 'Basket', href: `https://www.fab.com/listings/${A}` });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => value === null ? '' : JSON.stringify(value) });
const zero = { offers: [{ offerId: 'personal-offer', price: 0 }] };
const detail = { title: 'Basket', licenses: [{ slug: 'personal', offerId: 'personal-offer' }] };

function harness(options = {}) {
  const calls = [];
  let writes = 0;
  const client = new Core.Client({
    cookie: () => options.noCsrf ? '' : 'a=b; fab_csrftoken=fixture-only', sleep: async () => {},
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      assert.equal(init.credentials, 'include');
      if (options.status) return response({}, options.status);
      if (init.method === 'POST') {
        writes++;
        assert.equal(url, `/i/listings/${A}/add-to-library`);
        assert.equal(init.headers['X-CSRFToken'], 'fixture-only');
        assert.equal(JSON.parse(init.body).offerId, 'personal-offer');
        return response(null, 204);
      }
      if (url.includes('listings-states')) return response(options.badState ? {} : { acquired: options.owned === true || (writes > 0 && !options.neverOwned) });
      if (url.endsWith('/prices-infos')) { options.onPrice?.(); return response(options.prices || zero); }
      assert.equal(url, `/i/listings/${A}`);
      return response(options.detail || detail);
    }
  });
  return { client, calls, get writes() { return writes; } };
}

test('scans From Free, Chinese free and owned cards without Fab CSS classes or hover buttons', () => {
  const dom = new JSDOM(`<main><section>
    <article><a href="/listings/${A}?x=1"><img alt="Basket"></a><a href="/listings/${A}">Basket</a><p>From Free</p></article>
    <article><a href="/en-US/listings/${B}"><img alt="石头"></a><h3>石头</h3><p>来自 免费</p></article>
    <article><a href="/listings/${C}"><img alt="Stand"></a><h3>Stand</h3><p>Saved in My Library</p></article>
    <a href="https://evil.invalid/listings/${A}">Untrusted</a></section></main>`, { url: 'https://www.fab.com/sellers/fixture' });
  const rows = Core.scan(dom.window.document);
  assert.deepEqual(rows.map(i => [i.name, i.hint]), [['Basket', 'free'], ['石头', 'free'], ['Stand', 'owned']]);
  assert.equal(rows.length, 3);
  dom.window.close();
});

test('validates listing URLs and rejects non-Fab links and malformed IDs', () => {
  assert.equal(Core.listingId(`/zh-CN/listings/${A}#format`), A);
  assert.equal(Core.listingId('https://evil.invalid/listings/' + A), null);
  assert.equal(Core.listingId('/listings/not-a-real-id'), null);
  assert.equal(Core.listingId('javascript:alert(1)'), null);
});

test('missing, null, empty, boolean and non-finite prices are never interpreted as free', () => {
  for (const price of [null, '', false, undefined, NaN, Infinity, {}, 'free']) {
    assert.equal(Core.selectOffer({ isFree: true }, { offers: [{ offerId: 'x', price }] }), null);
  }
  assert.equal(Core.amount({ price: 0, discountedPrice: 20 }), 20);
  assert.equal(Core.amount({ price: '0.00' }), 0);
});

test('mixed licenses: picks only a zero-cost offer, even if Professional is paid', () => {
  const info = { licenses: [{ slug: 'personal', offerId: 'p' }, { slug: 'professional', offerId: 'pro' }] };
  const prices = { offers: [{ offerId: 'pro', price: 49 }, { offerId: 'p', price: 0 }] };
  assert.equal(Core.selectOffer(info, prices).offerId, 'p');
  assert.throws(() => Core.selectOffer(info, prices, 'professional'), /所选授权/);
  assert.equal(Core.selectOffer(info, { offers: [{ offerId: 'p', price: 5, discountedPrice: 0 }] }).offerId, 'p');
});

test('prefers Professional only when its own offer is zero-cost', () => {
  const info = { licenses: [{ slug: 'professional', offerId: 'pro' }] };
  assert.equal(Core.selectOffer(info, { offers: [{ offerId: 'p', price: 0 }, { offerId: 'pro', price: 0 }] }).offerId, 'pro');
});

test('an owned asset only needs a state read, with no write or price request', async () => {
  const h = harness({ owned: true });
  assert.equal((await h.client.claim(item())).status, 'owned');
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes, 0);
});

test('paid offers are skipped even if listing-level isFree says true', async () => {
  const h = harness({ detail: { isFree: true, startingPrice: { price: 0 } }, prices: { offers: [{ offerId: 'paid', price: 99 }] } });
  assert.equal((await h.client.claim(item())).status, 'skipped');
  assert.equal(h.writes, 0);
});

test('claims a verified zero-cost offer then confirms acquired state', async () => {
  const h = harness();
  assert.equal((await h.client.claim(item())).status, 'claimed');
  assert.equal(h.writes, 1);
  assert.match(h.calls.at(-1).url, /listings-states/);
});

test('fallback prices are queried only after incomplete detail, with no POST before zero-price verification', async () => {
  let releaseDetail,releasePrices;const d=new Promise(r=>{releaseDetail=r;}),p=new Promise(r=>{releasePrices=r;});
  const started=[];let posts=0;
  const client=new Core.Client({cookie:()=> 'fab_csrftoken=fixture-only',fetch:async(url,init)=>{
    if(url.includes('listings-states'))return response({acquired:posts>0});
    if(init.method==='POST'){posts++;return response(null,204);}
    if(url.endsWith('/prices-infos')){started.push('prices');await p;return response(zero);}
    started.push('detail');await d;return response(detail);
  }});
  const run=client.claim(item());
  try{
    await new Promise(r=>setTimeout(r,15));
    assert.deepEqual(started,['detail']);assert.equal(posts,0);
    releaseDetail();await new Promise(r=>setTimeout(r,15));
    assert.deepEqual(started,['detail','prices']);assert.equal(posts,0);
  }finally{releaseDetail();releasePrices();}
  assert.equal((await run).status,'claimed');
});

test('a failed detail stops before any price or POST request', async () => {
  const calls=[];
  const client=new Core.Client({fetch:async(url,init)=>{calls.push({url,init});return response(url.includes('listings-states')?{acquired:false}:{},url.includes('listings-states')?200:500);}});
  await assert.rejects(client.claim(item()),e=>e.status===500);
  assert.equal(calls.length,2);
  assert.ok(!calls.some(c=>c.url.endsWith('/prices-infos')||c.init.method==='POST'));
});

test('a successful POST does not count as success if ownership remains false', async () => {
  const h = harness({ neverOwned: true });
  await assert.rejects(h.client.claim(item()), /尚未确认/);
  assert.equal(h.calls.filter(c => c.url.includes('listings-states')).length, 4);
});

test('unrecognized ownership or pricing responses prevent a POST', async () => {
  const state = harness({ badState: true });
  await assert.rejects(state.client.claim(item()), /拥有状态/);
  assert.equal(state.writes, 0);
  const prices = harness({ prices: { unknown: [] } });
  await assert.rejects(prices.client.claim(item()), /价格结构/);
  assert.equal(prices.writes, 0);
});

test('pause during preflight prevents the write', async () => {
  let paused = false;
  const h = harness({ onPrice: () => { paused = true; } });
  await assert.rejects(h.client.claim(item(), 'auto', () => paused), Core.Paused);
  assert.equal(h.writes, 0);
});

test('missing CSRF token never sends an unauthenticated write', async () => {
  const h = harness({ noCsrf: true });
  await assert.rejects(h.client.claim(item()), error => error.status === 403 && error.halt);
  assert.equal(h.writes, 0);
});

test('login, verification and rate limits are actionable stop conditions', async () => {
  for (const status of [401, 403, 429]) {
    const h = harness({ status });
    await assert.rejects(h.client.claim(item()), error => error.status === status && error.halt);
    assert.equal(h.writes, 0);
  }
});

test('the client does not expose arbitrary endpoints or purchase operations', async () => {
  const h = harness();
  for (const p of ['https://evil.invalid/', '/i/checkout', '/i/listings/abc/buy', '/i/users/me/token']) await assert.rejects(h.client.request(p), /请求路径/);
  assert.equal(h.calls.length, 0);
});

const tick = () => new Promise(r => setTimeout(r, 15));
async function uiFixture(t, options = {}) {
  const dom = new JSDOM(options.html || `<main><article><a href="/listings/${A}"><img alt="Basket"></a><h3>Basket</h3><p>From Free</p></article></main>`, {
    url: options.url || 'https://www.fab.com/sellers/fixture', runScripts: 'outside-only', pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  if (options.userAgent) Object.defineProperty(w.navigator, 'userAgent', { value: options.userAgent });
  if (options.userAgent) Object.defineProperty(w.navigator, 'userAgent', { value: options.userAgent });
  const calls = [], messages = [];
  let posts = 0, identityCalls = 0;
  const storage = options.storage || {};
  if (options.settings) storage.fabHelperSettings = options.settings;
  w.document.cookie = 'fab_csrftoken=fixture-only';
  w.chrome = { runtime: { id: 'local-test', onMessage: { addListener(fn) { messages.push(fn); } } }, storage: { local: {
    get: async key => {
      if (options.beforeStorageGet) await options.beforeStorageGet(key);
      if (key === null && options.storageReadError) throw new Error('fixture read failure');
      return JSON.parse(JSON.stringify(key === null ? storage : (key in storage ? { [key]: storage[key] } : {})));
    },
    set: async values => {
      if (options.storageWriteError) throw new Error('fixture write failure');
      if (options.beforeStorageSet) await options.beforeStorageSet(values);
      Object.assign(storage, JSON.parse(JSON.stringify(values)));
    },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; }
  } } };
  w.fetch = async (url, init) => {
    if (url === '/i/users/me') {
      identityCalls++;
      return response(options.accountResponse || { uid: options.account || 'fixture-account' }, options.accountStatus || 200);
    }
    calls.push({ url, init });
    if (options.fetch) {
      if (init.method === 'POST') posts++;
      return options.fetch(url, init);
    }
    if (options.stateBarrier && url.includes('listings-states') && !posts) await options.stateBarrier;
    if (init.method === 'POST') { posts++; return response(null, 204); }
    if (url.includes('listings-states')) return response({ acquired: options.owned === true || posts > 0 });
    if (url.endsWith('/prices-infos')) return response(zero);
    return response(options.detail || detail);
  };
  w.eval(fs.readFileSync(path.join(__dirname, '../extension/core.js'), 'utf8'));
  let scans = 0;
  const scan = w.FabFreeCore.scan;
  const RealRequestGate = w.FabFreeCore.RequestGate;
  w.FabFreeCore = { ...w.FabFreeCore, RequestGate: RealRequestGate ? class extends RealRequestGate { constructor(config) { super(config); Object.defineProperty(this, 'interval', { get: () => options.requestInterval ?? 0, set: () => {} }); } } : undefined, scan(doc) { scans++; return scan(doc); } };
  w.eval(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'));
  await tick();
  const shadow = w.document.getElementById('fab-free-helper-root').shadowRoot;
  return { w, shadow, calls, storage, messages, get identityCalls() { return identityCalls; }, get posts() { return posts; }, get scans() { return scans; } };
}

test('webpage panel mounts, counts From Free and never auto-claims on load', async t => {
  const h = await uiFixture(t);
  assert.equal(h.shadow.querySelector('#found').textContent, '当前网页 · 1 项');
  assert.equal(h.calls.length, 0);
  assert.equal(h.shadow.querySelector('#start').disabled, false);
  assert.equal(h.shadow.querySelector('#delay').value, '500');
  assert.equal(h.shadow.querySelector('#body').hidden, true);
  h.shadow.querySelector('#toggle').click();
  assert.equal(h.shadow.querySelector('#body').hidden, false);
  h.shadow.querySelector('#summary').click();
  assert.equal(h.shadow.querySelector('#body').hidden, true);
});

test('speed upgrade preserves an existing user-selected interval', async t => {
  const h = await uiFixture(t, { settings: { delay: '2000', license: 'personal', concurrency: '1', scroll: false } });
  assert.equal(h.shadow.querySelector('#delay').value, '2000');
  assert.equal(h.shadow.querySelector('#license').value, 'personal');
  assert.equal(h.shadow.querySelector('#concurrency').value, '1');
});

const assetGrid = ids => '<main><section>' + ids.map(id => `<article><a href="/listings/${id}">Asset ${id}</a><p>From Free</p></article>`).join('') + '</section></main>';
async function until(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), message);
}

test('quick mode reserves exactly three assets concurrently and never duplicates a claim', async t => {
  const ids = [A, B, C, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff'];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const acquired = new Set(), posted = [];
  const h = await uiFixture(t, { html: assetGrid(ids), fetch: async (url, init) => {
    const id = url.match(/[a-f0-9-]{36}/)[0];
    if (url.includes('listings-states')) {
      if (!acquired.has(id)) await barrier;
      return response({ acquired: acquired.has(id) });
    }
    if (init.method === 'POST') { posted.push(id); acquired.add(id); return response(null, 204); }
    return response(url.endsWith('/prices-infos') ? zero : detail);
  } });
  assert.equal(h.shadow.querySelector('#concurrency').value, '3');
  h.shadow.querySelector('#start').click();
  try {
    await until(() => h.calls.length === 3, 'three ownership reads should overlap');
    assert.equal(h.shadow.querySelectorAll('.state').length, 6);
    assert.equal([...h.shadow.querySelectorAll('.state')].filter(e => e.textContent === '核对中').length, 3);
    assert.equal(h.posts, 0);
    assert.equal(h.shadow.querySelector('#concurrency').disabled, true);
  } finally { release(); }
  await until(() => h.shadow.querySelector('#pause').disabled, 'all workers should finish');
  assert.equal(h.shadow.querySelector('#claimed').textContent, '6');
  assert.deepEqual(posted.slice().sort(), ids.slice().sort());
  assert.equal(h.scans, 3);
});

test('serial option and pause prevent reserving another asset while a read is in flight', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const h = await uiFixture(t, { html: assetGrid([A, B, C]), stateBarrier: barrier, settings: { concurrency: '1' } });
  h.shadow.querySelector('#start').click();
  await until(() => h.calls.length === 1, 'only one read starts in serial mode');
  h.shadow.querySelector('#pause').click();
  release();
  await until(() => h.shadow.querySelector('#start').disabled === false, 'paused work returns to pending');
  assert.equal(h.calls.length, 1);
  assert.equal(h.posts, 0);
});

for (const concurrency of [3, 32]) test(`a rate limit stops ${concurrency} workers before POST and drains their outstanding reads`, async t => {
  let releaseOther, releaseLimited;
  const other = new Promise(resolve => { releaseOther = resolve; });
  const limited = new Promise(resolve => { releaseLimited = resolve; });
  const ids = [A, ...Array.from({ length: concurrency - 1 }, (_, i) => i.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa')];
  const h = await uiFixture(t, { html: assetGrid(ids), settings: { concurrency: String(concurrency) }, fetch: async (url, init) => {
    if (url.includes('listings-states')) return response({ acquired: false });
    if (init.method === 'POST') return response(null, 204);
    if (url.includes(A) && url.endsWith('/prices-infos')) { await limited; return response({}, 429); }
    if (!url.includes(A)) await other;
    return response(url.endsWith('/prices-infos') ? zero : detail);
  } });
  h.shadow.querySelector('#start').click();
  try {
    await until(() => h.calls.length === concurrency * 2 + 1, 'details and the limited price fallback should start');
    releaseLimited();
    await until(() => /限流/.test(h.shadow.querySelector('#message').textContent), 'rate limit must be reported immediately');
    assert.equal(h.shadow.querySelector('#start').disabled, true);
    assert.equal(h.shadow.querySelector('#concurrency').disabled, true);
    assert.equal(h.posts, 0);
  } finally { releaseLimited(); releaseOther(); }
  await until(() => h.shadow.querySelector('#concurrency').disabled === false, 'all outstanding reads must settle');
  assert.equal(h.posts, 0);
  assert.equal(h.shadow.querySelector('#failed').textContent, '1');
  assert.equal(h.shadow.querySelectorAll('.state').length, concurrency);
  assert.equal([...h.shadow.querySelectorAll('.state')].filter(e => e.textContent === '待核对').length, concurrency - 1);
});

test('pause waits for submitted claims to verify while stopping unsubmitted workers', async t => {
  let releaseVerify, releaseOther;
  const verify = new Promise(resolve => { releaseVerify = resolve; });
  const other = new Promise(resolve => { releaseOther = resolve; });
  let submitted = false;
  const h = await uiFixture(t, { html: assetGrid([A, B, C]), fetch: async (url, init) => {
    if (url.includes('listings-states')) {
      if (!url.includes(A)) { await other; return response({ acquired: false }); }
      if (submitted) await verify;
      return response({ acquired: submitted });
    }
    if (init.method === 'POST') { submitted = true; return response(null, 204); }
    return response(url.endsWith('/prices-infos') ? zero : detail);
  } });
  h.shadow.querySelector('#start').click();
  try {
    await until(() => h.posts === 1, 'first asset must be submitted');
    h.shadow.querySelector('#pause').click();
    assert.equal(h.shadow.querySelector('#claimed').textContent, '0');
    assert.equal(h.shadow.querySelector('#concurrency').disabled, true);
    releaseOther();
    await tick();
    assert.equal(h.posts, 1);
    assert.equal(h.shadow.querySelector('#concurrency').disabled, true);
  } finally { releaseOther(); releaseVerify(); }
  await until(() => h.shadow.querySelector('#concurrency').disabled === false, 'submitted ownership verification should finish');
  assert.equal(h.shadow.querySelector('#claimed').textContent, '1');
  assert.equal(h.posts, 1);
});

test('known owned queue drains without per-item page scans or a full claim cooldown', async t => {
  const html = '<main><section>' + [A, B, C].map(id => `<article><a href="/listings/${id}">Asset ${id}</a><p>From Free</p></article>`).join('') + '</section></main>';
  const h = await uiFixture(t, { html, owned: true });
  h.shadow.querySelector('#start').click();
  const deadline = Date.now() + 2500;
  while (!h.shadow.querySelector('#pause').disabled && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(h.shadow.querySelector('#owned').textContent, '3');
  assert.equal(h.calls.length, 3);
  assert.equal(h.posts, 0);
  assert.equal(h.scans, 3); // initial mount, start, then a single scan when the known queue drains
  assert.equal(h.shadow.querySelector('#pause').disabled, true);
});

test('panel start performs the full current-page claim and escapes untrusted titles', async t => {
  const h = await uiFixture(t, { detail: { ...detail, title: '<img src=x onerror=alert(1)>' } });
  h.shadow.querySelector('#start').click();
  await tick();
  assert.equal(h.posts, 1);
  assert.equal(h.shadow.querySelector('#claimed').textContent, '1');
  assert.equal(h.shadow.querySelectorAll('.list img').length, 0);
  assert.match(h.shadow.querySelector('.name').textContent, /<img/);
  h.shadow.querySelector('#pause').click();
  await new Promise(r => setTimeout(r, 180));
  assert.equal(h.shadow.querySelector('#pause').disabled, true);
});

test('switching pages during a read cancels before any claim POST', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const h = await uiFixture(t, { stateBarrier: barrier });
  h.shadow.querySelector('#start').click();
  await until(() => h.calls.length === 1, 'initial ownership read starts');
  h.w.history.pushState({}, '', '/sellers/different-fixture');
  release();
  await tick();
  assert.equal(h.posts, 0);
  assert.equal(h.calls.length, 1);
});

test('extension manifest is Fab-only, local code only, and needs no native program', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.fab.com/*']);
  for (const file of manifest.content_scripts[0].js) assert.ok(fs.existsSync(path.join(__dirname, '../extension', file)));
  assert.ok(!manifest.externally_connectable);
  assert.ok(!manifest.web_accessible_resources);
});

test('identity accepts stable IDs only and never uses email or display names as cache identity', async () => {
  for (const [user, expected] of [[{ uid: 'user-a' }, 'user-a'], [{ id: 'user-b' }, 'user-b'], [{ uid: 'user-c', isAnonymous: true }, null], [{ email: 'fixture@example.invalid', username: 'Display name' }, null], [{ uid: '../bad' }, null]]) {
    const client = new Core.Client({ fetch: async (url, init) => {
      assert.equal(url, '/i/users/me'); assert.equal(init.method, 'GET');
      return response(user);
    } });
    assert.equal(await client.account(), expected);
  }
});

test('confirmed ownership persists through a page reload with zero repeated asset requests', async t => {
  const storage = {};
  const first = await uiFixture(t, { storage, owned: true });
  first.shadow.querySelector('#start').click();
  await until(() => first.shadow.querySelector('#pause').disabled, 'first run should finish');
  const key = 'fabHelperOwned_v1_fixture-account_' + A;
  assert.equal(storage[key].status, 'owned');
  assert.deepEqual(Object.keys(storage[key]).sort(), ['confirmedAt', 'status', 'version']);
  const second = await uiFixture(t, { storage });
  second.shadow.querySelector('#start').click();
  await until(() => second.shadow.querySelector('#pause').disabled, 'cached run should finish');
  assert.equal(second.identityCalls, 1);
  assert.equal(second.calls.length, 0);
  assert.equal(second.posts, 0);
  assert.equal(second.shadow.querySelector('#owned').textContent, '1');
  assert.match(second.shadow.querySelector('.note').textContent, /本地记录/);
});

test('cache restores known rows while only new assets are queried', async t => {
  const storage = { ['fabHelperOwned_v1_fixture-account_' + A]: { version: 1, status: 'claimed', confirmedAt: Date.now() } };
  const h = await uiFixture(t, { storage, owned: true, html: assetGrid([A, B]) });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#pause').disabled, 'mixed queue should finish');
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].url.endsWith(B));
  assert.equal(h.shadow.querySelector('#owned').textContent, '2');
});

test('another Fab account never reuses existing ownership records', async t => {
  const keyA = 'fabHelperOwned_v1_account-a_' + A;
  const storage = { [keyA]: { version: 1, status: 'claimed', confirmedAt: Date.now() } };
  const h = await uiFixture(t, { storage, account: 'account-b' });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#pause').disabled, 'new account should finish its own claim');
  assert.equal(h.posts, 1);
  assert.equal(storage['fabHelperOwned_v1_account-b_' + A].status, 'claimed');
  assert.equal(storage[keyA].status, 'claimed');
});

test('unknown identity and invalid cache rows fall back to live verification', async t => {
  for (const unknownIdentity of [false, true]) {
    const storage = { ['fabHelperOwned_v1_fixture-account_' + A]: { version: 1, status: 'failed' } };
    const h = await uiFixture(t, { storage, owned: true, accountResponse: unknownIdentity ? { email: 'fixture@example.invalid' } : undefined });
    h.shadow.querySelector('#start').click();
    await until(() => h.shadow.querySelector('#pause').disabled, 'fallback should finish');
    assert.equal(h.calls.length, 1);
    if (unknownIdentity) assert.match(h.shadow.querySelector('#memory').textContent, /无法识别/);
  }
});

test('storage failure does not lose confirmed Fab ownership or report an unearned success', async t => {
  for (const failures of [{ storageReadError: true }, { storageWriteError: true }]) {
    const h = await uiFixture(t, failures);
    h.shadow.querySelector('#start').click();
    await until(() => h.shadow.querySelector('#pause').disabled, 'claim should finish despite local storage failure');
    assert.equal(h.posts, 1);
    assert.equal(h.shadow.querySelector('#claimed').textContent, '1');
    assert.equal(h.shadow.querySelector('#failed').textContent, '0');
    assert.match(h.shadow.querySelector('#memory').textContent, /失败/);
  }
});

test('clearing local records touches only the active account and makes no Fab write', async t => {
  const key = 'fabHelperOwned_v1_fixture-account_' + A;
  const otherKey = 'fabHelperOwned_v1_another-account_' + A;
  const storage = { [key]: { version: 1, status: 'owned' }, [otherKey]: { version: 1, status: 'owned' }, fabHelperSettings: { concurrency: '5' } };
  const h = await uiFixture(t, { storage });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#pause').disabled, 'cache restoration should finish');
  h.shadow.querySelector('#clear-memory').click();
  await tick();
  assert.equal(storage[key], undefined);
  assert.ok(storage[otherKey]);
  assert.ok(storage.fabHelperSettings);
  assert.equal(h.posts, 0);
  assert.equal(h.shadow.querySelector('#start').disabled, false);
});

for (const concurrency of [5, 8, 16, 32]) test(`${concurrency}-asset mode respects the selected in-flight limit and pauses cleanly`, async t => {
  const ids = Array.from({ length: concurrency + 2 }, (_, i) => i.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const h = await uiFixture(t, { html: assetGrid(ids), stateBarrier: barrier, settings: { concurrency: String(concurrency) } });
  assert.equal(h.shadow.querySelector('#concurrency').value, String(concurrency));
  h.shadow.querySelector('#start').click();
  try {
    await until(() => h.calls.length === concurrency, 'selected number of ownership requests starts');
    assert.equal([...h.shadow.querySelectorAll('.state')].filter(e => e.textContent === '核对中').length, concurrency);
    h.shadow.querySelector('#pause').click();
  } finally { release(); }
  await until(() => h.shadow.querySelector('#concurrency').disabled === false, 'workers should pause');
  assert.equal(h.calls.length, concurrency);
  assert.equal(h.posts, 0);
});

test('a changed login session stops preflight before claiming or caching ownership', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const h = await uiFixture(t, { stateBarrier: barrier });
  h.shadow.querySelector('#start').click();
  await until(() => h.calls.length === 1, 'preflight should start');
  h.w.document.cookie = 'fab_csrftoken=different-fixture';
  release();
  await until(() => h.shadow.querySelector('#concurrency').disabled === false, 'session change should stop work');
  assert.equal(h.posts, 0);
  assert.equal(Object.keys(h.storage).filter(k => k.startsWith('fabHelperOwned')).length, 0);
});

const catalogRow = id => ({ uid: id, title: 'Catalogue ' + id, isFree: true, user: { sellerName: 'Quixel Megascans' }, thumbnails: [{ uri: 'https://example.invalid/never-load.jpg' }] });
const catalogPage = (ids, next = null) => ({ results: ids.map(catalogRow), cursors: { next } });
const catalogRecord = account => 'fabHelperCatalog_v1_' + account + '_quixel';
const retryRecord = (account, id) => 'fabHelperRetry_v1_' + account + '_' + id;
const searchUrl = url => new URL(url, 'https://www.fab.com');

test('catalogue reads validate the seller, identifiers and cursors and retain no thumbnail data', async () => {
  const client = new Core.Client({ fetch: async url => {
    const params = searchUrl(url).searchParams;
    assert.equal(params.get('seller'), 'Quixel Megascans');
    assert.equal(params.get('is_free'), '1');
    assert.equal(params.get('count'), '24');
    assert.equal(params.get('cursor'), 'fixture+/=');
    return response(catalogPage([A], 'next-page'));
  } });
  const page = await client.quixelPage('fixture+/=');
  assert.equal(page.next, 'next-page');
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['hint', 'href', 'id', 'name', 'note', 'status']);
  for (const bad of [
    { results: [catalogRow(A)], cursors: { next: 'same' } },
    { results: [catalogRow(A), catalogRow(A)], cursors: { next: null } },
    { results: [{ ...catalogRow(A), user: { sellerName: 'Another seller' } }], cursors: { next: null } },
    { results: [{ ...catalogRow(A), uid: 'invalid' }], cursors: { next: null } },
    { results: [], cursors: { next: 'later' } },
    { results: [catalogRow(A)] }
  ]) {
    const c = new Core.Client({ fetch: async () => response(bad) });
    await assert.rejects(c.quixelPage('same'), Core.ApiError);
  }
});

test('catalogue API additions accept only the fixed free seller query and at most 24 state IDs', async () => {
  const h = harness();
  for (const url of [
    '/i/listings/search?seller=Quixel%20Megascans&is_free=1&count=24&sort_by=listingTypeWeight',
    '/i/listings/search?seller=Other&is_free=1&count=24&sort_by=title',
    '/i/listings/search?seller=Quixel%20Megascans&is_free=0&count=24&sort_by=title',
    '/i/listings/search?seller=Quixel%20Megascans&is_free=1&count=24&sort_by=title&token=x',
    '/i/users/me/listings-states?listing_ids=invalid',
    '/i/users/me/listings-states?' + Array.from({ length: 25 }, () => 'listing_ids=' + A).join('&')
  ]) await assert.rejects(h.client.request(url), /请求路径/);
  await assert.rejects(h.client.request('/i/listings/search?seller=Quixel%20Megascans&is_free=1&count=24&sort_by=title', 'POST'), /请求路径/);
  assert.equal(h.calls.length, 0);
});

test('bulk state results keep missing entries unknown and reject unrelated or malformed rows', async () => {
  const c = new Core.Client({ fetch: async () => response([{ uid: A, acquired: true }]) });
  const result = await c.states([A, B]);
  assert.equal(result.get(A), true);
  assert.equal(result.has(B), false);
  for (const rows of [[{ uid: C, acquired: true }], [{ uid: A, acquired: 'true' }], [{ uid: A, acquired: true }, { uid: A, acquired: true }], { acquired: true }]) {
    const bad = new Core.Client({ fetch: async () => response(rows) });
    await assert.rejects(bad.states([A, B]), /批量拥有状态/);
  }
});

test('Quixel seller pages default to a no-scroll catalogue without making requests on load', async t => {
  const h = await uiFixture(t, { url: 'https://www.fab.com/sellers/Quixel%20Megascans' });
  assert.equal(h.shadow.querySelector('#scope').value, 'quixel');
  assert.equal(h.shadow.querySelector('#scroll-option').hidden, true);
  assert.equal(h.shadow.querySelector('#start').disabled, false);
  assert.equal(h.scans, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.identityCalls, 0);
});

test('catalogue mode streams pages, checks owned batches and claims only new zero-price assets without scrolling', async t => {
  const acquired = new Set([A, B]);
  const h = await uiFixture(t, { settings: { scope: 'quixel', scroll: true, concurrency: '32' }, fetch: async (url, init) => {
    const parsed = searchUrl(url);
    if (parsed.pathname === '/i/listings/search') return response(parsed.searchParams.has('cursor') ? catalogPage([C]) : catalogPage([A, B], 'second'));
    if (parsed.pathname === '/i/users/me/listings-states') return response(parsed.searchParams.getAll('listing_ids').map(uid => ({ uid, acquired: acquired.has(uid) })));
    const id = url.match(/[a-f0-9-]{36}/)[0];
    if (url.includes('listings-states/')) return response({ acquired: acquired.has(id) });
    if (init.method === 'POST') { acquired.add(id); return response(null, 204); }
    return response(url.endsWith('/prices-infos') ? zero : detail);
  } });
  let scrolls = 0; h.w.scrollBy = () => scrolls++;
  h.shadow.querySelector('#start').click();
  await until(() => h.storage[catalogRecord('fixture-account')]?.done === true && h.shadow.querySelector('#scope').disabled === false, 'catalogue should reach the final page');
  assert.equal(scrolls, 0);
  assert.equal(h.scans, 1); // scan visible ownership badges once, without scrolling
  assert.equal(h.posts, 1);
  assert.equal(h.shadow.querySelector('#owned').textContent, '3');
  assert.equal(h.shadow.querySelector('#claimed').textContent, '1');
  assert.equal(h.shadow.querySelectorAll('.list img').length, 0);
  assert.equal(h.calls.filter(c => c.url.includes('/listings/search?')).length, 2);
  assert.equal(h.calls.filter(c => c.url.includes('/listings-states?')).length, 3);
  assert.ok(!h.calls.some(c => c.url.endsWith('/listings-states/' + A) || c.url.endsWith('/listings-states/' + B)));
  assert.equal(h.storage[catalogRecord('fixture-account')].pages, 2);
});

test('pausing a catalogue page keeps its cursor and reload resumes at that page', async t => {
  const storage = {};
  let release, secondStarted = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const first = await uiFixture(t, { storage, settings: { scope: 'quixel' }, fetch: async url => {
    const parsed = searchUrl(url);
    if (parsed.pathname === '/i/listings/search') {
      if (parsed.searchParams.has('cursor')) { secondStarted = true; await barrier; return response(catalogPage([B])); }
      return response(catalogPage([A], 'second'));
    }
    return response([{ uid: A, acquired: true }]);
  } });
  first.shadow.querySelector('#start').click();
  try {
    await until(() => secondStarted, 'the first page must finish and save its next cursor');
    first.shadow.querySelector('#pause').click();
  } finally { release(); }
  await until(() => first.shadow.querySelector('#scope').disabled === false, 'paused request should drain');
  assert.equal(storage[catalogRecord('fixture-account')].cursor, 'second');
  assert.equal(storage[catalogRecord('fixture-account')].done, false);
  const second = await uiFixture(t, { storage, fetch: async url => {
    const parsed = searchUrl(url);
    if (parsed.pathname === '/i/listings/search') { assert.equal(parsed.searchParams.get('cursor'), 'second'); return response(catalogPage([B])); }
    return response([{ uid: B, acquired: true }]);
  } });
  second.shadow.querySelector('#start').click();
  await until(() => second.shadow.querySelector('#scope').disabled === false, 'reload should finish only the resumed page');
  assert.equal(second.posts, 0);
  assert.equal(second.calls.filter(c => c.url.includes('/listings/search?')).length, 1);
  assert.equal(storage[catalogRecord('fixture-account')].pages, 2);
});

for (const stage of ['directory', 'bulk-state', 'prices']) test(`catalogue ${stage} rate limiting stops before any claim or cursor advance`, async t => {
  const h = await uiFixture(t, { settings: { scope: 'quixel', concurrency: '32' }, fetch: async url => {
    const parsed = searchUrl(url);
    if (parsed.pathname === '/i/listings/search') return response(stage === 'directory' ? {} : catalogPage([A], 'second'), stage === 'directory' ? 429 : 200);
    if (parsed.pathname === '/i/users/me/listings-states') return response(stage === 'bulk-state' ? {} : [{ uid: A, acquired: false }], stage === 'bulk-state' ? 429 : 200);
    if (url.includes('listings-states/')) return response({ acquired: false });
    if (url.endsWith('/prices-infos')) return response({}, 429);
    return response(detail);
  } });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'limited work should stop');
  assert.equal(h.posts, 0);
  assert.equal(h.storage[catalogRecord('fixture-account')], undefined);
  assert.match(h.shadow.querySelector('#message').textContent, /限流/);
  assert.equal(h.calls.filter(c => c.url.includes('/listings/search?')).length, 1);
});

test('unrecognized bulk states fall back to individual ownership verification', async t => {
  const h = await uiFixture(t, { settings: { scope: 'quixel' }, fetch: async url => {
    if (url.includes('/listings/search?')) return response(catalogPage([A]));
    if (url.includes('/listings-states?')) return response({ unexpected: 'schema' });
    return response({ acquired: true });
  } });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'fallback should finish');
  assert.equal(h.posts, 0);
  assert.equal(h.calls.filter(c => c.url.endsWith('/listings-states/' + A)).length, 1);
  assert.equal(h.shadow.querySelector('#owned').textContent, '1');
});

test('a failed asset is saved separately and can be retried after the directory finishes', async t => {
  let fail = true, submitted = false;
  const h = await uiFixture(t, { settings: { scope: 'quixel' }, fetch: async (url, init) => {
    if (url.includes('/listings/search?')) return response(catalogPage([A]));
    if (url.includes('/listings-states?')) return response([{ uid: A, acquired: submitted }]);
    if (url.includes('listings-states/')) return response({ acquired: submitted });
    if (init.method === 'POST') { submitted = true; return response(null, 204); }
    if (url.endsWith('/prices-infos')) return response(fail ? {} : zero, fail ? 500 : 200);
    return response(detail);
  } });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'failed page should stop');
  assert.equal(h.storage[catalogRecord('fixture-account')].done, true);
  assert.equal(h.storage[retryRecord('fixture-account', A)].version, 1);
  assert.equal(h.shadow.querySelector('#failed').textContent, '1');
  fail = false;
  h.shadow.querySelector('#retry').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'retry should finish');
  assert.equal(h.posts, 1);
  assert.equal(h.storage[retryRecord('fixture-account', A)], undefined);
  assert.equal(h.calls.filter(c => c.url.includes('/listings/search?')).length, 1);
  assert.equal(h.storage[catalogRecord('fixture-account')].done, true);
});

test('catalogue cursors are account-scoped and reset can start over before identity has loaded', async t => {
  const old = catalogRecord('another-account'), current = catalogRecord('fixture-account');
  const storage = { [old]: { version: 1, cursor: 'other', pages: 50, done: true }, [current]: { version: 1, cursor: 'finished', pages: 10, done: true }, ['fabHelperOwned_v1_fixture-account_' + A]: { version: 1, status: 'owned' } };
  const h = await uiFixture(t, { storage, settings: { scope: 'quixel' }, fetch: async url => {
    assert.ok(url.includes('/listings/search?'));
    assert.equal(searchUrl(url).searchParams.has('cursor'), false);
    return response(catalogPage([A]));
  } });
  h.shadow.querySelector('#scan').click();
  await tick();
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'reset should start at page one');
  assert.equal(h.calls.length, 1);
  assert.equal(storage[current].pages, 1);
  assert.equal(storage[old].cursor, 'other');
  h.shadow.querySelector('#clear-memory').click();
  await tick();
  assert.equal(storage[current], undefined);
  assert.equal(storage['fabHelperOwned_v1_fixture-account_' + A], undefined);
  assert.equal(storage[old].cursor, 'other');
  assert.equal(h.posts, 0);
});

test('hiding library products stops catalogue pagination before it can skip shifting results', async t => {
  const h = await uiFixture(t, { settings: { scope: 'quixel' }, accountResponse: { uid: 'fixture-account', preferences: { showMyLibraryProducts: false } } });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'unsafe pagination preference should stop');
  assert.equal(h.calls.length, 0);
  assert.equal(h.posts, 0);
  assert.match(h.shadow.querySelector('#message').textContent, /分页移位/);
});

test('pause during a batch ownership read prevents all following reads and writes', async t => {
  let release, started = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const h = await uiFixture(t, { settings: { scope: 'quixel' }, fetch: async url => {
    if (url.includes('/listings/search?')) return response(catalogPage([A]));
    started = true; await barrier;
    return response([{ uid: A, acquired: false }]);
  } });
  h.shadow.querySelector('#start').click();
  try {
    await until(() => started, 'bulk read must start');
    h.shadow.querySelector('#pause').click();
  } finally { release(); }
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'bulk read should drain');
  assert.equal(h.calls.length, 2);
  assert.equal(h.posts, 0);
  assert.equal(h.storage[catalogRecord('fixture-account')], undefined);
});

test('a new account starts from page one and never reuses another account catalogue completion', async t => {
  const storage = { [catalogRecord('fixture-account')]: { version: 1, cursor: 'previous', pages: 100, done: true }, ['fabHelperOwned_v1_fixture-account_' + A]: { version: 1, status: 'owned' } };
  const h = await uiFixture(t, { storage, account: 'new-account', settings: { scope: 'quixel' }, fetch: async url => {
    if (url.includes('/listings/search?')) { assert.equal(searchUrl(url).searchParams.has('cursor'), false); return response(catalogPage([A])); }
    return response([{ uid: A, acquired: true }]);
  } });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'new account should complete its own directory');
  assert.equal(h.calls.length, 2);
  assert.equal(storage[catalogRecord('new-account')].pages, 1);
  assert.equal(storage[catalogRecord('fixture-account')].pages, 100);
});


test('stable title ordering uses position cursors rather than the repeating weight offset', async () => {
  const next = 'bz0zJnA9QWZyaWNhbitGbGFn';
  const seen = [];
  const client = new Core.Client({ fetch: async url => {
    const p = searchUrl(url).searchParams;
    assert.equal(p.get('sort_by'), 'title');
    seen.push(p.get('cursor'));
    return response(catalogPage([p.has('cursor') ? B : A], p.has('cursor') ? null : next));
  } });
  const first = await client.quixelPage();
  await client.quixelPage(first.next);
  assert.deepEqual(seen, [null, next]);
});

test('legacy weight checkpoints migrate once, retain ownership, and resume the new title checkpoint after reload', async t => {
  const key = catalogRecord('fixture-account');
  const ownedKey = 'fabHelperOwned_v1_fixture-account_' + A;
  const owned = { version: 1, status: 'owned', confirmedAt: 12345 };
  const storage = { [key]: { version: 1, cursor: 'bz01MDI0', pages: 210, done: false }, [ownedKey]: owned };
  const first = await uiFixture(t, { storage, settings: { scope: 'quixel' }, fetch: async url => {
    const p = searchUrl(url);
    assert.equal(p.pathname, '/i/listings/search');
    if (p.searchParams.has('cursor')) {
      assert.equal(p.searchParams.get('cursor'), 'stable-second');
      return response({}, 500);
    }
    assert.equal(p.searchParams.get('sort_by'), 'title');
    return response(catalogPage([A], 'stable-second'));
  } });
  first.shadow.querySelector('#start').click();
  await until(() => first.shadow.querySelector('#scope').disabled === false, 'migrated scan should save a title checkpoint before the simulated network failure');
  assert.deepEqual(storage[ownedKey], owned);
  assert.equal(storage[key].version, 2);
  assert.equal(storage[key].sort, 'title');
  assert.equal(storage[key].cursor, 'stable-second');
  assert.equal(storage[key].pages, 1);
  assert.equal(storage[key].done, false);
  assert.equal(first.calls.length, 2);
  assert.equal(first.posts, 0);
  const second = await uiFixture(t, { storage, fetch: async url => {
    const p = searchUrl(url);
    if (p.pathname === '/i/listings/search') {
      assert.equal(p.searchParams.get('cursor'), 'stable-second');
      return response(catalogPage([B]));
    }
    return response([{ uid: B, acquired: true }]);
  } });
  second.shadow.querySelector('#start').click();
  await until(() => second.shadow.querySelector('#scope').disabled === false, 'reload should resume the title cursor');
  assert.equal(storage[key].done, true);
  assert.equal(storage[key].pages, 2);
  assert.equal(second.calls.filter(c => c.url.includes('/listings/search?')).length, 1);
  assert.equal(second.posts, 0);
});

test('repeated title cursors stop safely and the Continue button can retry the same checkpoint', async t => {
  const key = catalogRecord('fixture-account');
  const storage = { [key]: { version: 2, sort: 'title', cursor: 'stable-page', pages: 210, done: false }, ['fabHelperOwned_v1_fixture-account_' + A]: { version: 1, status: 'owned' } };
  let repeated = true;
  const h = await uiFixture(t, { storage, settings: { scope: 'quixel' }, fetch: async url => {
    assert.equal(searchUrl(url).searchParams.get('cursor'), 'stable-page');
    return response(catalogPage([A], repeated ? 'stable-page' : null));
  } });
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'a repeated page should stop and drain');
  assert.equal(storage[key].cursor, 'stable-page');
  assert.equal(storage[key].pages, 210);
  assert.equal(h.shadow.querySelector('#start').disabled, false);
  assert.match(h.shadow.querySelector('#message').textContent, /分页断点异常/);
  repeated = false;
  h.shadow.querySelector('#start').click();
  await until(() => h.shadow.querySelector('#scope').disabled === false, 'Continue should finish when the endpoint recovers');
  assert.equal(storage[key].done, true);
  assert.equal(storage[key].pages, 211);
  assert.equal(h.posts, 0);
  assert.equal(h.calls.length, 2);
});

test('browser-local ownership, checkpoints and clearing stay isolated for the same Fab account', async t => {
  const key = catalogRecord('fixture-account');
  const edgeStore = { [key]: { version: 2, sort: 'title', cursor: 'edge-page', pages: 2, done: false }, ['fabHelperOwned_v1_fixture-account_' + A]: { version: 1, status: 'owned' } };
  const chromeStore = { [key]: { version: 2, sort: 'title', cursor: 'chrome-page', pages: 8, done: false }, ['fabHelperOwned_v1_fixture-account_' + B]: { version: 1, status: 'owned' } };
  edgeStore[retryRecord('fixture-account', C)] = { version: 1, name: 'Edge failed', note: 'HTTP 500' };
  chromeStore[retryRecord('fixture-account', C)] = { version: 1, name: 'Chrome failed', note: 'HTTP 404' };
  const originalChrome = JSON.stringify(chromeStore);
  function browserFetch(cursor, unknown) { return async url => {
    const p = searchUrl(url);
    if (p.pathname === '/i/listings/search') {
      assert.equal(p.searchParams.get('cursor'), cursor);
      return response(catalogPage([A, B]));
    }
    assert.deepEqual(p.searchParams.getAll('listing_ids'), [unknown]);
    return response([{ uid: unknown, acquired: true }]);
  }; }
  const edge = await uiFixture(t, { storage: edgeStore, settings: { scope: 'quixel' }, userAgent: 'Mozilla/5.0 Chrome/140.0 Edg/140.0', fetch: browserFetch('edge-page', B) });
  edge.shadow.querySelector('#start').click();
  await until(() => edge.shadow.querySelector('#scope').disabled === false, 'Edge should finish its own checkpoint');
  assert.equal(JSON.stringify(chromeStore), originalChrome);
  assert.match(edge.shadow.querySelector('#memory').textContent, /Edge/);
  const chrome = await uiFixture(t, { storage: chromeStore, settings: { scope: 'quixel' }, userAgent: 'Mozilla/5.0 Chrome/140.0', fetch: browserFetch('chrome-page', A) });
  chrome.shadow.querySelector('#start').click();
  await until(() => chrome.shadow.querySelector('#scope').disabled === false, 'Chrome should finish its own checkpoint');
  assert.match(chrome.shadow.querySelector('#memory').textContent, /Chrome/);
  assert.equal(edgeStore[key].pages, 3);
  assert.equal(chromeStore[key].pages, 9);
  const completedChrome = JSON.stringify(chromeStore);
  edge.shadow.querySelector('#clear-memory').click();
  await tick();
  assert.equal(edgeStore[key], undefined);
  assert.equal(edgeStore[retryRecord('fixture-account', C)], undefined);
  assert.equal(chromeStore[retryRecord('fixture-account', C)].note, 'HTTP 404');
  assert.equal(JSON.stringify(chromeStore), completedChrome);
  assert.equal(edge.posts + chrome.posts, 0);
});


test('an HTTP 400 bundle failure is durable before the next cursor and Continue can retry it independently', async t => {
  let release, saving = false, fail = true, submitted = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const key = catalogRecord('fixture-account'), retryKey = retryRecord('fixture-account', A);
  const storage = { ['fabHelperOwned_v1_fixture-account_' + B]: {version:1,status:'owned'}, ['fabHelperOwned_v1_fixture-account_' + C]: {version:1,status:'owned'} };
  const h = await uiFixture(t, { storage, settings: {scope:'quixel'}, beforeStorageSet: async values => {
    if (retryKey in values && !saving) { saving = true; await barrier; }
  }, fetch: async (url,init) => {
    const p = searchUrl(url);
    if (p.pathname === '/i/listings/search') {
      if (p.searchParams.has('cursor')) {
        assert.ok(storage[retryKey], 'failed item must be saved before advancing');
        assert.equal(storage[key].cursor, 'next-page');
        return response(catalogPage([C]));
      }
      return response(catalogPage([A,B], 'next-page'));
    }
    if (p.pathname === '/i/users/me/listings-states') return response([{uid:A,acquired:submitted}]);
    if (url.includes('listings-states/')) return response({acquired:submitted});
    if (init.method === 'POST') {if (fail) return response({},400); submitted=true;return response(null,204);}
    return response(url.endsWith('/prices-infos') ? zero : {...detail,title:'Alpine Tundra Bundle',listingType:'bundle'});
  } });
  h.shadow.querySelector('#start').click();
  try {
    await until(()=>saving, 'failure queue write should start');
    assert.equal(storage[key],undefined);
    assert.equal(h.calls.filter(c=>c.url.includes('/listings/search?')).length,1);
  } finally {release();}
  await until(()=>storage[key]?.done && !h.shadow.querySelector('#scope').disabled,'later page should finish despite one failed asset');
  assert.equal(h.posts,2);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'0');
  assert.match(storage[retryKey].note,/HTTP 400/);
  assert.equal(h.shadow.querySelector('#owned').textContent,'2');
  assert.equal(h.shadow.querySelector('#failed').textContent,'1');
  assert.ok(h.shadow.querySelector('.row .name').href.endsWith(A));
  assert.match(h.shadow.querySelector('#message').textContent,/待重试/);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.equal(h.shadow.querySelector('#start').textContent,'重试未完成');
  fail=false;
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'Continue should retry only unresolved items');
  assert.equal(h.posts,3);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'1');
  assert.equal(storage[retryKey],undefined);
  assert.equal(storage[key].pages,2);
  assert.equal(h.calls.filter(c=>c.url.includes('/listings/search?')).length,2);
  assert.equal(h.shadow.querySelector('#failed').textContent,'0');
});

test('saved failed assets survive reload, ignore other accounts and clear only with the active account', async t => {
  const key=catalogRecord('fixture-account'), retryKey=retryRecord('fixture-account',A), other=retryRecord('other-account',C);
  const checkpoint={version:2,sort:'title',cursor:'',pages:210,done:true};
  const storage={ [key]:checkpoint, [retryKey]:{version:1,name:'Recover me',note:'HTTP 404'}, [other]:{version:1,name:'Other account',note:'HTTP 500'} };
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'},fetch:async url=>{
    assert.ok(url.endsWith('/listings-states/'+A));
    return response({acquired:true});
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'finished directory should restore failures');
  assert.equal(h.calls.length,0);
  assert.equal(h.shadow.querySelector('#failed').textContent,'1');
  assert.match(h.shadow.querySelector('#list').textContent,/HTTP 404/);
  h.shadow.querySelector('#retry').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'saved failure should be retried independently');
  assert.equal(h.calls.length,1);
  assert.equal(h.posts,0);
  assert.equal(storage[retryKey],undefined);
  assert.deepEqual(storage[key],checkpoint);
  assert.equal(storage[other].note,'HTTP 500');
  h.shadow.querySelector('#clear-memory').click();
  await tick();
  assert.equal(storage[key],undefined);
  assert.equal(storage[other].note,'HTTP 500');
});

test('failure queue storage errors never advance the page or discard the failing asset', async t => {
  const key=catalogRecord('fixture-account');
  const checkpoint={version:2,sort:'title',cursor:'keep-this-page',pages:7,done:false};
  const storage={[key]:checkpoint};
  const h=await uiFixture(t,{storage,storageWriteError:true,settings:{scope:'quixel'},fetch:async url=>{
    if(url.includes('/listings/search?')) return response(catalogPage([A],'next-page'));
    if(url.includes('/listings-states?')) return response([{uid:A,acquired:false}]);
    if(url.includes('listings-states/')) return response({acquired:false});
    if(url.endsWith('/prices-infos')) return response({},500);
    return response(detail);
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'storage error should safely stop');
  assert.deepEqual(storage[key],checkpoint);
  assert.equal(storage[retryRecord('fixture-account',A)],undefined);
  assert.equal(h.shadow.querySelector('#failed').textContent,'1');
  assert.match(h.shadow.querySelector('#message').textContent,/保存失败/);
  assert.match(h.shadow.querySelector('.row .note').textContent,/HTTP 500/);
  assert.equal(h.calls.filter(c=>c.url.includes('/listings/search?')).length,1);
  assert.equal(h.posts,0);
});

test('rate limiting while retrying saved failures keeps them and sends no claim', async t => {
  const key=catalogRecord('fixture-account'), retryKey=retryRecord('fixture-account',A);
  const checkpoint={version:2,sort:'title',cursor:'',pages:9,done:true};
  const storage={[key]:checkpoint,[retryKey]:{version:1,name:'Retry',note:'HTTP 500'}};
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'},fetch:async()=>response({},429)});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'failure should restore');
  h.shadow.querySelector('#retry').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'rate limited retry should stop');
  assert.ok(storage[retryKey]);
  assert.deepEqual(storage[key],checkpoint);
  assert.match(h.shadow.querySelector('#message').textContent,/限流/);
  assert.equal(h.posts,0);
  assert.equal(h.calls.length,1);
});


test('pausing a saved-failure retry keeps Continue available and the durable queue intact', async t => {
  const key=catalogRecord('fixture-account'), retryKey=retryRecord('fixture-account',A);
  const storage={[key]:{version:2,sort:'title',cursor:'',pages:3,done:true},[retryKey]:{version:1,name:'Paused retry',note:'HTTP 500'}};
  let release;const barrier=new Promise(resolve=>{release=resolve;});
  const h=await uiFixture(t,{storage,stateBarrier:barrier,settings:{scope:'quixel'}});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'restore failure');
  h.shadow.querySelector('#start').click();
  try {
    await until(()=>h.calls.length===1,'retry state read should start');
    h.shadow.querySelector('#pause').click();
  } finally {release();}
  await until(()=>!h.shadow.querySelector('#scope').disabled,'paused retry should drain');
  assert.equal(h.posts,0);
  assert.ok(storage[retryKey]);
  assert.equal(h.shadow.querySelector('#failed').textContent,'1');
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'Continue should resume the paused failed item');
  assert.equal(h.posts,1);
  assert.equal(storage[retryKey],undefined);
  assert.ok(h.calls.every(c=>!c.url.includes('/listings/search?')));
});

test('changing accounts before a retry never uses the old failures and leaves Start usable', async t => {
  const key=catalogRecord('fixture-account'), retryKey=retryRecord('fixture-account',A);
  const storage={[key]:{version:2,sort:'title',cursor:'',pages:3,done:true},[retryKey]:{version:1,name:'Old account',note:'HTTP 500'}};
  const account={uid:'fixture-account'};
  const h=await uiFixture(t,{storage,accountResponse:account,settings:{scope:'quixel'},fetch:async url=>{
    assert.ok(url.includes('/listings/search?'));
    assert.equal(searchUrl(url).searchParams.has('cursor'),false);
    return response(catalogPage([]));
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'restore old failure');
  account.uid='other-account';
  h.shadow.querySelector('#retry').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'account change should stop the retry');
  assert.equal(h.calls.length,0);
  assert.ok(storage[retryKey]);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.equal(h.shadow.querySelector('#failed').textContent,'0');
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'new account should be able to start its own directory');
  assert.ok(storage[catalogRecord('other-account')].done);
  assert.equal(storage[key].pages,3);
  assert.ok(storage[retryKey]);
  assert.equal(h.posts,0);
});


test('a single gate spaces every request start, including reads and submission confirmation', async () => {
  const gate=new Core.RequestGate({interval:20});
  const starts=[];
  const client=new Core.Client({beforeRequest:()=>gate.wait(),fetch:async()=>{starts.push(Date.now());return response({});}});
  await Promise.all([client.request('/i/users/me'),client.request('/i/listings/'+A),client.request('/i/listings/'+A+'/prices-infos'),client.request('/i/users/me/listings-states/'+A,'GET',undefined,{afterSubmission:true})]);
  assert.equal(starts.length,4);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=20,'requests must not burst together');
});

test('429 cancels queued requests before fetch and never dispatches the queued POST', async () => {
  const gate=new Core.RequestGate({interval:20});
  let stopped=false;const methods=[];
  const client=new Core.Client({cookie:()=> 'fab_csrftoken=fixture-only',beforeRequest:()=>gate.wait(()=>stopped),onHalt:()=>{stopped=true;},fetch:async(url,init)=>{methods.push(init.method);return response({},429);}});
  const results=await Promise.allSettled([client.request('/i/users/me'),client.request('/i/listings/'+A+'/add-to-library','POST',{offerId:'fixture'})]);
  assert.equal(results[0].reason.status,429);
  assert.ok(results[1].reason instanceof Core.Paused);
  assert.deepEqual(methods,['GET']);
});

test('429 exposes Retry-After seconds and HTTP dates as advice, with no invented fallback', async () => {
  const now=Date.UTC(2026,10,11,12,0,0);
  for(const [header,ms] of [['90',90000],[new Date(now+120000).toUTCString(),120000],[null,null]]){
    const client=new Core.Client({now:()=>now,fetch:async()=>({...response({},429),headers:{get:name=>name.toLowerCase()==='retry-after'?header:null}})});
    await assert.rejects(client.account(),e=>e.status===429&&e.retryAt===(ms===null?undefined:now+ms)&&/手动继续/.test(e.message)&&!/冷却/.test(e.message));
  }
});

test('a submitted claim can still confirm during a manual pause through the request gate', async () => {
  let stopped=false,submitted=false;const roles=[];
  const client=new Core.Client({cookie:()=> 'fab_csrftoken=fixture-only',beforeRequest:async role=>{roles.push(role.afterSubmission===true);if(stopped&&!role.afterSubmission)throw new Core.Paused();},fetch:async(url,init)=>{
    if(url.includes('listings-states'))return response({acquired:submitted});
    if(init.method==='POST'){submitted=true;stopped=true;return response(null,204);}
    return response(url.endsWith('/prices-infos')?zero:detail);
  }});
  assert.equal((await client.claim(item(),'auto',()=>stopped)).status,'claimed');
  assert.deepEqual(roles,[false,false,false,false,true]);
});

test('legacy cooldown cleanup is browser-local and never starts a task automatically', async t => {
  const storage={fabHelperRateLimit_v1:{version:1,until:Date.now()+600000}};
  const otherStorage={fabHelperRateLimit_v1:{version:1,until:Date.now()+600000}};
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'}});
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.doesNotMatch(h.shadow.querySelector('#start').textContent,/冷却/);
  assert.equal(storage.fabHelperRateLimit_v1,undefined);
  assert.ok(otherStorage.fabHelperRateLimit_v1);
  const other=await uiFixture(t,{storage:otherStorage,settings:{scope:'quixel'}});
  assert.equal(other.shadow.querySelector('#start').disabled,false);
  assert.equal(otherStorage.fabHelperRateLimit_v1,undefined);
  assert.equal(h.identityCalls,0);assert.equal(h.calls.length,0);
});

test('a paced 429 pauses queued workers without marking unrequested assets failed', async t => {
  const h=await uiFixture(t,{html:assetGrid([A,B]),requestInterval:20,settings:{concurrency:'3'},fetch:async()=>response({},429)});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#concurrency').disabled,'limited work should drain');
  assert.equal(h.calls.length,1);
  assert.equal(h.posts,0);
  assert.equal(h.shadow.querySelector('#failed').textContent,'1');
  assert.equal([...h.shadow.querySelectorAll('.state')].filter(e=>e.textContent==='待核对').length,1);
  assert.equal(h.storage.fabHelperRateLimit_v1,undefined);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
});

test('clearing ownership after 429 never starts a new task or creates a cooldown', async t => {
  const storage={['fabHelperOwned_v1_fixture-account_'+A]:{version:1,status:'owned'}};
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'},fetch:async()=>response({},429)});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'directory 429 should pause');
  h.shadow.querySelector('#clear-memory').click();await tick();
  assert.equal(storage.fabHelperRateLimit_v1,undefined);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.equal(h.calls.length,1);assert.equal(h.posts,0);
});

test('owned total includes new claims without double-counting progress, and Continue preserves the new count', async t => {
  const h=await uiFixture(t);
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'first claim');
  assert.equal(h.shadow.querySelector('#claimed').textContent,'1');
  assert.equal(h.shadow.querySelector('#owned').textContent,'1');
  assert.equal(h.shadow.querySelector('#counter').textContent,'1/1');
  assert.ok(h.storage['fabHelperOwned_v1_fixture-account_'+A]);
  h.w.document.querySelector('main').innerHTML=assetGrid([A,B]);
  h.shadow.querySelector('#scan').click();
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'continue with new row');
  assert.equal(h.shadow.querySelector('#claimed').textContent,'1');
  assert.equal(h.shadow.querySelector('#owned').textContent,'2');
  assert.equal(h.shadow.querySelector('#counter').textContent,'2/2');
  assert.equal(h.posts,1);
});

test('fresh bulk unowned results remove only redundant preflight reads and still verify the zero-price claim', async t => {
  let submitted=false;
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:async(url,init)=>{
    if(url.includes('/listings/search?'))return response(catalogPage([A]));
    if(url.includes('/listings-states?'))return response([{uid:A,acquired:submitted}]);
    if(url.includes('listings-states/'))return response({acquired:submitted});
    if(init.method==='POST'){submitted=true;return response(null,204);}
    return response(url.endsWith('/prices-infos')?zero:detail);
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'fresh bulk page completes');
  assert.equal(h.posts,1);
  assert.equal(h.calls.filter(c=>c.url.includes('listings-states/')).length,0);
  assert.equal(h.calls.filter(c=>c.url.includes('/listings-states?')).length,2);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/prices-infos')).length,1);
  assert.equal(h.shadow.querySelector('#owned').textContent,'1');
  assert.equal(h.shadow.querySelector('#claimed').textContent,'1');
  assert.equal(h.storage[catalogRecord('fixture-account')].done,true);
});

test('a competing claim HTTP 400 counts as owned only after a fresh true state, with no second POST', async () => {
  for(const acquired of [true,false]){
    let submitted=false,posts=0,reads=0;
    const client=new Core.Client({cookie:()=> 'fab_csrftoken=fixture-only',fetch:async(url,init)=>{
      if(url.includes('listings-states/')){reads++;return response({acquired:submitted&&acquired});}
      if(init.method==='POST'){submitted=true;posts++;return response({},400);}
      return response(url.endsWith('/prices-infos')?zero:detail);
    }});
    const result=client.claim(item(),'auto',()=>false,true);
    if(acquired)assert.equal((await result).status,'owned');
    else await assert.rejects(result,e=>e.status===400);
    assert.equal(posts,1);
    assert.equal(reads,1);
  }
});

test('request pace is selectable, browser-local and restored without changing the per-item delay', async t => {
  const storage={};
  const h=await uiFixture(t,{storage,settings:{rate:'500',delay:'2000'}});
  const rate=h.shadow.querySelector('#rate');
  assert.ok(rate);
  assert.equal(rate.value,'500');
  rate.value='1000';rate.dispatchEvent(new h.w.Event('change'));
  await tick();
  assert.equal(storage.fabHelperSettings.rate,'1000');
  assert.equal(storage.fabHelperSettings.delay,'2000');
  const reloaded=await uiFixture(t,{storage});
  assert.equal(reloaded.shadow.querySelector('#rate').value,'1000');
  const other=await uiFixture(t);
  assert.equal(other.shadow.querySelector('#rate').value,'500');
  assert.equal(h.identityCalls,0);
});

test('429 pauses for manual recovery and backs the selectable request pace off one step', async t => {
  const h=await uiFixture(t,{settings:{rate:'500'},fetch:async()=>response({},429)});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'rate-limit drain');
  assert.equal(h.shadow.querySelector('#rate').value,'1000');
  assert.equal(h.storage.fabHelperSettings.rate,'1000');
  assert.equal(h.storage.fabHelperRateLimit_v1,undefined);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.equal(h.posts,0);
});

test('identical asset titles remain separate by ID while ownership totals count each asset once', async t => {
  const h=await uiFixture(t,{owned:true,html:assetGrid([A,B]).replaceAll('Asset '+A,'Same title').replaceAll('Asset '+B,'Same title')});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'same-title reads');
  const links=[...h.shadow.querySelectorAll('.name')];
  assert.equal(links.length,2);
  assert.equal(new Set(links.map(a=>a.href)).size,2);
  assert.ok(links.every(a=>a.textContent==='Same title'));
  assert.ok(links.every(a=>a.title.includes(a.href.split('/').at(-1))));
  assert.equal(h.shadow.querySelector('#owned').textContent,'2');
  assert.equal(h.shadow.querySelector('#counter').textContent,'2/2');
});


test('an ordinary failed free item is automatically rechecked once, then only confirmed success is counted', async t => {
  let prices=0,submitted=false;
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:async(url,init)=>{
    if(url.includes('/listings/search?'))return response(catalogPage([A]));
    if(url.includes('/listings-states?'))return response([{uid:A,acquired:submitted}]);
    if(url.includes('listings-states/'))return response({acquired:submitted});
    if(init.method==='POST'){submitted=true;return response(null,204);}
    if(url.endsWith('/prices-infos'))return ++prices===1?response({},500):response(zero);
    return response(detail);
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'ordinary error should recover automatically');
  assert.equal(prices,2);
  assert.equal(h.posts,1);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'1');
  assert.equal(h.shadow.querySelector('#owned').textContent,'1');
  assert.equal(h.shadow.querySelector('#failed').textContent,'0');
  assert.ok(h.storage['fabHelperOwned_v1_fixture-account_'+A]);
  assert.equal(h.storage[retryRecord('fixture-account',A)],undefined);
});

test('a persisted failure encountered during catalogue scanning is automatically rechecked rather than skipped', async t => {
  const retryKey=retryRecord('fixture-account',A),storage={[retryKey]:{version:1,name:'Old failed free asset',note:'HTTP 500'}};
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'},fetch:async url=>url.includes('/listings/search?')?response(catalogPage([A])):response([{uid:A,acquired:true}])});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'saved failure should be rechecked');
  assert.equal(h.shadow.querySelector('#owned').textContent,'1');
  assert.equal(h.shadow.querySelector('#failed').textContent,'0');
  assert.equal(storage[retryKey],undefined);
  assert.equal(h.posts,0);
});

test('pause during automatic failure backoff cancels the retry and retains the current catalogue page', async t => {
  let prices=0;
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:async url=>{
    if(url.includes('/listings/search?'))return response(catalogPage([A]));
    if(url.includes('/listings-states?'))return response([{uid:A,acquired:false}]);
    if(url.endsWith('/prices-infos')){prices++;return response({},500);}
    return response(detail);
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>h.shadow.querySelector('.note')?.textContent.includes('自动复核'),'automatic retry wait');
  h.shadow.querySelector('#pause').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'pause should cancel retry');
  assert.equal(prices,1);
  assert.equal(h.posts,0);
  assert.equal(h.storage[catalogRecord('fixture-account')],undefined);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
});


test('reusing a fresh unowned batch result never skips price checks or submits a paid offer', async () => {
  const h=harness({prices:{offers:[{offerId:'paid',price:9}]}});
  assert.equal((await h.client.claim(item(),'auto',()=>false,true)).status,'skipped');
  assert.equal(h.writes,0);
  assert.equal(h.calls.filter(c=>c.url.includes('listings-states')).length,0);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/prices-infos')).length,1);
});


const pricedDetail=(id=A,personal=0,professional=0)=>({uid:id,title:'Verified fixture',licenses:[
  {slug:'personal',offerId:'personal-offer',priceTier:{currencyCode:'CNY',price:personal,discountedPrice:null}},
  {slug:'professional',offerId:'professional-offer',priceTier:{currencyCode:'CNY',price:professional,discountedPrice:null}}
]});

test('complete fresh detail prices avoid the separate prices request without weakening license choice', async () => {
  for(const preference of ['auto','personal','professional']){
    const calls=[];let posted=false;
    const client=new Core.Client({cookie:()=> 'fab_csrftoken=fixture-only',fetch:async(url,init)=>{
      calls.push({url,init});
      if(url.includes('listings-states'))return response({acquired:posted});
      if(init.method==='POST'){posted=true;assert.equal(JSON.parse(init.body).offerId,preference==='personal'?'personal-offer':'professional-offer');return response(null,204);}
      return response(url.endsWith('/prices-infos')?zero:pricedDetail());
    }});
    assert.equal((await client.claim(item(),preference)).status,'claimed');
    assert.equal(calls.filter(c=>c.url.endsWith('/prices-infos')).length,0);
  }
});

test('fresh detail price reuse rejects paid licenses and falls back for any incomplete or mismatched data', async () => {
  for(const preference of ['auto','professional']){
    let posts=0;
    const client=new Core.Client({cookie:()=> 'fab_csrftoken=fixture-only',fetch:async(url,init)=>{
      if(url.includes('listings-states'))return response({acquired:posts>0});
      if(init.method==='POST'){posts++;assert.equal(JSON.parse(init.body).offerId,'personal-offer');return response(null,204);}
      return response(url.endsWith('/prices-infos')?zero:pricedDetail(A,0,99));
    }});
    if(preference==='professional')await assert.rejects(client.claim(item(),preference),/零元/);
    else assert.equal((await client.claim(item(),preference)).status,'claimed');
    assert.equal(posts,preference==='auto'?1:0);
  }
  for(const bad of [null,{}, {currencyCode:'CNY',price:''},{currencyCode:'CNY',price:false}]){
    const d=pricedDetail();d.licenses[1].priceTier=bad;
    const h=harness({detail:d});
    assert.equal((await h.client.claim(item())).status,'claimed');
    assert.equal(h.calls.filter(c=>c.url.endsWith('/prices-infos')).length,1);
  }
  const wrong=harness({detail:pricedDetail(B),prices:{offers:[{offerId:'paid',price:99}]}});
  assert.equal((await wrong.client.claim(item())).status,'skipped');
  assert.equal(wrong.writes,0);
});

test('deferred catalogue submission is never reported or stored as confirmed ownership', async () => {
  let posts=0;
  const client=new Core.Client({cookie:()=> 'fab_csrftoken=fixture-only',fetch:async(url,init)=>{
    if(init.method==='POST'){posts++;return response(null,204);}
    if(url.includes('listings-states'))return response({acquired:false});
    return response(url.endsWith('/prices-infos')?zero:pricedDetail());
  }});
  const result=await client.claim(item(),'auto',()=>false,true,true);
  assert.equal(result.status,'submitted');
  assert.equal(posts,1);
});

function fastCatalogueFixture(submitted, overrides={}) {
  return async (url,init)=>{
    const p=searchUrl(url);
    if(p.pathname==='/i/listings/search')return response(catalogPage(overrides.ids||[A,B]));
    if(p.pathname==='/i/users/me/listings-states'){
      const ids=p.searchParams.getAll('listing_ids');
      if(submitted.size&&overrides.confirm)return overrides.confirm(ids);
      return response(ids.map(uid=>({uid,acquired:submitted.has(uid)})));
    }
    const id=url.match(/[a-f0-9-]{36}/)?.[0];
    if(url.includes('listings-states/'))return response({acquired:overrides.individual?overrides.individual(id):submitted.has(id)});
    if(init.method==='POST'){submitted.add(id);return response(null,204);}
    return response(url.endsWith('/prices-infos')?zero:pricedDetail(id));
  };
}

test('24 new assets use at most 51 asset requests with one batch confirmation and no separate prices reads', async t => {
  const ids=[A,B,C,...Array.from({length:21},(_,i)=>i.toString(16).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa')];
  const submitted=new Set();
  const h=await uiFixture(t,{settings:{scope:'quixel',concurrency:'32'},fetch:fastCatalogueFixture(submitted,{ids})});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'optimized page should finish');
  assert.equal(h.posts,24);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'24');
  assert.equal(h.shadow.querySelector('#owned').textContent,'24');
  assert.equal(h.shadow.querySelector('#counter').textContent,'24/24');
  assert.equal(h.calls.filter(c=>c.url.includes('/listings-states?')).length,2);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/prices-infos')).length,0);
  assert.equal(h.calls.filter(c=>c.url.includes('listings-states/')).length,0);
  assert.ok(h.calls.length<=51,'asset request budget must beat the previous 98');
  assert.equal(Object.keys(h.storage).filter(k=>k.startsWith('fabHelperOwned_')).length,24);
});

test('manual pause still confirms submitted catalogue assets in a batch and retains the page cursor', async t => {
  let started=false,release;const barrier=new Promise(resolve=>{release=resolve;});
  const submitted=new Set();
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:fastCatalogueFixture(submitted,{confirm:async ids=>{started=true;await barrier;return response(ids.map(uid=>({uid,acquired:true})));}})});
  h.shadow.querySelector('#start').click();
  try{
    await until(()=>started,'post-submission batch should start');
    assert.equal(h.shadow.querySelector('#claimed').textContent,'0');
    assert.equal(Object.keys(h.storage).filter(k=>k.startsWith('fabHelperOwned_')).length,0);
    h.shadow.querySelector('#pause').click();
  }finally{release();}
  await until(()=>!h.shadow.querySelector('#scope').disabled,'paused batch should drain');
  assert.equal(h.posts,2);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'2');
  assert.equal(h.storage[catalogRecord('fixture-account')],undefined);
});

test('a rate limit during batch confirmation leaves submissions unconfirmed and never advances the cursor', async t => {
  const submitted=new Set();
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:fastCatalogueFixture(submitted,{confirm:async()=>response({},429)})});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'limited confirmation should stop');
  assert.equal(h.posts,2);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'0');
  assert.equal(Object.keys(h.storage).filter(k=>k.startsWith('fabHelperOwned_')).length,0);
  assert.equal(h.storage[catalogRecord('fixture-account')],undefined);
  assert.equal(h.storage.fabHelperRateLimit_v1,undefined);
  assert.equal(h.calls.filter(c=>c.url.includes('listings-states/')).length,0);
});

test('partial batch confirmation falls back only for missing IDs and never repeats a submission', async t => {
  const submitted=new Set();
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:fastCatalogueFixture(submitted,{confirm:async()=>response([{uid:A,acquired:true}])})});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'partial confirmation should fall back');
  assert.equal(h.posts,2);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'2');
  assert.equal(h.calls.filter(c=>c.url.includes('listings-states/')).length,1);
  assert.ok(h.calls.some(c=>c.url.endsWith('listings-states/'+B)));
});


test('negative batch confirmation never caches a POST as success and keeps a durable retry record', async t => {
  const submitted=new Set();
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:fastCatalogueFixture(submitted,{confirm:async ids=>response(ids.map(uid=>({uid,acquired:false})))})});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'negative confirmations should be retained',7000);
  assert.equal(h.posts,2);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'0');
  assert.equal(h.shadow.querySelector('#failed').textContent,'2');
  assert.equal(Object.keys(h.storage).filter(k=>k.startsWith('fabHelperOwned_')).length,0);
  assert.ok(h.storage[retryRecord('fixture-account',A)]);
  assert.ok(h.storage[retryRecord('fixture-account',B)]);
});

test('a partial confirmation followed by a fallback rate limit preserves already confirmed ownership', async t => {
  const submitted=new Set();
  const fetch=fastCatalogueFixture(submitted,{confirm:async()=>response([{uid:A,acquired:true}])});
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:async(url,init)=>url.endsWith('listings-states/'+B)?response({},429):fetch(url,init)});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'partial confirmation limit should drain');
  assert.equal(h.posts,2);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'1');
  assert.ok(h.storage['fabHelperOwned_v1_fixture-account_'+A]);
  assert.equal(h.storage['fabHelperOwned_v1_fixture-account_'+B],undefined);
  assert.equal(h.storage[catalogRecord('fixture-account')],undefined);
});

test('malformed confirmation batches safely fall back to individual state reads', async t => {
  const submitted=new Set();
  const h=await uiFixture(t,{settings:{scope:'quixel'},fetch:fastCatalogueFixture(submitted,{confirm:async()=>response({bad:'schema'})})});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'malformed batch fallback should finish');
  assert.equal(h.posts,2);
  assert.equal(h.shadow.querySelector('#claimed').textContent,'2');
  assert.equal(h.calls.filter(c=>c.url.includes('listings-states/')).length,2);
});


test('fast request intervals and zero item delay are selectable and persist across reload', async t => {
  for(const rate of ['100','250']){
    const storage={};
    const h=await uiFixture(t,{storage,settings:{rate,delay:'0',concurrency:'16'}});
    assert.equal(h.shadow.querySelector('#rate').value,rate);
    assert.equal(h.shadow.querySelector('#delay').value,'0');
    h.shadow.querySelector('#rate').dispatchEvent(new h.w.Event('change'));
    await tick();
    const next=await uiFixture(t,{storage});
    assert.equal(next.shadow.querySelector('#rate').value,rate);
    assert.equal(next.shadow.querySelector('#delay').value,'0');
    assert.equal(h.posts,0);
    assert.equal(h.identityCalls,0);
  }
});

test('one-click turbo applies a concrete faster configuration without starting or clearing progress', async t => {
  const owned='fabHelperOwned_v1_fixture-account_'+A,checkpoint=catalogRecord('fixture-account');
  const storage={[owned]:{version:1,status:'owned'},[checkpoint]:{version:2,sort:'title',cursor:'saved',pages:12,done:false}};
  const h=await uiFixture(t,{storage,settings:{rate:'500',delay:'2000',concurrency:'8'}});
  const before=JSON.stringify({owned:storage[owned],checkpoint:storage[checkpoint]});
  const turbo=h.shadow.querySelector('#turbo');assert.ok(turbo);
  turbo.click();await tick();
  assert.equal(h.shadow.querySelector('#rate').value,'100');
  assert.equal(h.shadow.querySelector('#delay').value,'0');
  assert.equal(h.shadow.querySelector('#concurrency').value,'16');
  assert.equal(storage.fabHelperSettings.rate,'100');
  assert.equal(storage.fabHelperSettings.delay,'0');
  assert.equal(storage.fabHelperSettings.concurrency,'16');
  assert.equal(JSON.stringify({owned:storage[owned],checkpoint:storage[checkpoint]}),before);
  assert.equal(h.posts,0);assert.equal(h.identityCalls,0);
});

test('turbo after legacy cleanup changes settings without dispatching or recreating a cooldown', async t => {
  const h=await uiFixture(t,{storage:{fabHelperRateLimit_v1:{version:1,until:Date.now()+600000}},settings:{scope:'quixel'}});
  const turbo=h.shadow.querySelector('#turbo');assert.ok(turbo);turbo.click();await tick();
  assert.equal(h.storage.fabHelperRateLimit_v1,undefined);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.equal(h.calls.length,0);assert.equal(h.identityCalls,0);
});

test('fast modes back off only to valid interval options and keep manual 429 stop protection', async t => {
  for(const [before,after] of [['100','250'],['250','500'],['500','1000'],['1000','2000'],['2000','2000']]){
    const h=await uiFixture(t,{settings:{rate:before},fetch:async()=>response({},429)});
    h.shadow.querySelector('#start').click();
    await until(()=>!h.shadow.querySelector('#scope').disabled,'fast rate limit should drain');
    assert.equal(h.shadow.querySelector('#rate').value,after);
    assert.equal(h.storage.fabHelperSettings.rate,after);
    assert.equal(h.storage.fabHelperRateLimit_v1,undefined);
    assert.equal(h.shadow.querySelector('#start').disabled,false);
    assert.equal(h.posts,0);
  }
});

test('100 ms mode preserves request spacing while reducing the same 51-request scheduling budget fivefold', async () => {
  const elapsed=[];
  for(const interval of [500,100]){
    let now=0;const starts=[];
    const gate=new Core.RequestGate({interval,now:()=>now,sleep:ms=>new Promise(resolve=>setImmediate(()=>{now+=ms;resolve();}))});
    const client=new Core.Client({beforeRequest:()=>gate.wait(),fetch:async()=>{starts.push(now);return response({});}});
    await Promise.all(Array.from({length:51},()=>client.request('/i/users/me')));
    assert.equal(starts.length,51);
    for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=interval);
    elapsed.push(starts.at(-1)-starts[0]);
  }
  assert.deepEqual(elapsed,[25000,5000]);
});

test('cached catalogue pages have no fixed half-second delay beyond the global request gate', async t => {
  const storage={};for(const id of [A,B,C])storage['fabHelperOwned_v1_fixture-account_'+id]={version:1,status:'owned'};
  const starts=[];
  const h=await uiFixture(t,{storage,settings:{scope:'quixel',rate:'100',delay:'0'},fetch:async url=>{
    assert.ok(url.includes('/listings/search?'));
    starts.push(Date.now());
    const cursor=searchUrl(url).searchParams.get('cursor');
    return response(cursor==='third'?catalogPage([C]):cursor==='second'?catalogPage([B],'third'):catalogPage([A],'second'));
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'cached scan should drain without extra page sleeps');
  assert.equal(starts.length,3);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]<450,'the gate already provides request pacing');
  assert.equal(h.posts,0);
  assert.equal(h.storage[catalogRecord('fixture-account')].pages,3);
});


test('manual resume policy exposes server waiting advice without claiming a forced cooldown', async () => {
  const now=Date.UTC(2026,10,11,12,0,0);
  const client=new Core.Client({now:()=>now,fetch:async()=>({...response({},429),headers:{get:()=> '600'}})});
  await assert.rejects(client.account(),e=>e.status===429&&e.retryAt===now+600000&&/建议/.test(e.message)&&!/冷却/.test(e.message));
});

test('manual resume policy invents no default waiting duration when Retry-After is missing or invalid', async () => {
  for(const value of [null,'invalid-header']){
    const client=new Core.Client({fetch:async()=>({...response({},429),headers:{get:()=>value}})});
    await assert.rejects(client.account(),e=>e.status===429&&e.retryAt===undefined&&/手动继续/.test(e.message)&&!/60|冷却/.test(e.message));
  }
});

test('manual resume policy retires legacy cooldown state without deleting owned records or checkpoints', async t => {
  const owned='fabHelperOwned_v1_fixture-account_'+A,key=catalogRecord('fixture-account');
  const storage={fabHelperRateLimit_v1:{version:1,until:Date.now()+600000},[owned]:{version:1,status:'owned'},[key]:{version:2,sort:'title',cursor:'saved',pages:12,done:false}};
  const expected=JSON.stringify({owned:storage[owned],checkpoint:storage[key]});
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'}});
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.equal(storage.fabHelperRateLimit_v1,undefined);
  assert.equal(JSON.stringify({owned:storage[owned],checkpoint:storage[key]}),expected);
  assert.equal(h.calls.length,0);assert.equal(h.identityCalls,0);
});

test('manual resume policy pauses 429 once and permits a deliberate Continue without a timer or automatic retry', async t => {
  let resumed=false;
  const h=await uiFixture(t,{fetch:async(url,init)=>{
    assert.notEqual(init.method,'POST');
    return resumed?response({acquired:true}):{...response({},429),headers:{get:()=> '600'}};
  }});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'limited task should drain');
  assert.equal(h.calls.length,1);
  assert.equal(h.shadow.querySelector('#start').disabled,false);
  assert.doesNotMatch(h.shadow.querySelector('#start').textContent,/冷却/);
  await tick();assert.equal(h.calls.length,1);
  resumed=true;h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'manual Continue should recheck the failed item');
  assert.equal(h.calls.length,2);
  assert.equal(h.posts,0);
  assert.equal(h.shadow.querySelector('#owned').textContent,'1');
  assert.equal(h.shadow.querySelector('#failed').textContent,'0');
  assert.equal(h.storage.fabHelperRateLimit_v1,undefined);
});


const ownedCard=(id=A,title='Already owned')=>'<article><a href="/listings/'+id+'"><img alt="'+title+'"></a><h3>'+title+'</h3><p><svg></svg>Saved in My Library</p></article>';

test('explicit webpage ownership labels skip all per-asset requests and are saved for the current account', async t => {
  const storage={};
  const h=await uiFixture(t,{storage,html:'<main>'+ownedCard(A)+ownedCard(B)+'</main>',fetch:async()=>{throw Error('owned cards must not issue asset requests');}});
  h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'owned labels should be accepted directly');
  assert.equal(h.identityCalls,1);assert.equal(h.calls.length,0);assert.equal(h.posts,0);
  assert.equal(h.shadow.querySelector('#owned').textContent,'2');
  assert.equal(storage['fabHelperOwned_v1_fixture-account_'+A].status,'owned');
  assert.equal(storage['fabHelperOwned_v1_fixture-account_'+B].status,'owned');
  const reloaded=await uiFixture(t,{storage,fetch:async()=>{throw Error('cache hit must not query the asset');}});
  reloaded.shadow.querySelector('#start').click();
  await until(()=>!reloaded.shadow.querySelector('#scope').disabled,'local record should survive refresh');
  assert.equal(reloaded.calls.length,0);assert.equal(reloaded.shadow.querySelector('#owned').textContent,'1');
});

test('an asset title containing ownership words is not treated as a webpage ownership badge', () => {
  const dom=new JSDOM('<main><article><a href="/listings/'+A+'"><img></a><h3>Saved in My Library</h3><p>From Free</p></article></main>',{url:'https://www.fab.com/sellers/fixture'});
  try{assert.equal(Core.scan(dom.window.document)[0].pageOwned,false);}finally{dom.window.close();}
});

test('webpage ownership markers are not reused after the verified account or page session changes', async t => {
  const account={uid:'fixture-account'};
  const h=await uiFixture(t,{accountResponse:account,html:'<main>'+ownedCard()+'</main>',owned:true});
  h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'initial marked owner');
  assert.equal(h.calls.length,0);
  account.uid='other-account';
  h.w.document.querySelector('main').innerHTML=ownedCard(A)+'<article><a href="/listings/'+B+'">New row</a><p>From Free</p></article>';
  h.shadow.querySelector('#scan').click();h.shadow.querySelector('#start').click();
  await until(()=>!h.shadow.querySelector('#scope').disabled,'changed account must be checked');
  assert.equal(h.calls.length,2);
  assert.ok(h.storage['fabHelperOwned_v1_fixture-account_'+A]);
  assert.ok(h.storage['fabHelperOwned_v1_other-account_'+A]);
  const changed=await uiFixture(t,{html:'<main>'+ownedCard()+'</main>',owned:true});
  changed.w.document.cookie='fab_csrftoken=changed-session';
  changed.shadow.querySelector('#start').click();await until(()=>!changed.shadow.querySelector('#scope').disabled,'changed session needs live state');
  assert.equal(changed.calls.length,1);
});

test('saved page 148 resumes its exact cursor and visible owned cards need only the directory request', async t => {
  const key=catalogRecord('fixture-account'),storage={[key]:{version:2,sort:'title',cursor:'resume-page-149',pages:148,done:false}};
  const h=await uiFixture(t,{storage,html:'<main>'+ownedCard()+'</main>',settings:{scope:'quixel'},fetch:async url=>{
    assert.ok(url.includes('/listings/search?'));assert.equal(searchUrl(url).searchParams.get('cursor'),'resume-page-149');
    return response(catalogPage([A]));
  }});
  h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'saved cursor should resume');
  assert.equal(h.identityCalls,1);assert.equal(h.calls.length,1);assert.equal(h.posts,0);
  assert.equal(h.shadow.querySelector('#owned').textContent,'1');
  assert.equal(storage[key].pages,149);
  assert.match(h.shadow.querySelector('#memory').textContent,/断点.*149/);
});

test('a checkpoint read failure never silently scans page one and retry reads the saved cursor again', async t => {
  const key=catalogRecord('fixture-account');let failRead=true;
  const storage={[key]:{version:2,sort:'title',cursor:'resume-149',pages:148,done:false},['fabHelperOwned_v1_fixture-account_'+A]:{version:1,status:'owned'}};
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'},beforeStorageGet:async k=>{if(k===key&&failRead)throw Error('transient read error');},fetch:async url=>{
    assert.equal(searchUrl(url).searchParams.get('cursor'),'resume-149');return response(catalogPage([A]));
  }});
  h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'read error should stop');
  assert.equal(h.calls.length,0);assert.equal(storage[key].pages,148);
  failRead=false;h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'retry should load the same checkpoint');
  assert.equal(h.calls.length,1);assert.equal(storage[key].pages,149);assert.equal(h.posts,0);
});

test('an unavailable ownership cache stops catalogue processing before it can rescan without local records', async t => {
  const h=await uiFixture(t,{storageReadError:true,settings:{scope:'quixel'},fetch:async()=>response(catalogPage([]))});
  h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'unreadable local records should stop');
  assert.equal(h.identityCalls,1);assert.equal(h.calls.length,0);assert.equal(h.posts,0);
  assert.match(h.shadow.querySelector('#message').textContent,/本地.*记录|本地.*进度/);
});

test('a malformed nonlegacy checkpoint is retained and never treated as a request to restart', async t => {
  const key=catalogRecord('fixture-account'),record={version:2,sort:'title',cursor:'',pages:148,done:false};
  const storage={[key]:record};
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'},fetch:async()=>response(catalogPage([]))});
  h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'invalid checkpoint must stop');
  assert.equal(h.calls.length,0);assert.deepEqual(storage[key],record);
});


test('catalogue ownership-save failures stop before the next directory page', async t => {
  const h=await uiFixture(t,{storageWriteError:true,settings:{scope:'quixel'},fetch:async url=>{
    if(url.includes('/listings/search?'))return response(catalogPage([A],'next'));
    return response([{uid:A,acquired:true}]);
  }});
  h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'save error should stop before advancing');
  assert.equal(h.calls.filter(c=>c.url.includes('/listings/search?')).length,1);
  assert.equal(h.storage[catalogRecord('fixture-account')],undefined);
  assert.equal(h.posts,0);
  assert.match(h.shadow.querySelector('#message').textContent,/本地.*保存失败/);
});


test('checkpoint write failure retains both saved and in-memory cursors until a manual retry succeeds', async t => {
  const key=catalogRecord('fixture-account');let failWrite=true;
  const initial={version:2,sort:'title',cursor:'resume-149',pages:148,done:false};
  const storage={[key]:initial};for(const id of [A,B])storage['fabHelperOwned_v1_fixture-account_'+id]={version:1,status:'owned'};
  const cursors=[];
  const h=await uiFixture(t,{storage,settings:{scope:'quixel'},beforeStorageSet:async values=>{if(key in values&&failWrite)throw Error('checkpoint write error');},fetch:async url=>{
    assert.ok(url.includes('/listings/search?'));const cursor=searchUrl(url).searchParams.get('cursor');cursors.push(cursor);
    return response(cursor==='resume-149'?catalogPage([A],'next-150'):catalogPage([B]));
  }});
  h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'checkpoint save should halt');
  assert.deepEqual(cursors,['resume-149']);assert.deepEqual(storage[key],initial);
  assert.match(h.shadow.querySelector('#message').textContent,/断点保存失败/);
  failWrite=false;h.shadow.querySelector('#start').click();await until(()=>!h.shadow.querySelector('#scope').disabled,'manual retry should resume the same page');
  assert.deepEqual(cursors,['resume-149','resume-149','next-150']);
  assert.equal(storage[key].pages,150);assert.equal(storage[key].done,true);assert.equal(h.posts,0);
});


test('a collapsed panel stays collapsed after refresh, asset navigation and unrelated settings changes', async t => {
  const storage={},h=await uiFixture(t,{storage});
  assert.equal(h.shadow.querySelector('#body').hidden,true);
  h.shadow.querySelector('#summary').click();
  assert.equal(h.shadow.querySelector('#body').hidden,false);
  h.shadow.querySelector('#toggle').click();await tick();
  assert.equal(storage.fabHelperPanel_v1.expanded,false);
  const detailPage=await uiFixture(t,{storage,url:'https://www.fab.com/listings/'+A});
  assert.equal(detailPage.shadow.querySelector('#body').hidden,true);
  assert.equal(detailPage.shadow.querySelector('#summary').getAttribute('aria-expanded'),'false');
  detailPage.shadow.querySelector('#rate').value='1000';
  detailPage.shadow.querySelector('#rate').dispatchEvent(new detailPage.w.Event('change'));await tick();
  const returned=await uiFixture(t,{storage});
  assert.equal(returned.shadow.querySelector('#body').hidden,true);
  assert.equal(returned.shadow.querySelector('#rate').value,'1000');
  assert.equal(h.identityCalls+detailPage.identityCalls+returned.identityCalls,0);
  assert.equal(h.posts+detailPage.posts+returned.posts,0);
});

test('explicit toolbar opening and Escape closing update the saved panel preference only', async t => {
  const owned='fabHelperOwned_v1_fixture-account_'+A,checkpoint=catalogRecord('fixture-account');
  const storage={fabHelperPanel_v1:{version:1,expanded:false},[owned]:{version:1,status:'owned'},[checkpoint]:{version:2,sort:'title',cursor:'saved',pages:148,done:false}};
  const before=JSON.stringify({owned:storage[owned],checkpoint:storage[checkpoint]});
  const h=await uiFixture(t,{storage});assert.equal(h.shadow.querySelector('#body').hidden,true);
  let reply;for(const listener of h.messages)listener({type:'FAB_HELPER_OPEN'},{},value=>{reply=value;});
  assert.equal(reply.ok,true);assert.equal(h.shadow.querySelector('#body').hidden,false);await tick();
  const restored=await uiFixture(t,{storage});
  assert.equal(restored.shadow.querySelector('#body').hidden,false);
  restored.shadow.dispatchEvent(new restored.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
  assert.equal(storage.fabHelperPanel_v1.expanded,false);
  assert.equal(JSON.stringify({owned:storage[owned],checkpoint:storage[checkpoint]}),before);
  const otherBrowser=await uiFixture(t);assert.equal(otherBrowser.shadow.querySelector('#body').hidden,true);
  assert.equal(h.identityCalls+restored.identityCalls+otherBrowser.identityCalls,0);
});

test('a delayed preference read never reopens a panel the user has just collapsed', async t => {
  let releaseRead,releaseWrites;
  const readBarrier=new Promise(resolve=>{releaseRead=resolve;}),writeBarrier=new Promise(resolve=>{releaseWrites=resolve;});
  const h=await uiFixture(t,{storage:{fabHelperPanel_v1:{version:1,expanded:true}},beforeStorageGet:async key=>{if(key==='fabHelperPanel_v1')await readBarrier;},beforeStorageSet:async values=>{if(values.fabHelperPanel_v1)await writeBarrier;}});
  try{
    assert.equal(h.shadow.querySelector('#body').hidden,true);
    h.shadow.querySelector('#summary').click();h.shadow.querySelector('#toggle').click();
    assert.equal(h.shadow.querySelector('#body').hidden,true);
    releaseRead();await tick();
    assert.equal(h.shadow.querySelector('#body').hidden,true);
  }finally{releaseRead();releaseWrites();}
  await tick();assert.equal(h.storage.fabHelperPanel_v1.expanded,false);
});
