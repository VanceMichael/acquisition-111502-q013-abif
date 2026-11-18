// 来源领取：只访问启动时冻结的授权 origin，不跟随跳转、不执行交付件。
// 入口若是交付索引（JSON），按其 roots 领取同包独立入口；每个真实原文都保留独立收件。
export async function retrieve(entry, allowedOrigin, maximumBytes = 16 * 1024 * 1024) {
  const url = new URL(entry);
  if (url.origin !== allowedOrigin || url.username || url.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Object.assign(new Error('source_response_' + response.status), { status: 502 });
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) throw Object.assign(new Error('source_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return {
    url: url.href,
    bytes: Buffer.concat(chunks),
    mediaType: response.headers.get('content-type') || 'application/octet-stream',
    revision: response.headers.get('etag') || 'unversioned',
    headers: Object.fromEntries(response.headers)
  };
}

function isDeliveryIndex(value) {
  return value && typeof value === 'object' && typeof value.deliveryId === 'string' && Array.isArray(value.roots);
}

// 领取入口；若入口是交付索引，则解析 roots 并领取其中每个独立入口的原文。
// 单个 root 缺件不拖垮整次领取：失败的 root 进入 failures，由调用方登记问题，已领到的原文照常保留。
export async function retrieveDelivery(entry, allowedOrigin) {
  const initial = await retrieve(entry, allowedOrigin);
  const roots = [];
  const failures = [];
  let delivery = null;
  if (initial.mediaType.includes('application/json')) {
    try {
      const parsed = JSON.parse(initial.bytes.toString('utf8'));
      if (isDeliveryIndex(parsed)) delivery = parsed;
    } catch {
      delivery = null;
    }
  }
  if (delivery) {
    for (const root of delivery.roots) {
      if (!root || typeof root.href !== 'string') {
        throw Object.assign(new Error('invalid_delivery_root'), { status: 502 });
      }
      const rootUrl = new URL(root.href, initial.url);
      if (rootUrl.origin !== new URL(initial.url).origin) {
        throw Object.assign(new Error('source_not_allowed'), { status: 403 });
      }
      try {
        roots.push(await retrieve(rootUrl.href, allowedOrigin));
      } catch (error) {
        failures.push({ href: rootUrl.href, reason: error.status ? 'source_response_' + error.status : 'source_unreachable' });
      }
    }
  }
  return { entry: initial, delivery, roots, failures };
}
