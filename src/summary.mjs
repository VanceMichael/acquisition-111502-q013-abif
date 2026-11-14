export function summarize(bytes, mediaType) {
  if (mediaType.includes('application/json')) {
    try {
      const value = JSON.parse(bytes);
      if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    } catch {}
  }
  return { format: 'abif', signature: bytes.subarray(0, 4).toString('ascii'), version: bytes.length >= 6 ? bytes.readUInt16BE(4) : null, byteLength: bytes.length };
}
