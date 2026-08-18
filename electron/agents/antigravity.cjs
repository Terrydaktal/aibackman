const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { asUnixSeconds, compactTitle, fileFingerprint, parseJsonFile, stableId } = require('./utils.cjs');
const { writeNormalizedConversation } = require('../archive/standard/index.cjs');
const { DEFAULT_GEMINI_ROOT, readGoogleAccounts } = require('./google-accounts.cjs');

const DEFAULT_ROOT = path.join(DEFAULT_GEMINI_ROOT, 'antigravity-cli');
const ANTIGRAVITY_ROUTING_VERSION = 2;

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

function firstNonEmptyValue(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || null;
}

function extractModelMetadata(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const payloadMetadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  return {
    model: firstNonEmptyValue(
      event?.model,
      event?.model_slug,
      event?.model_name,
      event?.model_id,
      payload.model,
      payload.model_slug,
      payload.model_name,
      payload.model_id,
      metadata.model,
      metadata.model_slug,
      metadata.model_name,
      payloadMetadata.model,
      payloadMetadata.model_slug,
      payloadMetadata.model_name,
    ),
    effort: firstNonEmptyValue(
      event?.thinking_effort,
      event?.reasoning_effort,
      event?.effort,
      event?.thinking_level,
      payload.thinking_effort,
      payload.reasoning_effort,
      payload.effort,
      payload.thinking_level,
      payloadMetadata.thinking_effort,
      payloadMetadata.reasoning_effort,
      payloadMetadata.effort,
      payloadMetadata.thinking_level,
    ),
  };
}

async function parseTranscript(filePath, conversationId) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const messages = [];
  let parentId = null;
  let occurrence = 0;
  let currentModel = null;
  let currentEffort = null;
  let parseErrors = 0;
  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    const extractedMetadata = extractModelMetadata(event);
    currentModel = extractedMetadata.model || currentModel;
    currentEffort = extractedMetadata.effort || currentEffort;
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
      metadata_json: JSON.stringify({
        source: 'antigravity-local',
        eventType: event.type,
        stepIndex: sequence,
        ...(currentModel ? { model: currentModel } : {}),
        ...(currentEffort ? { thinking_effort: currentEffort } : {}),
      }),
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
    const sourceItem = db.getSourceItem(sourceKey);
    let sourceMetadata = {};
    try {
      sourceMetadata = sourceItem?.metadata_json ? JSON.parse(sourceItem.metadata_json) : {};
    } catch {
      sourceMetadata = {};
    }
    if (sourceItem?.fingerprint === fingerprint && sourceMetadata.routingVersion === ANTIGRAVITY_ROUTING_VERSION) {
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
      writeNormalizedConversation(db, {
        id: conversationId,
        title: compactTitle(summary.Title || summary.Preview || firstUser?.content, 'Antigravity session'),
        created_at: createdAt,
        updated_at: updatedAt,
        last_synced_updated_at: updatedAt,
        current_node_id: parsed.messages.at(-1).id,
        is_deleted_on_web: 0,
        messages: parsed.messages,
      }, { replaceMessages: true });
      importedConversations += 1;
      importedMessages += parsed.messages.length;
    }
    db.upsertSourceItem({
      sourceKey,
      sourcePath: transcriptPath,
      fingerprint,
      metadata: { routingVersion: ANTIGRAVITY_ROUTING_VERSION },
    });
    onProgress?.({ current: index + 1, total: conversationIds.length, conversationId });
  }
  return { importedConversations, importedMessages, skippedFiles, parseErrors, sourceItems: conversationIds.length };
}

module.exports = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  description: 'Local Antigravity coding-agent transcripts',
  accent: '#ea4335',
  capabilities: { localBackup: true },
  discoverAccounts,
  refreshLocal,
};
