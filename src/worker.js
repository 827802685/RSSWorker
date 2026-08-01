import { Hono } from 'hono';
import { cors } from 'hono/cors';
import indexHtml from './html/index.html';
import notFoundHtml from './html/404.html';
import errorHtml from './html/err.html';
import robotsTxt from './robots.txt';

import route from './route';

const app = new Hono();

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

// API: 返回所有支持的 RSS 订阅源信息
app.get('/api/feeds', (ctx) => {
	const origin = new URL(ctx.req.url).origin;
	return ctx.json({
		origin,
		feeds: [
			{
				platform: 'bilibili',
				name: 'B站动态',
				icon: '📺',
				route: '/rss/bilibili/user/dynamic/:uid',
				paramName: 'uid',
				paramLabel: 'B站用户UID',
				paramPlaceholder: '如: 1',
				paramDescription: 'B站用户UID，可在用户主页URL中获取',
				example: '1',
				helpUrl: 'https://space.bilibili.com/1',
			},
			{
				platform: 'bilibili',
				name: 'B站视频',
				icon: '🎬',
				route: '/rss/bilibili/user/video/:uid',
				paramName: 'uid',
				paramLabel: 'B站用户UID',
				paramPlaceholder: '如: 1',
				paramDescription: 'B站用户UID，可在用户主页URL中获取',
				example: '1',
				helpUrl: 'https://space.bilibili.com/1',
			},
			{
				platform: 'douyin',
				name: '抖音视频',
				icon: '🎵',
				route: '/rss/douyin/user/:uid',
				paramName: 'uid',
				paramLabel: '抖音sec_user_id',
				paramPlaceholder: '如: MS4wLjABAAAA...',
				paramDescription: '抖音用户sec_uid，在用户主页URL中获取（以MS4wLjABAAAA开头）',
				example: 'MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao',
				helpUrl: 'https://www.douyin.com/user/MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao',
				envHint: '可能需要配置 DOUYIN_COOKIE 环境变量',
			},
			{
				platform: 'telegram',
				name: 'Telegram频道',
				icon: '✈️',
				route: '/rss/telegram/channel/:username',
				paramName: 'username',
				paramLabel: '频道用户名',
				paramPlaceholder: '如: durov',
				paramDescription: 'Telegram频道的用户名（不含@）',
				example: 'durov',
				helpUrl: 'https://t.me/s/durov',
			},
			{
				platform: 'weibo',
				name: '微博用户',
				icon: '📢',
				route: '/rss/weibo/user/:uid',
				paramName: 'uid',
				paramLabel: '微博用户UID',
				paramPlaceholder: '如: 1195242765',
				paramDescription: '微博用户UID，可在用户主页URL中获取',
				example: '1195242765',
				helpUrl: 'https://weibo.com/u/1195242765',
				envHint: '可能需要配置 WEIBO_COOKIE 环境变量',
			},
			{
				platform: 'xiaohongshu',
				name: '小红书用户',
				icon: '📕',
				route: '/rss/xiaohongshu/user/:uid',
				paramName: 'uid',
				paramLabel: '小红书用户ID',
				paramPlaceholder: '如: 5d2aec020000000012037401',
				paramDescription: '小红书用户ID，在用户主页URL中获取',
				example: '5d2aec020000000012037401',
				helpUrl: 'https://www.xiaohongshu.com/user/profile/5d2aec020000000012037401',
			},
		],
	});
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
