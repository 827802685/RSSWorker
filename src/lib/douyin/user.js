import { renderRss2 } from '../../utils/util';

/**
 * 递归搜索对象中的 aweme_list（视频列表）
 */
let findAwemeList = (obj, depth = 0) => {
	if (!obj || typeof obj !== 'object' || depth > 10) return null;
	if (obj.aweme_list && Array.isArray(obj.aweme_list) && obj.aweme_list.length > 0) {
		return obj.aweme_list;
	}
	for (let key in obj) {
		if (typeof obj[key] === 'object' && obj[key] !== null) {
			const result = findAwemeList(obj[key], depth + 1);
			if (result) return result;
		}
	}
	return null;
};

/**
 * 递归搜索对象中的用户信息
 */
let findUserInfo = (obj, depth = 0) => {
	if (!obj || typeof obj !== 'object' || depth > 10) return null;
	if (obj.user && (obj.user.nickname || obj.user.sec_uid)) return obj.user;
	if (obj.userInfo && (obj.userInfo.nickname || obj.userInfo.sec_uid)) return obj.userInfo;
	if (obj.author && (obj.author.nickname || obj.author.sec_uid)) return obj.author;
	for (let key in obj) {
		if (typeof obj[key] === 'object' && obj[key] !== null) {
			const result = findUserInfo(obj[key], depth + 1);
			if (result) return result;
		}
	}
	return null;
};

/**
 * 从视频数据中提取封面图 URL
 */
let getCoverUrl = (post) => {
	return (
		post.video?.cover?.url_list?.pop() ||
		post.video?.origin_cover?.url_list?.pop() ||
		post.video?.dynamic_cover?.url_list?.pop() ||
		post.aweme_info?.video?.cover?.url_list?.pop() ||
		''
	);
};

/**
 * 从视频数据中提取无水印视频 URL
 */
let getVideoUrl = (post) => {
	return post.video?.play_addr?.url_list?.pop() || post.video?.download_addr?.url_list?.pop() || '';
};

let deal = async (ctx) => {
	const { uid } = ctx.req.param();

	// sec_uid 通常以 MS4wLjABAAAA 开头
	if (!uid || !uid.startsWith('MS4wLjABAAAA')) {
		throw new Error('无效的抖音用户ID。sec_uid 应以 MS4wLjABAAAA 开头。请在抖音用户主页 URL 中获取。');
	}

	const pageUrl = `https://www.douyin.com/user/${uid}`;

	const res = await fetch(pageUrl, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
			Referer: 'https://www.douyin.com/',
			Cookie: ctx.env.DOUYIN_COOKIE || '',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		},
	});

	if (!res.ok) {
		throw new Error(`请求抖音页面失败: HTTP ${res.status}`);
	}

	const html = await res.text();

	// 方式1: 提取 RENDER_DATA
	let renderDataMatch = html.match(/<script\s+id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/);

	// 方式2: 提取 _ROUTER_DATA (备选)
	if (!renderDataMatch) {
		renderDataMatch = html.match(/<script\s+id="_ROUTER_DATA"[^>]*>([\s\S]*?)<\/script>/);
	}

	// 方式3: 从 window.__INITIAL_STATE__ 中提取
	let initialStateMatch = null;
	if (!renderDataMatch) {
		initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
	}

	let pageData = null;

	if (renderDataMatch) {
		try {
			pageData = JSON.parse(decodeURIComponent(renderDataMatch[1]));
		} catch (e) {
			try {
				pageData = JSON.parse(renderDataMatch[1]);
			} catch (e2) {
				throw new Error('解析抖音页面数据失败');
			}
		}
	} else if (initialStateMatch) {
		try {
			let stateStr = initialStateMatch[1].replace(/undefined/g, 'null');
			pageData = JSON.parse(stateStr);
		} catch (e) {
			throw new Error('解析抖音初始状态数据失败');
		}
	}

	if (!pageData) {
		throw new Error('无法获取抖音数据。可能需要配置 DOUYYIN_COOKIE 环境变量，或用户ID不正确。');
	}

	// 递归搜索视频列表和用户信息
	const awemeList = findAwemeList(pageData) || [];
	const userInfo = findUserInfo(pageData) || {};

	if (awemeList.length === 0) {
		throw new Error('未找到抖音视频数据。该用户可能没有发布视频，或需要配置 DOUYIN_COOKIE。');
	}

	const userNickName = userInfo.nickname || uid;
	const userAvatar = userInfo.avatar_thumb?.url_list?.pop() || userInfo.avatar_url || '';

	const items = awemeList
		.filter((post) => post && (post.aweme_id || post.desc))
		.map((post) => {
			const awemeId = post.aweme_id || '';
			const desc = post.desc || '无标题';
			const coverUrl = getCoverUrl(post);
			const videoUrl = getVideoUrl(post);
			const createTime = post.create_time;
			const pubDate = createTime ? new Date(createTime * 1000).toUTCString() : '';

			// 构建描述 HTML
			let descriptionHtml = '';
			if (coverUrl) {
				descriptionHtml += `<img src="${coverUrl}" alt="${desc}" /><br>`;
			}
			descriptionHtml += `<p>${desc.replace(/\n/g, '<br>')}</p>`;
			if (videoUrl) {
				descriptionHtml += `<br><a href="${videoUrl}">下载视频</a>`;
			}

			return {
				title: desc.split('\n')[0] || '无标题',
				link: `https://www.douyin.com/video/${awemeId}`,
				description: descriptionHtml,
				pubDate: pubDate,
				guid: awemeId,
				author: userNickName,
				enclosure: coverUrl
					? {
							url: coverUrl,
							type: 'image/jpeg',
							length: 0,
						}
					: undefined,
			};
		});

	const data = {
		title: `${userNickName} 的抖音视频`,
		link: pageUrl,
		description: `${userNickName} 的抖音视频`,
		language: 'zh-cn',
		image: userAvatar,
		items: items,
	};

	ctx.header('Content-Type', 'application/xml');
	return ctx.body(renderRss2(data));
};

let setup = (route) => {
	route.get('/douyin/user/:uid', deal);
};

export default { setup };
