import { createServer } from 'node:http';
import { Archive } from './archive.mjs';
import { retrieve } from './transport.mjs';
import { summarize } from './summary.mjs';
import { parseAbif, isAbif } from './abif.mjs';

export function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 24 * 1024 * 1024) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

async function acquireInto(archive, { collectionId, entry, allowedOrigin, visited, depth, parentReceiptId }) {
  const receiptIds = [];
  if (visited.has(entry)) return receiptIds;
  visited.add(entry);

  let result;
  try {
    result = await retrieve(entry, allowedOrigin);
  } catch (error) {
    if (parentReceiptId) {
      await archive.addIssues(collectionId, [{
        reason: 'source_dependency_unavailable',
        location: 'entry:' + entry,
        receiptId: parentReceiptId,
        detail: error.status ? error.message : 'retrieval_failed'
      }]);
      return receiptIds;
    }
    throw error;
  }

  const receipt = await archive.receive({ collectionId, sourceKey: entry, revision: result.revision,
    mediaType: result.mediaType, bytes: result.bytes, summary: summarize(result.bytes, result.mediaType) });
  receiptIds.push(receipt.receiptId);

  if (isAbif(result.bytes)) {
    const interpreted = parseAbif(result.bytes, { receiptId: receipt.receiptId });
    for (const record of interpreted.records) await archive.addRecord(collectionId, record);
    await archive.addIssues(collectionId, interpreted.issues);
    return receiptIds;
  }

  let delivery = null;
  try {
    const value = JSON.parse(result.bytes.toString('utf8'));
    if (value && typeof value === 'object' && Array.isArray(value.roots)) delivery = value;
  } catch {}
  if (!delivery || depth <= 0) return receiptIds;

  for (const root of delivery.roots) {
    if (!root || typeof root.href !== 'string') {
      await archive.addIssues(collectionId, [{
        reason: 'invalid_root_reference',
        location: 'delivery:roots',
        receiptId: receipt.receiptId
      }]);
      continue;
    }
    let child;
    try { child = new URL(root.href, entry).href; } catch {
      await archive.addIssues(collectionId, [{
        reason: 'invalid_root_reference', location: 'entry:' + root.href, receiptId: receipt.receiptId
      }]);
      continue;
    }
    receiptIds.push(...await acquireInto(archive, {
      collectionId, entry: child, allowedOrigin, visited, depth: depth - 1, parentReceiptId: receipt.receiptId
    }));
  }
  return receiptIds;
}

export async function createService({ directory, allowedOrigin }) {
  const archive = new Archive(directory);
  await archive.initialize();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/collections') return json(response, 200, await archive.list());
      const collection = url.pathname.match(/^\/collections\/([a-zA-Z0-9_.-]+)$/);
      if (collection && request.method === 'GET') return json(response, 200, await archive.collection(collection[1]));
      const records = url.pathname.match(/^\/collections\/([a-zA-Z0-9_.-]+)\/records$/);
      if (records && request.method === 'POST') return json(response, 201, await archive.addRecord(records[1], await requestBody(request)));
      const blob = url.pathname.match(/^\/receipts\/([a-f0-9]{64})\/body$/);
      if (blob && request.method === 'GET') {
        const receipt = await archive.receipt(blob[1]);
        response.writeHead(200, { 'content-type': receipt.mediaType });
        return response.end(await archive.body(blob[1]));
      }
      const receipt = url.pathname.match(/^\/receipts\/([a-f0-9]{64})$/);
      if (receipt && request.method === 'GET') return json(response, 200, await archive.receipt(receipt[1]));
      if (request.method === 'POST' && url.pathname === '/intakes') {
        const body = await requestBody(request);
        if (typeof body.contentBase64 !== 'string') throw Object.assign(new Error('missing_content'), { status: 400 });
        const bytes = Buffer.from(body.contentBase64, 'base64');
        const result = await archive.receive({ ...body, bytes, summary: summarize(bytes, body.mediaType || 'application/octet-stream') });
        return json(response, 201, result);
      }
      if (request.method === 'POST' && url.pathname === '/acquisitions') {
        const body = await requestBody(request);
        if (typeof body.entry !== 'string') throw Object.assign(new Error('missing_entry'), { status: 400 });
        const receiptIds = await acquireInto(archive, {
          collectionId: body.collectionId,
          entry: body.entry,
          allowedOrigin,
          visited: new Set(),
          depth: 1
        });
        return json(response, 201, { collectionId: body.collectionId, receiptIds });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      json(response, error.status || 500, { error: error.status ? error.message : 'internal_error' });
    }
  });
  return { server, archive };
}
