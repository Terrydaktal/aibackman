const fs = require('fs');
const readline = require('readline');
const { asUnixSeconds, compactTitle, stableId } = require('./utils.cjs');
const { STANDARD_CACHE_FORMAT_VERSION } = require('../archive/standard/cacheVersion.cjs');

function codeBlock(value, language = '') {
  const text = String(value ?? '');
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}${language}\n${text}\n${fence}`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
    if (block?.type === 'image') {
      if (/^image\/(png|jpeg|gif|webp|avif)$/.test(block.mimeType || '') && typeof block.data === 'string') {
        return [`![Image](data:${block.mimeType};base64,${block.data.replace(/\s/g, '')})`];
      }
      return ['[Image attachment]'];
    }
    return [];
  }).join('\n\n');
}

function internalContent(content) {
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return [block.thinking];
    if (block?.type === 'toolCall') {
      return [`Tool: ${String(block.name || 'unknown')}\n\n${codeBlock(JSON.stringify(block.arguments ?? {}, null, 2), 'json')}`];
    }
    return [];
  }).join('\n\n');
}

// Parse Pi's JSONL directly. Calling Pi's SessionManager would migrate and rewrite
// source files; archive imports must leave the original sessions untouched.
async function parsePiSession(filePath) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const states = new Map();
  const messages = [];
  let header = null;
  let conversationId = null;
  let previousEntryId = null;
  let currentNodeId = null;
  let name = '';
  let createdAt = 0;
  let updatedAt = 0;
  let lineNumber = 0;
  let parseErrors = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line.replace(/^\uFEFF/, ''));
      } catch {
        // JSON errors can contain source text. Return counts, never that text.
        parseErrors += 1;
        continue;
      }
      if (!header) {
        if (entry?.type !== 'session' || typeof entry.id !== 'string' || !entry.id) {
          return { conversation: null, parseErrors, unsupported: true };
        }
        if (![1, 2, 3].includes(Number(entry.version ?? 1))) {
          return { conversation: null, parseErrors, unsupported: true };
        }
        header = entry;
        conversationId = stableId('pi', header.id);
        createdAt = asUnixSeconds(header.timestamp, 0);
        updatedAt = createdAt;
        continue;
      }
      if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' || entry.type === 'session') {
        parseErrors += 1;
        continue;
      }

      const legacy = Number(header.version ?? 1) === 1;
      const entryId = typeof entry.id === 'string' && entry.id ? entry.id : legacy ? `line-${lineNumber}` : null;
      const parentEntryId = legacy ? previousEntryId : entry.parentId;
      if (!entryId || states.has(entryId) || (parentEntryId != null && !states.has(parentEntryId))) {
        parseErrors += 1;
        continue;
      }
      const state = {
        messageId: null, model: null, provider: null, effort: 'off',
        ...(states.get(parentEntryId) || {}),
      };
      const timestamp = asUnixSeconds(entry.timestamp, createdAt + lineNumber * 0.001);
      updatedAt = Math.max(updatedAt, timestamp);
      if (entry.type === 'model_change') {
        state.model = entry.modelId || null;
        state.provider = entry.provider || null;
      } else if (entry.type === 'thinking_level_change') {
        state.effort = entry.thinkingLevel || null;
      } else if (entry.type === 'session_info') {
        name = typeof entry.name === 'string' ? entry.name.trim() : '';
      }

      const message = entry.type === 'message' ? entry.message
        : entry.type === 'custom_message' ? { ...entry, role: 'custom' } : null;
      if (message?.role === 'assistant') {
        state.model = message.model || state.model;
        state.provider = message.provider || state.provider;
        state.effort = message.thinking_effort ?? message.reasoning_effort ?? state.effort;
      }
      const metadata = {
        source: 'pi-local', originalId: entryId, entryType: entry.type,
        sessionId: header.id, cwd: header.cwd || null,
        ...(header.parentSession ? { parentSession: header.parentSession } : {}),
        ...(state.model ? { model: state.model } : {}),
        ...(state.provider ? { provider: state.provider } : {}),
        ...(state.effort ? { thinking_effort: state.effort } : {}),
      };
      const append = (role, content, extra = {}, part = 'message') => {
        const id = stableId('pimsg', JSON.stringify([header.id, entryId, part]));
        messages.push({
          id, conversation_id: conversationId, role, content,
          created_at: message?.timestamp != null ? asUnixSeconds(message.timestamp, timestamp) : timestamp,
          parent_id: state.messageId,
          metadata_json: JSON.stringify({ ...metadata, ...extra }),
        });
        state.messageId = id;
      };

      if (message && typeof message.role === 'string') {
        const extra = { originalRole: message.role };
        for (const key of ['api', 'usage', 'stopReason', 'errorMessage', 'toolName', 'toolCallId', 'isError', 'exitCode', 'cancelled', 'truncated', 'fullOutputPath', 'customType']) {
          if (message[key] != null) extra[key] = message[key];
        }
        if (message.role === 'assistant') {
          const internal = internalContent(message.content);
          if (internal) append('tool', internal, { ...extra, is_visually_hidden_from_conversation: true }, 'thinking');
          const text = contentText(message.content);
          if (text || !internal) append('assistant', text || message.errorMessage || '', extra);
        } else if (message.role === 'user') {
          append('user', contentText(message.content), extra);
        } else if (message.role === 'toolResult') {
          append('tool', contentText(message.content), extra);
        } else if (message.role === 'bashExecution') {
          append('tool', `${codeBlock(message.command, 'bash')}\n\n${codeBlock(message.output)}`, extra);
        } else if (['custom', 'hookMessage'].includes(message.role)) {
          append(message.display === false ? 'system' : 'assistant', contentText(message.content), extra);
        } else {
          append('system', contentText(message.content) || message.summary || '', extra);
        }
      } else if (['compaction', 'branch_summary'].includes(entry.type)) {
        append('system', String(entry.summary || ''), { tokensBefore: entry.tokensBefore, fromId: entry.fromId });
      } else if (entry.type === 'message') {
        parseErrors += 1;
      }

      states.set(entryId, state);
      previousEntryId = entryId;
      currentNodeId = state.messageId;
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!header) return { conversation: null, parseErrors, unsupported: true };
  const firstUser = messages.find((message) => message.role === 'user');
  return {
    parseErrors,
    unsupported: false,
    conversation: {
      id: conversationId,
      title: compactTitle(name || firstUser?.content, 'Pi session'),
      created_at: createdAt, updated_at: updatedAt, last_synced_updated_at: updatedAt,
      current_node_id: currentNodeId,
      cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
      messages,
    },
  };
}

module.exports = { parsePiSession };
