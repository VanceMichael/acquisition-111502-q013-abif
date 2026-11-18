import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.mjs';
import { createService } from '../src/service.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };

const traceAb1 = new URL('../fixtures/trace.ab1', import.meta.url);

test('人工收件保留原始字节且同版本重收幂等', async () => {
  const context = await harness();
  try {
    const payload = { collectionId: 'manual', sourceKey: 'manual-1', revision: 'r1', mediaType: 'text/plain', contentBase64: Buffer.from('人工摘要').toString('base64') };
    const first = await context.call('/intakes', payload);
    assert.equal(first.status, 201);
    assert.deepEqual((await context.call('/intakes', payload)).value, first.value);
    const bytes = await fetch(context.base + '/receipts/' + first.value.receiptId + '/body').then(response => response.text());
    assert.equal(bytes, '人工摘要');
    assert.equal((await context.call('/intakes', { ...payload, contentBase64: Buffer.from('变更内容').toString('base64') })).status, 409);
  } finally { await context.close(); }
});

test('来源入口通过真实 HTTP 领取并留下字节摘要', async () => {
  const context = await harness();
  try {
    const result = await context.call('/acquisitions', { collectionId: 'raw', entry: context.source + descriptor.entry });
    assert.equal(result.status, 201);
    assert.ok(result.value.receiptIds.length > 0);
    const receipt = await context.call('/receipts/' + result.value.receiptIds[0]);
    assert.equal(receipt.value.sha256.length, 64);
    assert.ok(receipt.value.byteLength > 0);
    assert.ok(context.provider.requests.some(request => request.path === descriptor.entry));
  } finally { await context.close(); }
});

test('授权来源之外的地址不发送请求', async () => {
  const context = await harness();
  try {
    const result = await context.call('/acquisitions', { collectionId: 'scope', entry: 'http://outside.invalid/file' });
    assert.equal(result.status, 403);
    assert.equal(context.provider.requests.length, 0);
  } finally { await context.close(); }
});

test('人工结构化记录的出处跨重启仍可回查', async () => {
  const context = await harness();
  try {
    const receipt = await context.call('/intakes', { collectionId: 'notes', sourceKey: 'notes', revision: 'v1', contentBase64: 'eA==' });
    const record = { kind: 'manual-note', key: 'n1', value: { text: '人工确认' }, provenance: [{ receiptId: receipt.value.receiptId, location: 'byte:0' }] };
    assert.equal((await context.call('/collections/notes/records', record)).status, 201);
    await context.restart();
    assert.deepEqual((await context.call('/collections/notes')).value.records, [record]);
  } finally { await context.close(); }
});

test('拒绝将另一资料集的收件依据写到本资料集', async () => {
  const context = await harness();
  try {
    const receipt = await context.call('/intakes', { collectionId: 'left', sourceKey: 'left', revision: 'v1', contentBase64: 'eA==' });
    const record = { kind: 'manual-note', key: 'n1', value: { text: '不应跨接' }, provenance: [{ receiptId: receipt.value.receiptId, location: 'byte:0' }] };
    assert.equal((await context.call('/collections/right/records', record)).status, 400);
  } finally { await context.close(); }
});

test('本地来源的字节范围与完整文件一致', async () => {
  const context = await harness();
  try {
    const url = context.source + descriptor.primary;
    const complete = Buffer.from(await fetch(url).then(response => response.arrayBuffer()));
    const response = await fetch(url, { headers: { range: 'bytes=0-7' } });
    assert.equal(response.status, 206);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, complete.subarray(0, 8));
    assert.ok(response.headers.get('content-range'));
  } finally { await context.close(); }
});

test('ABIF 解释按同次调用配对，出处能回到真实收件且重复领取幂等', async () => {
  const context = await harness();
  try {
    const acquired = await context.call('/acquisitions', { collectionId: 'abif', entry: context.source + descriptor.entry });
    assert.equal(acquired.status, 201);
    const collection = (await context.call('/collections/abif')).value;
    const calls = collection.records.filter(record => record.kind === 'base-call');
    const v1 = calls.find(record => record.value.version === 1);
    const v2 = calls.find(record => record.value.version === 2);
    // 第一次调用没有 PLOC，不能与第二次调用的任何组件配对
    assert.equal(v1.value.peakLocations, undefined);
    assert.equal(v1.value.pairing.complete, false);
    assert.deepEqual(v2.value.qualities, [11, 21, 31, 41, 51]);
    assert.equal(v2.value.pairing.complete, true);
    // 染料只按 FWO_ 声明解释
    const channel9 = collection.records.find(record => record.kind === 'trace-channel' && record.value.directoryNumber === 9);
    assert.equal(channel9.value.dye, 'G');
    assert.equal(channel9.value.dyeBasis, 'FWO_#1');
    // 每条出处都绑定真实收件，location 指向该收件字节内的位置
    for (const record of collection.records) {
      for (const origin of record.provenance) {
        const receipt = await context.call('/receipts/' + origin.receiptId);
        assert.equal(receipt.status, 200);
        assert.equal(receipt.value.collectionId, 'abif');
        const body = Buffer.from(await (await fetch(context.base + '/receipts/' + origin.receiptId + '/body')).arrayBuffer());
        const match = origin.location.match(/:bytes@(\d+)\.\.(\d+)$/);
        if (match) assert.equal(Number(match[2]) + 1 <= body.length, true);
      }
    }
    // 重复领取不产生重复记录或问题
    const again = await context.call('/acquisitions', { collectionId: 'abif', entry: context.source + descriptor.entry });
    assert.equal(again.status, 201);
    const reloaded = (await context.call('/collections/abif')).value;
    assert.equal(reloaded.records.length, collection.records.length);
    assert.deepEqual(reloaded.records, collection.records);
    assert.deepEqual(reloaded.issues, []);
  } finally { await context.close(); }
});

test('交付索引声明的 root 缺件时保留已领原文并登记问题', async () => {
  // 独立的最小来源：交付索引指向一个 404 root 和一个可领 ABIF root。
  const directory = await mkdtemp(join(tmpdir(), 'missing-root-'));
  const abifBytes = await readFile(traceAb1);
  const server = createServer(async (request, response) => {
    if (request.url === '/deliveries') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ deliveryId: 'd', revision: 'r', roots: [{ href: '/missing.ab1' }, { href: '/trace.ab1' }] }));
    } else if (request.url === '/trace.ab1') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(await abifBytes);
    } else {
      response.writeHead(404); response.end('not_found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${server.address().port}`;
  const service = await createService({ directory, allowedOrigin: source });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const response = await fetch(base + '/acquisitions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectionId: 'gaps', entry: source + '/deliveries' })
    });
    assert.equal(response.status, 201);
    const collection = await (await fetch(base + '/collections/gaps')).json();
    assert.ok(collection.receiptIds.length >= 2, '已领原文必须保留');
    assert.ok(collection.issues.some(issue => issue.reason.startsWith('source_response_') && issue.location.includes('/missing.ab1')));
    assert.ok(collection.records.some(record => record.kind === 'base-call'));
  } finally {
    service.server.closeAllConnections(); server.closeAllConnections();
    await Promise.all([new Promise(resolve => service.server.close(resolve)), new Promise(resolve => server.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});
