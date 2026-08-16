import { Hono } from 'hono';
import telegram_channel from './lib/telegram/channel';
import weibo_user from './lib/weibo/user';
import xiaohongshu_user from './lib/xiaohongshu/user';
import douyin_user from './lib/douyin/user';
import custom_source from './lib/custom';

const route = new Hono();

// 轻量插件：静态导入（仅使用 fetch + HTMLRewriter）
let lightPlugins = [telegram_channel, weibo_user, xiaohongshu_user, douyin_user, custom_source];
for (let plugin of lightPlugins) {
	plugin.setup(route);
}

// bilibili 插件：懒加载（gRPC + protobuf 栈约 800KB，仅在访问 bilibili 路由时加载）
route.get('/bilibili/user/dynamic/:uid', async (ctx) => {
	const { default: mod } = await import('./lib/bilibili/user/dynamic');
	return mod.deal(ctx);
});
route.get('/bilibili/user/video/:uid', async (ctx) => {
	const { default: mod } = await import('./lib/bilibili/user/video');
	return mod.deal(ctx);
});

export default route;