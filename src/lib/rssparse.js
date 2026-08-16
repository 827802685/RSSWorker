// RSS/Atom 解析器 + 普通 HTML 网页文章抽取
// 无需第三方依赖，使用正则与 HTMLRewriter，兼容 Cloudflare Workers

function decodeEntities(s) {
	if (!s) return '';
	return s
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (m, d) => String.fromCodePoint(parseInt(d, 16)));
}

function stripTags(s) {
	return s ? String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

function grab(html, openTag, closeTag) {
	let m = html.match(new RegExp(openTag + '([\\s\\S]*?)' + closeTag, 'i'));
	return m ? m[1] : '';
}

function attr(html, name) {
	let m = html.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
	if (!m) return '';
	return (m[2] || m[3] || m[4] || '').trim();
}

// 统一规范化链接
function toAbsolute(base, href) {
	if (!href) return '';
	if (/^https?:\/\//i.test(href)) return href;
	try {
		return new URL(href, base).href;
	} catch (e) {
		return href;
	}
}

// 解析 Atom feed
function parseAtom(xml, base) {
	const feedTitle = stripTags(grab(xml, '<feed[^>]*>([\\s\\S]*?)<title', '<')) || 'RSS Feed';
	// 更可靠的标题：取 feed 内第一个 title
	let titleM = xml.match(/<feed[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
	let title = titleM ? stripTags(titleM[1]) : feedTitle;

	const feedLink = (() => {
		let m = xml.match(/<feed[^>]*>[\s\S]*?<link[^>]*\/?>/i);
		while (m) {
			const link = m[0];
			if (/rel\s*=\s*"self"/i.test(link)) {
				let h = attr(link, 'href');
				if (h) return h;
			}
			m = xml.slice(m.index + m[0].length).match(/<link[^>]*\/?>/i);
		}
		return base;
	})();

	const desc = stripTags(grab(xml, '<feed[^>]*>([\\s\\S]*?)<subtitle', '<'));

	// 提取条目
	const entries = [];
	const entryRe = /<entry[\s\S]*?<\/entry>/gi;
	let me;
	while ((me = entryRe.exec(xml)) !== null) {
		const en = me[0];
		const eTitle = stripTags(grab(en, '<title[^>]*>', '<\\/title>'));
		// link 优先 href 属性，否则内联文本
		let eLink = '';
		const linkRe = /<link[^>]*\/?>/gi;
		let lm;
		while ((lm = linkRe.exec(en)) !== null) {
			const l = lm[0];
			if (/rel\s*=\s*"alternate"/i.test(l) || /rel\s*=\s*"self"/i.test(l) === false) {
				const h = attr(l, 'href');
				if (h) { eLink = h; }
			}
			if (!eLink) eLink = attr(l, 'href');
			if (eLink) break;
		}
		if (!eLink) eLink = stripTags(grab(en, '<link[^>]*>', '<\\/link>'));
		eLink = toAbsolute(base, eLink);

		const eId = stripTags(grab(en, '<id[^>]*>', '<\\/id>')) || eLink;
		const eUpdated = stripTags(grab(en, '<updated[^>]*>', '<\\/updated>')) || stripTags(grab(en, '<published[^>]*>', '<\\/published>'));
		let eDesc = grab(en, '<summary[^>]*>', '<\\/summary>') || grab(en, '<content[^>]*>', '<\\/content>') || '';
		if (eDesc && !/<[^>]+>/.test(eDesc)) eDesc = decodeEntities(eDesc).replace(/\n/g, '<br>');
		const eAuthor = stripTags(grab(en, '<author[^>]*>([\\s\\S]*?)<name>([\\s\\S]*?)<\\/name>', '<')) ||
			stripTags(grab(en, '<author[^>]*>([\\s\\S]*?)<uri>([\\s\\S]*?)<\\/uri>', '<'));

		entries.push({
			title: eTitle || '(无标题)',
			link: eLink,
			id: eId,
			guid: eId,
			description: eDesc,
			pubDate: eUpdated,
			author: eAuthor,
		});
	}
	return { title, link: toAbsolute(base, feedLink), description: desc, items: entries };
}

// 解析 RSS 2.0 / RDF
function parseRss(xml, base) {
	let title = stripTags(grab(xml, '<channel>([\\s\\S]*?)<title', '<')) || 'RSS Feed';
	let titleM = xml.match(/<channel>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
	if (titleM) title = stripTags(titleM[1]);
	const desc = stripTags(grab(xml, '<channel>([\\s\\S]*?)<description', '<'));
	const channelLink = stripTags(grab(xml, '<channel>([\\s\\S]*?)<link[^>]*>([\\s\\S]*?)<\\/link>', '<')) || base;

	const items = [];
	const itemRe = /<item[\s\S]*?<\/item>/gi;
	let me;
	while ((me = itemRe.exec(xml)) !== null) {
		const it = me[0];
		const iTitle = stripTags(grab(it, '<title[^>]*>', '<\\/title>'));
		let iLink = stripTags(grab(it, '<link[^>]*>([\\s\\S]*?)<\\/link>', '<'));
		if (!iLink) iLink = attr(it, 'xml:link[^>]*') || attr(grab(it.replace(/\s+>/g, '>'), '<link[^>]*', ''), 'href');
		if (!iLink) {
			// 自闭合 link
			const linkSelf = it.match(/<link[^>]*\/>/i);
			if (linkSelf) iLink = attr(linkSelf[0], 'href');
		}
		iLink = toAbsolute(base, iLink);
		const iGuid = stripTags(grab(it, '<guid[^>]*>', '<\\/guid>')) ||
			stripTags(grab(it, '<id[^>]*>', '<\\/id>')) || iLink;
		const iPub = stripTags(grab(it, '<pubDate[^>]*>', '<\\/pubDate>')) ||
			stripTags(grab(it, '<dc:date[^>]*>', '<\\/dc:date>'));
		const iDesc = grab(it, '<description[^>]*>', '<\\/description>');
		const iAuthor = stripTags(grab(it, '<author[^>]*>', '<\\/author>')) ||
			stripTags(grab(it, '<dc:creator[^>]*>', '<\\/dc:creator>'));

		items.push({
			title: iTitle || '(无标题)',
			link: iLink,
			id: iGuid,
			guid: iGuid,
			description: iDesc,
			pubDate: iPub,
			author: iAuthor,
		});
	}
	return { title, link: toAbsolute(base, channelLink), description: desc, items };
}

// 自动识别并解析 feed / 普通网页
// 返回 { type: 'rss'|'atom'|'html', title, link, description, items }
async function detectAndParse(url, html) {
	const base = url;
	const lower = html.slice(0, 4000);
	if (/<atom\b|<feed\b/i.test(lower)) {
		return { type: 'atom', ...parseAtom(html, base) };
	}
	if (/<rss\b|<rdf:RDF|<rdf\b/i.test(lower)) {
		return { type: 'rss', ...parseRss(html, base) };
	}
	return await parseHtmlArticle(url, html);
}

// HTML 网页：抽取正文链接作为条目（找不到就尝试整页文本）
function parseHtmlArticle(url, html) {
	// 收集 <article> 或常规 a 链接
	const links = [];
	// 用正则收集候选标题链接
	const aRe = /<a[^>]+href\s*=\s*(["'])[^"']*\1[^>]*>[\s\S]*?<\/a>/gi;
	let m;
	const seen = new Set();
	while ((m = aRe.exec(html)) !== null && links.length < 60) {
		const raw = m[0];
		let href = attr(raw, 'href');
		const text = stripTags(raw);
		if (!href || !text || text.length < 4) continue;
		const isNav = /^(#|javascript:|mailto:|tel:)/i.test(href) || href[0] === '#';
		if (isNav) continue;
		if (/(^(css|js|ico|png|jpg|jpeg|svg|webp|gif)$)/i.test(href)) continue;
		href = toAbsolute(url, href);
		if (seen.has(href)) continue;
		// 过滤明显导航类短文本
		if (text.length > 80) {
			const longText = text.slice(0, 120);
			seen.add(href);
			links.push({ title: longText, link: href, guid: href, description: '', pubDate: '' });
		} else if (/\/\d{6,}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\/p\/|\/a\/|\/article\//i.test(href) && text.length >= 6) {
			seen.add(href);
			links.push({ title: text, link: href, guid: href, description: '', pubDate: '' });
		}
	}
	// 取页面前几条权威标题
	const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	let title = titleM ? stripTags(titleM[1]) : (url.split('/').pop() || '网页订阅');
	if (title.length > 80) title = title.slice(0, 80);

	if (links.length === 0) {
		// 退化为整页文本片段
		let body = stripTags(grab(html, '<body[^>]*>', '<\\/body>'));
		if (!body) body = stripTags(html);
		const items = [];
		const chunk = body.slice(0, 4000);
		const lines = chunk.split(/[。！？\n]{1}/).map(s => s.trim()).filter(s => s.length > 20);
		lines.slice(0, 20).forEach((line) => {
			const guid = url + '#t_' + Math.abs(hashCode(line));
			items.push({ title: line.slice(0, 80), link: url, guid, description: line, pubDate: '' });
		});
		return { type: 'html', title, link: url, description: '', items };
	}
	return { type: 'html', title, link: url, description: '', items: links };
}

function hashCode(s) {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}

export { decodeEntities, stripTags, detectAndParse, parseRss, parseAtom, toAbsolute };