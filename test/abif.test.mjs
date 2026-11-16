import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness } from './harness.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };
import { parseAbif } from '../src/abif.mjs';

const RECEIPT = 'a'.repeat(64);

function buildAbif(entries) {
  const headerSize = 34;
  const directorySize = entries.length * 28;
  let cursor = headerSize + directorySize;
  const layout = entries.map(entry => {
    const size = entry.data.length;
    if (size <= 4) return { ...entry, inline: true, dataOffset: 0, externalOffset: null };
    const externalOffset = cursor;
    cursor += size;
    return { ...entry, inline: false, dataOffset: externalOffset, externalOffset };
  });
  const bytes = Buffer.alloc(cursor);
  bytes.write('ABIF', 0, 'latin1');
  bytes.writeUInt16BE(101, 4);
  bytes.write('tdir', 6, 'latin1');
  bytes.writeUInt16BE(1023, 14);
  bytes.writeUInt16BE(28, 16);
  bytes.writeUInt32BE(entries.length, 18);
  bytes.writeUInt32BE(directorySize, 22);
  bytes.writeUInt32BE(headerSize, 26);
  layout.forEach((entry, index) => {
    const offset = headerSize + index * 28;
    bytes.write(entry.name, offset, 'latin1');
    bytes.writeUInt32BE(entry.number, offset + 4);
    bytes.writeUInt16BE(entry.type, offset + 8);
    bytes.writeUInt16BE(entry.elementSize, offset + 10);
    bytes.writeUInt32BE(entry.count, offset + 12);
    bytes.writeUInt32BE(entry.data.length, offset + 16);
    bytes.writeUInt32BE(entry.dataOffset, offset + 20);
    if (entry.inline) entry.data.copy(bytes, offset + 20);
    else entry.data.copy(bytes, entry.externalOffset);
  });
  return { bytes, layout, headerSize };
}

function stringEntry(name, number, text) {
  return { name, number, type: 2, elementSize: 1, count: text.length, data: Buffer.from(text, 'latin1') };
}

function intEntry(name, number, values) {
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16BE(value, index * 2));
  return { name, number, type: 4, elementSize: 2, count: values.length, data };
}

const baseCallEntry = (number, sequence, qualities) => [stringEntry('PBAS', number, sequence), intEntry('PCON', number, qualities)];

test('同次调用才配对，两版调用各自保存来源', async () => {
  const context = await harness();
  try {
    const result = await context.call('/acquisitions', { collectionId: 'calls', entry: context.source + descriptor.entry });
    assert.equal(result.status, 201);
    const collection = (await context.call('/collections/calls')).value;
    const calls = collection.records.filter(record => record.kind === 'base-call');
    assert.equal(calls.length, 2);

    const first = calls.find(call => call.value.version === 1);
    const second = calls.find(call => call.value.version === 2);
    assert.equal(first.value.sequence, 'ACGT');
    assert.deepEqual(first.value.qualities, [10, 20, 30, 40]);
    assert.equal(second.value.sequence, 'ACGTA');
    assert.deepEqual(second.value.qualities, [11, 21, 31, 41, 51]);
    assert.deepEqual(second.value.peakLocations, [1, 3, 5, 7, 9]);
    assert.equal(second.value.complete, true);
    assert.equal(first.value.complete, false);
    assert.deepEqual(first.value.pairing.missing, ['PLOC']);

    const bodies = new Map();
    const readOrigin = async origin => {
      if (!bodies.has(origin.receiptId)) {
        bodies.set(origin.receiptId, Buffer.from(await fetch(context.base + '/receipts/' + origin.receiptId + '/body').then(response => response.arrayBuffer())));
      }
      const match = origin.location.match(/^byte:(\d+)(?:-(\d+))?$/);
      assert.ok(match, origin.location);
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : start;
      return bodies.get(origin.receiptId).subarray(start, end + 1);
    };

    for (const call of calls) {
      const expectedVersion = call.value.version;
      for (const [field, tag] of [['sequence', 'PBAS'], ['qualities', 'PCON'], ['peakLocations', 'PLOC']]) {
        const source = call.value.sources[field];
        if (!source) continue;
        assert.equal(source.tag, tag);
        assert.equal(source.number, expectedVersion);
        const bytes = await readOrigin(source);
        assert.equal(bytes.toString('hex'), (await readOrigin(call.provenance.find(origin => origin.tag === tag))).toString('hex'));
      }
      for (const origin of call.provenance) {
        assert.equal(origin.number, expectedVersion);
        await readOrigin(origin);
      }
    }

    // The exact bytes behind version 2 must be the second call, never the first.
    assert.equal((await readOrigin(second.value.sources.sequence)).toString('latin1'), 'ACGTA');
    const qualityBytes = await readOrigin(second.value.sources.qualities);
    assert.deepEqual([11, 21, 31, 41, 51], [...qualityBytes]);
    assert.equal((await readOrigin(first.value.sources.sequence)).toString('latin1'), 'ACGT');
  } finally { await context.close(); }
});

test('短数据读自目录项本身而非文件偏移', () => {
  const built = buildAbif([...baseCallEntry(1, 'ACGT', [10, 20, 30, 40])]);
  // PBAS is four bytes and therefore inline; PCON is eight bytes and external.
  assert.equal(built.layout[0].inline, true);
  assert.equal(built.layout[1].inline, false);
  assert.equal(built.bytes.readUInt32BE(built.headerSize + 20), Buffer.from('ACGT').readUInt32BE(0));
  assert.ok(built.bytes.readUInt32BE(built.headerSize + 28 + 20) >= built.headerSize + 56);

  const parsed = parseAbif(built.bytes, { receiptId: RECEIPT });
  const call = parsed.records.find(record => record.kind === 'base-call');
  assert.equal(call.value.sequence, 'ACGT');
  assert.deepEqual(call.value.qualities, [10, 20, 30, 40]);
  assert.equal(call.value.sources.sequence.location, 'byte:' + (built.headerSize + 20) + '-' + (built.headerSize + 23));
  assert.equal(call.value.sources.qualities.location, 'byte:' + built.layout[1].externalOffset + '-' + (built.layout[1].externalOffset + 7));
  assert.equal(parsed.issues.filter(issue => issue.reason === 'call_length_conflict').length, 0);
});

test('长度冲突保留为冲突，不截到最短', () => {
  const built = buildAbif([
    ...baseCallEntry(1, 'ACGT', [10, 20, 30, 40]),
    intEntry('PLOC', 1, [1, 2, 3])
  ]);
  const parsed = parseAbif(built.bytes, { receiptId: RECEIPT });
  const call = parsed.records.find(record => record.kind === 'base-call');
  assert.equal(call.value.complete, false);
  assert.equal(call.value.pairing.conflict, true);
  assert.deepEqual(call.value.pairing.lengths, { PBAS: 4, PCON: 4, PLOC: 3 });
  assert.equal(call.value.sequence, 'ACGT');
  assert.deepEqual(call.value.qualities, [10, 20, 30, 40]);
  assert.deepEqual(call.value.peakLocations, [1, 2, 3]);
  const issue = parsed.issues.find(item => item.reason === 'call_length_conflict');
  assert.ok(issue);
  assert.equal(issue.callVersion, 1);
});

test('染料由 FWO_ 声明决定，不按数组顺序猜', () => {
  const sequence = 'ACGT';
  const channels = [9, 10, 11, 12].map(number => intEntry('DATA', number, Array.from({ length: 4 }, (_, index) => number * 100 + index)));
  const ordered = buildAbif([...baseCallEntry(1, sequence, [1, 2, 3, 4]), stringEntry('FWO_', 1, 'GATC'), ...channels]);
  const shuffled = buildAbif([...baseCallEntry(1, sequence, [1, 2, 3, 4]), stringEntry('FWO_', 1, 'CTAG'), ...channels]);

  const first = parseAbif(ordered.bytes, { receiptId: RECEIPT }).records.filter(record => record.kind === 'trace-channel');
  const second = parseAbif(shuffled.bytes, { receiptId: RECEIPT }).records.filter(record => record.kind === 'trace-channel');
  const dyeOf = list => Object.fromEntries(list.map(record => [record.value.directoryNumber, record.value.dye]));
  assert.deepEqual(dyeOf(first), { 9: 'G', 10: 'A', 11: 'T', 12: 'C' });
  assert.deepEqual(dyeOf(second), { 9: 'C', 10: 'T', 11: 'A', 12: 'G' });
  for (const record of first) {
    assert.equal(record.value.sources.samples.tag, 'DATA');
    assert.equal(record.value.sources.dye.tag, 'FWO_');
    assert.deepEqual(record.value.samples, [record.value.directoryNumber * 100, 1 + record.value.directoryNumber * 100, 2 + record.value.directoryNumber * 100, 3 + record.value.directoryNumber * 100]);
  }
});

test('没有 FWO_ 声明时不把 DATA 按顺序当作某染料', () => {
  const built = buildAbif([...baseCallEntry(1, 'ACGT', [1, 2, 3, 4]), intEntry('DATA', 1, [1, 2, 3, 4])]);
  const parsed = parseAbif(built.bytes, { receiptId: RECEIPT });
  assert.equal(parsed.records.some(record => record.kind === 'trace-channel'), false);
  const raw = parsed.records.find(record => record.kind === 'directory-entry' && record.value.tag === 'DATA');
  assert.equal(raw.value.status, 'unmapped-channel');
  assert.match(raw.provenance[0].location, /^byte:\d+/);
});

test('未知目录项保留可回查出处', () => {
  const built = buildAbif([
    ...baseCallEntry(1, 'ACGT', [1, 2, 3, 4]),
    stringEntry('SMPL', 1, 'sample-name'),
    { name: 'XXYZ', number: 3, type: 99, elementSize: 1, count: 2, data: Buffer.from([1, 2]) }
  ]);
  const parsed = parseAbif(built.bytes, { receiptId: RECEIPT });
  for (const tag of ['SMPL', 'XXYZ']) {
    const record = parsed.records.find(item => item.kind === 'directory-entry' && item.value.tag === tag);
    assert.ok(record, tag);
    assert.match(record.provenance[0].location, /^byte:\d+-\d+$/);
    assert.equal(record.provenance[0].receiptId, RECEIPT);
    assert.equal(record.value.tag, tag);
  }
  assert.ok(parsed.records.every(record => record.provenance.length > 0));
});

test('不完整来源报告对应目录项并保留原文收件', async () => {
  const context = await harness('partial');
  try {
    const result = await context.call('/acquisitions', { collectionId: 'partial-calls', entry: context.source + descriptor.entry });
    assert.ok(result.status < 500);
    const collection = (await context.call('/collections/partial-calls')).value;
    const receipt = await context.call('/receipts/' + result.value.receiptIds.at(-1));
    const bytes = Buffer.from(await fetch(context.base + '/receipts/' + receipt.value.receiptId + '/body').then(response => response.arrayBuffer()));
    assert.deepEqual(bytes, await readFile(new URL('../fixtures/trace.ab1.partial', import.meta.url)));
    const truncated = collection.issues.find(issue => issue.reason === 'truncated_external_data');
    assert.ok(truncated);
    assert.equal(truncated.tag, 'DATA');
    assert.equal(truncated.number, 11);
    assert.equal(truncated.receiptId, receipt.value.receiptId);
    assert.ok(truncated.location && truncated.entryLocation);
    assert.match(truncated.location, /^byte:\d+-\d+$/);
    const missing = collection.issues.find(issue => issue.reason === 'missing_external_data');
    assert.equal(missing.number, 12);
    assert.equal(collection.records.some(record => record.kind === 'trace-channel' && record.value.directoryNumber === 11), false);
    assert.equal(collection.records.some(record => record.kind === 'trace-channel' && record.value.directoryNumber === 12), false);
    assert.ok(collection.records.find(record => record.kind === 'base-call' && record.value.version === 2));
    const raw = collection.records.find(record => record.kind === 'directory-entry' && record.value.tag === 'DATA' && record.value.number === 11);
    assert.equal(raw.value.status, 'truncated');

    await context.restart();
    const again = (await context.call('/collections/partial-calls')).value;
    assert.deepEqual(again.records, collection.records);
    assert.deepEqual(again.issues, collection.issues);
  } finally { await context.close(); }
});

test('领取入口时按 roots 取得真实调用文件并各自留收件', async () => {
  const context = await harness();
  try {
    const result = await context.call('/acquisitions', { collectionId: 'roots', entry: context.source + descriptor.entry });
    assert.equal(result.status, 201);
    assert.equal(result.value.receiptIds.length, 2);
    const paths = context.provider.requests.map(request => request.path);
    assert.ok(paths.includes(descriptor.entry));
    assert.ok(paths.includes(descriptor.primary));
    const deliveries = await context.call('/collections/roots');
    for (const record of deliveries.value.records) {
      for (const origin of record.provenance) {
        const receipt = await context.call('/receipts/' + origin.receiptId);
        assert.equal(receipt.status, 200);
        assert.equal(receipt.value.collectionId, 'roots');
      }
    }
  } finally { await context.close(); }
});
