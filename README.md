# RSSWorker

RSSWorker 是一个轻量级的 RSS 订阅工具，可以部署在 Cloudflare Worker 上。

## 支持

注：以下路由均在 `[域名]/rss/` 下，如 `https://example.com/rss/bilibili/user/dynamic/1`。

- bilibili 动态 (/bilibili/user/dynamic/:uid)
- bilibili 视频 (/bilibili/user/video/:uid)
- 抖音视频 (/douyin/user/:uid)
- telegram 频道 (/telegram/channel/:username)
- weibo 用户 (/weibo/user/:uid)
- 小红书用户 (/xiaohongshu/user/:uid)

### 控制面板

访问根路径 `/` 即可打开控制面板，支持：
- 可视化生成各平台 RSS 订阅链接
- 一键复制订阅地址
- 在线预览 RSS 输出
- 暗色/亮色主题切换
- API 接口 `/api/feeds` 获取所有订阅源信息

### 抖音订阅

> 抖音用户ID为 `sec_user_id`，以 `MS4wLjABAAAA` 开头。
> 获取方法：
> 1. 打开抖音网页版 (douyin.com)
> 2. 进入目标用户的主页
> 3. 从URL中获取 sec_user_id，如 `https://www.douyin.com/user/MS4wLjABAAAA...`
> 4. 可能需要配置 Cookie：`wrangler secret put DOUYIN_COOKIE`

### 小红书订阅

> 小红书更新后不能再使用小红书号，需要使用小红书用户ID。  
> 获取方法：  
> 移动端：用户页面 > 右上角三个点 > 复制链接 > 获取链接中的用户ID  
> 网页端：用户页面 > 链接中的用户ID  
> 格式：https://www.xiaohongshu.com/user/profile/5d2aec020000000012037401

### 微博订阅

> 微博更新后需要加上Cookie
> 获取方法（参考 https://docs.rsshub.app/zh/deploy/config#%E5%BE%AE%E5%8D%9A ） ：
> 1. 打开并登录微博
> 2. 从个人微博主页的网址中获取uid，在`https://m.weibo.cn/api/container/getIndex?type=uid&value=`后追加uid，访问该链接
> 2. 按下F12打开控制台，切换至Network（网络）面板
> 3. 在该网页切换至任意关注分组，并在面板打开最先捕获到的请求 （该情形下捕获到的请求路径应包含/feed/group）
> 4. 查看该请求的Headers（请求头）, 找到Cookie字段并复制内容
> 5. 命令行中输入`wrangler secret put WEIBO_COOKIE`，按下回车后再将第4步中复制的Cookie字段粘贴，后按下回车

## 部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/827802685/RSSWorker)

### 自动构建

项目已配置 GitHub Actions，推送到 `main` 分支时会自动部署到 Cloudflare Workers。

需要在 GitHub 仓库 Settings > Secrets 中配置以下变量：
- `CF_API_TOKEN` - Cloudflare API Token（需要 Workers 部署权限）
- `CF_ACCOUNT_ID` - Cloudflare Account ID

## 开发

在 `src/lib/[网站名称]/[功能]` 参照已有的 demo 添加脚本，然后在 `src/route.js` 中添加插件即可。

注意事项：
1. Cloudflare Worker 有最大打包体积限制（免费用户 1 MB，付费用户 10 MB），所以插件需要尽量轻量化。如使用 fetch 进行请求、使用 Cloudflare Worker 提供的 HTMLRewriter 进行 HTML 解析等。

模板引擎使用的格式为：

```js
let items = [
	{
		title: 'Bilibili User Dynamic',
		link: `https://space.bilibili.com/${uid}/dynamic`,
		description: 'Bilibili User Dynamic233',
		pubDate: new Date().toUTCString(),
		guid: `https://space.bilibili.com/${uid}/dynamic`,
		author: 'bilibili@bilibili.com',
		category: 'video',
		comments: `https://space.bilibili.com/${uid}/dynamic`,
		enclosure: {
			url: 'https://www.bilibili.com/favicon.ico',
			type: 'image/x-icon',
			length: 0,
		},
		source: {
			title: 'Bilibili',
			url: 'https://www.bilibili.com',
		},
	},
];
let data = {
    title: `bilibili 动态`,
    link: `https://space.bilibili.com/${uid}/dynamic`,
    description: `${globalUsername} 的 bilibili 动态`,
    language: 'zh-cn',
    category: 'bilibili',
    items: items,
};
```

## 致谢

- [RSSHub](https://github.com/DIYgod/RSSHub) 灵感和部分代码来源

- [NodeSupport](https://github.com/NodeSeekDev/NodeSupport)赞助了本项目

[![image](https://img.imgdd.com/a3ae28fb-ec40-451b-9470-b14aa6dc034a.png)](https://yxvm.com/)
