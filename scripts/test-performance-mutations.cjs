const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repository = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-mutants-'));
try {
  for (const mutant of [
    { id: 'hidden-messages-counted', file: 'electron/archive/standard/summaries.cjs', from: "'$.is_visually_hidden_from_conversation'), 0) != 1", to: "'$.is_visually_hidden_from_conversation'), 0) != 2" },
    { id: 'audit-tampering-accepted', file: 'electron/archive/safety/journal.cjs', from: 'integrity.previous_hash !== previousHash || integrity.hash !== expected', to: 'false && integrity.previous_hash !== previousHash && integrity.hash !== expected' },
    { id: 'duplicate-conversation-read', file: 'electron/archive/standard/reader.cjs', from: 'const currentMessages = currentMessagesFromRows(conversation, allMessages);', to: 'const currentMessages = currentMessagesFromRows(conversation, db.getMessages(conversationId));' },
  ]) {
    const copy = path.join(root, mutant.id);
    fs.mkdirSync(path.join(copy, 'scripts'), { recursive: true });
    fs.cpSync(path.join(repository, 'electron'), path.join(copy, 'electron'), { recursive: true });
    fs.cpSync(path.join(repository, 'scripts/fixtures'), path.join(copy, 'scripts/fixtures'), { recursive: true });
    fs.copyFileSync(path.join(repository, 'scripts/test-performance-optimizations.cjs'), path.join(copy, 'scripts/test-performance-optimizations.cjs'));
    fs.symlinkSync(path.join(repository, 'node_modules'), path.join(copy, 'node_modules'));
    const file = path.join(copy, mutant.file);
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(mutant.from), `Mutation target missing: ${mutant.id}`);
    fs.writeFileSync(file, source.replace(mutant.from, mutant.to));
    const result = spawnSync(process.execPath, [path.join(copy, 'scripts/test-performance-optimizations.cjs')],
      { encoding: 'utf8', timeout: 15000, env: process.env });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `Mutant survived: ${mutant.id}`);
    assert.match(result.stderr, /AssertionError/, `Mutant must fail a semantic oracle, not infrastructure: ${mutant.id}`);
    console.log(`Rejected semantic mutant: ${mutant.id}`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
