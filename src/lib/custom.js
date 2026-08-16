import { renderRss2 } from '../utils/util';
import { detectAndParse, stripTags } from './rssparse';

// 自定义网址订阅源处理：
// 输入任意网页 URL，自动探测是 RSS/Atom 还是普通 HTML，并生成统一 RSS2 输出
async function deal(ctx) {
	const { id } = ctx.req.param();

	// 1. 从 KV 订阅列表查找该 id，获取真实目标 URL
	const raw = await ctx.env.data.get('subscriptions');
	const subs = raw ? JSON.parse(raw) : [];
	const sub = subs.find(s => s.id === id);

	let target = null;
	if (sub && sub.sourceUrl) {
		target = sub.sourceUrl;
	} else if (sub && sub.param && /^https?:\/\//i.test(sub.param)) {
		target = sub.param;
	}

	if (!target) {
		// 允许通过查询参数临时传入
		const qUrl = new URL(ctx.req.url).searchParams.get('url');
		if (qUrl && /^https?:\/\//i.test(qUrl)) target = qUrl;
	}
	if (!target) {
		throw new Error('订阅源 URL 未配置');
	}

	// 2. 抓取页面
	const res = await fetch(target, {
		headers: {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
			Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		},
		redirect: 'follow',
	});
	if (!res.ok) throw new Error(`抓取失败: HTTP ${res.status}`);
	const html = await res.text();

	// 3. 自动识别与解析
	const parsed = await detectAndParse(target, html);

	const data = {
		title: parsed.title || '自定义订阅',
		link: parsed.link || target,
		description: parsed.description || '由 RSSWorker 自动生成的自定义订阅源',
		language: 'zh-cn',
		items: (parsed.items || []).slice(0, 50).map(it => ({
			title: stripTags(it.title) || '(无标题)',
			link: it.link || target,
			description: it.description || it.title || '',
			pubDate: it.pubDate || new Date().toUTCString(),
			author: it.author || '',
		})),
	};

	ctx.header('Content-Type', 'application/xml');
	return ctx.body(renderRss2(data));
}

let setup = (route) => {
	route.get('/custom/:id', deal);
};

export default { setup };