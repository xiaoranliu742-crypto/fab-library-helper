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

test('detail and price reads overlap, but no POST starts until both reads finish', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Set();
  let posts = 0;
  const client = new Core.Client({ cookie: () => 'fab_csrftoken=fixture-only', fetch: async (url, init) => {
    if (url.includes('listings-states')) return response({ acquired: posts > 0 });
    if (init.method === 'POST') { posts++; return response(null, 204); }
    const phase = url.endsWith('/prices-infos') ? 'prices' : 'detail';
    started.add(phase);
    await barrier;
    return response(phase === 'prices' ? zero : detail);
  } });
  const run = client.claim(item());
  try {
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.deepEqual([...started].sort(), ['detail', 'prices']);
    assert.equal(posts, 0);
  } finally { release(); }
  assert.equal((await run).status, 'claimed');
  assert.equal(posts, 1);
});

test('parallel read failures drain together and a rate limit still stops the batch', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let settled = false, posts = 0;
  const client = new Core.Client({ fetch: async (url, init) => {
    if (url.includes('listings-states')) return response({ acquired: false });
    if (init.method === 'POST') { posts++; return response(null, 204); }
    if (url.endsWith('/prices-infos')) { await barrier; return response({}, 429); }
    return response({}, 500);
  } });
  const run = client.claim(item());
  run.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(settled, false);
  } finally { release(); }
  await assert.rejects(run, error => error.status === 429 && error.halt);
  assert.equal(posts, 0);
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
    url: 'https://www.fab.com/sellers/fixture', runScripts: 'outside-only', pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const calls = [];
  let posts = 0, identityCalls = 0;
  const storage = options.storage || {};
  if (options.settings) storage.fabHelperSettings = options.settings;
  w.document.cookie = 'fab_csrftoken=fixture-only';
  w.chrome = { runtime: { id: 'local-test', onMessage: { addListener() {} } }, storage: { local: {
    get: async key => {
      if (key === null && options.storageReadError) throw new Error('fixture read failure');
      return JSON.parse(JSON.stringify(key === null ? storage : (key in storage ? { [key]: storage[key] } : {})));
    },
    set: async values => {
      if (options.storageWriteError) throw new Error('fixture write failure');
      Object.assign(storage, JSON.parse(JSON.stringify(values)));
    },
    remove: async keys => { for (const key of keys) delete storage[key]; }
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
  w.FabFreeCore = { ...w.FabFreeCore, scan(doc) { scans++; return scan(doc); } };
  w.eval(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'));
  await tick();
  const shadow = w.document.getElementById('fab-free-helper-root').shadowRoot;
  return { w, shadow, calls, storage, get identityCalls() { return identityCalls; }, get posts() { return posts; }, get scans() { return scans; } };
}

test('webpage panel mounts, counts From Free and never auto-claims on load', async t => {
  const h = await uiFixture(t);
  assert.equal(h.shadow.querySelector('#found').textContent, '当前网页 · 1 项');
  assert.equal(h.calls.length, 0);
  assert.equal(h.shadow.querySelector('#start').disabled, false);
  assert.equal(h.shadow.querySelector('#delay').value, '500');
  h.shadow.querySelector('#toggle').click();
  assert.equal(h.shadow.querySelector('#body').hidden, true);
  h.shadow.querySelector('#summary').click();
  assert.equal(h.shadow.querySelector('#body').hidden, false);
});

test('speed upgrade preserves an existing user-selected interval', async t => {
  const h = await uiFixture(t, { settings: { delay: '2000', license: 'personal', concurrency: '1', scroll: false } });
  assert.equal(h.shadow.querySelector('#delay').value, '2000');
  assert.equal(h.shadow.querySelector('#license').value, 'personal');
  assert.equal(h.shadow.querySelector('#concurrency').value, '1');
});

const assetGrid = ids => '<main><section>' + ids.map(id => `<article><a href="/listings/${id}">Asset ${id}</a><p>From Free</p></article>`).join('') + '</section></main>';
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
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

test('a rate limit stops other workers before POST and drains their outstanding reads', async t => {
  let releaseOther, releaseLimited;
  const other = new Promise(resolve => { releaseOther = resolve; });
  const limited = new Promise(resolve => { releaseLimited = resolve; });
  const h = await uiFixture(t, { html: assetGrid([A, B, C]), fetch: async (url, init) => {
    if (url.includes('listings-states')) return response({ acquired: false });
    if (init.method === 'POST') return response(null, 204);
    if (url.includes(A) && url.endsWith('/prices-infos')) { await limited; return response({}, 429); }
    if (!url.includes(A)) await other;
    return response(url.endsWith('/prices-infos') ? zero : detail);
  } });
  h.shadow.querySelector('#start').click();
  try {
    await until(() => h.calls.length === 9, 'all three preflights should start');
    releaseLimited();
    await until(() => /限流/.test(h.shadow.querySelector('#message').textContent), 'rate limit must be reported immediately');
    assert.equal(h.shadow.querySelector('#start').disabled, true);
    assert.equal(h.shadow.querySelector('#concurrency').disabled, true);
    assert.equal(h.posts, 0);
  } finally { releaseLimited(); releaseOther(); }
  await until(() => h.shadow.querySelector('#concurrency').disabled === false, 'all outstanding reads must settle');
  assert.equal(h.posts, 0);
  assert.equal(h.shadow.querySelector('#failed').textContent, '1');
  assert.equal(h.shadow.querySelectorAll('.state').length, 3);
  assert.equal([...h.shadow.querySelectorAll('.state')].filter(e => e.textContent === '待核对').length, 2);
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

for (const concurrency of [5, 8]) test(`${concurrency}-asset mode respects the selected in-flight limit and pauses cleanly`, async t => {
  const ids = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
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
