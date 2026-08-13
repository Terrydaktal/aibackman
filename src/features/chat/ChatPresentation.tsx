import React, { useState, memo, useCallback, useMemo } from 'react';
import type { Conversation, Message } from '../../types';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { HighlightText } from '../../components/HighlightText';
import {
  countSearchTextMatches,
  createWhitespaceFlexibleSearchRegExp,
} from '../../search/nativeHighlights';
import 'katex/dist/katex.min.css';
import '../../index.css';

const escapeRegExp = (value: unknown) => {
  const string = typeof value === 'string' ? value : String(value ?? '');
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_MESSAGE_HIGHLIGHT_HITS = 240;
const MAX_MAP_SEARCH_QUERY_LEN = 160;
const MAX_MARKDOWN_RENDER_CHARS = 30000;
const MAX_MARKDOWN_RENDER_LINES = 1200;
const MAX_MARKDOWN_MATH_DELIMITERS = 180;
const MAX_MARKDOWN_LATEX_COMMANDS = 320;
const MAX_MARKDOWN_CDOT_COMMANDS = 80;
const MIN_PLAIN_LATEX_COMMANDS = 6;
const MIN_PLAIN_LATEX_LINES = 8;
const MAX_CODE_HIGHLIGHT_CHARS = 8000;
const MAX_CODE_HIGHLIGHT_LINES = 400;
const MAX_SAFE_FALLBACK_CHARS = 120000;
const getMessagePreview = (content: string) => {
  const normalized = content
    .replace(/cite[^]*/g, ' ')
    .replace(/products[\s\S]*?(?:|$)/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' [image] ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '[empty]';
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
};

const normalizeMathDelimiters = (content: string) => {
  const segments = content.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment) => {
      if (segment.startsWith('```')) return segment;
      return segment
        .replace(/\\\[(.*?)\\\]/gs, (_match, expr: string) => `\n$$\n${expr.trim()}\n$$\n`)
        .replace(/\\\((.*?)\\\)/gs, (_match, expr: string) => `$${expr.trim()}$`);
    })
    .join('');
};

const normalizeCitationMarkers = (content: string) => {
  const citationOrder = new Map<string, number>();
  let nextCitation = 1;

  const citationNumber = (id: string) => {
    if (!citationOrder.has(id)) citationOrder.set(id, nextCitation++);
    return citationOrder.get(id)!;
  };

  return content
    .replace(/cite([^]+)/g, (_match, rawRefs: string) => {
      const refs = rawRefs
        .split('')
        .map((ref) => ref.trim())
        .filter(Boolean);
      if (refs.length === 0) return '';
      return refs.map((id) => {
        const n = citationNumber(id);
        return `[${n}](citation://${id})`;
      }).join(' ');
    })
    .replace(/cite/g, '')
    .replace(//g, '');
};

const normalizeProductsMarkers = (content: string) => {
  return content.replace(/products(\{[\s\S]*?\})(?:|$)/g, (_match, rawJson: string) => {
    try {
      const parsed = JSON.parse(rawJson) as { selections?: unknown; tags?: unknown };
      const selections = Array.isArray(parsed?.selections) ? parsed.selections : [];
      const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
      if (selections.length === 0) return '';

      const lines = ['\n**Products**\n'];
      selections.forEach((item, idx) => {
        if (!Array.isArray(item) || item.length < 2) return;
        const id = typeof item[0] === 'string' ? item[0].trim() : '';
        const label = typeof item[1] === 'string' ? item[1].trim() : '';
        if (!label) return;
        const tag = typeof tags[idx] === 'string' ? tags[idx].trim() : '';

        const prefix = `${idx + 1}. `;
        const product = id ? `[${label}](productref://${encodeURIComponent(id)})` : label;
        lines.push(tag ? `${prefix}${product} - ${tag}` : `${prefix}${product}`);
      });

      return lines.join('\n');
    } catch {
      return '';
    }
  });
};

type ThinkingPart = Pick<Message, 'id' | 'role' | 'content'>;
type BranchOption = {
  childId: string;
  role: Message['role'];
  preview: string;
};
type BranchInfo = {
  parentId: string;
  options: BranchOption[];
  activeChildId: string;
};
type DisplayMessage = Message & {
  thinkingParts?: ThinkingPart[];
  branchInfo?: BranchInfo;
  embeddedUi?: EmbeddedUiEntry[];
  isBridgeStatus?: boolean;
  bridgeStatusState?: string;
};
const isNavigableMessage = (msg: Message | DisplayMessage) => {
  if ('isBridgeStatus' in msg && msg.isBridgeStatus) return false;
  return (msg.role === 'user' || msg.role === 'assistant') && !!msg.content?.trim();
};
type CitationEntry = { id: string; url?: string; title?: string };
type BridgeComposerStatus = {
  conversationId: string | null;
  state: string;
  ready: boolean;
  reason?: string;
  updatedAt?: number;
};

class MarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode; rawContent: string; conversationId?: string },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode; rawContent: string; conversationId?: string }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown markdown render error');
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('Markdown render failed:', {
      conversationId: this.props.conversationId || null,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: info?.componentStack,
    });
  }

  componentDidUpdate(prevProps: { children: React.ReactNode; rawContent: string; conversationId?: string }) {
    if (
      this.state.hasError
      && (
        prevProps.rawContent !== this.props.rawContent
        || prevProps.conversationId !== this.props.conversationId
      )
    ) {
      this.setState({ hasError: false, message: '' });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="markdown-fallback">
          <div className="markdown-fallback-title">Rendering failed for this message.</div>
          <pre>{this.props.rawContent || ''}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const formatSendError = (error: unknown) => {
  const message = typeof error === 'string'
    ? error
    : (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'Failed to send message.');

  if (/unusual activity has been detected/i.test(message)) {
    return 'Send blocked by ChatGPT (403 unusual activity). Complete any verification on chatgpt.com, then retry. If it persists, wait a few minutes and try again.';
  }
  return message;
};

const normalizeForSendVerification = (content: string) => content
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .replace(/[`*_~>#]/g, '')
  .replace(/[()[\]{}]/g, '')
  .trim();

const matchesSentUserContent = (candidateContent: string, sentContent: string) => {
  const candidate = normalizeForSendVerification(candidateContent);
  const sent = normalizeForSendVerification(sentContent);
  if (!sent) return true;
  if (!candidate) return false;
  if (candidate.includes(sent) || sent.includes(candidate)) return true;

  // Large pasted/math-heavy messages may be normalized differently by upstream.
  if (sent.length >= 64 && candidate.length >= 64) {
    const start = sent.slice(0, 96);
    const end = sent.slice(-96);
    if (candidate.includes(start) && candidate.includes(end)) return true;
  }

  return false;
};

const summarizeMetadataOnlyStep = (msg: Message) => {
  if (!msg.metadata_json) return '';
  try {
    const meta = JSON.parse(msg.metadata_json) as Record<string, unknown>;
    const lines: string[] = [];

    if (typeof meta.reasoning_title === 'string' && meta.reasoning_title.trim()) {
      lines.push(`Reasoning: ${meta.reasoning_title.trim()}`);
    } else if (typeof meta.reasoning_status === 'string' && meta.reasoning_status.trim()) {
      lines.push(`Reasoning status: \`${meta.reasoning_status.trim()}\``);
    }
    if (meta.is_thinking_preamble_message) lines.push('Thinking preamble step');
    if (meta.is_visually_hidden_from_conversation) lines.push('Hidden internal step');

    if (meta.aggregate_result && typeof meta.aggregate_result === 'object') {
      const aggregateResult = meta.aggregate_result as Record<string, unknown>;
      const status = typeof aggregateResult.status === 'string' ? aggregateResult.status : 'available';
      lines.push(`Tool aggregate result: \`${status}\``);
    } else if (msg.role === 'tool') {
      lines.push('Tool step (no text output)');
    }

    if (lines.length === 0 && meta.finish_details && typeof meta.finish_details === 'object') {
      const finishDetails = meta.finish_details as Record<string, unknown>;
      if (typeof finishDetails.type === 'string') lines.push(`Finish: \`${finishDetails.type}\``);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
};

const isThinkingArtifactMessage = (msg: Message) => {
  if (!msg.metadata_json) return false;
  try {
    const metadata = JSON.parse(msg.metadata_json) as Record<string, unknown>;
    return metadata.is_thinking_preamble_message === true
      || metadata.is_visually_hidden_from_conversation === true;
  } catch {
    return false;
  }
};

const isVisibleConversationTurn = (msg: Message) => (
  (msg.role === 'user' || msg.role === 'assistant')
  && !!msg.content?.trim()
  && !isThinkingArtifactMessage(msg)
);

type EmbeddedUiEntry = {
  kind?: string;
  title?: string;
  src: string;
  height?: number;
  text?: string;
  markdown?: string;
  formatVersion?: number;
};

const DEEP_RESEARCH_IFRAME_HOST = 'connector_openai_deep_research.web-sandbox.oaiusercontent.com';
const DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION = 3;

const sanitizeEmbeddedUiEntries = (entries: unknown): EmbeddedUiEntry[] => {
  if (!Array.isArray(entries)) return [];
  const output: EmbeddedUiEntry[] = [];
  const seen = new Set<string>();

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const rawSrc = typeof entry.src === 'string' ? entry.src.trim() : '';
    if (!rawSrc) continue;

    try {
      const parsed = new URL(rawSrc);
      if (parsed.protocol !== 'https:' || parsed.hostname !== DEEP_RESEARCH_IFRAME_HOST) continue;
      const src = parsed.toString();
      if (seen.has(src)) continue;
      seen.add(src);
      output.push({
        kind: typeof entry.kind === 'string' ? entry.kind : 'deep-research',
        title: typeof entry.title === 'string' && entry.title.trim() && !/^internal:\/\//i.test(entry.title.trim())
          ? entry.title.trim()
          : 'Deep Research result',
        src,
        height: Math.max(320, Math.min(1200, Number(entry.height) || 484)),
        text: typeof entry.text === 'string' && entry.text.trim()
          ? entry.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
          : undefined,
        markdown: typeof entry.markdown === 'string' && entry.markdown.trim()
          ? entry.markdown.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
          : undefined,
        formatVersion: Number(entry.formatVersion) || 0,
      });
    } catch {
      // Ignore malformed or untrusted widget URLs.
    }
  }

  return output;
};

const getEmbeddedUiEntries = (msg: Message): EmbeddedUiEntry[] => {
  if (!msg.metadata_json) return [];
  try {
    const metadata = JSON.parse(msg.metadata_json) as Record<string, unknown>;
    return sanitizeEmbeddedUiEntries(metadata.embedded_ui);
  } catch {
    return [];
  }
};

const getDisplayMessageSearchText = (msg: DisplayMessage) => {
  const embeddedText = (msg.embeddedUi || []).flatMap((entry) => [
    entry.title || '',
    entry.markdown || entry.text || '',
  ]);
  return [msg.content || '', ...embeddedText].filter(Boolean).join('\n');
};

const buildCitationRegistry = (rawMessages: Message[]): Record<string, CitationEntry> => {
  const registry: Record<string, CitationEntry> = {};
  const markerIdPattern = 'turn\\d+[a-z]+\\d+';
  const trimPunctuation = (value: string) => value.replace(/[),.;!?]+$/, '');
  const citationIdRegex = /turn\d+[a-z]+\d+/i;
  const urlRegex = /https?:\/\/[^\s)\]}>"']+/i;

  const ensureEntry = (id: string) => {
    if (!registry[id]) registry[id] = { id };
    return registry[id];
  };

  const firstCitationId = (value: unknown) => {
    if (typeof value !== 'string') return null;
    const match = value.match(citationIdRegex);
    return match ? match[0] : null;
  };

  const firstUrl = (value: unknown) => {
    if (typeof value !== 'string') return null;
    const match = value.match(urlRegex);
    return match ? trimPunctuation(match[0]) : null;
  };

  const collectFromMetadata = (value: unknown, seen: Set<string>, depth = 0) => {
    if (!value || depth > 12) return;

    if (Array.isArray(value)) {
      for (const item of value) collectFromMetadata(item, seen, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    const stringValues = Object.values(obj).filter((v): v is string => typeof v === 'string');

    // ChatGPT metadata often stores citation ids in matched_text and URLs in safe_urls.
    const matchedText = typeof obj.matched_text === 'string' ? obj.matched_text : '';
    const safeUrls = Array.isArray(obj.safe_urls)
      ? obj.safe_urls.filter((u): u is string => typeof u === 'string').map((u) => trimPunctuation(u.trim())).filter(Boolean)
      : [];
    if (matchedText && safeUrls.length > 0) {
      const ids = Array.from(matchedText.matchAll(/turn\d+[a-z]+\d+/gi)).map((m) => m[0]);
      ids.forEach((id, idx) => {
        const url = safeUrls[idx] || safeUrls[0];
        if (!url) return;
        const dedupeKey = `${id}|${url}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        const entry = ensureEntry(id);
        if (!entry.url) entry.url = url;
      });
    }

    const id =
      firstCitationId(obj.ref_id)
      || firstCitationId(obj.citation_id)
      || firstCitationId(obj.source_id)
      || firstCitationId(obj.id)
      || stringValues.map((v) => firstCitationId(v)).find(Boolean)
      || null;

    const url =
      firstUrl(obj.url)
      || firstUrl(obj.href)
      || firstUrl(obj.link)
      || firstUrl(obj.uri)
      || stringValues.map((v) => firstUrl(v)).find(Boolean)
      || null;

    if (id && url) {
      const dedupeKey = `${id}|${url}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        const entry = ensureEntry(id);
        if (!entry.url) entry.url = url;
        if (!entry.title) {
          const title = typeof obj.title === 'string'
            ? obj.title.trim()
            : typeof obj.name === 'string'
              ? obj.name.trim()
              : '';
          if (title) entry.title = title;
        }
      }
    }

    for (const nested of Object.values(obj)) {
      if (nested && typeof nested === 'object') {
        collectFromMetadata(nested, seen, depth + 1);
      }
    }
  };

  const metadataSeen = new Set<string>();
  for (const msg of rawMessages) {
    if (!msg.metadata_json) continue;
    try {
      const parsed = JSON.parse(msg.metadata_json);
      collectFromMetadata(parsed, metadataSeen);
    } catch {
      // Ignore malformed cached metadata.
    }
  }

  const searchableMessages = rawMessages.filter((m) => m.content && m.content.trim());

  for (const msg of searchableMessages) {
    const text = msg.content;

    const inlinePattern = new RegExp(`([^\\n]{0,240}?)\\((https?:\\/\\/[^\\s)]+)\\)\\s*【(${markerIdPattern})】`, 'g');
    let inlineMatch: RegExpExecArray | null;
    while ((inlineMatch = inlinePattern.exec(text)) !== null) {
      const title = inlineMatch[1].replace(/^[\s*\-•]+/, '').trim();
      const url = trimPunctuation(inlineMatch[2].trim());
      const id = inlineMatch[3].trim();
      const entry = ensureEntry(id);
      if (!entry.url) entry.url = url;
      if (!entry.title && title) entry.title = title;
    }

    const markdownLinkWithMarkerPattern = new RegExp(`\\[([^\\]]{1,240})\\]\\((https?:\\/\\/[^\\s)]+)\\)\\s*【(${markerIdPattern})】`, 'g');
    let mdMatch: RegExpExecArray | null;
    while ((mdMatch = markdownLinkWithMarkerPattern.exec(text)) !== null) {
      const title = mdMatch[1].trim();
      const url = trimPunctuation(mdMatch[2].trim());
      const id = mdMatch[3].trim();
      const entry = ensureEntry(id);
      if (!entry.url) entry.url = url;
      if (!entry.title && title) entry.title = title;
    }

    const rawUrlWithMarkerPattern = new RegExp(`(https?:\\/\\/\\S+)\\s*【(${markerIdPattern})】`, 'g');
    let rawMatch: RegExpExecArray | null;
    while ((rawMatch = rawUrlWithMarkerPattern.exec(text)) !== null) {
      const url = trimPunctuation(rawMatch[1].trim());
      const id = rawMatch[2].trim();
      const entry = ensureEntry(id);
      if (!entry.url) entry.url = url;
    }

    const markerPattern = new RegExp(`【(${markerIdPattern})】`, 'g');
    let markerMatch: RegExpExecArray | null;
    while ((markerMatch = markerPattern.exec(text)) !== null) {
      const id = markerMatch[1];
      const entry = ensureEntry(id);
      if (entry.url) continue;

      const markerIndex = markerMatch.index;
      const windowStart = Math.max(0, markerIndex - 500);
      const windowEnd = Math.min(text.length, markerIndex + 500);
      const windowText = text.slice(windowStart, windowEnd);
      const urls = [...windowText.matchAll(/https?:\/\/[^\s)\]]+/g)];
      if (urls.length === 0) continue;

      const nearest = urls.reduce((best, current) => {
        const currentIndex = windowStart + (current.index || 0);
        const bestIndex = windowStart + (best.index || 0);
        return Math.abs(currentIndex - markerIndex) < Math.abs(bestIndex - markerIndex) ? current : best;
      });

      entry.url = trimPunctuation(nearest[0].trim());

      const lineStart = text.lastIndexOf('\n', markerIndex);
      const line = text.slice(lineStart + 1, markerIndex).trim();
      if (!entry.title && line) {
        entry.title = line.replace(/^[\d.\s*\-•]+/, '').trim();
      }
    }
  }

  return registry;
};

const sortMessagesChronologically = (a: Message, b: Message) => {
  const createdDelta = Number(a.created_at || 0) - Number(b.created_at || 0);
  if (createdDelta !== 0) return createdDelta;
  return String(a.id || '').localeCompare(String(b.id || ''));
};

const countVisibleTurnsInPath = (path: Message[]) => path.filter(isVisibleConversationTurn).length;

const resolvePreferredCurrentNodeId = (allMessages: Message[], currentNodeId: string | null) => {
  if (!currentNodeId) return null;
  if (!Array.isArray(allMessages) || allMessages.length === 0) return currentNodeId;

  const byId = new Map(allMessages.map((msg) => [msg.id, msg]));
  const lineage: Message[] = [];
  const seen = new Set<string>();
  let nodeId: string | null = currentNodeId;
  let guard = 0;
  while (nodeId && byId.has(nodeId) && !seen.has(nodeId) && guard < 20000) {
    seen.add(nodeId);
    const node: Message = byId.get(nodeId)!;
    lineage.push(node);
    nodeId = node.parent_id || null;
    guard += 1;
  }
  lineage.reverse();
  const currentVisibleCount = countVisibleTurnsInPath(lineage);
  const allVisibleCount = allMessages.filter(isVisibleConversationTurn).length;

  const currentLooksHealthy = currentVisibleCount > 0 && (
    (allVisibleCount < 8 || currentVisibleCount >= Math.max(4, Math.floor(allVisibleCount * 0.55)))
    && (allVisibleCount < 100 || (allVisibleCount - currentVisibleCount) < 20)
  );
  if (currentLooksHealthy) return currentNodeId;

  const childIds = new Set(
    allMessages
      .map((msg) => msg.parent_id || null)
      .filter((value): value is string => !!value)
  );
  const leafNodes = allMessages.filter((msg) => !childIds.has(msg.id));
  if (leafNodes.length === 0) return currentNodeId;

  let bestNodeId = currentNodeId;
  let bestVisibleCount = currentVisibleCount;
  let bestCreatedAt = Number(byId.get(currentNodeId)?.created_at || 0);
  for (const leaf of leafNodes) {
    const leafLineage: Message[] = [];
    const visited = new Set<string>();
    let leafNodeId: string | null = leaf.id;
    let leafGuard = 0;
    while (leafNodeId && byId.has(leafNodeId) && !visited.has(leafNodeId) && leafGuard < 20000) {
      visited.add(leafNodeId);
      const node: Message = byId.get(leafNodeId)!;
      leafLineage.push(node);
      leafNodeId = node.parent_id || null;
      leafGuard += 1;
    }
    leafLineage.reverse();
    const visibleCount = countVisibleTurnsInPath(leafLineage);
    const createdAt = Number(leaf.created_at || 0);
    if (
      visibleCount > bestVisibleCount
      || (visibleCount === bestVisibleCount && createdAt > bestCreatedAt)
    ) {
      bestNodeId = leaf.id;
      bestVisibleCount = visibleCount;
      bestCreatedAt = createdAt;
    }
  }

  return bestNodeId;
};

const buildLinearConversationPath = (
  rawMessages: Message[],
  currentNodeId: string | null,
  selectedChildByParent: Record<string, string> = {}
) => {
  const orderedMessages = [...rawMessages].sort(sortMessagesChronologically);
  const byId = new Map(orderedMessages.map((msg) => [msg.id, msg]));
  const childrenByParent = new Map<string, Message[]>();
  for (const msg of orderedMessages) {
    const parentId = msg.parent_id || '';
    if (!parentId || !byId.has(parentId)) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId)!.push(msg);
  }
  for (const children of childrenByParent.values()) {
    children.sort(sortMessagesChronologically);
  }

  const effectiveCurrentNodeId = resolvePreferredCurrentNodeId(orderedMessages, currentNodeId);
  const activeLineage = new Set<string>();
  let walkerId: string | null = effectiveCurrentNodeId;
  let guard = 0;
  while (walkerId && byId.has(walkerId) && !activeLineage.has(walkerId) && guard < 20000) {
    activeLineage.add(walkerId);
    walkerId = byId.get(walkerId)?.parent_id || null;
    guard += 1;
  }

  const rootCandidates = orderedMessages.filter((msg) => !msg.parent_id || !byId.has(msg.parent_id));
  const root = rootCandidates.find((msg) => activeLineage.has(msg.id)) || rootCandidates[0] || null;
  const branchInfoByMessageId = new Map<string, BranchInfo>();
  const path: Message[] = [];
  const visited = new Set<string>();
  let current = root;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    const children = childrenByParent.get(current.id) || [];
    if (children.length === 0) break;

    let activeChild = children.find((child) => child.id === selectedChildByParent[current.id]) || null;
    if (!activeChild) {
      activeChild = children.find((child) => activeLineage.has(child.id)) || null;
    }
    if (!activeChild) {
      activeChild = children[children.length - 1] || null;
    }

    if (children.length > 1 && activeChild) {
      branchInfoByMessageId.set(current.id, {
        parentId: current.id,
        options: children.map((child) => ({
          childId: child.id,
          role: child.role,
          preview: getMessagePreview(child.content || child.role),
        })),
        activeChildId: activeChild.id,
      });
    }

    current = activeChild;
  }

  return {
    pathMessages: path.map((msg) => {
      const branchInfo = branchInfoByMessageId.get(msg.id);
      return branchInfo ? { ...msg, branchInfo } : msg;
    }),
    effectiveCurrentNodeId,
  };
};

const buildDisplayMessages = (rawMessages: Message[]): DisplayMessage[] => {
  const output: DisplayMessage[] = [];
  const embeddedUiSeen = new Set<string>();
  const segmentable = rawMessages.filter((m) => (m.content && m.content.trim()) || !!m.metadata_json);

  const flushSegment = (segment: Message[]) => {
    if (segment.length === 0) return;
    const pendingThinkingParts: ThinkingPart[] = [];
    let lastAssistantIndex = -1;

    const flushPendingThinkingToLastAssistant = () => {
      if (pendingThinkingParts.length === 0 || lastAssistantIndex < 0) return;
      const lastAssistant = output[lastAssistantIndex];
      const existing = lastAssistant.thinkingParts || [];
      lastAssistant.thinkingParts = existing.concat(pendingThinkingParts.splice(0));
    };

    for (const message of segment) {
      const visible = (message.content || '').trim();

      // Tool messages normally remain in the expandable thinking section. A Deep Research
      // widget is actual answer content, so promote it to a visible assistant row.
      const embeddedUi = message.role !== 'user'
        ? getEmbeddedUiEntries(message).filter((entry) => !embeddedUiSeen.has(entry.src))
        : [];
      if (embeddedUi.length > 0) {
        embeddedUi.forEach((entry) => embeddedUiSeen.add(entry.src));
        flushPendingThinkingToLastAssistant();
        const genericWidgetText = /the tool included embedded ui|rendered a widget that contains the deep research experience|^internal:\/\/deep-research$/i.test(visible);
        output.push({
          ...message,
          role: 'assistant',
          content: genericWidgetText ? '' : visible,
          embeddedUi,
          thinkingParts: undefined,
        });
        lastAssistantIndex = output.length - 1;
        continue;
      }

      if (visible && isThinkingArtifactMessage(message)) {
        pendingThinkingParts.push({ id: message.id, role: message.role, content: message.content });
        continue;
      }

      if (message.role === 'user') {
        flushPendingThinkingToLastAssistant();
        if (visible) output.push({ ...message });
        continue;
      }

      if (message.role === 'assistant' && visible) {
        output.push({
          ...message,
          thinkingParts: pendingThinkingParts.length > 0 ? pendingThinkingParts.splice(0) : undefined,
        });
        lastAssistantIndex = output.length - 1;
        continue;
      }

      const content = visible ? message.content : summarizeMetadataOnlyStep(message);
      if (!content?.trim()) continue;
      pendingThinkingParts.push({ id: message.id, role: message.role, content });
    }

    flushPendingThinkingToLastAssistant();
  };

  let segment: Message[] = [];
  for (const msg of segmentable) {
    if (msg.role === 'user' && segment.length > 0) {
      flushSegment(segment);
      segment = [msg];
    } else {
      segment.push(msg);
    }
  }
  flushSegment(segment);

  return output;
};

const countNeedleHits = (text: string, needleLower: string) => {
  return countSearchTextMatches(text, needleLower, MAX_MESSAGE_HIGHLIGHT_HITS + 1);
};

const sanitizeMapSearchQuery = (raw: string) => {
  const value = String(raw || '').replace(/\s+/g, ' ');
  if (!value.trim()) return '';
  return value.slice(0, MAX_MAP_SEARCH_QUERY_LEN);
};

const countLines = (text: string) => {
  if (!text) return 0;
  return 1 + (text.match(/\n/g)?.length || 0);
};

const findTextOccurrenceRect = (root: Element, query: string, occurrenceIndex: number): DOMRect | null => {
  const needle = typeof query === 'string' ? query.trim() : '';
  const matcher = createWhitespaceFlexibleSearchRegExp(needle, 'giu');
  if (!matcher || occurrenceIndex < 0) return null;

  let seen = 0;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const value = node.nodeValue || '';
        if (!value.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue || '';
    matcher.lastIndex = 0;
    let match = matcher.exec(value);
    while (match) {
      const idx = match.index;
      if (seen === occurrenceIndex) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + match[0].length);
        const rect = range.getClientRects()[0] || range.getBoundingClientRect();
        range.detach();
        return rect || null;
      }
      seen += 1;
      match = matcher.exec(value);
    }
    node = walker.nextNode();
  }

  return null;
};

const countRegexMatches = (text: string, pattern: RegExp) => {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
};

const CHAT_IMAGE_MARKDOWN_PATTERN = /!\[([^\]]*?)\]\((chatgpt-image:\/\/[^)\s]+)\)/g;
const HAS_CHAT_IMAGE_MARKDOWN_PATTERN = /!\[[^\]]*?\]\(chatgpt-image:\/\/[^)\s]+\)/;

const stripRedundantChatImageText = (value: string) => {
  const lines = String(value || '').split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'Chat Image') continue;
    kept.push(line);
  }
  return kept.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

type ChatImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  conversationId?: string;
  onOpenImage?: (src: string) => void;
};

type ImageFallback = {
  source: string;
  resolved?: string;
};

const ChatImage = ({ src, alt, conversationId, onOpenImage, ...props }: ChatImageProps) => {
  const [fallback, setFallback] = useState<ImageFallback | null>(null);
  const triedFallback = !!src && fallback?.source === src;
  const resolvedSrc = triedFallback ? (fallback.resolved || src) : src;

  const handleError = useCallback(async () => {
    if (triedFallback || !src || typeof src !== 'string' || !src.startsWith('chatgpt-image://')) return;
    setFallback({ source: src });
    const rawId = src.replace('chatgpt-image://', '').replace(/^\/+/, '');
    try {
      const dataUrl = await window.electronAPI.invoke('api:getImageDataUrl', { rawImageId: rawId, conversationId });
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        setFallback({ source: src, resolved: dataUrl });
      }
    } catch (error) {
      console.error('Image fallback failed:', error);
    }
  }, [src, conversationId, triedFallback]);

  const handleClick = useCallback(() => {
    if (resolvedSrc && onOpenImage) onOpenImage(resolvedSrc);
  }, [resolvedSrc, onOpenImage]);

  return <img src={resolvedSrc} alt={alt || 'Image'} loading="lazy" onError={handleError} onClick={handleClick} {...props} />;
};

const DeepResearchEmbed = memo(({ entry }: { entry: EmbeddedUiEntry }) => {
  const height = Math.max(320, Math.min(1200, Number(entry.height) || 484));

  return (
    <section className="deep-research-embed" aria-label={entry.title || 'Deep Research result'}>
      <div className="deep-research-embed-header">
        <span>{entry.title || 'Deep Research result'}</span>
        <a href={entry.src} target="_blank" rel="noreferrer">Open separately</a>
      </div>
      {entry.markdown || entry.text ? (
        <div className="deep-research-embed-text deep-research-embed-markdown markdown-body" style={{ maxHeight: height }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ children, ...props }) => {
                const label = React.Children.toArray(children)
                  .filter((child) => typeof child === 'string' || typeof child === 'number')
                  .join('')
                  .trim();
                const citationClass = /^\[?\d+\]?$/.test(label) ? 'deep-research-citation-link' : undefined;
                return <a {...props} className={citationClass} target="_blank" rel="noreferrer">{children}</a>;
              },
            }}
          >
            {entry.markdown || entry.text || ''}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="deep-research-embed-unavailable">
          The Deep Research content was not captured in this cached snapshot. Open it separately to view the live result.
        </div>
      )}
    </section>
  );
});

const MarkdownMessage = memo(({ content, embeddedUi, highlightQuery, highlightCodeBlocks, conversationId, onOpenImage, citationRegistry }: { content: string, embeddedUi?: EmbeddedUiEntry[], highlightQuery?: string, highlightCodeBlocks?: boolean, conversationId?: string, onOpenImage?: (src: string) => void, citationRegistry: Record<string, CitationEntry> }) => {
  const query = highlightQuery || '';
  const rawContent = typeof content === 'string' ? content : String(content || '');
  const embeddedUiEntries = useMemo(() => sanitizeEmbeddedUiEntries(embeddedUi), [embeddedUi]);
  const contentWithoutEmbeddedUi = rawContent;
  const rawLineCount = useMemo(() => countLines(contentWithoutEmbeddedUi), [contentWithoutEmbeddedUi]);
  const mathDelimiterCount = useMemo(() => countRegexMatches(contentWithoutEmbeddedUi, /\$\$?|\\\(|\\\)|\\\[|\\\]/g), [contentWithoutEmbeddedUi]);
  const latexCommandCount = useMemo(() => countRegexMatches(contentWithoutEmbeddedUi, /\\[a-zA-Z]+/g), [contentWithoutEmbeddedUi]);
  const cdotCount = useMemo(() => countRegexMatches(contentWithoutEmbeddedUi, /\\cdot\b/g), [contentWithoutEmbeddedUi]);
  const hasMarkdownMath = mathDelimiterCount > 0;
  const mathComplexityHigh = hasMarkdownMath && (
    mathDelimiterCount > MAX_MARKDOWN_MATH_DELIMITERS
    || latexCommandCount > MAX_MARKDOWN_LATEX_COMMANDS
    || cdotCount > MAX_MARKDOWN_CDOT_COMMANDS
  );
  const plainLatexTextMode = !hasMarkdownMath
    && (latexCommandCount >= MIN_PLAIN_LATEX_COMMANDS || cdotCount > 0)
    && (rawLineCount >= MIN_PLAIN_LATEX_LINES || rawContent.length > 800);
  const safeRenderMode = rawContent.length > MAX_MARKDOWN_RENDER_CHARS || rawLineCount > MAX_MARKDOWN_RENDER_LINES;
  const effectiveQuery = mathComplexityHigh ? '' : query;
  const codeSearchQuery = highlightCodeBlocks ? effectiveQuery : '';
  const safeFallbackContent = useMemo(() => {
    if (contentWithoutEmbeddedUi.length <= MAX_SAFE_FALLBACK_CHARS) return contentWithoutEmbeddedUi;
    return `${contentWithoutEmbeddedUi.slice(0, MAX_SAFE_FALLBACK_CHARS)}\n\n[truncated for performance]`;
  }, [contentWithoutEmbeddedUi]);
  const renderedContent = useMemo(() => {
    try {
      const normalized = normalizeMathDelimiters(normalizeCitationMarkers(normalizeProductsMarkers(contentWithoutEmbeddedUi)));
      if (!HAS_CHAT_IMAGE_MARKDOWN_PATTERN.test(normalized)) return normalized;
      return stripRedundantChatImageText(normalized);
    } catch (error) {
      console.error('Markdown preprocessing failed:', error);
      return contentWithoutEmbeddedUi;
    }
  }, [contentWithoutEmbeddedUi]);
  const hasChatImages = useMemo(() => HAS_CHAT_IMAGE_MARKDOWN_PATTERN.test(renderedContent), [renderedContent]);

  const markdownComponents: Components = {
    a: ({ href, children, ...props }) => {
      const highlightedChildren = <HighlightText query={effectiveQuery}>{children}</HighlightText>;
      if (typeof href === 'string' && href.startsWith('productref://')) {
        const id = decodeURIComponent(href.replace('productref://', ''));
        const entry = citationRegistry[id];
        if (entry?.url) {
          return <a href={entry.url} target="_blank" rel="noreferrer" title={entry.title || id} {...props}>{highlightedChildren}</a>;
        }
        return <span title={id}>{highlightedChildren}</span>;
      }
      if (typeof href === 'string' && href.startsWith('citation://')) {
        const id = decodeURIComponent(href.replace('citation://', ''));
        const entry = citationRegistry[id];
        if (entry?.url) {
          return (
            <sup className="citation-ref">
              <a href={entry.url} target="_blank" rel="noreferrer" title={entry.title || id}>
                {highlightedChildren}
              </a>
            </sup>
          );
        }
        return <sup className="citation-ref" title={id}>{highlightedChildren}</sup>;
      }
      return <a href={href} target="_blank" rel="noreferrer" {...props}>{highlightedChildren}</a>;
    },
    p: ({ children, ...props }) => <p {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></p>,
    li: ({ children, ...props }) => <li {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></li>,
    td: ({ children, ...props }) => <td {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></td>,
    th: ({ children, ...props }) => <th {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></th>,
    blockquote: ({ children, ...props }) => <blockquote {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></blockquote>,
    h1: ({ children, ...props }) => <h1 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h1>,
    h2: ({ children, ...props }) => <h2 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h2>,
    h3: ({ children, ...props }) => <h3 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h3>,
    h4: ({ children, ...props }) => <h4 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h4>,
    h5: ({ children, ...props }) => <h5 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h5>,
    h6: ({ children, ...props }) => <h6 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h6>,
    img: ({ src, alt, ...props }) => (
      <ChatImage src={src} alt={alt} conversationId={conversationId} onOpenImage={onOpenImage} {...props} />
    ),
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '');
      const codeText = String(children).replace(/\n$/, '');
      const codeLineCount = countLines(codeText);
      const codeTooLarge = codeText.length > MAX_CODE_HIGHLIGHT_CHARS || codeLineCount > MAX_CODE_HIGHLIGHT_LINES;
      const shouldHighlightCode = !!codeSearchQuery && !codeTooLarge;
      return match ? (
        codeTooLarge ? (
          <pre className="large-code-fallback">
            <code>{codeText.length <= MAX_SAFE_FALLBACK_CHARS ? codeText : `${codeText.slice(0, MAX_SAFE_FALLBACK_CHARS)}\n\n[truncated for performance]`}</code>
          </pre>
        ) : shouldHighlightCode ? (
          <pre className={className}>
            <code>
              <HighlightText query={codeSearchQuery}>{codeText}</HighlightText>
            </code>
          </pre>
        ) : (
          <SyntaxHighlighter
            style={vscDarkPlus as { [key: string]: React.CSSProperties }}
            language={match[1]}
            PreTag="div"
            codeTagProps={{ style: { fontSize: 'inherit' } }}
            customStyle={{ margin: 0, padding: 0, background: 'transparent', fontSize: 'inherit' }}
          >
            {codeText}
          </SyntaxHighlighter>
        )
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };

  const renderMarkdownChunk = (chunk: string, key: string) => (
    <ReactMarkdown
      key={key}
      urlTransform={(value: string) => value}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={markdownComponents}
    >
      {chunk}
    </ReactMarkdown>
  );

  const renderContentWithImages = () => {
    if (!hasChatImages) {
      return renderMarkdownChunk(renderedContent, 'markdown-full');
    }

    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let imageIndex = 0;
    const chatImagePattern = new RegExp(CHAT_IMAGE_MARKDOWN_PATTERN);

    while ((match = chatImagePattern.exec(renderedContent)) !== null) {
      const before = renderedContent.slice(lastIndex, match.index);
      if (before.trim()) {
        nodes.push(renderMarkdownChunk(before, `markdown-${imageIndex}-before`));
      }

      nodes.push(
        <ChatImage
          key={`chat-image-${imageIndex}`}
          src={match[2]}
          alt={match[1] || 'Chat Image'}
          conversationId={conversationId}
          onOpenImage={onOpenImage}
        />
      );

      lastIndex = match.index + match[0].length;
      imageIndex += 1;
    }

    const after = renderedContent.slice(lastIndex);
    if (after.trim()) {
      nodes.push(renderMarkdownChunk(after, `markdown-${imageIndex}-after`));
    }

    return nodes.length > 0 ? nodes : renderMarkdownChunk(renderedContent, 'markdown-fallback');
  };

  const renderContentWithEmbeddedUi = (body: React.ReactNode) => {
    if (embeddedUiEntries.length === 0) return body;
    return (
      <div className="message-with-deep-research">
        {body}
        {embeddedUiEntries.map((entry) => (
          <DeepResearchEmbed key={entry.src} entry={entry} />
        ))}
      </div>
    );
  };

  if (hasChatImages) {
    return (
      <MarkdownErrorBoundary rawContent={content} conversationId={conversationId}>
        {renderContentWithEmbeddedUi(renderContentWithImages())}
      </MarkdownErrorBoundary>
    );
  }

  if (safeRenderMode) {
    return (
      <div className="markdown-fallback">
        <div className="markdown-fallback-title">Large message rendered in safe mode.</div>
        <pre><HighlightText query={effectiveQuery}>{safeFallbackContent}</HighlightText></pre>
        {renderContentWithEmbeddedUi(null)}
      </div>
    );
  }

  if (plainLatexTextMode) {
    return (
      <div className="plain-latex-text">
        <HighlightText query={query}>{contentWithoutEmbeddedUi}</HighlightText>
        {renderContentWithEmbeddedUi(null)}
      </div>
    );
  }

  return (
    <MarkdownErrorBoundary rawContent={content} conversationId={conversationId}>
      {renderContentWithEmbeddedUi(renderContentWithImages())}
    </MarkdownErrorBoundary>
  );
});

const MessageRow = memo(({ msg, highlightQuery, highlightCodeBlocks, isTarget, onOpenImage, citationRegistry, onSwitchBranch }: { msg: DisplayMessage, highlightQuery?: string, highlightCodeBlocks?: boolean, isTarget?: boolean, onOpenImage?: (src: string) => void, citationRegistry: Record<string, CitationEntry>, onSwitchBranch?: (parentId: string, childId: string) => void }) => {
  const hasThinking = msg.role === 'assistant' && !!msg.thinkingParts && msg.thinkingParts.length > 0;
  const [thinkingState, setThinkingState] = useState({ messageId: msg.id, open: false });
  const thinkingOpen = thinkingState.messageId === msg.id && thinkingState.open;
  const branchInfo = msg.branchInfo;
  const activeBranchIndex = branchInfo ? Math.max(0, branchInfo.options.findIndex((option) => option.childId === branchInfo.activeChildId)) : -1;
  const canMoveBranchBackward = !!branchInfo && activeBranchIndex > 0;
  const canMoveBranchForward = !!branchInfo && activeBranchIndex >= 0 && activeBranchIndex < branchInfo.options.length - 1;

  if (msg.isBridgeStatus) {
    return (
      <div className={`message-row assistant bridge-status-message ${isTarget ? 'highlight-target' : ''}`} data-message-id={msg.id}>
        <div className="message-content">
          <div className="message-header">
            <div className="role-label">ChatGPT</div>
          </div>
          <div className="bridge-status-bubble">
            <div className={`bridge-status-text ${msg.bridgeStatusState === 'thinking' ? 'loading-shimmer' : ''}`}>
              {msg.content}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`message-row ${msg.role} ${isTarget ? 'highlight-target' : ''}`} data-message-id={msg.id}>
      <div className="message-content">
        <div className="message-header">
          <div className="role-label">{msg.role === 'user' ? 'You' : 'ChatGPT'}</div>
          {hasThinking ? (
            <button
              type="button"
              className={`thinking-inline-toggle ${thinkingOpen ? 'open' : ''}`}
              onClick={() => setThinkingState((previous) => ({
                messageId: msg.id,
                open: previous.messageId === msg.id ? !previous.open : true,
              }))}
              aria-expanded={thinkingOpen}
            >
              <span className="thinking-chevron" aria-hidden="true">▾</span>
              <span>Thinking</span>
            </button>
          ) : null}
        </div>
        {hasThinking && thinkingOpen ? (
          <div className="thinking-box-inline">
            <div className="thinking-content">
              {msg.thinkingParts!.map((part) => (
                <div key={part.id} className="thinking-item">
                  <div className="thinking-role">{part.role}</div>
                  <div className="markdown-body">
                    <MarkdownMessage content={part.content} highlightQuery={highlightQuery} conversationId={msg.conversation_id} onOpenImage={onOpenImage} citationRegistry={citationRegistry} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="markdown-body">
          <MarkdownMessage content={msg.content} embeddedUi={msg.embeddedUi} highlightQuery={highlightQuery} highlightCodeBlocks={highlightCodeBlocks} conversationId={msg.conversation_id} onOpenImage={onOpenImage} citationRegistry={citationRegistry} />
        </div>
        {branchInfo ? (
          <div className="branch-switcher" aria-label="Branch switcher">
            <button
              type="button"
              className="branch-switcher-btn"
              onClick={() => {
                if (!branchInfo || !canMoveBranchBackward || !onSwitchBranch) return;
                onSwitchBranch(branchInfo.parentId, branchInfo.options[activeBranchIndex - 1].childId);
              }}
              disabled={!canMoveBranchBackward}
              aria-label="Previous branch"
            >
              ‹
            </button>
            <div className="branch-switcher-label" title={branchInfo.options[activeBranchIndex]?.preview || ''}>
              <span className="branch-switcher-count">Branch {activeBranchIndex + 1} of {branchInfo.options.length}</span>
              <span className="branch-switcher-preview">{branchInfo.options[activeBranchIndex]?.preview || ''}</span>
            </div>
            <button
              type="button"
              className="branch-switcher-btn"
              onClick={() => {
                if (!branchInfo || !canMoveBranchForward || !onSwitchBranch) return;
                onSwitchBranch(branchInfo.parentId, branchInfo.options[activeBranchIndex + 1].childId);
              }}
              disabled={!canMoveBranchForward}
              aria-label="Next branch"
            >
              ›
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

type ConversationMarkerState = 'none' | 'uncached' | 'dirty';

const ConversationItem = memo(({ conv, active, markerState, onClick, onContextMenu }: { conv: Conversation, active: boolean, markerState: ConversationMarkerState, onClick: () => void, onContextMenu: (e: React.MouseEvent) => void }) => {
  const markerTitle = markerState === 'uncached'
    ? 'Not cached yet'
    : markerState === 'dirty'
      ? 'Cached copy needs a full sync'
      : '';
  return (
    <div
      className={`conversation-item ${active ? 'active' : ''} ${conv.is_deleted_on_web ? 'local-only' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="conv-item-content">
        <div className="conv-item-leading">
          <span className="conv-title">{conv.title || 'New Chat'}</span>
          <span
            className={`conversation-marker conversation-marker-${markerState} ${markerState !== 'none' ? 'visible' : ''}`}
            title={markerTitle}
            aria-hidden={markerState === 'none'}
          >
            !
          </span>
        </div>
        {conv.is_deleted_on_web ? <span className="local-badge" title="This chat was deleted on the web but is preserved locally">Local</span> : null}
      </div>
    </div>
  );
});

export {
  buildCitationRegistry,
  buildDisplayMessages,
  buildLinearConversationPath,
  ConversationItem,
  countLines,
  countNeedleHits,
  DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION,
  escapeRegExp,
  findTextOccurrenceRect,
  formatSendError,
  getDisplayMessageSearchText,
  getEmbeddedUiEntries,
  getMessagePreview,
  isNavigableMessage,
  matchesSentUserContent,
  MAX_MAP_SEARCH_QUERY_LEN,
  MAX_MESSAGE_HIGHLIGHT_HITS,
  MessageRow,
  sanitizeMapSearchQuery,
  sleep,
};

export type {
  BridgeComposerStatus,
  CitationEntry,
  DisplayMessage,
};
