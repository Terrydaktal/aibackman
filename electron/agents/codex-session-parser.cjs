const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { asUnixSeconds } = require('./utils.cjs');

function extractAccountId(event) {
  const payload = event?.payload || {};
  return event?.account_id
    || payload.account_id
    || payload.info?.account_id
    || payload.info?.total_token_usage?.account_id
    || null;
}

async function parseSession(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = path.basename(filePath, '.jsonl').replace(/^rollout-[^-]+-/, '');
  let cwd = '';
  let sessionMetadataSeen = false;
  let isSubagent = false;
  let parentSessionId = null;
  let accountId = null;
  const accountIds = new Set();
  let currentModel = null;
  let currentEffort = null;
  let sequence = 0;
  let parseErrors = 0;
  const visible = [];

  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (event.type === 'session_meta' && !sessionMetadataSeen) {
      const metadata = event.payload && typeof event.payload === 'object' ? event.payload : {};
      sessionMetadataSeen = true;
      sessionId = String(metadata.id || metadata.session_id || sessionId);
      cwd = String(metadata.cwd || '');
      parentSessionId = metadata.parent_thread_id || metadata.forked_from_id || null;
      isSubagent = Boolean(
        metadata.thread_source === 'subagent'
        || metadata.source?.subagent
        || parentSessionId
      );
    }
    const eventAccountId = extractAccountId(event);
    if (eventAccountId) {
      accountId = String(eventAccountId);
      accountIds.add(accountId);
    }
    const eventPayload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const contextModel = event.model || eventPayload.model || eventPayload.model_slug || eventPayload.model_name;
    const contextEffort = event.effort || event.reasoning_effort || eventPayload.effort
      || eventPayload.reasoning_effort || eventPayload.thinking_effort;
    if (contextModel) currentModel = String(contextModel).trim() || currentModel;
    if (contextEffort) currentEffort = String(contextEffort).trim() || currentEffort;
    if (event.type !== 'event_msg') continue;
    const eventType = event.payload?.type;
    if (eventType !== 'user_message' && eventType !== 'agent_message') continue;
    const content = String(event.payload?.message || '').trim();
    if (!content) continue;
    visible.push({
      sequence,
      role: eventType === 'user_message' ? 'user' : 'assistant',
      content,
      phase: event.payload?.phase || null,
      model: currentModel,
      effort: currentEffort,
      createdAt: asUnixSeconds(event.timestamp, Date.now() / 1000 + sequence * 0.001),
    });
    sequence += 1;
  }

  return {
    sessionId,
    cwd,
    accountId,
    accountIds: [...accountIds],
    visible,
    parseErrors,
    isSubagent,
    parentSessionId: parentSessionId == null ? null : String(parentSessionId),
  };
}

module.exports = { parseSession };
