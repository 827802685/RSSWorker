import { Hono } from 'hono';
import { cors } from 'hono/cors';
import indexHtml from './html/index.html';
import settingHtml from './html/setting.html';
import rssHtml from './html/rss.html';
import notFoundHtml from './html/404.html';
import errorHtml from './html/err.html';
import robotsTxt from './robots.txt';

import route from './route';

const app = new Hono();

// --- Helpers ---

async function hashPassword(password) {
	const encoder = new TextEncoder();
	const data = encoder.encode(password + '::rssworker_salt_v1');
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
	const arr = new Uint8Array(32);
	crypto.getRandomValues(arr);
	return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateId() {
	const arr = new Uint8Array(8);
	crypto.getRandomValues(arr);
	return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getSessionToken(ctx) {
	const cookieHeader = ctx.req.header('Cookie') || '';
	const match = cookieHeader.match(/rss_session=([^;]+)/);
	return match ? match[1] : null;
}

async function verifySession(ctx) {
	const token = getSessionToken(ctx);
	if (!token) return null;
	try {
		const sessionData = await ctx.env.data.get(`session:${token}`);
		if (!sessionData) return null;
		const session = JSON.parse(sessionData);
		if (Date.now() > session.expires) {
			await ctx.env.data.delete(`session:${token}`);
			return null;
		}
		return session;
	} catch (e) {
		return null;
	}
}

function setSessionCookie(ctx, token) {
	ctx.header(
		'Set-Cookie',
		`rss_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
	);
}

function clearSessionCookie(ctx) {
	ctx.header('Set-Cookie', `rss_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

function escapeHtml(str) {
	return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Subscription helpers
async function getSubscriptions(env) {
	const raw = await env.data.get('subscriptions');
	if (!raw) return [];
	try {
		return JSON.parse(raw);
	} catch (e) {
		return [];
	}
}

async function saveSubscriptions(env, subs) {
	await env.data.put('subscriptions', JSON.stringify(subs));
}

// Available feed types
const FEED_TYPES = [
	{ platform: 'bilibili', name: 'B站动态', icon: '📺', route: '/rss/bilibili/user/dynamic/:uid', paramLabel: 'B站用户UID', paramPlaceholder: '如: 1', paramDescription: 'B站用户UID，可在用户主页URL中获取', helpUrl: 'https://space.bilibili.com/1' },
	{ platform: 'bilibili', name: 'B站视频', icon: '🎬', route: '/rss/bilibili/user/video/:uid', paramLabel: 'B站用户UID', paramPlaceholder: '如: 1', paramDescription: 'B站用户UID，可在用户主页URL中获取', helpUrl: 'https://space.bilibili.com/1' },
	{ platform: 'douyin', name: '抖音视频', icon: '🎵', route: '/rss/douyin/user/:uid', paramLabel: '抖音sec_user_id', paramPlaceholder: '如: MS4wLjABAAAA...', paramDescription: '抖音用户sec_uid，在用户主页URL中获取', helpUrl: 'https://www.douyin.com/user/MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao', envHint: '可能需要配置 DOUYIN_COOKIE 环境变量' },
	{ platform: 'telegram', name: 'Telegram频道', icon: '✈️', route: '/rss/telegram/channel/:username', paramLabel: '频道用户名', paramPlaceholder: '如: durov', paramDescription: 'Telegram频道的用户名（不含@）', helpUrl: 'https://t.me/s/durov' },
	{ platform: 'weibo', name: '微博用户', icon: '📢', route: '/rss/weibo/user/:uid', paramLabel: '微博用户UID', paramPlaceholder: '如: 1195242765', paramDescription: '微博用户UID，可在用户主页URL中获取', helpUrl: 'https://weibo.com/u/1195242765', envHint: '可能需要配置 WEIBO_COOKIE 环境变量' },
	{ platform: 'xiaohongshu', name: '小红书用户', icon: '📕', route: '/rss/xiaohongshu/user/:uid', paramLabel: '小红书用户ID', paramPlaceholder: '如: 5d2aec020000000012037401', paramDescription: '小红书用户ID，在用户主页URL中获取', helpUrl: 'https://www.xiaohongshu.com/user/profile/5d2aec020000000012037401' },
];

app.use('/*', cors());

// --- Routes ---

// RSS 聚合索引页：展示所有已保存订阅
app.get('/rss', async (ctx) => {
	try {
		const origin = new URL(ctx.req.url).origin;
		const subs = await getSubscriptions(ctx.env);

		const listHtml = subs.length === 0
			? '<div class="empty">还没有订阅源<br><br><a href="/setting">前往控制面板添加订阅 →</a></div>'
			: '<ul class="list">' + subs.map(function(s) {
				return '<li><span class="icon">' + s.icon + '</span><a class="name" href="' + origin + s.url + '" target="_blank">' + escapeHtml(s.title || s.name) + '</a><span class="url">' + escapeHtml(origin + s.url) + '</span></li>';
			}).join('') + '</ul>';

		const html = rssHtml
			.split('{{SUB_COUNT}}').join(String(subs.length))
			.split('{{SUBSCRIPTIONS}}').join(listHtml);

		return ctx.html(html);
	} catch (e) {
		return ctx.text('Error: ' + e.message, 500);
	}
});

app.route('/rss', route);

// Homepage
app.get('/', async (ctx) => {
	try {
		const origin = new URL(ctx.req.url).origin;
		const subs = await getSubscriptions(ctx.env);

		const subsHtml = subs.length === 0
			? '<div style="text-align:center;padding:60px 20px;color:#8b8fa3;"><p style="font-size:18px;">还没有订阅</p><p style="font-size:14px;margin-top:8px;">前往 <a href="/setting" style="color:#6366f1;">控制面板</a> 添加订阅</p></div>'
			: '<div class="subs-grid">' + subs.map(function(s) {
				return '<div class="sub-card"><div class="sub-header"><div class="sub-icon">' + s.icon + '</div><div><div class="sub-name">' + escapeHtml(s.title || s.name) + '</div><div class="sub-platform">' + s.platform + '</div></div></div><div class="sub-url">' + escapeHtml(origin + s.url) + '</div><div class="sub-actions"><a href="' + origin + s.url + '" target="_blank" class="btn btn-primary btn-sm">查看 RSS</a><button class="btn btn-secondary btn-sm" onclick="copyUrl(\'' + origin + s.url + '\')">复制链接</button></div></div>';
			}).join('') + '</div>';

		const html = indexHtml
			.split('{{SUBSCRIPTIONS}}').join(subsHtml)
			.split('{{SUB_COUNT}}').join(String(subs.length));

		return ctx.html(html);
	} catch (e) {
		return ctx.text('Error: ' + e.message, 500);
	}
});

app.get('/robots.txt', (ctx) => {
	return ctx.text(robotsTxt);
});

app.get('/api/feeds', (ctx) => {
	return ctx.json({ feeds: FEED_TYPES });
});

app.get('/api/subscriptions', async (ctx) => {
	const origin = new URL(ctx.req.url).origin;
	const subs = await getSubscriptions(ctx.env);
	return ctx.json({ origin, subscriptions: subs.map(s => ({ ...s, fullUrl: origin + s.url })) });
});

// --- Setting / Auth routes ---

app.get('/setting', (ctx) => {
	return ctx.html(settingHtml);
});

app.get('/setting/api/status', async (ctx) => {
	try {
		const credExists = await ctx.env.data.get('auth:email');
		const session = await verifySession(ctx);
		if (session) return ctx.json({ authenticated: true, needsSetup: false, email: session.email });
		return ctx.json({ authenticated: false, needsSetup: !credExists });
	} catch (e) {
		return ctx.json({ authenticated: false, needsSetup: true });
	}
});

app.post('/setting/api/setup', async (ctx) => {
	try {
		const existingEmail = await ctx.env.data.get('auth:email');
		if (existingEmail) return ctx.json({ success: false, error: '管理员账号已存在，请直接登录' });
		const body = await ctx.req.json();
		const email = (body.email || '').trim().toLowerCase();
		const password = body.password || '';
		if (!email || !email.includes('@')) return ctx.json({ success: false, error: '请输入有效邮箱' });
		if (password.length < 6) return ctx.json({ success: false, error: '密码至少6位' });
		const passwordHash = await hashPassword(password);
		await ctx.env.data.put('auth:email', email);
		await ctx.env.data.put('auth:password_hash', passwordHash);
		const token = generateToken();
		const session = { email, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 };
		await ctx.env.data.put('session:' + token, JSON.stringify(session), { expirationTtl: 7 * 24 * 60 * 60 });
		setSessionCookie(ctx, token);
		return ctx.json({ success: true, email });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

app.post('/setting/api/login', async (ctx) => {
	try {
		const body = await ctx.req.json();
		const email = (body.email || '').trim().toLowerCase();
		const password = body.password || '';
		const storedEmail = await ctx.env.data.get('auth:email');
		const storedHash = await ctx.env.data.get('auth:password_hash');
		if (!storedEmail || !storedHash) return ctx.json({ success: false, error: '系统尚未初始化，请先设置账号' });
		if (email !== storedEmail) return ctx.json({ success: false, error: '邮箱或密码错误' });
		if ((await hashPassword(password)) !== storedHash) return ctx.json({ success: false, error: '邮箱或密码错误' });
		const token = generateToken();
		const session = { email, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 };
		await ctx.env.data.put('session:' + token, JSON.stringify(session), { expirationTtl: 7 * 24 * 60 * 60 });
		setSessionCookie(ctx, token);
		return ctx.json({ success: true, email });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

app.post('/setting/api/logout', async (ctx) => {
	const token = getSessionToken(ctx);
	if (token) await ctx.env.data.delete('session:' + token);
	clearSessionCookie(ctx);
	return ctx.json({ success: true });
});

app.post('/setting/api/change-password', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });
		const body = await ctx.req.json();
		const oldPassword = body.oldPassword || '';
		const newPassword = body.newPassword || '';
		const storedHash = await ctx.env.data.get('auth:password_hash');
		if ((await hashPassword(oldPassword)) !== storedHash) return ctx.json({ success: false, error: '当前密码错误' });
		if (newPassword.length < 6) return ctx.json({ success: false, error: '新密码至少6位' });
		await ctx.env.data.put('auth:password_hash', await hashPassword(newPassword));
		return ctx.json({ success: true });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

// --- Subscription Management API ---

app.get('/setting/api/subscriptions', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });
		const subs = await getSubscriptions(ctx.env);
		return ctx.json({ success: true, subscriptions: subs });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

app.post('/setting/api/subscriptions', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });
		const body = await ctx.req.json();
		const feedType = FEED_TYPES.find(f => f.route === body.route);
		if (!feedType) return ctx.json({ success: false, error: '不支持的平台' });
		const param = (body.param || '').trim();
		if (!param) return ctx.json({ success: false, error: '请输入参数' });
		const subs = await getSubscriptions(ctx.env);
		const url = feedType.route.replace(':uid', encodeURIComponent(param)).replace(':username', encodeURIComponent(param));
		if (subs.some(s => s.url === url)) return ctx.json({ success: false, error: '该订阅已存在' });
		const sub = {
			id: generateId(),
			platform: feedType.platform,
			name: feedType.name,
			icon: feedType.icon,
			route: feedType.route,
			param: param,
			title: (body.title || '').trim() || (feedType.name + ' - ' + param),
			url: url,
			createdAt: Date.now(),
		};
		subs.push(sub);
		await saveSubscriptions(ctx.env, subs);
		return ctx.json({ success: true, subscription: sub });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

app.delete('/setting/api/subscriptions/:id', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });
		const { id } = ctx.req.param();
		const subs = await getSubscriptions(ctx.env);
		const filtered = subs.filter(s => s.id !== id);
		if (filtered.length === subs.length) return ctx.json({ success: false, error: '订阅不存在' });
		await saveSubscriptions(ctx.env, filtered);
		return ctx.json({ success: true });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

app.put('/setting/api/subscriptions/:id', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });
		const { id } = ctx.req.param();
		const body = await ctx.req.json();
		const subs = await getSubscriptions(ctx.env);
		const idx = subs.findIndex(s => s.id === id);
		if (idx === -1) return ctx.json({ success: false, error: '订阅不存在' });
		if (body.title !== undefined) {
			subs[idx].title = body.title.trim() || subs[idx].title;
		}
		await saveSubscriptions(ctx.env, subs);
		return ctx.json({ success: true, subscription: subs[idx] });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

app.notFound((ctx) => {
	return ctx.html(notFoundHtml);
});
app.onError((err, c) => {
	let stack_str = err.stack;
	let stack_arr = stack_str.split('\n').join('<br>');
	let result = errorHtml.replace('{ERROR_MESSAGE}', '' + err);
	result = result.replace('{ERROR_STACK}', '' + stack_arr);
	return c.html(result, 500);
});

export default app;
