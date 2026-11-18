import { createServer } from 'node:http';
import { Archive } from './archive.mjs';
import { retrieveDelivery } from './transport.mjs';
import { summarize } from './summary.mjs';
import { interpretAbif } from './abif.mjs';

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
        const collectionId = body.collectionId;
        const delivery = await retrieveDelivery(body.entry, allowedOrigin);
        const receipts = [];

        // 入口原文（交付索引或直接资料）先登记为真实收件。
        const entryReceipt = await archive.receive({
          collectionId, sourceKey: body.entry, revision: delivery.entry.revision,
          mediaType: delivery.entry.mediaType, bytes: delivery.entry.bytes,
          summary: summarize(delivery.entry.bytes, delivery.entry.mediaType)
        });
        receipts.push(entryReceipt);

        const payloads = delivery.roots.length > 0
          ? delivery.roots
          : [delivery.entry];

        for (const failure of delivery.failures) {
          await archive.applyInterpretation(collectionId, {
            records: [],
            issues: [{
              reason: failure.reason,
              location: `delivery-root:${failure.href}`,
              detail: '交付索引声明的入口未能领取，保留已领原文，不把缺件视为来源删除'
            }]
          });
        }

        for (const payload of payloads) {
          const receipt = delivery.roots.length > 0
            ? await archive.receive({
              collectionId, sourceKey: payload.url, revision: payload.revision,
              mediaType: payload.mediaType, bytes: payload.bytes,
              summary: summarize(payload.bytes, payload.mediaType)
            })
            : entryReceipt;
          if (!receipts.some(existing => existing.receiptId === receipt.receiptId)) receipts.push(receipt);

          // 仅对 ABIF 原文做目录解释；非 ABIF 保持原始收件，不假装已解释。
          if (payload.bytes.subarray(0, 4).toString('latin1') === 'ABIF') {
            try {
              const interpreted = interpretAbif(payload.bytes, { receiptId: receipt.receiptId });
              await archive.applyInterpretation(collectionId, interpreted);
            } catch (error) {
              if (error.status !== 422) throw error;
              await archive.applyInterpretation(collectionId, {
                records: [],
                issues: [{ reason: error.message, location: 'abif:header@0..33' }]
              });
            }
          }
        }
        return json(response, 201, {
          collectionId,
          receiptIds: receipts.map(receipt => receipt.receiptId)
        });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      json(response, error.status || 500, { error: error.status ? error.message : 'internal_error' });
    }
  });
  return { server, archive };
}
