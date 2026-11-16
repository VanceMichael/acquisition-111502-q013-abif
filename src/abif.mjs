const ABIF_VERSION = 101;
const DIRECTORY_ENTRY_SIZE = 28;
const ABIF_HEADER_SIZE = 34;

const CALL_TAGS = ['PBAS', 'PCON', 'PLOC'];
const TRACE_TAGS = new Set(['DATA']);
const DYE_DATA_NUMBERS = new Map([[9, 0], [10, 1], [11, 2], [12, 3]]);

function byteRange(start, length) {
  if (!Number.isInteger(start) || start < 0) return 'byte:unknown';
  if (!Number.isInteger(length) || length <= 0) return `byte:${start}`;
  return `byte:${start}-${start + length - 1}`;
}

function problem(reason, location, details = {}) {
  return { reason, location, ...details };
}

function printableTag(raw) {
  const value = raw.replace(/\0+$/, '');
  return value.replace(/[^\x20-\x7e]/g, '?');
}

function readEntry(bytes, offset, receiptId) {
  const rawName = bytes.toString('latin1', offset, offset + 4);
  const name = printableTag(rawName);
  const number = bytes.readUInt32BE(offset + 4);
  const elementType = bytes.readUInt16BE(offset + 8);
  const elementSize = bytes.readUInt16BE(offset + 10);
  const elementCount = bytes.readUInt32BE(offset + 12);
  const dataSize = bytes.readUInt32BE(offset + 16);
  const dataOffset = bytes.readUInt32BE(offset + 20);
  const inline = dataSize <= 4;
  const entryLocation = byteRange(offset, DIRECTORY_ENTRY_SIZE);

  let data;
  let valueLocation;
  let availableBytes;
  let complete;

  if (inline) {
    // ABIF stores values of four bytes or less in the directory entry itself.
    // The dataOffset field is not a file offset in that case.
    data = bytes.subarray(offset + 20, offset + 20 + dataSize);
    valueLocation = byteRange(offset + 20, dataSize);
    availableBytes = dataSize;
    complete = true;
  } else {
    data = bytes.subarray(dataOffset, dataOffset + dataSize);
    valueLocation = byteRange(dataOffset, dataSize);
    availableBytes = Math.max(0, Math.min(dataSize, bytes.length - dataOffset));
    complete = dataOffset >= 0 && dataOffset + dataSize <= bytes.length;
  }

  return {
    receiptId, offset, rawName, name, number, elementType, elementSize,
    elementCount, dataSize, dataOffset, inline, data, valueLocation,
    entryLocation, availableBytes, complete
  };
}

function decodeEntry(entry) {
  if (!entry.complete) return { ok: false, reason: 'incomplete_data' };
  if (entry.elementSize === 0) return { ok: false, reason: 'invalid_element_size' };
  if (entry.elementCount * entry.elementSize > entry.dataSize) {
    return { ok: false, reason: 'count_exceeds_data' };
  }
  const count = entry.elementCount;
  const size = entry.elementSize;
  const data = entry.data;

  switch (entry.elementType) {
    case 2: {
      if (size !== 1) return { ok: false, reason: 'unsupported_element_size' };
      return { ok: true, value: data.toString('latin1', 0, count).replace(/\0+$/, '') };
    }
    case 1: {
      if (size !== 1) return { ok: false, reason: 'unsupported_element_size' };
      return { ok: true, value: Array.from(data.subarray(0, count)) };
    }
    case 3: {
      if (size !== 2) return { ok: false, reason: 'unsupported_element_size' };
      const value = [];
      for (let index = 0; index < count; index++) value.push(data.readUInt16BE(index * size));
      return { ok: true, value };
    }
    case 4: {
      if (size !== 2) return { ok: false, reason: 'unsupported_element_size' };
      const value = [];
      for (let index = 0; index < count; index++) value.push(data.readInt16BE(index * size));
      return { ok: true, value };
    }
    case 5: {
      if (size !== 4) return { ok: false, reason: 'unsupported_element_size' };
      const value = [];
      for (let index = 0; index < count; index++) value.push(data.readInt32BE(index * size));
      return { ok: true, value };
    }
    case 6: {
      if (size !== 4) return { ok: false, reason: 'unsupported_element_size' };
      const value = [];
      for (let index = 0; index < count; index++) value.push(data.readFloatBE(index * size));
      return { ok: true, value };
    }
    case 7: {
      if (size !== 8) return { ok: false, reason: 'unsupported_element_size' };
      const value = [];
      for (let index = 0; index < count; index++) value.push(data.readDoubleBE(index * size));
      return { ok: true, value };
    }
    case 18: {
      if (size !== 1) return { ok: false, reason: 'unsupported_element_size' };
      return { ok: true, value: Array.from(data.subarray(0, count), item => item !== 0) };
    }
    case 19: {
      if (size !== 1) return { ok: false, reason: 'unsupported_element_size' };
      return { ok: true, value: data.toString('latin1', 0, count).replace(/\0+$/, '') };
    }
    default:
      return { ok: false, reason: 'unsupported_element_type' };
  }
}

function decodeProblem(entry, decoded, issues) {
  const shared = {
    receiptId: entry.receiptId,
    entryLocation: entry.entryLocation,
    tag: entry.name,
    number: entry.number,
    elementType: entry.elementType,
    elementSize: entry.elementSize,
    elementCount: entry.elementCount,
    declaredDataSize: entry.dataSize
  };
  if (!entry.complete) {
    issues.push(problem(
      entry.availableBytes > 0 ? 'truncated_external_data' : 'missing_external_data',
      entry.entryLocation,
      {
        ...shared,
        dataRange: entry.valueLocation,
        availableBytes: entry.availableBytes,
        missingBytes: entry.dataSize - entry.availableBytes
      }
    ));
  } else {
    issues.push(problem(decoded.reason, entry.entryLocation, shared));
  }
}

function sourceOf(entry) {
  return {
    receiptId: entry.receiptId,
    location: entry.valueLocation,
    entryLocation: entry.entryLocation,
    tag: entry.name,
    number: entry.number
  };
}

function rawRecord(entry, status, detail = {}) {
  return {
    kind: 'directory-entry',
    key: `${entry.receiptId}:${entry.name}.${entry.number}@${entry.offset}`,
    value: {
      tag: entry.name,
      number: entry.number,
      elementType: entry.elementType,
      elementSize: entry.elementSize,
      elementCount: entry.elementCount,
      dataSize: entry.dataSize,
      storage: entry.inline ? 'inline' : 'external',
      dataOffset: entry.inline ? null : entry.dataOffset,
      status,
      ...detail
    },
    provenance: [{ receiptId: entry.receiptId, location: entry.entryLocation }]
  };
}

function parseDirectory(bytes, receiptId, issues) {
  if (bytes.length < 4 || bytes.toString('latin1', 0, 4) !== 'ABIF') {
    issues.push(problem('unsupported_abif_signature', byteRange(0, Math.min(4, bytes.length)), {
      receiptId,
      expected: 'ABIF'
    }));
    return null;
  }
  if (bytes.length < ABIF_HEADER_SIZE) {
    issues.push(problem('truncated_abif_header', byteRange(0, bytes.length), {
      receiptId,
      availableBytes: bytes.length,
      requiredBytes: ABIF_HEADER_SIZE
    }));
    return null;
  }

  const version = bytes.readUInt16BE(4);
  if (version !== ABIF_VERSION) {
    issues.push(problem('unsupported_abif_version', byteRange(0, 6), { receiptId, version, supported: ABIF_VERSION }));
    return null;
  }

  const declaredEntrySize = bytes.readUInt16BE(16);
  if (declaredEntrySize !== DIRECTORY_ENTRY_SIZE) {
    issues.push(problem('unexpected_directory_entry_size', byteRange(14, 4), {
      receiptId,
      declaredEntrySize,
      expected: DIRECTORY_ENTRY_SIZE
    }));
  }

  const declaredCount = bytes.readUInt32BE(18);
  const directoryOffset = bytes.readUInt32BE(26);
  if (directoryOffset > bytes.length) {
    issues.push(problem('directory_outside_source', byteRange(directoryOffset, 0), {
      receiptId,
      directoryOffset,
      availableBytes: bytes.length
    }));
    return [];
  }

  const availableEntries = Math.min(declaredCount, Math.floor((bytes.length - directoryOffset) / DIRECTORY_ENTRY_SIZE));
  if (availableEntries < declaredCount) {
    issues.push(problem('truncated_directory', byteRange(directoryOffset + availableEntries * DIRECTORY_ENTRY_SIZE,
      (declaredCount - availableEntries) * DIRECTORY_ENTRY_SIZE), {
      receiptId,
      declaredEntries: declaredCount,
      availableEntries
    }));
  }

  const entries = [];
  for (let index = 0; index < availableEntries; index++) {
    entries.push(readEntry(bytes, directoryOffset + index * DIRECTORY_ENTRY_SIZE, receiptId));
  }
  return entries;
}

function buildBaseCalls(entries, receipts) {
  const records = [];
  const issues = [];
  const raw = [];
  const calls = new Map();
  const seen = new Set();

  for (const entry of entries) {
    if (!CALL_TAGS.includes(entry.name)) continue;
    const identity = `${entry.name}.${entry.number}`;
    if (seen.has(identity)) {
      issues.push(problem('duplicate_directory_identity', entry.entryLocation, {
        receiptId: entry.receiptId, tag: entry.name, number: entry.number
      }));
      raw.push(rawRecord(entry, 'duplicate'));
      continue;
    }
    seen.add(identity);
    receipts.consumed.add(entry);

    const decoded = decodeEntry(entry);
    if (!decoded.ok) {
      decodeProblem(entry, decoded, issues);
      raw.push(rawRecord(entry, entry.complete ? 'unsupported' : (entry.availableBytes > 0 ? 'truncated' : 'missing')));
      continue;
    }
    let call = calls.get(entry.number);
    if (!call) {
      call = {};
      calls.set(entry.number, call);
    }
    call[entry.name] = { entry, value: decoded.value };
  }

  for (const [number, call] of [...calls].sort((left, right) => left[0] - right[0])) {
    const present = CALL_TAGS.filter(tag => call[tag]);
    if (present.length === 0) continue;

    const lengths = {};
    for (const tag of CALL_TAGS) lengths[tag] = call[tag] ? call[tag].value.length : null;
    const presentLengths = present.map(tag => call[tag].value.length);
    const conflict = new Set(presentLengths).size > 1;
    const complete = present.length === CALL_TAGS.length && !conflict;

    if (conflict) {
      const anchor = call.PBAS || call.PCON || call.PLOC;
      issues.push(problem('call_length_conflict', anchor.entry.entryLocation, {
        receiptId: anchor.entry.receiptId,
        callVersion: number,
        lengths,
        locations: Object.fromEntries(present.map(tag => [tag, call[tag].entry.entryLocation]))
      }));
    }

    const provenance = present.map(tag => sourceOf(call[tag].entry));
    const sources = {};
    for (const tag of present) {
      const key = tag === 'PBAS' ? 'sequence' : tag === 'PCON' ? 'qualities' : 'peakLocations';
      sources[key] = sourceOf(call[tag].entry);
    }

    const anchor = present[0];
    records.push({
      kind: 'base-call',
      key: `${call[anchor].entry.receiptId}:CALL.${number}`,
      value: {
        version: number,
        sequence: call.PBAS ? call.PBAS.value : null,
        qualities: call.PCON ? call.PCON.value : null,
        peakLocations: call.PLOC ? call.PLOC.value : null,
        complete,
        pairing: {
          complete,
          conflict,
          present,
          missing: CALL_TAGS.filter(tag => !call[tag]),
          lengths
        },
        sources
      },
      provenance
    });
  }

  return { records, issues, raw };
}

function buildTraces(entries, receipts) {
  const records = [];
  const issues = [];
  const raw = [];
  const fwoEntries = entries.filter(entry => entry.name === 'FWO_');
  let dyes = null;
  let dyeOrigin = null;

  for (const [index, entry] of fwoEntries.entries()) {
    if (index > 0) {
      issues.push(problem('duplicate_directory_identity', entry.entryLocation, {
        receiptId: entry.receiptId, tag: entry.name, number: entry.number
      }));
      raw.push(rawRecord(entry, 'duplicate'));
      continue;
    }
    const decoded = decodeEntry(entry);
    if (!decoded.ok) {
      decodeProblem(entry, decoded, issues);
      raw.push(rawRecord(entry, entry.complete ? 'unsupported' : (entry.availableBytes > 0 ? 'truncated' : 'missing')));
      continue;
    }
    if (typeof decoded.value !== 'string' || decoded.value.length < 4) {
      issues.push(problem('incomplete_dye_declaration', entry.entryLocation, {
        receiptId: entry.receiptId,
        declared: decoded.value,
        expectedLength: 4
      }));
      raw.push(rawRecord(entry, 'invalid-dye-declaration', { declared: decoded.value }));
      continue;
    }
    dyes = decoded.value.slice(0, 4);
    dyeOrigin = sourceOf(entry);
    receipts.consumed.add(entry);
  }

  const dataNumbers = new Map();
  for (const entry of entries) {
    if (!TRACE_TAGS.has(entry.name)) continue;
    if (dataNumbers.has(entry.number)) {
      issues.push(problem('duplicate_directory_identity', entry.entryLocation, {
        receiptId: entry.receiptId, tag: entry.name, number: entry.number
      }));
      raw.push(rawRecord(entry, 'duplicate'));
      continue;
    }
    dataNumbers.set(entry.number, entry);

    const mapped = DYE_DATA_NUMBERS.has(entry.number) && dyes;
    if (!mapped) {
      // DATA numbers outside the FWO_ declaration keep their original directory
      // identity; their dye is not inferred from array order.
      raw.push(rawRecord(entry, 'unmapped-channel'));
      if (!entry.complete) {
        const decoded = decodeEntry(entry);
        decodeProblem(entry, decoded, issues);
      }
      continue;
    }
    const decoded = decodeEntry(entry);
    if (!decoded.ok) {
      decodeProblem(entry, decoded, issues);
      raw.push(rawRecord(entry, entry.complete ? 'unsupported' : (entry.availableBytes > 0 ? 'truncated' : 'missing')));
      continue;
    }

    receipts.consumed.add(entry);
    const dataOrigin = sourceOf(entry);
    records.push({
      kind: 'trace-channel',
      key: `${entry.receiptId}:${entry.name}.${entry.number}`,
      value: {
        dye: dyes[DYE_DATA_NUMBERS.get(entry.number)],
        directoryNumber: entry.number,
        sampleCount: entry.elementCount,
        samples: decoded.value,
        sources: { samples: dataOrigin, dye: dyeOrigin }
      },
      provenance: [
        { receiptId: dataOrigin.receiptId, location: dataOrigin.location },
        { receiptId: dyeOrigin.receiptId, location: dyeOrigin.location }
      ]
    });
  }

  return { records, issues, raw };
}

export function parseAbif(bytes, { receiptId }) {
  const issues = [];
  const entries = parseDirectory(bytes, receiptId, issues);
  if (!entries) return { records: [], issues };

  const receipts = { consumed: new Set() };
  const baseCalls = buildBaseCalls(entries, receipts);
  const traces = buildTraces(entries, receipts);
  const records = [...baseCalls.records, ...traces.records];
  issues.push(...baseCalls.issues, ...traces.issues);

  const raw = [...baseCalls.raw, ...traces.raw];
  for (const entry of entries) {
    if (receipts.consumed.has(entry) || raw.some(record => record.provenance[0].location === entry.entryLocation)) continue;
    const status = entry.complete ? 'unrecognized' : (entry.availableBytes > 0 ? 'truncated' : 'missing');
    if (!entry.complete) {
      decodeProblem(entry, { ok: false, reason: 'incomplete_data' }, issues);
    }
    raw.push(rawRecord(entry, status));
  }

  records.push(...raw);
  return { records, issues };
}

export function isAbif(bytes) {
  return bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'ABIF';
}
