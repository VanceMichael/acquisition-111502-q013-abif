import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectory, interpretAbif, ELEMENT_TYPES } from '../src/abif.mjs';

// 合成 ABIF v101 字节，仅用于测试解析规则，不代表真实测序数据。
function buildAbif(entries, { truncateAt = null } = {}) {
  const header = Buffer.alloc(34);
  header.write('ABIF', 0, 'latin1');
  header.writeUInt16BE(101, 4);
  const blobs = [];
  const directoryOffset = 34; // 签名 4 + 版本 2 + 根目录项 28
  let cursor = directoryOffset + entries.length * 28;
  const dirEntries = entries.map(spec => {
    const typeInfo = ELEMENT_TYPES[spec.type];
    const elementSize = spec.elementSize || typeInfo.size;
    const payload = spec.payload;
    const dataSize = payload.length;
    const entry = {
      name: spec.name, number: spec.number, type: spec.type, elementSize,
      numElements: spec.numElements ?? (dataSize / elementSize), dataSize, payload
    };
    if (dataSize <= 4) {
      entry.inline = true;
      entry.inlinePayload = payload;
    } else {
      entry.inline = false;
      entry.offset = cursor;
      blobs.push({ offset: cursor, payload });
      cursor += dataSize;
    }
    return entry;
  });
  const total = cursor;
  const bytes = Buffer.alloc(total);
  header.copy(bytes, 0);
  // 根目录项 tdir#1 位于 6..33
  bytes.write('tdir', 6, 'latin1');
  bytes.writeInt32BE(1, 10);
  bytes.writeInt16BE(1023, 14);
  bytes.writeInt16BE(28, 16);
  bytes.writeInt32BE(entries.length, 18);
  bytes.writeInt32BE(entries.length * 28, 22);
  bytes.writeInt32BE(directoryOffset, 26);
  dirEntries.forEach((entry, index) => {
    const o = directoryOffset + index * 28;
    bytes.write(entry.name, o, 'latin1');
    bytes.writeInt32BE(entry.number, o + 4);
    bytes.writeInt16BE(entry.type, o + 8);
    bytes.writeInt16BE(entry.elementSize, o + 10);
    bytes.writeInt32BE(entry.numElements, o + 12);
    bytes.writeInt32BE(entry.dataSize, o + 16);
    if (entry.inline) {
      entry.inlinePayload.copy(bytes, o + 20);
    } else {
      bytes.writeInt32BE(entry.offset, o + 20);
    }
  });
  for (const blob of blobs) blob.payload.copy(bytes, blob.offset);
  return truncateAt === null ? bytes : bytes.subarray(0, truncateAt);
}

const char = value => Buffer.from(value, 'latin1');
const byteValues = values => Buffer.from(values);
const shorts = values => {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16BE(value, index * 2));
  return buffer;
};

test('内联短数据直接取自目录项，不按文件偏移读取', () => {
  const abif = buildAbif([
    { name: 'PBAS', number: 1, type: 2, payload: char('ACGT') },
    { name: 'PCON', number: 1, type: 1, payload: byteValues([10, 20, 30, 40]) },
    { name: 'FWO_', number: 1, type: 2, payload: char('GATC') }
  ]);
  const parsed = parseDirectory(abif);
  const pbas = parsed.entries.find(entry => entry.name === 'PBAS');
  assert.equal(pbas.dataLocation, 'abif:PBAS#1:entry@34:dataOffset');
  assert.equal(pbas.payload.toString('latin1'), 'ACGT');
  const result = interpretAbif(abif, { receiptId: 'r1' });
  const call = result.records.find(record => record.kind === 'base-call');
  assert.deepEqual(call.value.sequence, 'ACGT');
  assert.deepEqual(call.value.qualities, [10, 20, 30, 40]);
  assert.ok(call.provenance.every(origin => origin.receiptId === 'r1'));
});

test('PBAS/PCON/PLOC 只有同编号才配为同次调用，版本互不串接', () => {
  const abif = buildAbif([
    { name: 'PBAS', number: 1, type: 2, payload: char('ACGT') },
    { name: 'PCON', number: 1, type: 1, payload: byteValues([10, 20, 30, 40]) },
    { name: 'PBAS', number: 2, type: 2, payload: char('ACGTA') },
    { name: 'PCON', number: 2, type: 1, payload: byteValues([11, 21, 31, 41, 51]) },
    { name: 'PLOC', number: 2, type: 4, payload: shorts([1, 3, 5, 7, 9]) }
  ]);
  const result = interpretAbif(abif, { receiptId: 'r1' });
  const calls = result.records.filter(record => record.kind === 'base-call').sort((a, b) => a.value.version - b.value.version);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].value.version, 1);
  assert.deepEqual(calls[0].value.qualities, [10, 20, 30, 40]);
  assert.equal(calls[0].value.peakLocations, undefined);
  assert.equal(calls[0].value.pairing.complete, false);
  assert.equal(calls[1].value.version, 2);
  assert.deepEqual(calls[1].value.peakLocations, [1, 3, 5, 7, 9]);
  assert.equal(calls[1].value.pairing.complete, true);
  // 每次调用的出处只含同编号目录项
  const v1Locations = calls[0].provenance.map(origin => origin.location);
  assert.ok(v1Locations.some(location => location.includes('PBAS#1')));
  assert.ok(!v1Locations.some(location => location.includes('#2')));
});

test('同次调用长度冲突保留为冲突，不截断到最短假装配对', () => {
  const abif = buildAbif([
    { name: 'PBAS', number: 1, type: 2, payload: char('ACGTA') },
    { name: 'PCON', number: 1, type: 1, payload: byteValues([10, 20, 30]) },
    { name: 'PLOC', number: 1, type: 4, payload: shorts([1, 3, 5, 7]) }
  ]);
  const result = interpretAbif(abif, { receiptId: 'r1' });
  const call = result.records.find(record => record.kind === 'base-call');
  assert.equal(call.value.sequence, 'ACGTA');
  assert.deepEqual(call.value.qualities, [10, 20, 30]);
  assert.deepEqual(call.value.peakLocations, [1, 3, 5, 7]);
  assert.equal(call.value.pairing.matched, false);
  assert.equal(call.value.pairing.complete, false);
  assert.deepEqual(call.value.pairing.lengths, { sequence: 5, qualities: 3, peakLocations: 4 });
  const conflict = result.issues.find(issue => issue.reason === 'base_call_length_conflict');
  assert.ok(conflict);
  assert.equal(conflict.location, 'abif:base-call#1');
});

test('DATA 通道染料由 FWO_ 来源声明决定，不按数组顺序猜', () => {
  const abif = buildAbif([
    { name: 'FWO_', number: 1, type: 2, payload: char('CATG') },
    { name: 'DATA', number: 9, type: 4, payload: shorts([1, 2, 3]) },
    { name: 'DATA', number: 10, type: 4, payload: shorts([4, 5, 6]) },
    { name: 'DATA', number: 13, type: 4, payload: shorts([7, 8]) }
  ]);
  const result = interpretAbif(abif, { receiptId: 'r1' });
  const channels = result.records.filter(record => record.kind === 'trace-channel');
  assert.equal(channels.length, 3);
  const byNumber = new Map(channels.map(channel => [channel.value.directoryNumber, channel.value]));
  assert.equal(byNumber.get(9).dye, 'C');
  assert.equal(byNumber.get(10).dye, 'A');
  assert.equal(byNumber.get(9).dyeBasis, 'FWO_#1');
  // DATA#13 不在 FWO_ 声明的 9..12 范围，染料保持未声明并登记问题
  assert.equal(byNumber.get(13).dye, null);
  assert.equal(byNumber.get(13).dyeBasis, 'undeclared');
  assert.ok(result.issues.some(issue => issue.reason === 'trace_dye_undeclared' && issue.location.includes('DATA#13')));
});

test('缺少 FWO_ 时不猜染料，轨迹仍按目录编号保留', () => {
  const abif = buildAbif([
    { name: 'DATA', number: 9, type: 4, payload: shorts([1, 2, 3]) }
  ]);
  const result = interpretAbif(abif, { receiptId: 'r1' });
  const channel = result.records.find(record => record.kind === 'trace-channel');
  assert.equal(channel.value.dye, null);
  assert.equal(channel.value.dyeBasis, 'undeclared');
  assert.equal(channel.value.sampleCount, 3);
});

test('未知目录项作为记录保留出处，不阻塞已知条目', () => {
  const abif = buildAbif([
    { name: 'PBAS', number: 1, type: 2, payload: char('AC') },
    { name: 'PCON', number: 1, type: 1, payload: byteValues([1, 2]) },
    { name: 'SPAC', number: 3, type: 5, payload: Buffer.from([0, 0, 0, 7, 0, 0, 0, 8]) }
  ]);
  const result = interpretAbif(abif, { receiptId: 'r1' });
  const unknown = result.records.find(record => record.kind === 'abif-directory-entry');
  assert.ok(unknown);
  assert.equal(unknown.key, 'SPAC#3');
  assert.equal(unknown.value.supported, false);
  assert.equal(unknown.provenance[0].receiptId, 'r1');
  assert.ok(unknown.provenance[0].location.startsWith('abif:SPAC#3:bytes@'));
  assert.ok(result.records.some(record => record.kind === 'base-call'));
});

test('截断的外置数据报告具体目录项，不把缺失默认为零', () => {
  const full = buildAbif([
    { name: 'DATA', number: 9, type: 4, payload: shorts([1, 2, 3, 4, 5]) }
  ]);
  const truncated = buildAbif([
    { name: 'DATA', number: 9, type: 4, payload: shorts([1, 2, 3, 4, 5]) }
  ], { truncateAt: full.length - 4 });
  const result = interpretAbif(truncated, { receiptId: 'r1' });
  const issue = result.issues.find(item => item.reason === 'truncated_external_data');
  assert.ok(issue);
  assert.ok(issue.location.includes('DATA#9'));
  assert.equal(result.records.some(record => record.kind === 'trace-channel'), false);
});

test('非 ABIF 或不支持版本明确报错，不假装已解释', () => {
  assert.throws(() => parseDirectory(Buffer.from('XXXX' + Buffer.alloc(30))), /not_abif/);
  const badVersion = Buffer.alloc(34);
  badVersion.write('ABIF', 0, 'latin1');
  badVersion.writeUInt16BE(102, 4);
  assert.throws(() => parseDirectory(badVersion), /unsupported_abif_version/);
});
