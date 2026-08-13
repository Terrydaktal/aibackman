const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { asUnixSeconds, compactTitle, fileFingerprint, parseJsonFile, stableId } = require('./utils.cjs');
const { DEFAULT_GEMINI_ROOT, readGoogleAccounts } = require('./google-accounts.cjs');

const DEFAULT_ROOT = path.join(DEFAULT_GEMINI_ROOT, 'antigravity-cli');

function discoverAccounts(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const geminiRoot = options.geminiRoot || path.dirname(root);
  if (!fs.existsSync(root)) return [];
  const { active } = readGoogleAccounts(geminiRoot);
  return [{
    id: 'antigravity-local',
    label: active || 'Local Antigravity',
    sourceKind: 'local',
    sourceConfig: { root, ...(active ? { accountEmail: active } : {}) },
  }];
}

function extractUserRequest(content) {
  const raw = String(content || '');
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return String(match?.[1] || raw.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '')).trim();
}

async function parseTranscript(filePath, conversationId) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const messages = [];
  let parentId = null;
  let occurrence = 0;
  let parseErrors = 0;
  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    let role = null;
    let content = '';
    if (event.type === 'USER_INPUT') {
      role = 'user';
      content = extractUserRequest(event.content);
    } else if (event.type === 'PLANNER_RESPONSE' && event.source === 'MODEL') {
      role = 'assistant';
      content = String(event.content || '').trim();
    }
    if (!role || !content) continue;
    const sequence = Number.isFinite(Number(event.step_index)) ? Number(event.step_index) : occurrence;
    const id = stableId('antimsg', `${conversationId}:${sequence}:${occurrence}:${role}`);
    messages.push({
      id,
      conversation_id: conversationId,
      role,
      content,
      metadata_json: JSON.stringify({ source: 'antigravity-local', eventType: event.type, stepIndex: sequence }),
      created_at: asUnixSeconds(event.created_at, Date.now() / 1000 + occurrence * 0.001),
      parent_id: parentId,
    });
    parentId = id;
    occurrence += 1;
  }
  return { messages, parseErrors };
}

async function refreshLocal({ db, sourceConfig = {}, onProgress }) {
  const root = sourceConfig.root || DEFAULT_ROOT;
  const brainRoot = path.join(root, 'brain');
  const metadataPath = path.join(root, 'cache', 'conversation_metadata.json');
  const metadata = fs.existsSync(metadataPath) ? parseJsonFile(metadataPath)?.conversations || {} : {};
  const conversationIds = fs.existsSync(brainRoot)
    ? fs.readdirSync(brainRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  let importedConversations = 0;
  let importedMessages = 0;
  let skippedFiles = 0;
  let parseErrors = 0;

  for (let index = 0; index < conversationIds.length; index += 1) {
    const conversationId = conversationIds[index];
    const transcriptPath = path.join(brainRoot, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) continue;
    const fingerprint = fileFingerprint(transcriptPath);
    const sourceKey = `antigravity:${conversationId}`;
    if (db.getSourceItem(sourceKey)?.fingerprint === fingerprint) {
      skippedFiles += 1;
      continue;
    }
    const parsed = await parseTranscript(transcriptPath, conversationId);
    parseErrors += parsed.parseErrors;
    if (parsed.messages.length > 0) {
      const summary = metadata[conversationId]?.summary || {};
      const firstUser = parsed.messages.find((message) => message.role === 'user');
      const createdAt = parsed.messages[0].created_at;
      const updatedAt = asUnixSeconds(summary.UpdatedAt, parsed.messages.at(-1).created_at);
      db.importConversationSnapshot({
        id: conversationId,
        title: compactTitle(summary.Title || summary.Preview || firstUser?.content, 'Antigravity chat'),
        created_at: createdAt,
        updated_at: updatedAt,
        last_synced_updated_at: updatedAt,
        current_node_id: parsed.messages.at(-1).id,
        is_deleted_on_web: 0,
      }, parsed.messages, { replaceMessages: true });
      importedConversations += 1;
      importedMessages += parsed.messages.length;
    }
    db.upsertSourceItem({ sourceKey, sourcePath: transcriptPath, fingerprint });
    onProgress?.({ current: index + 1, total: conversationIds.length, conversationId });
  }
  return { importedConversations, importedMessages, skippedFiles, parseErrors, sourceItems: conversationIds.length };
}

module.exports = {
  id: 'antigravity',
  name: 'Antigravity',
  description: 'Local Antigravity coding-agent transcripts',
  accent: '#ea4335',
  capabilities: { localBackup: true },
  discoverAccounts,
  refreshLocal,
};
