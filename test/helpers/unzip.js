'use strict';

const { inflateRawSync } = require('node:zlib');

/** 读 zip（store/deflate），只支持打包脚本写出的那种结构。 */
function readZip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file: EOCD not found');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const files = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== uncompressedSize) throw new Error(`size mismatch for ${name}`);
    files.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/**
 * 按本地头从头往后走（安装器报「bad zip local header」「zip entry truncated」的那种读法），
 * 返回每个条目的原始字段，供测试核对安装器规则。
 */
function readLocalHeaders(buffer) {
  const headers = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const dataStart = offset + 30 + nameLength + extraLength;
    headers.push({
      name: buffer.toString('utf8', offset + 30, offset + 30 + nameLength),
      flags: buffer.readUInt16LE(offset + 6),
      method: buffer.readUInt16LE(offset + 8),
      time: buffer.readUInt16LE(offset + 10),
      date: buffer.readUInt16LE(offset + 12),
      crc: buffer.readUInt32LE(offset + 14),
      compressedSize,
      size: buffer.readUInt32LE(offset + 22),
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    offset = dataStart + compressedSize;
  }
  return { headers, centralOffset: offset };
}

module.exports = { readZip, readLocalHeaders };