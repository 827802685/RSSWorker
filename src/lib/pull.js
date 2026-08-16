import { putObject } from './storage/s3';
import push from './push/index';
import { parseRss, parseAtom, detectAndParse } from './rssparse';

const DEFAULT_ORIGIN = 'https://rss.zjkl.qzz.io';

function nowMin() {
	const d = new Date();
	return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function readKV(env, key) {
	if (!env.data) return null;
	try { return await env.data.get(key); } catch (e) { return null; }
}

async function writeKV(env, key, val) {
	if (!env.data) return;
	try { await env.data.put(key, val); } catch (e) {}
}

// 判断某个订阅当前是否到点该拉取
function isDue(sub, clock) {
	if (!sub.pullEnabled) return false;
	const times = sub.pullTimes && Array.isArray(sub.pullTimes) ? sub.pullTimes : [];
	if (times.length === 0) return true; // 启用但未指定时间则每次都拉
	if (!times.includes(clock)) return false;
	// 防止 10 分钟内重复拉：距上次拉取至少 8 分钟
	if (sub.lastPull && Date.now() - sub.lastPull < 8 * 60 * 1000) return false;
	return true;
}

// 确保 D1 表结构
async function ensureSchema(env) {
	if (!env.DB) return false;
	try {
		await env.DB.prepare(`
			CREATE TABLE IF NOT EXISTS items (
				id TEXT PRIMARY KEY,
				source_id TEXT,
				title TEXT,
				link TEXT,
				description TEXT,
				author TEXT,
				guid TEXT,
				published TEXT,
				pulled_at INTEGER
			)
		`).run();
		await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id)').run();
		return true;
	} catch (e) { return false; }
}

// 从给定 URL 抓取并解析，返回 {title, items}
async function fetchAndParse(url, origin, sub) {
	if (sub.sourceUrl) {
		// 自定义源：直接抓取页面并自动识别 RSS/HTML
		const res = await fetch(sub.sourceUrl, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
				Accept: 'application/rss+xml, application/atom+xml, application/xml, text/html,*/*;q=0.8',
			},
			redirect: 'follow',
		});
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const text = await res.text();
		return detectAndParse(sub.sourceUrl, text);
	}
	// 平台路由或其他已生成 RSS：抓自身生成源
	const selfUrl = origin + sub.url;
	const res = await fetch(selfUrl, { headers: { 'User-Agent': 'Mozilla/5.0 RSSWorker' }, redirect: 'follow' });
	if (!res.ok) throw new Error('HTTP ' + res.status);
	const text = await res.text();
	if (/<rss\b|<rdf/.test(text)) return parseRss(text, selfUrl);
	if (/<atom\b|<feed\b/.test(text)) return parseAtom(text, selfUrl);
	throw new Error('非有效RSS响应');
}

// 存储配置：KV（storage:config）优先，env 兜底
async function storageConfig(env) {
	const kvRaw = await readKV(env, 'storage:config');
	let kv = {};
	if (kvRaw) { try { kv = JSON.parse(kvRaw); } catch (e) {} }
	return {
		endpoint: kv.endpoint || env.S3_ENDPOINT || '',
		bucket: kv.bucket || env.S3_BUCKET || '',
		accessKey: kv.accessKey || env.S3_ACCESS_KEY || '',
		secretKey: kv.secretKey || env.S3_SECRET_KEY || '',
		region: kv.region || env.S3_REGION || 'auto',
		pathPrefix: kv.pathPrefix || env.S3_PATH_PREFIX || 'rssworker',
	};
}

// 归档到 S3
async function archiveToS3(env, sub, items, parsed) {
	const cfg = await storageConfig(env);
	if (!cfg.endpoint || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) return null;
	const date = new Date().toISOString().slice(0, 10);
	const key = `${cfg.pathPrefix}/${sub.id}/${date}-${Date.now()}.json`;
	const payload = JSON.stringify({
		source: { id: sub.id, title: sub.title, url: sub.url },
		pulled_at: Date.now(),
		items,
	});
	try {
		await putObject({
			endpoint: cfg.endpoint,
			bucket: cfg.bucket,
			key,
			body: payload,
			contentType: 'application/json',
			accessKey: cfg.accessKey,
			secretKey: cfg.secretKey,
			region: cfg.region,
		});
		return key;
	} catch (e) {
		return null;
	}
}

// 去重：维护每源已见 guid 集合（KV），返回新增
async function dedup(env, sub, items) {
	const key = 'dedup:' + sub.id;
	const raw = await readKV(env, key);
	const seen = raw ? new Set(JSON.parse(raw)) : new Set();
	const fresh = [];
	for (const it of items) {
		const g = it.guid || it.link || it.id;
		if (!g) continue;
		if (!seen.has(g)) {
			seen.add(g);
			fresh.push(it);
		}
	}
	// 裁剪，最多保留 500 个 guid
	const arr = Array.from(seen);
	const capped = arr.slice(Math.max(0, arr.length - 800));
	await writeKV(env, key, JSON.stringify(capped));
	return fresh;
}

async function archiveToD1(env, sub, items) {
	if (!env.DB) return;
	try {
		const stmt = env.DB.prepare(`
			INSERT OR IGNORE INTO items (id, source_id, title, link, description, author, guid, published, pulled_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const batch = items.slice(0, 50).map(it => stmt.bind(
			(sub.id + ':' + (it.guid || it.link || it.id)),
			sub.id,
			it.title || '',
			it.link || '',
			it.description || '',
			it.author || '',
			it.guid || it.link || it.id || '',
			it.pubDate || '',
			Date.now(),
		));
		await env.DB.batch(batch);
	} catch (e) {}
}

// 主入口：拉取所有到点的订阅源并推送
async function pullAll(env, { trigger } = {}) {
	const results = [];
	const origin = (await readKV(env, 'app:origin')) || DEFAULT_ORIGIN;
	const raw = await readKV(env, 'subscriptions');
	let subs = [];
	if (raw) { try { subs = JSON.parse(raw); } catch (e) {} }
	if (subs.length === 0) return { ok: true, message: '无订阅', results };

	const clock = nowMin();
	let changed = false;

	for (const sub of subs) {
		// trigger==='all' 时忽略时间调度；正常 cron 按调度
		if (!sub.pullEnabled) {
			if (!trigger) continue;
		} else if (!trigger && !isDue(sub, clock)) {
			continue;
		}
		const rec = { id: sub.id, title: sub.title, ok: false, newItems: 0, error: null, archived: null, pushes: [] };
		try {
			const parsed = await fetchAndParse(origin, origin, sub);
			const items = parsed.items || [];
			const fresh = await dedup(env, sub, items);
			rec.newItems = fresh.length;
			if (fresh.length > 0) {
				await archiveToD1(env, sub, fresh);
				rec.archived = await archiveToS3(env, sub, fresh, parsed);
				const pushes = await push.push(env, sub, fresh);
				rec.pushes = pushes;
			}
			rec.ok = true;
			if (!sub.lastPull || trigger) changed = true;
			sub.lastPull = Date.now();
		} catch (e) {
			rec.error = e.message;
			sub.lastPull = Date.now();
		}
		results.push(rec);
	}

	if (changed) {
		await writeKV(env, 'subscriptions', JSON.stringify(subs));
	}
	// 记录拉取日志
	await writeKV(env, 'pull:last', JSON.stringify({ time: Date.now(), count: subs.length, results }));
	return { ok: true, origin, clock, results };
}

export default { pullAll, isDue };