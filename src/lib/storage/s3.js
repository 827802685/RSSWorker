// 外部 S3 兼容对象存储客户端（AWS SigV4 签名）
// 支持阿里云 OSS、腾讯云 COS、MinIO 等 path-style 访问

const enc = new TextEncoder();

async function sha256(data) {
	const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
	const k = typeof key === 'string' ? enc.encode(key) : key;
	return crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
		.then(k => crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}

async function hmacHex(key, data) {
	const buf = await hmac(key, data);
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 解析 endpoint，返回 { host, scheme }
function parseEndpoint(endpoint) {
	let url;
	if (/^https?:\/\//i.test(endpoint)) {
		url = new URL(endpoint);
	} else {
		url = new URL('https://' + endpoint);
	}
	return { host: url.host, scheme: url.protocol.replace(':', '') };
}

// 上传对象（PUT），path-style
// opts: { bucket, key, body(Uint8Array|string|ArrayBuffer), contentType, accessKey, secretKey, region }
async function putObject(opts) {
	const ep = parseEndpoint(opts.endpoint);
	const region = opts.region || 'auto';
	const service = 's3';
	const now = new Date();
	const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	const dateStamp = amzDate.slice(0, 8);

	const body = typeof opts.body === 'string' ? enc.encode(opts.body) : opts.body;
	const payloadHash = await sha256(body);

	const path = '/' + opts.bucket + '/' + opts.key; // path-style
	const contentType = opts.contentType || 'application/octet-stream';

	const headers = {
		host: ep.host,
		'x-amz-date': amzDate,
		'x-amz-content-sha256': payloadHash,
		'content-type': contentType,
	};

	const canonicalHeaders = Object.keys(headers).sort()
		.map(k => k + ':' + String(headers[k]).trim() + '\n').join('');
	const signedHeaders = Object.keys(headers).sort().join(';');

	const canonicalRequest = [
		'PUT',
		path,
		'',
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n');

	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		scope,
		await sha256(canonicalRequest),
	].join('\n');

	let signingKey = await hmac('AWS4' + opts.secretKey, dateStamp);
	signingKey = await hmac(signingKey, region);
	signingKey = await hmac(signingKey, service);
	signingKey = await hmac(signingKey, 'aws4_request');

	const signature = await hmacHex(signingKey, stringToSign);
	const authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const url = `${ep.scheme}://${ep.host}${path}`;
	const res = await fetch(url, {
		method: 'PUT',
		headers: {
			'Content-Type': contentType,
			'X-Amz-Date': amzDate,
			'X-Amz-Content-Sha256': payloadHash,
			'Authorization': authorization,
		},
		body,
	});
	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`S3 上传失败: HTTP ${res.status} ${t.slice(0, 200)}`);
	}
	return res;
}

export { putObject };