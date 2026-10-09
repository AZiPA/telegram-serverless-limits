export default function (input) {
  const bytes = input.bytes;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 16 * 1024 ** 3) {
    throw new Error('Invalid buffer size');
  }
  if (!['edges', 'fill'].includes(input.touch)) throw new Error('Unknown touch mode');
  if (input.touch === 'fill' && bytes > 8 * 1024 ** 3) throw new Error('Fill test ceiling exceeded');
  const buffer = new ArrayBuffer(bytes);
  let verifiedPages = 0;
  if (input.touch === 'fill') {
    for (let start = 0; start < bytes; start += 16 * 1024 * 1024) {
      const view = new Uint8Array(buffer, start, Math.min(16 * 1024 * 1024, bytes - start));
      view.fill(0xa5);
    }
    for (let start = 0; start < bytes; start += 16 * 1024 * 1024) {
      const view = new Uint8Array(buffer, start, Math.min(16 * 1024 * 1024, bytes - start));
      for (let i = 0; i < view.length; i += 4096) {
        if (view[i] !== 0xa5) throw new Error('Buffer verification failed');
        verifiedPages++;
      }
    }
  } else {
    new Uint8Array(buffer, 0, 1)[0] = 0xa5;
    new Uint8Array(buffer, bytes - 1, 1)[0] = 0xa5;
  }
  let checksum = 0x12345678;
  for (let i = 0; i < 100_000_000; i++) {
    checksum ^= checksum << 13;
    checksum ^= checksum >>> 17;
    checksum ^= checksum << 5;
  }
  if (new Uint8Array(buffer, bytes - 1, 1)[0] !== 0xa5) throw new Error('Last byte verification failed');
  return { totalBytes: buffer.byteLength, count: 1, touch: input.touch, verifiedPages, checksum: checksum >>> 0 };
}
