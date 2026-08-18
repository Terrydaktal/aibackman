const fs = require('fs');
const os = require('os');
const path = require('path');

const STRUCTURED_DATA = {
  FLOAT_MAX: 0xfff00000,
  HEADER: 0xfff10000,
  NULL: 0xffff0000,
  UNDEFINED: 0xffff0001,
  BOOLEAN: 0xffff0002,
  INT32: 0xffff0003,
  STRING: 0xffff0004,
  DATE_OBJECT: 0xffff0005,
  REGEXP_OBJECT: 0xffff0006,
  ARRAY_OBJECT: 0xffff0007,
  OBJECT_OBJECT: 0xffff0008,
  ARRAY_BUFFER_OBJECT_V2: 0xffff0009,
  BOOLEAN_OBJECT: 0xffff000a,
  STRING_OBJECT: 0xffff000b,
  NUMBER_OBJECT: 0xffff000c,
  BACK_REFERENCE_OBJECT: 0xffff000d,
  TYPED_ARRAY_OBJECT_V2: 0xffff0010,
  MAP_OBJECT: 0xffff0011,
  SET_OBJECT: 0xffff0012,
  END_OF_KEYS: 0xffff0013,
  SAVED_FRAME_OBJECT: 0xffff0016,
  JSPRINCIPALS: 0xffff0017,
  NULL_JSPRINCIPALS: 0xffff0018,
  RECONSTRUCTED_SAVED_FRAME_PRINCIPALS_IS_SYSTEM: 0xffff0019,
  RECONSTRUCTED_SAVED_FRAME_PRINCIPALS_IS_NOT_SYSTEM: 0xffff001a,
  BIGINT: 0xffff001d,
  BIGINT_OBJECT: 0xffff001e,
  ARRAY_BUFFER_OBJECT: 0xffff001f,
  TYPED_ARRAY_OBJECT: 0xffff0020,
  DATA_VIEW_OBJECT: 0xffff0021,
  ERROR_OBJECT: 0xffff0022,
  RESIZABLE_ARRAY_BUFFER_OBJECT: 0xffff0023,
};

const STRUCTURED_CLONE = {
  BLOB: 0xffff8001,
  FILE_WITHOUT_LASTMODIFIEDDATE: 0xffff8002,
  FILELIST: 0xffff8003,
  MUTABLEFILE: 0xffff8004,
  FILE: 0xffff8005,
  WASM_MODULE: 0xffff8006,
  CONTENT_PRINCIPAL: 0xffff800d,
  URLSEARCHPARAMS: 0xffff8014,
  DIRECTORY: 0xffff8020,
};

function align(value, boundary) {
  return (value + boundary - 1) & ~(boundary - 1);
}

function decodeSnappyBlock(input) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let sourceOffset = 0;
  let expectedLength = 0;
  let shift = 0;
  while (sourceOffset < source.length) {
    const byte = source[sourceOffset++];
    expectedLength |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('Invalid Snappy length prefix.');
  }

  const output = Buffer.allocUnsafe(expectedLength);
  let outputOffset = 0;
  while (outputOffset < expectedLength && sourceOffset < source.length) {
    const tag = source[sourceOffset++];
    const type = tag & 0x03;
    if (type === 0) {
      const lengthCode = tag >>> 2;
      let length;
      if (lengthCode < 60) {
        length = lengthCode + 1;
      } else {
        const extraBytes = lengthCode - 59;
        if (sourceOffset + extraBytes > source.length) throw new Error('Invalid Snappy literal.');
        length = 1;
        for (let index = 0; index < extraBytes; index += 1) {
          length += source[sourceOffset++] << (index * 8);
        }
      }
      if (sourceOffset + length > source.length || outputOffset + length > expectedLength) {
        throw new Error('Invalid Snappy literal length.');
      }
      source.copy(output, outputOffset, sourceOffset, sourceOffset + length);
      sourceOffset += length;
      outputOffset += length;
      continue;
    }

    let length;
    let copyOffset;
    if (type === 1) {
      length = ((tag >>> 2) & 0x07) + 4;
      if (sourceOffset >= source.length) throw new Error('Invalid Snappy copy.');
      copyOffset = ((tag & 0xe0) << 3) | source[sourceOffset++];
    } else if (type === 2) {
      length = (tag >>> 2) + 1;
      if (sourceOffset + 2 > source.length) throw new Error('Invalid Snappy copy.');
      copyOffset = source[sourceOffset] | (source[sourceOffset + 1] << 8);
      sourceOffset += 2;
    } else {
      length = (tag >>> 2) + 1;
      if (sourceOffset + 4 > source.length) throw new Error('Invalid Snappy copy.');
      copyOffset = source.readUInt32LE(sourceOffset);
      sourceOffset += 4;
    }
    if (copyOffset <= 0 || copyOffset > outputOffset || outputOffset + length > expectedLength) {
      throw new Error('Invalid Snappy copy offset.');
    }
    for (let index = 0; index < length; index += 1) {
      output[outputOffset++] = output[outputOffset - copyOffset - 1];
    }
  }
  if (outputOffset !== expectedLength) throw new Error('Truncated Snappy block.');
  return output;
}

function decodeSnappy(input) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frameHeader = Buffer.from([0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59]);
  if (!source.subarray(0, frameHeader.length).equals(frameHeader)) return decodeSnappyBlock(source);

  const chunks = [];
  let offset = frameHeader.length;
  while (offset + 4 <= source.length) {
    const type = source[offset];
    const length = source[offset + 1] | (source[offset + 2] << 8) | (source[offset + 3] << 16);
    offset += 4;
    if (offset + length > source.length || length < 4) throw new Error('Invalid Snappy framed stream.');
    const payload = source.subarray(offset + 4, offset + length);
    offset += length;
    if (type === 0x00) chunks.push(decodeSnappyBlock(payload));
    else if (type === 0x01) chunks.push(payload);
    else if (type === 0xff) {
      if (!payload.equals(frameHeader)) throw new Error('Invalid Snappy stream identifier.');
    } else if (type < 0x80) {
      throw new Error(`Unsupported Snappy chunk type: ${type}`);
    }
  }
  return Buffer.concat(chunks);
}

class GeckoStructuredCloneDecoder {
  constructor(data) {
    this.data = data;
    this.offset = 0;
    this.objects = [];
  }

  ensure(size) {
    if (this.offset + size > this.data.length) throw new Error(`Truncated Firefox structured clone value at ${this.offset}; need ${size} bytes, have ${this.data.length - this.offset}.`);
  }

  align(boundary = 8) {
    this.offset = align(this.offset, boundary);
    this.ensure(0);
  }

  readUInt32() {
    this.ensure(4);
    const value = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt32() {
    this.ensure(4);
    const value = this.data.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt64() {
    this.ensure(8);
    const low = this.data.readUInt32LE(this.offset);
    const high = this.data.readUInt32LE(this.offset + 4);
    this.offset += 8;
    return high * 0x100000000 + low;
  }

  readDouble() {
    this.ensure(8);
    const value = this.data.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  readBytes(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid Firefox structured clone byte length.');
    this.ensure(length);
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readPair() {
    this.align(8);
    const data = this.readUInt32();
    const tag = this.readUInt32();
    return { tag, data };
  }

  readRawPair() {
    this.align(8);
    const second = this.readUInt32();
    const first = this.readUInt32();
    return { first, second };
  }

  peekTag() {
    const position = this.offset;
    const { tag } = this.readPair();
    this.offset = position;
    return tag;
  }

  readString(data) {
    const length = data & 0x7fffffff;
    const bytes = data & 0x80000000
      ? this.readBytes(length)
      : this.readBytes(length * 2);
    return data & 0x80000000 ? bytes.toString('latin1') : bytes.toString('utf16le');
  }

  readBlobString() {
    const length = this.readUInt64();
    return this.readBytes(length).toString('utf8');
  }

  readPrincipalInfo(tag) {
    if (tag === STRUCTURED_CLONE.CONTENT_PRINCIPAL) {
      const { first: suffixLength, second: specLength } = this.readRawPair();
      this.readBytes(suffixLength);
      this.readBytes(specLength);
      const { first: originLength } = this.readRawPair();
      this.readBytes(originLength);
      const { first: baseDomainIsVoid, second: baseDomainLength } = this.readRawPair();
      if (!baseDomainIsVoid) this.readBytes(baseDomainLength);
      return;
    }
    if (tag === 0xffff800b || tag === 0xffff800c) return;
    if (tag === 0xffff8012) {
      const { first: count } = this.readRawPair();
      for (let index = 0; index < count; index += 1) {
        const { first: nestedTag } = this.readRawPair();
        this.readPrincipalInfo(nestedTag);
      }
      return;
    }
    throw new Error(`Unsupported Firefox principal tag: 0x${tag.toString(16)}`);
  }

  readPrincipal(tag) {
    if (tag === STRUCTURED_DATA.JSPRINCIPALS) {
      const { tag: principalTag } = this.readPair();
      this.readPrincipalInfo(principalTag);
    } else if (tag !== STRUCTURED_DATA.NULL_JSPRINCIPALS
      && tag !== STRUCTURED_DATA.RECONSTRUCTED_SAVED_FRAME_PRINCIPALS_IS_SYSTEM
      && tag !== STRUCTURED_DATA.RECONSTRUCTED_SAVED_FRAME_PRINCIPALS_IS_NOT_SYSTEM) {
      throw new Error(`Unsupported Firefox SavedFrame principal tag: 0x${tag.toString(16)}`);
    }
  }

  consumeEndOfKeys() {
    const tag = this.peekTag();
    if (tag !== STRUCTURED_DATA.END_OF_KEYS) throw new Error(`Firefox structured clone object was not terminated at ${this.offset} (tag 0x${tag.toString(16)}).`);
    this.readPair();
  }

  readSavedFrame(principalTag) {
    this.readPrincipal(principalTag);
    const mutedErrors = this.readValue();
    const source = typeof mutedErrors === 'boolean' ? this.readValue() : mutedErrors;
    const line = this.readValue();
    const column = this.readValue();
    const functionName = this.readValue();
    const asyncCause = this.readValue();
    this.readValue();
    this.consumeEndOfKeys();
    return { source, line, column, functionName, asyncCause };
  }

  readError(type) {
    const message = this.readValue();
    const hasCause = this.readValue();
    const fileName = this.readValue();
    const line = this.readValue();
    const column = this.readValue();
    const error = {
      name: ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError'][type] || 'Error',
      message: typeof message === 'string' ? message : '',
      ...(fileName ? { fileName } : {}),
      ...(Number.isFinite(line) ? { lineNumber: line } : {}),
      ...(Number.isFinite(column) ? { columnNumber: column } : {}),
    };
    this.objects.push(error);
    const cause = this.readValue();
    const errors = this.readValue();
    const stack = this.readValue();
    if (hasCause) error.cause = cause;
    if (type === 7 && errors != null) error.errors = errors;
    if (stack && typeof stack === 'object') error.stack = stack;
    this.consumeEndOfKeys();
    return error;
  }

  readFile(tag, index) {
    const size = this.readUInt64();
    const type = this.readBlobString();
    let lastModified = null;
    if (tag === STRUCTURED_CLONE.FILE) lastModified = this.readUInt64();
    else if (tag === STRUCTURED_CLONE.FILE_WITHOUT_LASTMODIFIEDDATE) lastModified = Number.MAX_SAFE_INTEGER;
    const name = tag === STRUCTURED_CLONE.BLOB ? '' : this.readBlobString();
    return { index, size, type, name, ...(lastModified == null ? {} : { lastModified }) };
  }

  readValue() {
    const { tag, data } = this.readPair();
    let value;
    if (tag === STRUCTURED_DATA.NULL || tag === STRUCTURED_DATA.UNDEFINED) value = null;
    else if (tag === STRUCTURED_DATA.BOOLEAN) value = Boolean(data);
    else if (tag === STRUCTURED_DATA.INT32) value = data | 0;
    else if (tag === STRUCTURED_DATA.STRING || tag === STRUCTURED_DATA.STRING_OBJECT) value = this.readString(data);
    else if (tag === STRUCTURED_DATA.NUMBER_OBJECT) value = this.readDouble();
    else if (tag === STRUCTURED_DATA.DATE_OBJECT) value = this.readDouble();
    else if (tag === STRUCTURED_DATA.BIGINT || tag === STRUCTURED_DATA.BIGINT_OBJECT) {
      const length = data & 0x7fffffff;
      const bytes = Buffer.alloc(length * 8);
      for (let index = 0; index < length; index += 1) this.readBytes(8).copy(bytes, index * 8);
      value = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex') || '0'}`);
      if (data & 0x80000000) value = -value;
      if (tag === STRUCTURED_DATA.BIGINT_OBJECT) this.objects.push(value);
    } else if (tag === STRUCTURED_DATA.BOOLEAN_OBJECT) {
      value = Boolean(data);
      this.objects.push(value);
    } else if (tag === STRUCTURED_DATA.ARRAY_OBJECT) {
      value = [];
      this.objects.push(value);
      while (this.peekTag() !== STRUCTURED_DATA.END_OF_KEYS) {
        const key = this.readValue();
        const field = this.readValue();
        if (typeof key === 'number' && Number.isInteger(key) && key >= 0) value[key] = field;
        else if (key != null) value[key] = field;
      }
      this.consumeEndOfKeys();
    } else if (tag === STRUCTURED_DATA.OBJECT_OBJECT || tag === STRUCTURED_DATA.MAP_OBJECT) {
      value = {};
      this.objects.push(value);
      while (this.peekTag() !== STRUCTURED_DATA.END_OF_KEYS) {
        const key = this.readValue();
        if (key == null) break;
        value[String(key)] = this.readValue();
      }
      this.consumeEndOfKeys();
    } else if (tag === STRUCTURED_DATA.SET_OBJECT) {
      value = [];
      this.objects.push(value);
      while (this.peekTag() !== STRUCTURED_DATA.END_OF_KEYS) value.push(this.readValue());
      this.consumeEndOfKeys();
    } else if (tag === STRUCTURED_DATA.BACK_REFERENCE_OBJECT) {
      value = this.objects[data];
    } else if (tag === STRUCTURED_DATA.ERROR_OBJECT) {
      value = this.readError(data);
    } else if (tag === STRUCTURED_DATA.SAVED_FRAME_OBJECT) {
      value = this.readSavedFrame(data);
    } else if (tag === STRUCTURED_DATA.ARRAY_BUFFER_OBJECT_V2
      || tag === STRUCTURED_DATA.ARRAY_BUFFER_OBJECT
      || tag === STRUCTURED_DATA.RESIZABLE_ARRAY_BUFFER_OBJECT) {
      const length = tag === STRUCTURED_DATA.ARRAY_BUFFER_OBJECT_V2 ? data : this.readUInt64();
      value = this.readBytes(length);
      this.objects.push(value);
    } else if (tag === STRUCTURED_CLONE.BLOB || tag === STRUCTURED_CLONE.FILE || tag === STRUCTURED_CLONE.FILE_WITHOUT_LASTMODIFIEDDATE) {
      value = this.readFile(tag, data);
    } else if (tag === STRUCTURED_CLONE.FILELIST) {
      value = [];
      for (let index = 0; index < data; index += 1) {
        const fileTag = this.readUInt32();
        const fileIndex = this.readUInt32();
        value.push(this.readFile(fileTag, fileIndex));
      }
    } else if (tag === STRUCTURED_CLONE.DIRECTORY) {
      value = { path: this.readBlobString() };
    } else if (tag <= STRUCTURED_DATA.FLOAT_MAX) {
      const bytes = Buffer.alloc(8);
      bytes.writeUInt32LE(data, 0);
      bytes.writeUInt32LE(tag, 4);
      value = bytes.readDoubleLE(0);
    } else {
      throw new Error(`Unsupported Firefox structured clone tag: 0x${tag.toString(16)}`);
    }
    this.align(8);
    return value;
  }

  decode() {
    const header = this.readPair();
    if (header.tag !== STRUCTURED_DATA.HEADER) throw new Error('Firefox structured clone header not found.');
    return this.readValue();
  }
}

function decodeFirefoxValue(data) {
  const compressed = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const decoded = compressed.subarray(0, 8).readUInt32LE(0) === 3
    && compressed.subarray(4, 8).readUInt32LE(0) === STRUCTURED_DATA.HEADER
    ? compressed
    : decodeSnappy(compressed);
  return new GeckoStructuredCloneDecoder(decoded).decode();
}

function decodeFirefoxKey(key) {
  const bytes = Buffer.from(key);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (bytes[index] + 255) & 0xff;
  return bytes.toString('utf8').replace(/^\/(?=(?:conversation|conversations):)/, '');
}

function findSqliteFiles(rootPath) {
  const files = [];
  const queue = [{ directory: path.resolve(rootPath), depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.sqlite')) files.push(entryPath);
      if (entry.isDirectory() && depth < 8 && !entry.name.startsWith('.')) queue.push({ directory: entryPath, depth: depth + 1 });
    }
  }
  return files;
}

function copySqliteForReading(sourcePath, temporaryRoot) {
  const destination = path.join(temporaryRoot, 'database.sqlite');
  fs.copyFileSync(sourcePath, destination);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${sourcePath}${suffix}`)) fs.copyFileSync(`${sourcePath}${suffix}`, `${destination}${suffix}`);
  }
  return destination;
}

function readFirefoxIndexedDbRecords(inputPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    throw new Error('ChatHub Firefox imports require the Electron SQLite runtime.');
  }
  const candidates = findSqliteFiles(inputPath).sort((left, right) => fs.statSync(right).size - fs.statSync(left).size);
  let selected = null;
  let selectedTemporaryRoot = null;
  for (const candidate of candidates) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chathub-firefox-'));
    try {
      const database = new Database(copySqliteForReading(candidate, temporaryRoot), { readonly: true, fileMustExist: true });
      const schema = database.prepare("select name from sqlite_master where type = 'table' and name in ('database', 'object_data')").all();
      const origin = database.prepare("select origin from database where name = 'keyval-store'").get()?.origin;
      const count = database.prepare('select count(*) as count from object_data').get()?.count || 0;
      database.close();
      if (schema.some((entry) => entry.name === 'database') && schema.some((entry) => entry.name === 'object_data')
        && origin === 'https://app.chathub.gg' && count > 0) {
        selected = candidate;
        selectedTemporaryRoot = temporaryRoot;
        break;
      }
    } catch {}
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  if (!selected || !selectedTemporaryRoot) throw new Error('ChatHub backup does not contain a Firefox IndexedDB keyval-store database.');

  try {
    const database = new Database(path.join(selectedTemporaryRoot, 'database.sqlite'), { readonly: true, fileMustExist: true });
    const rows = database.prepare('select key, data from object_data').all();
    database.close();
    return rows
      .filter((row) => Buffer.isBuffer(row.key) && Buffer.isBuffer(row.data))
      .map((row) => ({ key: decodeFirefoxKey(row.key), value: decodeFirefoxValue(row.data) }));
  } catch (error) {
    throw new Error(`Could not decode ChatHub Firefox IndexedDB backup: ${error.message}`);
  } finally {
    fs.rmSync(selectedTemporaryRoot, { recursive: true, force: true });
  }
}

module.exports = {
  decodeFirefoxValue,
  readFirefoxIndexedDbRecords,
};
