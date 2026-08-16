// 推送模块：Resend 邮件 + QQ 官方机器人
// 配置来源：控制面板保存的 KV（push:config）优先，env 兜底

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_URL = 'https://api.bot.qq.com';

async function readKV(env, key) {
	if (!env.data) return null;
	try { return await env.data.get(key); } catch (e) { return null; }
}

async function pushConfig(env) {
	const kvRaw = await readKV(env, 'push:config');
	let kv = {};
	if (kvRaw) { try { kv = JSON.parse(kvRaw); } catch (e) {} }
	return {
		resendApiKey: kv.resendApiKey || env.RESEND_API_KEY || '',
		resendFrom: kv.resendFrom || env.RESEND_FROM || 'RSSWorker <onboarding@resend.dev>',
		resendTo: kv.resendTo || env.RESEND_TO || '',
		qqAppId: kv.qqAppId || env.QQ_APP_ID || '',
		qqAppSecret: kv.qqAppSecret || env.QQ_APP_SECRET || '',
		qqTargetType: kv.qqTargetType || env.QQ_TARGET_TYPE || 'group',
		qqTargetId: kv.qqTargetId || env.QQ_TARGET_ID || '',
		enabled: kv.enabled,
	};
}

// 生成文本摘要
function buildText(sub, items) {
	const lines = [`【${sub.title}】 更新了 ${items.length} 条`];
	items.slice(0, 10).forEach((it, i) => {
		lines.push(`${i + 1}. ${it.title}${it.link ? '\n   ' + it.link : ''}`);
	});
	if (items.length > 10) lines.push(`... 另有 ${items.length - 10} 条`);
	return lines.join('\n');
}

function buildEmailHtml(sub, items) {
	const rows = items.slice(0, 30).map(it => {
		const link = it.link ? `<a href="${it.link}">${it.link}</a>` : '';
		return `<li><b>${it.title}</b>${it.author ? ' — ' + it.author : ''}<br/>${link}</li>`;
	}).join('');
	return `<h3>${sub.title}</h3><p>更新了 ${items.length} 条</p><ul>${rows}</ul>`;
}

// Resend 邮件
async function sendResend(env, sub, items) {
	const cfg = await pushConfig(env);
	if (!cfg.resendApiKey || !cfg.resendTo) {
		return { channel: 'resend', ok: false, error: 'Resend 未配置' };
	}
	const to = cfg.resendTo.split(/[,;，；\s]+/).filter(Boolean);
	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + cfg.resendApiKey,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: cfg.resendFrom,
			to: to,
			subject: `【RSSWorker】${sub.title} 更新 ${items.length} 条`,
			html: buildEmailHtml(sub, items),
		}),
	});
	const text = await res.text().catch(() => '');
	if (!res.ok) {
		return { channel: 'resend', ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
	}
	return { channel: 'resend', ok: true, data: text };
}

// QQ token
async function qqToken(env) {
	const cfg = await pushConfig(env);
	if (!cfg.qqAppId || !cfg.qqAppSecret) return null;
	const cached = await readKV(env, 'qq:token');
	if (cached) {
		try {
			const c = JSON.parse(cached);
			if (c.expires > Date.now()) return c.token;
		} catch (e) {}
	}
	const res = await fetch(QQ_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ appId: cfg.qqAppId, clientSecret: cfg.qqAppSecret }),
	});
	const data = await res.json().catch(() => ({}));
	if (!data.access_token) {
		let err = data.message || data.errMsg || '获取 access_token 失败';
		return { error: err };
	}
	const expires = Date.now() + (Number(data.expires_in || 7200) - 60) * 1000;
	await env.data.put('qq:token', JSON.stringify({ token: data.access_token, expires }), { expirationTtl: Number(data.expires_in || 7200) - 60 });
	return { token: data.access_token };
}

// QQ 发消息（group 或 channel）
async function sendQQ(env, sub, items) {
	const cfg = await pushConfig(env);
	if (!cfg.qqAppId || !cfg.qqAppSecret || !cfg.qqTargetId) {
		return { channel: 'qq', ok: false, error: 'QQ 未配置或缺少目标ID' };
	}
	const tokenObj = await qqToken(env);
	if (!tokenObj || tokenObj.error) {
		return { channel: 'qq', ok: false, error: tokenObj ? tokenObj.error : 'QQ token 获取失败' };
	}
	const content = buildText(sub, items);
	const endpoint = cfg.qqTargetType === 'channel'
		? `${QQ_API_URL}/v2/channels/${cfg.qqTargetId}/messages`
		: `${QQ_API_URL}/v2/groups/${cfg.qqTargetId}/messages`;
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Authorization': 'QQBot ' + tokenObj.token,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ content, msg_type: 0 }),
	});
	const text = await res.text().catch(() => '');
	if (!res.ok) {
		return { channel: 'qq', ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
	}
	return { channel: 'qq', ok: true, data: text };
}

// 统一推送入口：发送到所有已启用通道
async function push(env, sub, items) {
	const cfg = await pushConfig(env);
	if (cfg.enabled !== false && !cfg.enabled && !cfg.resendApiKey && !cfg.qqAppId) {
		return [{ channel: 'push', ok: false, error: '未配置任何推送通道' }];
	}
	const results = [];
	results.push(await sendResend(env, sub, items));
	results.push(await sendQQ(env, sub, items));
	return results;
}

export default { push, pushConfig, buildText };