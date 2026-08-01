import { Hono } from 'hono';
import { cors } from 'hono/cors';
import indexHtml from './html/index.html';
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

// AWS SigV4 signing for S3 (minimal implementation)
async function hmacSha256(key, message) {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
	return sig;
}

async function sha256Hex(message) {
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(message));
	return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toHex(buffer) {
	return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function awsSigV4Sign(method, host, path, region, accessKey, secretKey, serviceName) {
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
	const dateStamp = amzDate.slice(0, 8);

	const canonicalUri = path;
	const canonicalQueryString = '';
	const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
	const signedHeaders = 'host;x-amz-date';
	const payloadHash = await sha256Hex('');

	const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

	const credentialScope = `${dateStamp}/${region}/${serviceName}/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

	let signingKey = new TextEncoder().encode(`AWS4${secretKey}`);
	signingKey = await hmacSha256(signingKey, dateStamp);
	signingKey = await hmacSha256(signingKey, region);
	signingKey = await hmacSha256(signingKey, serviceName);
	signingKey = await hmacSha256(signingKey, 'aws4_request');
	const signature = toHex(await hmacSha256(signingKey, stringToSign));

	return {
		authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		amzDate,
	};
}

// --- Routes ---

app.route('/rss', route);

app.get('/', (ctx) => {
	return ctx.html(indexHtml);
});

app.get('/robots.txt', (ctx) => {
	return ctx.text(robotsTxt);
});

app.get('/debug', (ctx) => {
	return ctx.json(ctx.req.raw?.cf);
});

app.get('/api/feeds', (ctx) => {
	const origin = new URL(ctx.req.url).origin;
	return ctx.json({
		origin,
		feeds: [
			{ platform: 'bilibili', name: 'B站动态', icon: '📺', route: '/rss/bilibili/user/dynamic/:uid', paramName: 'uid', paramLabel: 'B站用户UID', paramPlaceholder: '如: 1', paramDescription: 'B站用户UID，可在用户主页URL中获取', example: '1', helpUrl: 'https://space.bilibili.com/1' },
			{ platform: 'bilibili', name: 'B站视频', icon: '🎬', route: '/rss/bilibili/user/video/:uid', paramName: 'uid', paramLabel: 'B站用户UID', paramPlaceholder: '如: 1', paramDescription: 'B站用户UID，可在用户主页URL中获取', example: '1', helpUrl: 'https://space.bilibili.com/1' },
			{ platform: 'douyin', name: '抖音视频', icon: '🎵', route: '/rss/douyin/user/:uid', paramName: 'uid', paramLabel: '抖音sec_user_id', paramPlaceholder: '如: MS4wLjABAAAA...', paramDescription: '抖音用户sec_uid，在用户主页URL中获取（以MS4wLjABAAAA开头）', example: 'MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao', helpUrl: 'https://www.douyin.com/user/MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao', envHint: '可能需要配置 DOUYIN_COOKIE 环境变量' },
			{ platform: 'telegram', name: 'Telegram频道', icon: '✈️', route: '/rss/telegram/channel/:username', paramName: 'username', paramLabel: '频道用户名', paramPlaceholder: '如: durov', paramDescription: 'Telegram频道的用户名（不含@）', example: 'durov', helpUrl: 'https://t.me/s/durov' },
			{ platform: 'weibo', name: '微博用户', icon: '📢', route: '/rss/weibo/user/:uid', paramName: 'uid', paramLabel: '微博用户UID', paramPlaceholder: '如: 1195242765', paramDescription: '微博用户UID，可在用户主页URL中获取', example: '1195242765', helpUrl: 'https://weibo.com/u/1195242765', envHint: '可能需要配置 WEIBO_COOKIE 环境变量' },
			{ platform: 'xiaohongshu', name: '小红书用户', icon: '📕', route: '/rss/xiaohongshu/user/:uid', paramName: 'uid', paramLabel: '小红书用户ID', paramPlaceholder: '如: 5d2aec020000000012037401', paramDescription: '小红书用户ID，在用户主页URL中获取', example: '5d2aec020000000012037401', helpUrl: 'https://www.xiaohongshu.com/user/profile/5d2aec020000000012037401' },
		],
	});
});

// --- Setting / Auth routes ---

// 懒加载 setting 页面（仅在访问 /setting 时加载 HTML）
app.get('/setting', async (ctx) => {
	const { default: settingHtml } = await import('./html/setting.html');
	return ctx.html(settingHtml);
});

app.get('/setting/api/status', async (ctx) => {
	try {
		const credExists = await ctx.env.data.get('auth:email');
		const session = await verifySession(ctx);
		if (session) {
			return ctx.json({ authenticated: true, needsSetup: false, email: session.email });
		}
		return ctx.json({ authenticated: false, needsSetup: !credExists });
	} catch (e) {
		return ctx.json({ authenticated: false, needsSetup: true });
	}
});

app.post('/setting/api/setup', async (ctx) => {
	try {
		const existingEmail = await ctx.env.data.get('auth:email');
		if (existingEmail) {
			return ctx.json({ success: false, error: '管理员账号已存在，请直接登录' });
		}
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
		await ctx.env.data.put(`session:${token}`, JSON.stringify(session), { expirationTtl: 7 * 24 * 60 * 60 });
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
		await ctx.env.data.put(`session:${token}`, JSON.stringify(session), { expirationTtl: 7 * 24 * 60 * 60 });
		setSessionCookie(ctx, token);
		return ctx.json({ success: true, email });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

app.post('/setting/api/logout', async (ctx) => {
	const token = getSessionToken(ctx);
	if (token) await ctx.env.data.delete(`session:${token}`);
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

// --- S3 Storage Config ---

// 获取 S3 配置（密钥打码）
app.get('/setting/api/storage', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });
		const raw = await ctx.env.data.get('storage:s3_config');
		if (!raw) return ctx.json({ success: true, config: null });
		const config = JSON.parse(raw);
		// 返回时隐藏密钥
		return ctx.json({
			success: true,
			config: {
				...config,
				secretKey: config.secretKey ? '••••••••' + config.secretKey.slice(-4) : '',
			},
		});
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

// 保存 S3 配置
app.post('/setting/api/storage', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });
		const body = await ctx.req.json();

		const config = {
			endpoint: (body.endpoint || '').trim().replace(/\/+$/, ''),
			region: (body.region || '').trim() || 'us-east-1',
			bucket: (body.bucket || '').trim(),
			accessKey: (body.accessKey || '').trim(),
			pathStyle: !!body.pathStyle,
		};

		// 如果 secretKey 是打码值，保留原有密钥
		if (body.secretKey && !body.secretKey.startsWith('••••')) {
			config.secretKey = body.secretKey.trim();
		} else {
			const existing = await ctx.env.data.get('storage:s3_config');
			if (existing) {
				config.secretKey = JSON.parse(existing).secretKey || '';
			}
		}

		if (!config.endpoint || !config.bucket || !config.accessKey) {
			return ctx.json({ success: false, error: '请填写 Endpoint、Bucket 和 Access Key' });
		}

		await ctx.env.data.put('storage:s3_config', JSON.stringify(config));
		return ctx.json({ success: true });
	} catch (e) {
		return ctx.json({ success: false, error: '服务器错误: ' + e.message });
	}
});

// 测试 S3 连接
app.post('/setting/api/storage/test', async (ctx) => {
	try {
		const session = await verifySession(ctx);
		if (!session) return ctx.json({ success: false, error: '未登录' });

		const body = await ctx.req.json();
		let config;
		if (body.useSaved === true) {
			const raw = await ctx.env.data.get('storage:s3_config');
			if (!raw) return ctx.json({ success: false, error: '未找到已保存的配置' });
			config = JSON.parse(raw);
		} else {
			config = {
				endpoint: (body.endpoint || '').trim().replace(/\/+$/, ''),
				region: (body.region || '').trim() || 'us-east-1',
				bucket: (body.bucket || '').trim(),
				accessKey: (body.accessKey || '').trim(),
				secretKey: body.secretKey && !body.secretKey.startsWith('••••') ? body.secretKey.trim() : '',
				pathStyle: !!body.pathStyle,
			};
			// 如果密钥是打码值，尝试用已保存的
			if (!config.secretKey) {
				const raw = await ctx.env.data.get('storage:s3_config');
				if (raw) config.secretKey = JSON.parse(raw).secretKey || '';
			}
		}

		if (!config.endpoint || !config.bucket || !config.accessKey || !config.secretKey) {
			return ctx.json({ success: false, error: '配置不完整，请填写所有字段' });
		}

		// 构造 S3 HEAD Bucket 请求 URL
		const endpointUrl = new URL(config.endpoint);
		const host = config.pathStyle
			? `${endpointUrl.host}`
			: `${config.bucket}.${endpointUrl.host}`;
		const path = config.pathStyle ? `/${config.bucket}` : '/';
		const fullUrl = `${endpointUrl.protocol}//${host}${path}`;

		const { authorization, amzDate } = await awsSigV4Sign(
			'HEAD', host, path, config.region, config.accessKey, config.secretKey, 's3'
		);

		const res = await fetch(fullUrl, {
			method: 'HEAD',
			headers: {
				'Authorization': authorization,
				'x-amz-date': amzDate,
				'x-amz-content-sha256': await sha256Hex(''),
			},
		});

		if (res.status === 200 || res.status === 403) {
			// 200 = bucket exists and accessible, 403 = bucket exists but access denied (still means connection works)
			return ctx.json({ success: true, status: res.status, message: res.status === 200 ? '连接成功，Bucket 可访问' : '连接成功，但权限受限' });
		} else if (res.status === 404) {
			return ctx.json({ success: false, error: `Bucket 不存在 (HTTP ${res.status})` });
		} else {
			return ctx.json({ success: false, error: `S3 返回错误: HTTP ${res.status}` });
		}
	} catch (e) {
		return ctx.json({ success: false, error: '连接失败: ' + e.message });
	}
});

app.notFound((ctx) => {
	return ctx.html(notFoundHtml);
});
app.onError((err, c) => {
	let stack_str = err.stack;
	let stack_arr = stack_str.split('\n').join('<br>');
	let result = errorHtml.replace('{ERROR_MESSAGE}', `${err}`);
	result = result.replace('{ERROR_STACK}', `${stack_arr}`);
	return c.html(result, 500);
});
app.use('/*', cors());

export default app;
