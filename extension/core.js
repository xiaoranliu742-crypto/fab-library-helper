/* Fab 免费素材助手 — Copyright (c) 2026 菊山 (jushan). MIT. No external services. */
(function (root) {
  'use strict';
  const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const UID = new RegExp('^' + UUID + '$', 'i');
  const LISTING = new RegExp('^/(?:[a-z]{2}(?:-[a-z]{2})?/)?listings/(' + UUID + ')(?:/|$)', 'i');
  const FREE = /\bfree\b|免费|免費/i;
  const OWNED = /saved (?:in|to) my library|in (?:my|your) library|you own|已保存|已存入|已添加到|已加入|已拥有|已擁有/i;

  class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
    get halt() { return [401, 403, 429].includes(this.status); }
  }
  class Paused extends Error { constructor() { super('任务已暂停'); this.name = 'Paused'; } }

  function listingId(href, base = 'https://www.fab.com') {
    try {
      const url = new URL(href, base);
      if (url.origin !== 'https://www.fab.com') return null;
      return url.pathname.match(LISTING)?.[1]?.toLowerCase() || null;
    } catch { return null; }
  }
  function scan(doc) {
    const found = new Map();
    const idsByElement = new WeakMap();
    const idByLink = new WeakMap();
    const idOf = link => {
      if (!idByLink.has(link)) idByLink.set(link, listingId(link.getAttribute('href'), doc.baseURI));
      return idByLink.get(link);
    };
    const scope = doc.querySelector('main, [role="main"]') || doc.body;
    if (!scope) return [];
    for (const a of scope.querySelectorAll('a[href*="/listings/"]')) {
      const id = idOf(a);
      if (!id || found.has(id)) continue;
      let card = a;
      // A thumbnail/title can be separate links. Stop before an ancestor contains a second asset.
      for (let el = a.parentElement, depth = 0; el && el !== scope && el !== doc.body && depth < 8; el = el.parentElement, depth++) {
        // Shared grid ancestors are examined once per scan, rather than once per card.
        if (!idsByElement.has(el)) idsByElement.set(el, new Set(Array.from(el.querySelectorAll('a[href*="/listings/"]'), idOf).filter(Boolean)));
        const ids = idsByElement.get(el);
        if (ids.size > 1) break;
        if (ids.size === 1) card = el;
      }
      const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
      const heading = card.querySelector('h2,h3,h4,[class*="ellipsisWrapper"]');
      const titleLink = Array.from(card.querySelectorAll('a[href*="/listings/"]')).find(n => n.textContent.trim());
      const name = (heading?.textContent || a.getAttribute('aria-label') || titleLink?.textContent || card.querySelector('img')?.alt || '未命名素材').trim();
      found.set(id, { id, name: name.slice(0, 240), href: 'https://www.fab.com/listings/' + id,
        hint: OWNED.test(text) ? 'owned' : FREE.test(text) ? 'free' : 'unknown', status: 'pending', note: '' });
    }
    return [...found.values()];
  }

  function amount(offer) {
    // Null, empty strings and booleans are not zero. Discounted price takes precedence.
    const value = offer?.discountedPrice ?? offer?.price;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
    return null;
  }
  function selectOffer(detail, prices, preferred = 'auto') {
    if (!Array.isArray(prices?.offers)) throw new ApiError('价格结构无法识别，未提交入库');
    const free = prices.offers.filter(o => typeof o.offerId === 'string' && o.offerId.length && amount(o) === 0);
    if (!free.length) return null;
    const licenses = Array.isArray(detail?.licenses) ? detail.licenses : [];
    const slugOf = l => l.slug || l.license?.slug || l.licenseType?.slug;
    if (preferred !== 'auto') {
      const ids = new Set(licenses.filter(l => slugOf(l) === preferred).map(l => l.offerId));
      const chosen = free.find(o => ids.has(o.offerId));
      if (!chosen) throw new ApiError('无法确认所选授权为零元，请在素材详情页核对，或改用“自动”');
      return { ...chosen, license: preferred };
    }
    const professional = licenses.find(l => slugOf(l) === 'professional' && free.some(o => o.offerId === l.offerId));
    const chosen = free.find(o => o.offerId === professional?.offerId) || free[0];
    return { ...chosen, license: slugOf(licenses.find(l => l.offerId === chosen.offerId) || {}) || '零元授权' };
  }

  // Reserve request starts across all workers; waiting never consumes a network timeout.
  class RequestGate {
    constructor({ interval = 1000, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
      this.interval = interval; this.now = now; this.sleep = sleep;
      this.nextAt = 0; this.cooldownUntil = 0; this.queue = Promise.resolve();
    }
    blockUntil(until) { if (Number.isFinite(until)) this.cooldownUntil = Math.max(this.cooldownUntil, until); }
    async wait(shouldStop = () => false) {
      const previous = this.queue;
      let release;
      this.queue = new Promise(resolve => { release = resolve; });
      await previous;
      const check = () => {
        if (shouldStop()) throw new Paused();
        if (this.cooldownUntil > this.now()) {
          const error = new ApiError('Fab 请求限流，冷却 ' + Math.ceil((this.cooldownUntil - this.now()) / 1000) + ' 秒后可手动继续', 429);
          error.retryAt = this.cooldownUntil;
          throw error;
        }
      };
      try {
        check();
        while (this.now() < this.nextAt) {
          await this.sleep(Math.min(100, this.nextAt - this.now()));
          check();
        }
        this.nextAt = this.now() + this.interval;
      } finally { release(); }
    }
  }

  class Client {
    constructor({ fetch, cookie = () => '', sleep = ms => new Promise(r => setTimeout(r, ms)), onHalt = () => {}, beforeRequest = async () => {}, now = () => Date.now() }) {
      this.fetch = fetch; this.cookie = cookie; this.sleep = sleep; this.onHalt = onHalt;
      this.beforeRequest = beforeRequest; this.now = now;
    }
    async request(path, method = 'GET', payload, options = {}) {
      // No arbitrary URLs, payment endpoints, auth tokens or cross-origin requests.
      const url = new URL(path, 'https://www.fab.com');
      const params = url.searchParams;
      const ordinary = !url.search && /^\/i\/(?:listings\/[a-f0-9-]+(?:\/prices-infos|\/add-to-library)?|users\/me(?:\/listings-states\/[a-f0-9-]+)?)$/i.test(path);
      const catalogue = url.pathname === '/i/listings/search' && params.get('seller') === 'Quixel Megascans' &&
        params.get('is_free') === '1' && params.get('count') === '24' && params.get('sort_by') === 'title' &&
        [...params.keys()].every(key => ['seller', 'is_free', 'count', 'sort_by', 'cursor'].includes(key) && params.getAll(key).length === 1) &&
        (!params.has('cursor') || (params.get('cursor').length > 0 && params.get('cursor').length <= 2048));
      const ids = params.getAll('listing_ids');
      const states = url.pathname === '/i/users/me/listings-states' && ids.length > 0 && ids.length <= 24 &&
        [...params.keys()].every(key => key === 'listing_ids') && ids.every(id => UID.test(id));
      if (!path.startsWith('/i/') || url.origin !== 'https://www.fab.com' || url.hash || !(ordinary || (method === 'GET' && (catalogue || states)))) throw new ApiError('请求路径不受支持');
      if (method !== 'GET' && !(method === 'POST' && path.endsWith('/add-to-library'))) throw new ApiError('不支持的操作');
      const headers = { Accept: 'application/json' };
      if (method === 'POST') {
        const token = this.cookie().match(/(?:^|;\s*)fab_csrftoken=([^;]+)/)?.[1];
        if (!token) {
          const error = new ApiError('缺少网页验证信息。请在 Fab 手动领取一项免费素材并完成授权后重试', 403);
          await this.onHalt(error);
          throw error;
        }
        headers['X-CSRFToken'] = token;
        headers['Content-Type'] = 'application/json';
      }
      await this.beforeRequest(options);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await this.fetch(path, { method, credentials: 'include', redirect: 'error', headers,
          signal: controller.signal, ...(payload ? { body: JSON.stringify(payload) } : {}) });
        if (!response.ok) {
          if (response.status === 429) {
            const now = this.now(), value = response.headers?.get('Retry-After')?.trim();
            const parsed = value && /^\d+$/.test(value) ? now + Number(value) * 1000 : value ? Date.parse(value) : NaN;
            // Without a usable server value, 60 seconds is our conservative local fallback.
            const retryAt = Number.isFinite(parsed) ? Math.max(now + 1000, parsed) : now + 60000;
            const error = new ApiError('Fab 请求限流，冷却 ' + Math.ceil((retryAt - now) / 1000) + ' 秒后可手动继续', 429);
            error.retryAt = retryAt;
            throw error;
          }
          const message = response.status === 401 ? '请先在当前浏览器登录 Fab' :
            response.status === 403 ? '网页验证或授权尚未完成，请手动领取一项免费素材后重试' :
            `Fab 返回 HTTP ${response.status}，本项未确认成功`;
          throw new ApiError(message, response.status);
        }
        const body = await response.text();
        if (!body.trim()) return null;
        try { return JSON.parse(body); } catch { throw new ApiError('Fab 返回了非 JSON 页面，可能需要重新登录或完成网页验证', 403); }
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.halt) await this.onHalt(error);
          throw error;
        }
        throw new ApiError(error.name === 'AbortError' ? '请求超时；如已提交入库，重试时会先核对拥有状态' : '网络请求失败，请检查网络或网页验证状态');
      } finally { clearTimeout(timeout); }
    }
    async account() {
      const user = await this.request('/i/users/me');
      this.showMyLibraryProducts = user?.preferences?.showMyLibraryProducts !== false;
      const id = user?.uid ?? user?.id;
      return user?.isAnonymous !== true && typeof id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(id) ? id : null;
    }
    async state(id, afterSubmission = false) {
      const result = await this.request('/i/users/me/listings-states/' + id, 'GET', undefined, { afterSubmission });
      if (typeof result?.acquired !== 'boolean') throw new ApiError('无法核对素材拥有状态，未提交入库');
      return result.acquired;
    }
    async quixelPage(cursor = '') {
      if (typeof cursor !== 'string' || cursor.length > 2048) throw new ApiError('目录断点无法识别');
      // Type weights have thousands of ties: Fab repeats the offset cursor at 5024.
      // Title ordering returns a position cursor, so keep this order fixed across resumes.
      const params = new URLSearchParams({ seller: 'Quixel Megascans', sort_by: 'title', is_free: '1', count: '24' });
      if (cursor) params.set('cursor', cursor);
      const data = await this.request('/i/listings/search?' + params);
      if (!Array.isArray(data?.results) || data.results.length > 24 || !data.cursors || !('next' in data.cursors)) throw new ApiError('目录结构无法识别，已停止翻页');
      const next = data.cursors.next;
      if (next !== null && (typeof next !== 'string' || !next || next.length > 2048 || next === cursor || !data.results.length)) throw new ApiError('目录分页断点异常，已停止翻页');
      const seen = new Set();
      const items = data.results.map(row => {
        if (!UID.test(row?.uid) || typeof row.title !== 'string' || row.user?.sellerName !== 'Quixel Megascans' || seen.has(row.uid.toLowerCase())) throw new ApiError('目录素材或卖家无法核对，已停止翻页');
        seen.add(row.uid.toLowerCase());
        return { id: row.uid.toLowerCase(), name: row.title.slice(0, 240), href: 'https://www.fab.com/listings/' + row.uid.toLowerCase(), hint: row.isFree === true ? 'free' : 'unknown', status: 'pending', note: '' };
      });
      return { items, next };
    }
    async states(ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 24 || !ids.every(id => UID.test(id))) throw new ApiError('批量状态编号无法识别');
      const params = new URLSearchParams();
      for (const id of ids) params.append('listing_ids', id);
      const rows = await this.request('/i/users/me/listings-states?' + params);
      if (!Array.isArray(rows)) throw new ApiError('批量拥有状态无法识别，将逐项核对');
      const result = new Map();
      for (const row of rows) {
        if (!ids.includes(row?.uid) || typeof row.acquired !== 'boolean' || result.has(row.uid)) throw new ApiError('批量拥有状态无法识别，将逐项核对');
        result.set(row.uid, row.acquired);
      }
      // Missing entries are deliberately left unknown and use individual verification.
      return result;
    }
    async claim(item, preferred = 'auto', shouldStop = () => false, knownUnowned = false) {
      if (!UID.test(item.id)) throw new ApiError('无效素材编号');
      const checkpoint = () => { if (shouldStop()) throw new Paused(); };
      checkpoint();
      if (knownUnowned !== true && await this.state(item.id)) return { status: 'owned', note: '已在当前账号素材库中' };
      checkpoint();
      // These are independent reads. Wait for both, including failures, before a write or next item.
      const reads = await Promise.allSettled([
        this.request('/i/listings/' + item.id),
        this.request('/i/listings/' + item.id + '/prices-infos')
      ]);
      const failure = reads.find(r => r.status === 'rejected' && r.reason?.halt) || reads.find(r => r.status === 'rejected');
      if (failure) throw failure.reason;
      checkpoint();
      const [detail, prices] = reads.map(r => r.value);
      if (typeof detail?.title === 'string') item.name = detail.title.slice(0, 240);
      const offer = selectOffer(detail, prices, preferred);
      if (!offer) return { status: 'skipped', note: '没有核对到零元授权，已跳过' };
      checkpoint();
      try {
        await this.request('/i/listings/' + item.id + '/add-to-library', 'POST', { offerId: offer.offerId });
      } catch (error) {
        // Another tab/browser may have claimed since the batch read. A 400 alone is never success.
        if (error.status === 400) {
          try {
            if (await this.state(item.id, true)) return { status: 'owned', note: '提交时已拥有 · 已重新核对当前账号状态' };
          } catch (verification) { if (verification.halt) throw verification; }
        }
        throw error;
      }
      // A POST, closed dialog or disabled button is not proof of ownership.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await this.sleep(1000 * attempt);
        if (await this.state(item.id, true)) return { status: 'claimed', note: '已确认入库 · ' + offer.license };
      }
      throw new ApiError('已提交但尚未确认拥有状态，可稍后重试核对');
    }
  }
  const api = Object.freeze({ listingId, scan, amount, selectOffer, RequestGate, Client, ApiError, Paused });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FabFreeCore = api;
})(globalThis);
