// ABIF v101 目录解析与按出处解释。
// 规则来源：docs/source-contract.md
// - 目录项以 标签+编号 为局部身份；大端字节序。
// - dataSize <= 4 时值内联在目录项的 dataOffset 字段里，否则 dataOffset 才是文件内字节偏移。
// - PBAS/PCON/PLOC 同编号才属于同一次调用；长度冲突保留为冲突，不截断配对。
// - FWO_ 声明 DATA9..12 的染料顺序；其他 DATA 编号保留原始目录，不按数组顺序猜染料。
// - 本模块只接收文件中既有的调用与轨迹，不判峰、不比对、不作检测结论。

export const ELEMENT_TYPES = {
  1: { name: 'byte', size: 1, signed: false },
  2: { name: 'char', size: 1, signed: false },
  3: { name: 'word', size: 2, signed: false },
  4: { name: 'short', size: 2, signed: true },
  5: { name: 'long', size: 4, signed: true },
  7: { name: 'float', size: 4, signed: false, float: true },
  8: { name: 'double', size: 8, signed: false, float: true },
  10: { name: 'date', size: 4, signed: false },
  11: { name: 'time', size: 4, signed: false },
  13: { name: 'bool', size: 1, signed: false },
  18: { name: 'pString', size: 1, signed: false },
  19: { name: 'cString', size: 1, signed: false }
};

const HEADER_LENGTH = 34; // ABIF 签名 4 字节 + 版本 2 字节 + 根目录项 28 字节（6..33）
const ENTRY_LENGTH = 28;
const INLINE_LIMIT = 4;

function readSized(bytes, start, size, issues, location) {
  if (start < 0 || start + size > bytes.length) {
    issues.push({
      reason: 'truncated_external_data',
      location,
      detail: `需要字节区间 ${start}..${start + size - 1}，实际文件长度 ${bytes.length}`
    });
    return { value: null, truncated: true, end: Math.min(start + size, bytes.length) };
  }
  return { value: bytes.subarray(start, start + size), truncated: false, end: start + size };
}

// 读取一个目录项的数据载荷，区分内联短数据与外置字节偏移。
function readPayload(bytes, entry, issues) {
  const entryOffset = entry.entryOffset;
  const inlineLocation = `abif:${entry.name}#${entry.number}:entry@${entryOffset}:dataOffset`;
  const externalLocation = `abif:${entry.name}#${entry.number}:bytes@${entry.dataOffset}..${entry.dataOffset + entry.dataSize - 1}`;
  if (entry.dataSize <= INLINE_LIMIT) {
    return {
      location: inlineLocation,
      payload: bytes.subarray(entryOffset + 20, entryOffset + 20 + entry.dataSize),
      truncated: false
    };
  }
  const read = readSized(bytes, entry.dataOffset, entry.dataSize, issues, externalLocation);
  return { location: externalLocation, payload: read.value, truncated: read.truncated };
}

function decodeElements(entry, payload) {
  const kind = ELEMENT_TYPES[entry.elementType];
  if (!kind || !payload) return null;
  const values = [];
  for (let index = 0; index < entry.numElements; index += 1) {
    const start = index * kind.size;
    if (start + kind.size > payload.length) break;
    if (kind.float) {
      values.push(kind.size === 4 ? payload.readFloatBE(start) : payload.readDoubleBE(start));
    } else if (kind.size === 1) {
      values.push(kind.signed ? payload.readInt8(start) : payload.readUInt8(start));
    } else if (kind.size === 2) {
      values.push(kind.signed ? payload.readInt16BE(start) : payload.readUInt16BE(start));
    } else if (kind.size === 4) {
      values.push(kind.signed ? payload.readInt32BE(start) : payload.readUInt32BE(start));
    }
  }
  return values;
}

function decodeText(payload) {
  if (!payload) return null;
  // ABIF 文本可能带末尾 NUL，按来源字节原样保留并去掉单个终止 NUL 以便阅读。
  let text = payload.toString('latin1');
  if (text.endsWith('\0')) text = text.slice(0, -1);
  return text;
}

// 解析目录本身（不解释领域含义），返回全部目录项及其数据位置，未知项也保留。
export function parseDirectory(bytes) {
  const issues = [];
  if (bytes.length < HEADER_LENGTH || bytes.subarray(0, 4).toString('latin1') !== 'ABIF') {
    throw Object.assign(new Error('not_abif'), { status: 422 });
  }
  const version = bytes.readUInt16BE(4);
  if (version !== 101) {
    throw Object.assign(new Error('unsupported_abif_version'), { status: 422 });
  }
  const root = {
    name: bytes.subarray(6, 10).toString('latin1'),
    number: bytes.readInt32BE(10),
    elementType: bytes.readInt16BE(14),
    elementSize: bytes.readInt16BE(16),
    numElements: bytes.readInt32BE(18),
    dataSize: bytes.readInt32BE(22),
    dataOffset: bytes.readInt32BE(26)
  };
  if (root.name !== 'tdir' || root.elementSize !== ENTRY_LENGTH) {
    throw Object.assign(new Error('invalid_abif_directory'), { status: 422 });
  }
  const entries = [];
  for (let index = 0; index < root.numElements; index += 1) {
    const entryOffset = root.dataOffset + index * ENTRY_LENGTH;
    if (entryOffset + ENTRY_LENGTH > bytes.length) {
      issues.push({
        reason: 'truncated_directory_entry',
        location: `abif:directory:entry[${index}]@${entryOffset}`,
        detail: `目录项需要 ${ENTRY_LENGTH} 字节，超出文件长度 ${bytes.length}`
      });
      break;
    }
    const entry = {
      index,
      entryOffset,
      name: bytes.subarray(entryOffset, entryOffset + 4).toString('latin1'),
      number: bytes.readInt32BE(entryOffset + 4),
      elementType: bytes.readInt16BE(entryOffset + 8),
      elementSize: bytes.readInt16BE(entryOffset + 10),
      numElements: bytes.readInt32BE(entryOffset + 12),
      dataSize: bytes.readInt32BE(entryOffset + 16),
      dataOffset: bytes.readInt32BE(entryOffset + 20),
      handle: bytes.readInt32BE(entryOffset + 24),
      typeName: (ELEMENT_TYPES[bytes.readInt16BE(entryOffset + 8)] || { name: 'unknown' }).name
    };
    const data = readPayload(bytes, entry, issues);
    entry.dataLocation = data.location;
    entry.payload = data.payload;
    entry.truncated = data.truncated;
    entries.push(entry);
  }
  return { version, entries, issues };
}

function asText(entry) {
  if (entry.truncated) return null;
  if (entry.elementType === 2 || entry.elementType === 18 || entry.elementType === 19) return decodeText(entry.payload);
  return null;
}

function asNumbers(entry) {
  if (entry.truncated) return null;
  return decodeElements(entry, entry.payload);
}

// 把目录解释为 base-call / trace-channel 领域记录与未知目录项回查材料。
// receiptId 由调用方绑定真实收件；这里只产出可复查的 location。
export function interpretAbif(bytes, { receiptId } = {}) {
  const { version, entries, issues } = parseDirectory(bytes);
  const origin = location => (receiptId ? [{ receiptId, location }] : []);
  const headerOrigin = origin('abif:header@0..33');
  const records = [];

  const byTag = new Map();
  for (const entry of entries) {
    const list = byTag.get(entry.name) || [];
    list.push(entry);
    byTag.set(entry.name, list);
  }

  // 同编号的 PBAS/PCON/PLOC 才属于同一次调用，编号即调用版本。
  const versions = new Set();
  for (const name of ['PBAS', 'PCON', 'PLOC']) {
    for (const entry of byTag.get(name) || []) versions.add(entry.number);
  }
  const sortedVersions = [...versions].sort((a, b) => a - b);

  for (const callVersion of sortedVersions) {
    const pbas = (byTag.get('PBAS') || []).find(entry => entry.number === callVersion);
    const pcon = (byTag.get('PCON') || []).find(entry => entry.number === callVersion);
    const ploc = (byTag.get('PLOC') || []).find(entry => entry.number === callVersion);

    const value = { version: callVersion };
    const provenance = [...headerOrigin];
    const lengths = {};
    const present = [];

    // 每个组成部分各自带来源；截断的组成部分不取值、不默认为零，只在 issues 与出处中保留。
    const attach = (entry, field, decode) => {
      if (!entry) return;
      provenance.push(...origin(entry.dataLocation));
      if (entry.truncated) return;
      const decoded = decode(entry);
      if (decoded === null || decoded === undefined) return;
      value[field] = decoded;
      lengths[field] = Array.isArray(decoded) ? decoded.length : decoded.length;
      present.push(field);
    };
    attach(pbas, 'sequence', asText);
    attach(pcon, 'qualities', asNumbers);
    attach(ploc, 'peakLocations', asNumbers);

    const presentLengths = Object.values(lengths);
    const matched = presentLengths.length > 0 && presentLengths.every(length => length === presentLengths[0]);
    const truncatedComponents = [
      pbas?.truncated ? 'sequence' : null,
      pcon?.truncated ? 'qualities' : null,
      ploc?.truncated ? 'peakLocations' : null
    ].filter(Boolean);
    value.pairing = {
      complete: Boolean(pbas && pcon && ploc && truncatedComponents.length === 0 && matched),
      matched,
      lengths,
      present,
      truncatedComponents
    };
    if (!matched && presentLengths.length > 1) {
      issues.push({
        reason: 'base_call_length_conflict',
        location: `abif:base-call#${callVersion}`,
        detail: `同次调用长度不一致，保留冲突不截断: ${JSON.stringify(lengths)}`
      });
    }
    records.push({ kind: 'base-call', key: `base-call#${callVersion}`, value, provenance });
  }

  // FWO_ 声明 DATA9..12 的染料含义；没有声明就不猜。
  const filterOrderEntry = (byTag.get('FWO_') || [])[0];
  let filterOrder = null;
  if (filterOrderEntry) {
    filterOrder = asText(filterOrderEntry);
  }
  const declaredDyeByNumber = new Map();
  if (filterOrder !== null) {
    for (let index = 0; index < filterOrder.length; index += 1) {
      declaredDyeByNumber.set(9 + index, filterOrder[index]);
    }
  }

  for (const entry of byTag.get('DATA') || []) {
    if (entry.truncated) {
      // 截断轨迹不生成 trace-channel 记录，问题已在解析阶段登记，保留原始目录项可回查。
      continue;
    }
    const samples = asNumbers(entry);
    if (samples === null) continue;
    const dye = declaredDyeByNumber.get(entry.number) || null;
    const value = {
      dye,
      directoryNumber: entry.number,
      sampleCount: samples.length
    };
    const provenance = origin(entry.dataLocation);
    if (filterOrderEntry) provenance.push(...origin(filterOrderEntry.dataLocation));
    if (entry.number < 9 || entry.number > 12 || dye === null) {
      value.dyeBasis = 'undeclared';
      issues.push({
        reason: 'trace_dye_undeclared',
        location: entry.dataLocation,
        detail: `DATA#${entry.number} 不在 FWO_ 声明的 DATA9..12 范围内，染料含义未声明，保留原始轨迹不按顺序猜测`
      });
    } else {
      value.dyeBasis = 'FWO_#1';
    }
    records.push({ kind: 'trace-channel', key: `trace-channel#${entry.number}`, value, provenance });
  }

  // 未知目录项不阻塞已知条目，作为目录项记录保留出处，仍可回到真实字节回查。
  const known = new Set(['PBAS', 'PCON', 'PLOC', 'FWO_', 'DATA', 'tdir']);
  for (const entry of entries) {
    if (known.has(entry.name)) continue;
    records.push({
      kind: 'abif-directory-entry',
      key: `${entry.name}#${entry.number}`,
      value: {
        tag: entry.name,
        number: entry.number,
        elementType: entry.elementType,
        typeName: entry.typeName,
        numElements: entry.numElements,
        dataSize: entry.dataSize,
        supported: false,
        truncated: entry.truncated
      },
      provenance: origin(entry.dataLocation)
    });
  }

  return { formatVersion: version, records, issues };
}
