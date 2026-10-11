const fs = require('fs');
const { StringDecoder } = require('string_decoder');

// A synchronous iterator intended for archive workers. Only one array element
// (usually one conversation) is decoded at a time, including UTF-8 split reads.
function* jsonArray(filePath, chunkBytes = 64 * 1024) {
  const descriptor = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let started = false, ended = false, quoted = false, escaped = false;
  let depth = 0, value = '', afterComma = false;
  function* consume(text) {
    for (const character of text) {
      if (!started) {
        if (/[ \t\r\n]/.test(character)) continue;
        if (character !== '[') throw new SyntaxError('Expected a JSON array.');
        started = true;
        continue;
      }
      if (ended) {
        if (!/[ \t\r\n]/.test(character)) throw new SyntaxError('Unexpected data after JSON array.');
        continue;
      }
      if (!quoted && depth === 0 && (character === ',' || character === ']')) {
        if (value.replace(/[ \t\r\n]/g, '')) yield JSON.parse(value);
        else if (character === ',' || afterComma) throw new SyntaxError('Missing JSON array element.');
        value = '';
        afterComma = character === ',';
        ended = character === ']';
        continue;
      }
      value += character;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '[' || character === '{') depth += 1;
      else if (character === ']' || character === '}') depth -= 1;
    }
  }
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) yield* consume(decoder.write(buffer.subarray(0, bytes)));
    yield* consume(decoder.end());
    if (!started || !ended || quoted || depth !== 0) throw new SyntaxError('Incomplete JSON array.');
  } finally { fs.closeSync(descriptor); }
}

function readJsonCollection(filePath, { property = null, arrayProperty = null, message = 'Backup must contain a JSON array.' } = {}) {
  const descriptor = fs.openSync(filePath, 'r');
  const prefix = Buffer.alloc(4096);
  let first = '';
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, prefix, 0, prefix.length, null)) > 0) {
      first = prefix.subarray(0, bytes).toString('utf8').trimStart()[0] || '';
      if (first) break;
    }
  } finally { fs.closeSync(descriptor); }
  let iterable;
  if (first === '[' && !property) iterable = jsonArray(filePath);
  else {
    const root = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    iterable = property ? root?.[property] : (Array.isArray(root) ? root : root?.[arrayProperty]);
    if (!Array.isArray(iterable)) throw new Error(message);
  }
  const collection = { length: 0, *[Symbol.iterator]() {
    for (const entry of iterable) { collection.length += 1; yield entry; }
  } };
  return collection;
}

module.exports = { jsonArray, readJsonCollection };
