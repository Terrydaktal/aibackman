import React, { useState, useEffect, useRef, memo, useCallback, useMemo, useDeferredValue } from 'react';
import type { Conversation, Message } from './types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import 'katex/dist/katex.min.css';
import './index.css';

const escapeRegExp = (value: unknown) => {
  const string = typeof value === 'string' ? value : String(value ?? '');
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_HIGHLIGHT_TEXT_LEN = 20000;
const MAX_HIGHLIGHT_MATCHES = 160;
const MAX_HIGHLIGHT_NODE_TEXT_LEN = 60000;
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
const AI_MODE_TAKEOUT_DEFAULT_PATH = '/home/lewis/Desktop/backups/Google/Google 9lewis9 3/Takeout/My Activity/AI Mode/MyActivity.json';
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 20;
const FONT_SIZE_DEFAULT = 12;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 520;
const SIDEBAR_WIDTH_DEFAULT = 216;
const MAP_WIDTH_MIN = 180;
const MAP_WIDTH_MAX = 520;
const MAP_WIDTH_DEFAULT = 250;
type WorkspaceMode = 'home' | 'chatgpt' | 'aimode';
const clampFontSize = (value: number) =>
  Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(value)));
const clampPanelWidth = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));
const loadStoredPanelWidth = (key: string, fallback: number, min: number, max: number) => {
  const raw = Number(localStorage.getItem(key));
  if (!Number.isFinite(raw)) return fallback;
  return clampPanelWidth(raw, min, max);
};

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
type DisplayMessage = Message & {
  thinkingParts?: ThinkingPart[];
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

type OomDebugEntry = {
  ts: number;
  event: string;
  payload?: Record<string, unknown>;
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
    const meta = JSON.parse(msg.metadata_json) as Record<string, any>;
    const lines: string[] = [];

    if (typeof meta.reasoning_title === 'string' && meta.reasoning_title.trim()) {
      lines.push(`Reasoning: ${meta.reasoning_title.trim()}`);
    } else if (typeof meta.reasoning_status === 'string' && meta.reasoning_status.trim()) {
      lines.push(`Reasoning status: \`${meta.reasoning_status.trim()}\``);
    }
    if (meta.is_thinking_preamble_message) lines.push('Thinking preamble step');
    if (meta.is_visually_hidden_from_conversation) lines.push('Hidden internal step');

    if (meta.aggregate_result && typeof meta.aggregate_result === 'object') {
      const status = typeof meta.aggregate_result.status === 'string' ? meta.aggregate_result.status : 'available';
      lines.push(`Tool aggregate result: \`${status}\``);
    } else if (msg.role === 'tool') {
      lines.push('Tool step (no text output)');
    }

    if (lines.length === 0 && meta.finish_details && typeof meta.finish_details.type === 'string') {
      lines.push(`Finish: \`${meta.finish_details.type}\``);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
};

const assistantCandidateScore = (content: string) => {
  const text = content.trim();
  if (!text) return -Infinity;
  let score = Math.min(text.length, 20000);
  if (text.startsWith('{') && text.includes('"prompt"')) score -= 7000;
  if (text.startsWith('{') && text.includes('"size"')) score -= 7000;
  if (text.startsWith('```')) score -= 4000;
  if (text.startsWith('[Download')) score -= 1500;
  return score;
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

const buildDisplayMessages = (rawMessages: Message[]): DisplayMessage[] => {
  const output: DisplayMessage[] = [];
  const segmentable = rawMessages.filter((m) => (m.content && m.content.trim()) || !!m.metadata_json);

  const flushSegment = (segment: Message[]) => {
    if (segment.length === 0) return;
    const userMessages = segment.filter((m) => m.role === 'user' && m.content && m.content.trim());
    const assistantMessages = segment.filter((m) => m.role === 'assistant' && m.content && m.content.trim());

    userMessages.forEach((m) => output.push({ ...m }));
    if (assistantMessages.length === 0) return;

    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const strongestAssistant = assistantMessages.reduce((best, current) => {
      return assistantCandidateScore(current.content) > assistantCandidateScore(best.content) ? current : best;
    }, assistantMessages[0]);
    const finalAssistant =
      assistantCandidateScore(lastAssistant.content) >= assistantCandidateScore(strongestAssistant.content) * 0.55
        ? lastAssistant
        : strongestAssistant;
    const thinkingParts = segment
      .filter((m) => m.id !== finalAssistant.id && m.role !== 'user')
      .map((m) => {
        const visible = (m.content || '').trim();
        const content = visible ? m.content : summarizeMetadataOnlyStep(m);
        return { id: m.id, role: m.role, content };
      })
      .filter((m) => !!m.content?.trim());

    output.push({
      ...finalAssistant,
      thinkingParts: thinkingParts.length > 0 ? thinkingParts : undefined,
    });
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

const HighlightText = ({ children, query }: { children: React.ReactNode, query: string }): any => {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return children;
  const needleLower = q.toLowerCase();
  if (needleLower.length < 2 || needleLower.length > 80) return children;
  
  return React.Children.map(children, child => {
    if (typeof child === 'string') {
      if (!child || child.length > MAX_HIGHLIGHT_TEXT_LEN) return child;
      const haystackLower = child.toLowerCase();
      if (!haystackLower.includes(needleLower)) return child;

      const output: React.ReactNode[] = [];
      let cursor = 0;
      let matchCount = 0;
      while (cursor < child.length && matchCount < MAX_HIGHLIGHT_MATCHES) {
        const idx = haystackLower.indexOf(needleLower, cursor);
        if (idx === -1) break;
        if (idx > cursor) output.push(child.slice(cursor, idx));
        output.push(
          <mark key={`hl-${idx}-${matchCount}`} className="chat-highlight">
            {child.slice(idx, idx + q.length)}
          </mark>
        );
        cursor = idx + q.length;
        matchCount++;
      }
      if (cursor < child.length) output.push(child.slice(cursor));
      return output;
    }
    if (React.isValidElement(child) && (child.props as any).children) {
      const childProps = (child.props as any) || {};
      const className = typeof childProps.className === 'string' ? childProps.className : '';
      // KaTeX/math trees are very deep; cloning them recursively for search highlights
      // can cause large transient allocations in long chats.
      if (
        className.includes('katex') ||
        className.includes('math') ||
        child.type === 'code' ||
        child.type === 'pre'
      ) {
        return child;
      }
      const childText = typeof childProps.children === 'string' ? childProps.children : null;
      if (childText && childText.length > MAX_HIGHLIGHT_NODE_TEXT_LEN) return child;
      return React.cloneElement(child, {
        children: <HighlightText query={query}>{(child.props as any).children}</HighlightText>
      } as any);
    }
    return child;
  });
};

const countNeedleHits = (text: string, needleLower: string) => {
  if (!text || !needleLower) return 0;
  let cursor = 0;
  let hits = 0;
  const haystack = text.toLowerCase();
  while (cursor < haystack.length) {
    const idx = haystack.indexOf(needleLower, cursor);
    if (idx === -1) break;
    hits++;
    if (hits > MAX_MESSAGE_HIGHLIGHT_HITS) return hits;
    cursor = idx + needleLower.length;
  }
  return hits;
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

const ChatImage = ({ src, alt, conversationId, onOpenImage, ...props }: any) => {
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(src);
  const [triedFallback, setTriedFallback] = useState(false);

  useEffect(() => {
    setResolvedSrc(src);
    setTriedFallback(false);
  }, [src]);

  const handleError = useCallback(async () => {
    if (triedFallback || !src || typeof src !== 'string' || !src.startsWith('chatgpt-image://')) return;
    setTriedFallback(true);
    const rawId = src.replace('chatgpt-image://', '').replace(/^\/+/, '');
    try {
      const dataUrl = await window.electronAPI.invoke('api:getImageDataUrl', { rawImageId: rawId, conversationId });
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        setResolvedSrc(dataUrl);
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

const MarkdownMessage = memo(({ content, highlightQuery, conversationId, onOpenImage, citationRegistry }: { content: string, highlightQuery?: string, conversationId?: string, onOpenImage?: (src: string) => void, citationRegistry: Record<string, CitationEntry> }) => {
  const query = highlightQuery || '';
  const rawContent = typeof content === 'string' ? content : String(content || '');
  const rawLineCount = useMemo(() => countLines(rawContent), [rawContent]);
  const mathDelimiterCount = useMemo(() => countRegexMatches(rawContent, /\$\$?|\\\(|\\\)|\\\[|\\\]/g), [rawContent]);
  const latexCommandCount = useMemo(() => countRegexMatches(rawContent, /\\[a-zA-Z]+/g), [rawContent]);
  const cdotCount = useMemo(() => countRegexMatches(rawContent, /\\cdot\b/g), [rawContent]);
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
  const safeFallbackContent = useMemo(() => {
    if (rawContent.length <= MAX_SAFE_FALLBACK_CHARS) return rawContent;
    return `${rawContent.slice(0, MAX_SAFE_FALLBACK_CHARS)}\n\n[truncated for performance]`;
  }, [rawContent]);
  const renderedContent = useMemo(() => {
    try {
      const normalized = normalizeMathDelimiters(normalizeCitationMarkers(normalizeProductsMarkers(rawContent)));
      if (!HAS_CHAT_IMAGE_MARKDOWN_PATTERN.test(normalized)) return normalized;
      return stripRedundantChatImageText(normalized);
    } catch (error) {
      console.error('Markdown preprocessing failed:', error);
      return rawContent;
    }
  }, [rawContent]);
  const hasChatImages = useMemo(() => HAS_CHAT_IMAGE_MARKDOWN_PATTERN.test(renderedContent), [renderedContent]);

  const markdownComponents = {
    a: ({ href, children, ...props }: any) => {
      if (typeof href === 'string' && href.startsWith('productref://')) {
        const id = decodeURIComponent(href.replace('productref://', ''));
        const entry = citationRegistry[id];
        if (entry?.url) {
          return <a href={entry.url} target="_blank" rel="noreferrer" title={entry.title || id} {...props}>{children}</a>;
        }
        return <span title={id}>{children}</span>;
      }
      if (typeof href === 'string' && href.startsWith('citation://')) {
        const id = decodeURIComponent(href.replace('citation://', ''));
        const entry = citationRegistry[id];
        if (entry?.url) {
          return (
            <sup className="citation-ref">
              <a href={entry.url} target="_blank" rel="noreferrer" title={entry.title || id}>
                {children}
              </a>
            </sup>
          );
        }
        return <sup className="citation-ref" title={id}>{children}</sup>;
      }
      return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
    },
    p: ({ children, ...props }: any) => <p {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></p>,
    li: ({ children, ...props }: any) => <li {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></li>,
    h1: ({ children, ...props }: any) => <h1 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h1>,
    h2: ({ children, ...props }: any) => <h2 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h2>,
    h3: ({ children, ...props }: any) => <h3 {...props}><HighlightText query={effectiveQuery}>{children}</HighlightText></h3>,
    img: ({ src, alt, ...props }: any) => (
      <ChatImage src={src} alt={alt} conversationId={conversationId} onOpenImage={onOpenImage} {...props} />
    ),
    code({ inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const codeText = String(children).replace(/\n$/, '');
      const codeLineCount = countLines(codeText);
      const codeTooLarge = codeText.length > MAX_CODE_HIGHLIGHT_CHARS || codeLineCount > MAX_CODE_HIGHLIGHT_LINES;
      return !inline && match ? (
        codeTooLarge ? (
          <pre className="large-code-fallback">
            <code>{codeText.length <= MAX_SAFE_FALLBACK_CHARS ? codeText : `${codeText.slice(0, MAX_SAFE_FALLBACK_CHARS)}\n\n[truncated for performance]`}</code>
          </pre>
        ) : (
          <SyntaxHighlighter
            style={vscDarkPlus as any}
            language={match[1]}
            PreTag="div"
            codeTagProps={{ style: { fontSize: 'inherit' } }}
            customStyle={{ margin: 0, padding: 0, background: 'transparent', fontSize: 'inherit' }}
            {...props}
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

  if (hasChatImages) {
    return (
      <MarkdownErrorBoundary rawContent={content} conversationId={conversationId}>
        {renderContentWithImages()}
      </MarkdownErrorBoundary>
    );
  }

  if (safeRenderMode) {
    return (
      <div className="markdown-fallback">
        <div className="markdown-fallback-title">Large message rendered in safe mode.</div>
        <pre><HighlightText query={effectiveQuery}>{safeFallbackContent}</HighlightText></pre>
      </div>
    );
  }

  if (plainLatexTextMode) {
    return (
      <div className="plain-latex-text">
        <HighlightText query={query}>{rawContent}</HighlightText>
      </div>
    );
  }

  return (
    <MarkdownErrorBoundary rawContent={content} conversationId={conversationId}>
      {renderContentWithImages()}
    </MarkdownErrorBoundary>
  );
});

const MessageRow = memo(({ msg, highlightQuery, isTarget, onOpenImage, citationRegistry }: { msg: DisplayMessage, highlightQuery?: string, isTarget?: boolean, onOpenImage?: (src: string) => void, citationRegistry: Record<string, CitationEntry> }) => {
  const hasThinking = msg.role === 'assistant' && !!msg.thinkingParts && msg.thinkingParts.length > 0;
  const [thinkingOpen, setThinkingOpen] = useState(false);

  useEffect(() => {
    setThinkingOpen(false);
  }, [msg.id]);

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
              onClick={() => setThinkingOpen((prev) => !prev)}
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
          <MarkdownMessage content={msg.content} highlightQuery={highlightQuery} conversationId={msg.conversation_id} onOpenImage={onOpenImage} citationRegistry={citationRegistry} />
        </div>
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

function ChatGPTApp({ onGoHome, workspaceMode }: { onGoHome: () => void; workspaceMode: Exclude<WorkspaceMode, 'home'> }) {
  const isAiMode = workspaceMode === 'aimode';
  const lastConvStorageKey = isAiMode ? 'lastConvId:aimode' : 'lastConvId';
  const selectedModelStorageKey = isAiMode ? 'selectedModel:aimode' : 'selectedModel';
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(localStorage.getItem(lastConvStorageKey));
  const [messages, setMessages] = useState<Message[]>([]);
  const [isAuth, setIsAuth] = useState<boolean | null>(isAiMode ? true : null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(localStorage.getItem(selectedModelStorageKey) || 'Auto');
  const [pastedImage, setPastedImage] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; mimeType: string; dataUrl: string; sizeBytes: number }>>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isReauthenticating, setIsReauthenticating] = useState(false);
  const [bridgeComposerStatus, setBridgeComposerStatus] = useState<BridgeComposerStatus | null>(null);

  const [fontSize, setFontSize] = useState<number>(() => {
    const raw = Number(localStorage.getItem('fontSize'));
    return Number.isFinite(raw) ? clampFontSize(raw) : FONT_SIZE_DEFAULT;
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    loadStoredPanelWidth('sidebarWidth', SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
  );
  const [mapPanelWidth, setMapPanelWidth] = useState<number>(() =>
    loadStoredPanelWidth('mapPanelWidth', MAP_WIDTH_DEFAULT, MAP_WIDTH_MIN, MAP_WIDTH_MAX)
  );
  const [activeResizer, setActiveResizer] = useState<'sidebar' | 'map' | null>(null);
  const [chatWidth, setChatWidth] = useState<number>(Number(localStorage.getItem('chatWidth')) || 800);
  const [showSettings, setShowSettings] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
	  const [showSearch, setShowSearch] = useState(false);
		  const [searchQuery, setSearchQuery] = useState('');
		  const [mapSearchQuery, setMapSearchQuery] = useState('');
		  const [searchResults, setSearchResults] = useState<any[]>([]);
		  const [searchTotalCount, setSearchTotalCount] = useState(0);
		  const [searchTotalIsLowerBound, setSearchTotalIsLowerBound] = useState(false);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [activeHighlightQuery, setActiveHighlightQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => localStorage.getItem('sidebarOpen') !== '0');
  const [isMessageMapOpen, setIsMessageMapOpen] = useState<boolean>(() => localStorage.getItem('messageMapOpen') !== '0');
  const [viewportVisibleMessageIds, setViewportVisibleMessageIds] = useState<string[]>([]);

  const [hasMoreConvs, setHasMoreConvs] = useState(true);
  const [isLoadingMoreConvs, setIsLoadingMoreConvs] = useState(false);
  const [cacheStats, setCacheStats] = useState({ localCount: 0, cachedCount: 0 });
  const [cacheDiagnostics, setCacheDiagnostics] = useState({ uncachedCount: 0, failedCount: 0, unknownCount: 0, dirtyCount: 0 });
  const [uncachedConversationIds, setUncachedConversationIds] = useState<Set<string>>(new Set());
  const [dirtyConversationIds, setDirtyConversationIds] = useState<Set<string>>(new Set());
  const [isCachingAll, setIsCachingAll] = useState(false);
  const [cacheRunStatus, setCacheRunStatus] = useState('');
  const [conversationContextMenu, setConversationContextMenu] = useState<{ x: number; y: number; conversationId: string } | null>(null);

  const [isPanning, setIsPanning] = useState(false);
  const [panPosition, setPanPosition] = useState({ x: 0, y: 0 });
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number } | null>(null);
  const panStart = useRef({ x: 0, y: 0 });
  const panCurrent = useRef({ x: 0, y: 0 });
  const panRaf = useRef<number | null>(null);
  const panScrollTargetRef = useRef<HTMLElement | null>(null);
  const mapJumpLockUntilRef = useRef<number>(0);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const conversationsScrollerRef = useRef<HTMLElement | null>(null);
  const mapListRef = useRef<HTMLDivElement | null>(null);
  const mapOpenRef = useRef(isMessageMapOpen);
  const viewportHighlightRafRef = useRef<number | null>(null);
  const updateViewportNavHighlightRef = useRef<() => void>(() => {});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingJumpRef = useRef<{ msgId: string; startedAt: number } | null>(null);
  const panelResizeRef = useRef<{ type: 'sidebar' | 'map'; startX: number; startWidth: number } | null>(null);
  const suppressMiddlePasteRef = useRef(false);
  const suppressMiddlePasteUntilRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const oomDebugEnabledRef = useRef<boolean>(localStorage.getItem('oomDebug') === '1');
  const oomDebugEntriesRef = useRef<OomDebugEntry[]>([]);
  const oomDebugStateRef = useRef({
    mapQuery: '',
    navCount: 0,
    visibleCount: 0,
    displayCount: 0,
    displayViewCount: 0,
  });
  const lastConversationListSyncAtRef = useRef(0);
  const conversationListSyncInFlightRef = useRef(false);
  const updateCacheDiagnosticsRef = useRef<() => Promise<void>>(async () => {});
	  const conversationSelectionTokenRef = useRef(0);
	  const searchDebounceRef = useRef<number | null>(null);
	  const searchRequestTokenRef = useRef(0);
	  const selectConversationRef = useRef<(id: string, forceSync?: boolean, shouldSync?: boolean) => Promise<void>>(async () => {});
  const initializationStartedRef = useRef(false);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const activeConvIdRef = useRef<string | null>(localStorage.getItem(lastConvStorageKey));
  const bridgeComposerStatusRef = useRef<BridgeComposerStatus | null>(null);
  const hasScrolledToBottomRef = useRef<Record<string, boolean>>({});
  const virtuosoStateByConversationRef = useRef<Record<string, any>>({});
  const [restoreVirtuosoState, setRestoreVirtuosoState] = useState<any | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  const invokeMode = useCallback((channel: string, payload: Record<string, unknown> = {}) => (
    window.electronAPI.invoke(channel, { ...payload, mode: workspaceMode })
  ), [workspaceMode]);
  const displayMessages = useMemo(() => buildDisplayMessages(messages), [messages]);
  const citationRegistry = useMemo(() => buildCitationRegistry(messages), [messages]);
  const isBridgeReadyForActiveConversation = useMemo(() => {
    if (isAiMode) return false;
    if (!bridgeComposerStatus?.ready) return false;
    return (bridgeComposerStatus.conversationId || null) === (activeConvId || null);
  }, [activeConvId, bridgeComposerStatus, isAiMode]);
  const bridgeActivityLabel = useMemo(() => {
    if (isAiMode) return '';
    const status = bridgeComposerStatus;
    if (!status) return '';
    const sameConversation = (status.conversationId || null) === (activeConvId || null);
    if (!sameConversation) return '';
    if (status.state === 'sending') return 'Sending...';
    if (status.state === 'thinking') return 'Thinking...';
    if (status.state === 'warming') return 'Preparing chat...';
    if (status.state === 'ready') return 'Ready';
    if (status.state === 'error' && status.reason) return status.reason;
    return '';
  }, [activeConvId, bridgeComposerStatus, isAiMode]);
  const bridgeMessageStatus = useMemo(() => {
    if (isAiMode) return null;
    const status = bridgeComposerStatus;
    if (!status) return null;
    if (!isNearBottom) return null;
    const sameConversation = (status.conversationId || null) === (activeConvId || null);
    if (!sameConversation) return null;
    if (status.state === 'sending') return { state: status.state, text: 'Thinking...' };
    if (status.state === 'thinking') return { state: status.state, text: status.reason?.trim() || 'Thinking...' };
    // Intentionally exclude "warming" so "Preparing chat..." is not injected into the message list.
    return null;
  }, [activeConvId, bridgeComposerStatus, isNearBottom]);
  const displayMessagesForView = useMemo(() => {
    if (!bridgeMessageStatus) return displayMessages;
    const bridgeStatusMessage: DisplayMessage = {
      id: `__bridge-status__${activeConvId || 'new'}`,
      conversation_id: activeConvId || '',
      role: 'assistant',
      content: bridgeMessageStatus.text,
      created_at: Date.now() / 1000,
      isBridgeStatus: true,
      bridgeStatusState: bridgeMessageStatus.state,
    };
    return [...displayMessages, bridgeStatusMessage];
  }, [activeConvId, bridgeMessageStatus, displayMessages]);
  const getHeapSnapshot = useCallback(() => {
    const perfAny = performance as Performance & {
      memory?: {
        jsHeapSizeLimit: number;
        totalJSHeapSize: number;
        usedJSHeapSize: number;
      };
    };
    if (!perfAny.memory) return null;
    return {
      usedMB: Math.round((perfAny.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10,
      totalMB: Math.round((perfAny.memory.totalJSHeapSize / (1024 * 1024)) * 10) / 10,
      limitMB: Math.round((perfAny.memory.jsHeapSizeLimit / (1024 * 1024)) * 10) / 10,
    };
  }, []);
  const pushOomDebug = useCallback((event: string, payload: Record<string, unknown> = {}) => {
    if (!oomDebugEnabledRef.current) return;
    const domStats = {
      messageRows: document.querySelectorAll('.message-row[data-message-id]').length,
      mapItems: document.querySelectorAll('.content-nav-item').length,
      highlightMarks: document.querySelectorAll('mark.chat-highlight').length,
      katexNodes: document.querySelectorAll('.katex').length,
    };
    const entry: OomDebugEntry = {
      ts: Date.now(),
      event,
      payload: {
        ...payload,
        dom: domStats,
        heap: getHeapSnapshot(),
      },
    };
    const bucket = oomDebugEntriesRef.current;
    bucket.push(entry);
    if (bucket.length > 600) bucket.splice(0, bucket.length - 600);
    // Keep console output compact but continuous for post-mortem.
    console.debug('[oom-debug]', entry.event, JSON.stringify(entry.payload));
  }, [getHeapSnapshot]);
  const mapSearchNeedleRaw = mapSearchQuery.trim();
  const mapSearchNeedle = useDeferredValue(mapSearchNeedleRaw);
  const mapSearchNeedleActive = mapSearchNeedle.length >= 2 && mapSearchNeedle.length <= 80 ? mapSearchNeedle : '';
  const mapSearchRegex = useMemo(() => {
    if (!mapSearchNeedleActive) return null;
    try {
      return new RegExp(escapeRegExp(mapSearchNeedleActive), 'i');
    } catch {
      return null;
    }
  }, [mapSearchNeedleActive]);
  const navigationMessages = useMemo(() => (
    displayMessages
      .filter(isNavigableMessage)
      .map((m, i) => ({
        ...m,
        navIndex: i + 1,
        preview: getMessagePreview(m.content),
      }))
  ), [displayMessages]);
  const mapMatchMessageIds = useMemo(() => {
    if (!mapSearchRegex) return new Set<string>();
    const matches = new Set<string>();
    for (const msg of navigationMessages) {
      const content = msg.content || '';
      if (!content) continue;
      // Avoid repeated large string allocations from toLowerCase() on every keypress.
      if (mapSearchRegex.test(content)) matches.add(msg.id);
    }
    return matches;
  }, [mapSearchRegex, navigationMessages]);
  const activeMapMessageIds = useMemo(() => (
    isMessageMapOpen
      ? new Set(viewportVisibleMessageIds)
      : (targetMessageId ? new Set([targetMessageId]) : new Set<string>())
  ), [isMessageMapOpen, targetMessageId, viewportVisibleMessageIds]);
  const adjustFontSize = useCallback((delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    setFontSize((prev) => clampFontSize(prev + delta));
  }, []);
  const resetFontSize = useCallback(() => {
    setFontSize(FONT_SIZE_DEFAULT);
  }, []);
  const updateNearBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distanceToBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    const nextIsNearBottom = distanceToBottom <= 120;
    if (isNearBottomRef.current === nextIsNearBottom) return;
    isNearBottomRef.current = nextIsNearBottom;
    setIsNearBottom(nextIsNearBottom);
  }, []);
  const scheduleViewportHighlightUpdate = useCallback(() => {
    if (!mapOpenRef.current) return;
    if (viewportHighlightRafRef.current !== null) return;
    viewportHighlightRafRef.current = requestAnimationFrame(() => {
      viewportHighlightRafRef.current = null;
      updateViewportNavHighlightRef.current();
    });
  }, []);
  const handleMessageScroll = useCallback(() => {
    scheduleViewportHighlightUpdate();
    updateNearBottom();
  }, [scheduleViewportHighlightUpdate, updateNearBottom]);
  const handleMessageScrollerRef = useCallback((el: HTMLElement | null) => {
    if (scrollerRef.current === el) return;
    if (scrollerRef.current) {
      scrollerRef.current.removeEventListener('scroll', handleMessageScroll);
    }
    scrollerRef.current = el;
    if (el) {
      el.addEventListener('scroll', handleMessageScroll, { passive: true });
    }
    handleMessageScroll();
  }, [handleMessageScroll]);
  const handleConversationsScrollerRef = useCallback((el: HTMLElement | null) => {
    conversationsScrollerRef.current = el;
  }, []);
  const handleSidebarResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    panelResizeRef.current = { type: 'sidebar', startX: e.clientX, startWidth: sidebarWidth };
    setActiveResizer('sidebar');
  }, [sidebarWidth]);
  const handleMapResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    panelResizeRef.current = { type: 'map', startX: e.clientX, startWidth: mapPanelWidth };
    setActiveResizer('map');
  }, [mapPanelWidth]);
  const markMiddlePasteSuppressed = useCallback(() => {
    suppressMiddlePasteRef.current = true;
    suppressMiddlePasteUntilRef.current = Date.now() + 1500;
  }, []);

  const saveVirtuosoState = useCallback((conversationId: string | null) => {
    if (!conversationId || !virtuosoRef.current?.getState) return;
    virtuosoRef.current.getState((state: any) => {
      virtuosoStateByConversationRef.current[conversationId] = state;
    });
  }, []);

  const loadConversations = useCallback(async () => {
    const localConvs = await invokeMode('db:getConversations');
    setConversations(localConvs);
    try {
      const result = await invokeMode('api:syncConversations', { offset: 0, limit: 20 });
      setConversations(result.conversations);
      setHasMoreConvs(result.hasMore);
      lastConversationListSyncAtRef.current = Date.now();
    } catch (e) {
      console.error('Failed to sync conversations', e);
    }
  }, [invokeMode]);

  const checkAuth = useCallback(async () => {
    if (isAiMode) {
      setIsAuth(true);
      await loadConversations();
      return;
    }
    const authed = await window.electronAPI.invoke('auth:check');
    setIsAuth(authed);
    if (authed) {
      loadConversations();
    }
  }, [isAiMode, loadConversations]);

  const handleLogin = async () => {
    const success = await window.electronAPI.invoke('auth:login');
    if (success) {
      setIsAuth(true);
      loadConversations();
    }
  };

  const loadMoreConversations = useCallback(async () => {
    if (isLoadingMoreConvs || !hasMoreConvs) return;
    setIsLoadingMoreConvs(true);
    try {
      const result = await invokeMode('api:syncConversations', {
        offset: conversations.length,
        limit: 20
      });
      setConversations(result.conversations);
      setHasMoreConvs(result.hasMore);
    } catch (e) {
      console.error('Failed to load more conversations', e);
    } finally {
      setIsLoadingMoreConvs(false);
    }
  }, [conversations.length, hasMoreConvs, invokeMode, isLoadingMoreConvs]);

  const clearUncachedConversationMarker = useCallback((conversationId: string) => {
    setUncachedConversationIds((prev) => {
      if (!prev.has(conversationId)) return prev;
      const next = new Set(prev);
      next.delete(conversationId);
      return next;
    });
  }, []);

  const clearDirtyConversationMarker = useCallback((conversationId: string) => {
    setDirtyConversationIds((prev) => {
      if (!prev.has(conversationId)) return prev;
      const next = new Set(prev);
      next.delete(conversationId);
      return next;
    });
  }, []);

  const refreshConversationListOnSwitch = useCallback(() => {
    if (isAiMode || conversationListSyncInFlightRef.current) return;
    if (Date.now() - lastConversationListSyncAtRef.current < 30000) return;

    conversationListSyncInFlightRef.current = true;
    lastConversationListSyncAtRef.current = Date.now();
    invokeMode('api:syncConversations', { offset: 0, limit: 20 })
      .then(async (result) => {
        if (Array.isArray(result?.conversations)) {
          setConversations(result.conversations);
        }
        setHasMoreConvs(!!result?.hasMore);
        await updateCacheDiagnosticsRef.current();
      })
      .catch((error) => console.error('Failed to refresh conversation list after switching chats', error))
      .finally(() => {
        conversationListSyncInFlightRef.current = false;
      });
  }, [invokeMode, isAiMode]);

  const selectConversation = useCallback(async (id: string, forceSync = false, shouldSync = false) => {
    if (id === activeConvIdRef.current && !forceSync && !dirtyConversationIds.has(id)) return;
    const selectionToken = ++conversationSelectionTokenRef.current;

    if (activeConvIdRef.current && activeConvIdRef.current !== id) {
      saveVirtuosoState(activeConvIdRef.current);
      refreshConversationListOnSwitch();
    }

    setRestoreVirtuosoState(virtuosoStateByConversationRef.current[id] || null);
    setActiveConvId(id);
    activeConvIdRef.current = id;
    const localMsgs = await invokeMode('db:getMessages', { conversationId: id });
    if (activeConvIdRef.current !== id || conversationSelectionTokenRef.current !== selectionToken) return;
    setMessages(localMsgs);
    if (Array.isArray(localMsgs) && localMsgs.length > 0) {
      clearUncachedConversationMarker(id);
    }
    if (forceSync && localMsgs.length > 0) {
      setTimeout(() => {
        if (activeConvIdRef.current !== id) return;
        virtuosoRef.current?.scrollToIndex({ index: localMsgs.length - 1, align: 'end', behavior: 'auto' });
      }, 0);
    }
    const isDirty = dirtyConversationIds.has(id);
    const shouldSyncNow = isAiMode || shouldSync || isDirty || localMsgs.length === 0;
    if (!isAiMode) {
      invokeMode('api:prewarmConversation', { conversationId: id })
        .catch((error) => console.warn(`Failed to prewarm ${isAiMode ? 'AI Mode' : 'ChatGPT'} bridge conversation`, error));
    }
    if (!shouldSyncNow) {
      setIsSyncing(false);
      return;
    }
    setIsSyncing(true);
    try {
      await invokeMode('api:syncMessages', { conversationId: id, force: forceSync || isDirty });
      const syncedMsgs: Message[] = await invokeMode('db:getMessages', { conversationId: id });
      if (activeConvIdRef.current === id && conversationSelectionTokenRef.current === selectionToken) {
        setMessages(syncedMsgs);
        if (Array.isArray(syncedMsgs) && syncedMsgs.length > 0) {
          clearUncachedConversationMarker(id);
          clearDirtyConversationMarker(id);
        }
        if ((forceSync || isDirty) && syncedMsgs.length > 0) {
          setTimeout(() => {
            if (activeConvIdRef.current !== id) return;
            virtuosoRef.current?.scrollToIndex({ index: syncedMsgs.length - 1, align: 'end', behavior: 'auto' });
          }, 0);
        }
      }
    } catch (error) {
      console.error('Failed to sync messages', error);
    } finally {
      if (activeConvIdRef.current === id && conversationSelectionTokenRef.current === selectionToken) {
        setIsSyncing(false);
      }
    }
  }, [clearDirtyConversationMarker, clearUncachedConversationMarker, dirtyConversationIds, invokeMode, isAiMode, refreshConversationListOnSwitch, saveVirtuosoState]);
  selectConversationRef.current = selectConversation;

  const handleReauth = useCallback(async () => {
    if (isAiMode) return;
    if (isReauthenticating) return;
    setIsReauthenticating(true);
    try {
      const success = await window.electronAPI.invoke('auth:reauth');
      if (!success) {
        setSendError('Re-authentication was cancelled or failed.');
        return;
      }
      await checkAuth();
      if (activeConvIdRef.current) {
        await selectConversation(activeConvIdRef.current, true, true);
      }
      setSendError(null);
    } catch (error) {
      console.error('Re-authentication failed', error);
      setSendError('Re-authentication failed. Please try again.');
    } finally {
      setIsReauthenticating(false);
    }
  }, [checkAuth, isAiMode, isReauthenticating, selectConversation]);

  const handleRefreshCurrentChat = useCallback(async () => {
    const conversationId = activeConvIdRef.current;
    if (!conversationId) return;
    await selectConversation(conversationId, true, true);
  }, [selectConversation]);

  const handleSend = async () => {
    if (isAiMode) {
      setSendError('AI Mode imports are read-only in this app.');
      return;
    }
    if (isSending || (!inputValue.trim() && !pastedImage && attachedFiles.length === 0)) return;
    if (!isBridgeReadyForActiveConversation) {
      setSendError('Bridge chat is still loading. Wait for the send button to turn green.');
      return;
    }
    
    const outgoingContent = inputValue;
    const currentImage = pastedImage;
    const currentFiles = attachedFiles;
    const modelMap: Record<string, string> = {
      'Auto': 'auto', 'Instant 5.3': 'gpt-4o', 'Thinking 5.4 Standard': 'o1-mini',
      'Thinking 5.4 Extended': 'o1', 'Thinking 5.5 Standard': 'o3-mini', 'Thinking 5.5 Extended': 'o1',
    };
    const baselineMessageIds = new Set(messages.map((m) => m.id));
    
    setSendError(null);
    setIsSending(true);

    // Optimistically clear the input
    setInputValue('');
    setPastedImage(null);
    setAttachedFiles([]);

    // Create a temporary optimistic message
    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: activeConvId || '',
      role: 'user',
      content: outgoingContent,
      created_at: Date.now() / 1000,
      parent_id: messages.length > 0 ? messages[messages.length - 1].id : undefined,
    };
    
    // Add to list immediately
    setMessages(prev => [...prev, optimisticMsg]);

    try {
      await invokeMode('api:sendMessage', {
        conversationId: activeConvId,
        content: outgoingContent,
        model: modelMap[selectedModel] || 'auto',
        image: currentImage,
        files: currentFiles.map((f) => ({
          name: f.name,
          mimeType: f.mimeType,
          dataUrl: f.dataUrl,
          sizeBytes: f.sizeBytes,
        })),
      });

      if (activeConvId) {
        // Pull updates repeatedly while ChatGPT is thinking to mimic web streaming.
        const syncDeadline = Date.now() + 120000;
        let latestMsgs: Message[] = [];
        let stableAssistantPasses = 0;
        let lastAssistantFingerprint = '';

        while (Date.now() < syncDeadline) {
          const synced = await invokeMode('api:syncMessages', { conversationId: activeConvId, force: true });
          latestMsgs = Array.isArray(synced) ? synced : [];
          setMessages((prev) => {
            if (JSON.stringify(prev) === JSON.stringify(latestMsgs)) return prev;
            return latestMsgs;
          });

          const lastAssistant = [...latestMsgs].reverse().find((m) => m.role === 'assistant');
          const assistantFingerprint = lastAssistant
            ? `${lastAssistant.id}|${lastAssistant.content || ''}`
            : '';
          if (assistantFingerprint && assistantFingerprint === lastAssistantFingerprint) {
            stableAssistantPasses += 1;
          } else {
            stableAssistantPasses = 0;
            lastAssistantFingerprint = assistantFingerprint;
          }

          const bridgeState = bridgeComposerStatusRef.current?.state || '';
          const stillGenerating = bridgeState === 'sending' || bridgeState === 'thinking' || bridgeState === 'warming';
          if (!stillGenerating && stableAssistantPasses >= 2) break;

          await sleep(350);
        }

        const textNeedle = outgoingContent.trim();
        const userMessageConfirmed = !textNeedle || latestMsgs.some((m: Message) => {
          if (m.role !== 'user') return false;
          return matchesSentUserContent(m.content || '', textNeedle);
        });
        const hasNewUserTurn = latestMsgs.some((m: Message) => m.role === 'user' && !baselineMessageIds.has(m.id));
        const hasNewAssistantTurn = latestMsgs.some((m: Message) =>
          m.role === 'assistant' &&
          !baselineMessageIds.has(m.id) &&
          !!(m.content || '').trim()
        );
        const sendLikelySucceeded = userMessageConfirmed || hasNewUserTurn || hasNewAssistantTurn;

        if (!sendLikelySucceeded) {
          setSendError('Send could not be verified in this chat. Your draft was kept so you can retry.');
          setInputValue(outgoingContent);
          setPastedImage(currentImage);
          setAttachedFiles(currentFiles);
        }
      } else {
        // New conversation, need to refresh the list to find the new ID
        loadConversations();
      }
    } catch (error) {
      console.error('Failed to send message', error);
      setSendError(formatSendError(error));
      
      // Restore state on failure
      setInputValue(outgoingContent);
      setPastedImage(currentImage);
      setAttachedFiles(currentFiles);
      
      // Remove the optimistic message
      setMessages(prev => prev.filter(m => m.id !== tempId));
    } finally {
      setIsSending(false);
    }
  };

  const handleAttachFiles = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const fileArray = Array.from(list);
    const mapped = await Promise.all(fileArray.map(async (file) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      return {
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataUrl,
        sizeBytes: file.size,
      };
    }));
    setAttachedFiles((prev) => [...prev, ...mapped]);
  }, []);

	  const handleSearch = async (q: string) => {
	    setSearchQuery(q);
	    if (searchDebounceRef.current !== null) {
	      window.clearTimeout(searchDebounceRef.current);
	      searchDebounceRef.current = null;
	    }
		    const trimmed = q.trim();
		    if (!trimmed) {
		      searchRequestTokenRef.current += 1;
		      setSearchResults([]);
		      setSearchTotalCount(0);
		      setSearchTotalIsLowerBound(false);
		      return;
		    }
	    const requestToken = searchRequestTokenRef.current + 1;
	    searchRequestTokenRef.current = requestToken;
	    searchDebounceRef.current = window.setTimeout(async () => {
	      try {
		        const searchResponse = await invokeMode('db:searchMessages', { query: trimmed });
		        if (searchRequestTokenRef.current !== requestToken) {
		          return;
		        }
		        const responseResults = Array.isArray(searchResponse) ? searchResponse : searchResponse?.results;
		        const filteredResults = (Array.isArray(responseResults) ? responseResults : [])
		          .filter((r: any) => r.role === 'user' || r.role === 'assistant');
		        setSearchResults(filteredResults);
		        setSearchTotalCount(
		          typeof searchResponse?.total === 'number' ? searchResponse.total : filteredResults.length
		        );
		        setSearchTotalIsLowerBound(searchResponse?.total_is_lower_bound === true);
		      } catch (error) {
		        console.warn('Search failed:', error);
	      }
	    }, 180);
	  };

  const jumpToMessage = (e: React.MouseEvent, convId: string, msgId: string) => {
    e.stopPropagation();
    setTargetMessageId(msgId);
    setActiveHighlightQuery(searchQuery);
    selectConversation(convId);
    setShowSearch(false);
  };

  const jumpToMessageInCurrentChat = useCallback((msgId: string) => {
    const rowIndex = navigationMessages.findIndex((msg) => msg.id === msgId);
    const target = rowIndex >= 0 ? navigationMessages[rowIndex] : null;
    const targetContent = target?.content || '';
    const scrollerTop = scrollerRef.current ? Math.round(scrollerRef.current.scrollTop) : null;
    pushOomDebug('map-jump-click', {
      msgId,
      rowIndex,
      scrollerTop,
      mapQueryLen: mapSearchQuery.length,
      visibleHighlighted: viewportVisibleMessageIds.length,
      targetChars: targetContent.length,
      targetLines: countLines(targetContent),
    });
    mapJumpLockUntilRef.current = Date.now() + 900;
    pendingJumpRef.current = { msgId, startedAt: Date.now() };
    setViewportVisibleMessageIds([msgId]);
    setTargetMessageId(msgId);
    setActiveHighlightQuery('');
  }, [mapSearchQuery.length, navigationMessages, pushOomDebug, viewportVisibleMessageIds.length]);

  const handleDeleteConversation = async (id: string) => {
    if (window.confirm('Permanently delete this chat from your local database?')) {
      await invokeMode('db:deleteConversation', { id });
      if (activeConvId === id) {
        setActiveConvId(null);
        setMessages([]);
      }
      setConversationContextMenu(null);
      loadConversations();
    }
  };

  const handleAudit = async () => {
    if (isAiMode) return;
    setIsSyncing(true);
    try {
      const result = await invokeMode('api:auditDeletions');
      if (result.success) {
        loadConversations();
        updateStats();
      }
    } catch (e) {
      console.error('Audit failed', e);
    } finally {
      setIsSyncing(false);
    }
  };

  const updateStats = useCallback(async () => {
    const stats = await invokeMode('db:getStats');
    setCacheStats(stats);
  }, [invokeMode]);

  const updateCacheDiagnostics = useCallback(async () => {
    const diagnostics = await invokeMode('db:getCacheDiagnostics');
    if (diagnostics) {
      setCacheDiagnostics({
        uncachedCount: Number(diagnostics.uncachedCount || 0),
        failedCount: Number(diagnostics.failedCount || 0),
        unknownCount: Number(diagnostics.unknownCount || 0),
        dirtyCount: Number(diagnostics.dirtyCount || 0),
      });
      const uncachedIds = Array.isArray(diagnostics.uncachedRows)
        ? diagnostics.uncachedRows.map((row: { id?: unknown }) => String(row?.id || '')).filter(Boolean)
        : [];
      const dirtyIds = Array.isArray(diagnostics.dirtyRows)
        ? diagnostics.dirtyRows.map((row: { id?: unknown }) => String(row?.id || '')).filter(Boolean)
        : [];
      setUncachedConversationIds(new Set(uncachedIds));
      setDirtyConversationIds(new Set(dirtyIds));
    }
  }, [invokeMode]);
  updateCacheDiagnosticsRef.current = updateCacheDiagnostics;

  const handleCacheAll = async () => {
    if (isAiMode) return;
    if (isCachingAll) return;
    setIsCachingAll(true);
    try {
      setCacheRunStatus('Starting cache run...');
      const result = await invokeMode('api:cacheAll');
      if (result?.cancelled) {
        await updateStats();
        await updateCacheDiagnostics();
        setCacheRunStatus(`Cache run stopped: ${Number(result?.processed || 0)} synced, ${Number(result?.failed || 0)} failed.`);
        return;
      }
      if (result && typeof result === 'object' && result.success === false) {
        console.error('Cache All rejected:', result.reason || 'unknown reason');
        setCacheRunStatus(`Cache rejected: ${result.reason || 'unknown reason'}`);
        return;
      }
      await updateStats();
      await updateCacheDiagnostics();
      setCacheRunStatus(`Cache run complete: ${Number(result?.processed || 0)} cached, ${Number(result?.failed || 0)} failed.`);
    } catch (e) {
      console.error('Cache All failed', e);
      setCacheRunStatus(`Cache run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsCachingAll(false);
    }
  };

  const handleStopCache = async () => {
    if (!isCachingAll) return;
    setCacheRunStatus('Stopping cache run...');
    try {
      await invokeMode('api:cancelCache');
    } catch (e) {
      console.error('Failed to stop cache run', e);
      setCacheRunStatus(`Could not stop cache run: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRetryFailedCache = async () => {
    if (isAiMode) return;
    if (isCachingAll || cacheDiagnostics.failedCount === 0) return;
    setIsCachingAll(true);
    try {
      setCacheRunStatus('Retrying failed chats...');
      const result = await invokeMode('api:cacheFailed');
      if (result?.cancelled) {
        await updateStats();
        await updateCacheDiagnostics();
        setCacheRunStatus(`Retry stopped: ${Number(result?.processed || 0)} synced, ${Number(result?.failed || 0)} failed.`);
        return;
      }
      if (result && typeof result === 'object' && result.success === false) {
        console.error('Retry failed-cache rejected:', result.reason || 'unknown reason');
        setCacheRunStatus(`Retry rejected: ${result.reason || 'unknown reason'}`);
        return;
      }
      await updateStats();
      await updateCacheDiagnostics();
      setCacheRunStatus(`Retry complete: ${Number(result?.processed || 0)} cached, ${Number(result?.failed || 0)} failed.`);
    } catch (e) {
      console.error('Retry failed-cache pass failed', e);
      setCacheRunStatus(`Retry failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsCachingAll(false);
    }
  };

  useEffect(() => {
    updateStats();
    updateCacheDiagnostics();
  }, [conversations, updateStats, updateCacheDiagnostics]);

  useEffect(() => {
    if (window.electronAPI.onCacheProgress) {
      window.electronAPI.onCacheProgress((payload?: any) => {
        if (payload && typeof payload === 'object') {
          const stage = String(payload.stage || '');
          const processed = Number(payload.processed || 0);
          const failed = Number(payload.failed || 0);
          const inspected = Number(payload.inspected || 0);
          const total = Number(payload.total || 0);
          if (stage === 'run-start') {
            setCacheRunStatus(`Cache run started: 0/${total} processed.`);
          } else if (stage === 'chat-start') {
            setCacheRunStatus(`Syncing chat ${inspected}/${total}...`);
          } else if (stage === 'chat-success') {
            setCacheRunStatus(`Synced ${processed}/${total} chats (${failed} failed).`);
          } else if (stage === 'chat-fail') {
            setCacheRunStatus(`Failed ${failed} chats so far (${processed}/${total} synced).`);
          } else if (stage === 'chat-pause') {
            const pauseMs = Number(payload.pauseMs || 0);
            setCacheRunStatus(`Waiting ${(pauseMs / 1000).toFixed(1)}s before next chat...`);
          } else if (stage === 'run-complete') {
            setCacheRunStatus(`Cache run complete: ${processed} synced, ${failed} failed.`);
          } else if (stage === 'run-cancelled') {
            setCacheRunStatus(`Cache run stopped: ${processed} synced, ${failed} failed.`);
          }
        }
        updateStats();
        updateCacheDiagnostics();
      });
    }
  }, [updateStats, updateCacheDiagnostics]);

  useEffect(() => {
    localStorage.setItem(selectedModelStorageKey, selectedModel);
  }, [selectedModel, selectedModelStorageKey]);

  useEffect(() => {
    if (activeConvId && displayMessages.length > 0) {
      if (targetMessageId) {
        const index = displayMessages.findIndex(m => m.id === targetMessageId);
        if (index !== -1) {
          const timer = setTimeout(() => {
            virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' });
            hasScrolledToBottomRef.current[activeConvId] = true;
          }, 150);
          return () => clearTimeout(timer);
        }
      }
    }
  }, [displayMessages, activeConvId, targetMessageId]);

  useEffect(() => {
    let timer: number;
    const clearHighlight = (e: MouseEvent) => {
      if (e.button === 0) {
        setTargetMessageId(null);
        setActiveHighlightQuery('');
      }
    };
    if (targetMessageId) {
      timer = window.setTimeout(() => {
        window.addEventListener('mousedown', clearHighlight);
      }, 1000);
    }
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', clearHighlight);
    };
  }, [targetMessageId]);

  useEffect(() => {
    localStorage.setItem('fontSize', fontSize.toString());
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}pt`);
  }, [fontSize]);
  useEffect(() => {
    localStorage.setItem('sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem('sidebarOpen', isSidebarOpen ? '1' : '0');
  }, [isSidebarOpen]);
  useEffect(() => {
    localStorage.setItem('mapPanelWidth', String(mapPanelWidth));
  }, [mapPanelWidth]);
  useEffect(() => {
    if (!activeResizer) return;
    const handleMouseMove = (event: MouseEvent) => {
      const resize = panelResizeRef.current;
      if (!resize) return;
      const deltaX = event.clientX - resize.startX;
      if (resize.type === 'sidebar') {
        setSidebarWidth(clampPanelWidth(resize.startWidth + deltaX, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
        return;
      }
      setMapPanelWidth(clampPanelWidth(resize.startWidth - deltaX, MAP_WIDTH_MIN, MAP_WIDTH_MAX));
    };
    const handleMouseUp = () => {
      panelResizeRef.current = null;
      setActiveResizer(null);
    };
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeResizer]);

  useEffect(() => {
    const isZoomModifier = (event: KeyboardEvent | WheelEvent) => event.ctrlKey || event.metaKey;
    const handleWheelZoom = (event: WheelEvent) => {
      if (!isZoomModifier(event)) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      adjustFontSize(event.deltaY < 0 ? 1 : -1);
    };
    const handleKeyZoom = (event: KeyboardEvent) => {
      if (!isZoomModifier(event)) return;
      const key = event.key;
      if (key === '=' || key === '+' || key === 'Add') {
        event.preventDefault();
        adjustFontSize(1);
        return;
      }
      if (key === '-' || key === '_' || key === 'Subtract') {
        event.preventDefault();
        adjustFontSize(-1);
        return;
      }
      if (key === '0') {
        event.preventDefault();
        resetFontSize();
      }
    };
    window.addEventListener('wheel', handleWheelZoom, { passive: false });
    window.addEventListener('keydown', handleKeyZoom);
    return () => {
      window.removeEventListener('wheel', handleWheelZoom as EventListener);
      window.removeEventListener('keydown', handleKeyZoom);
    };
  }, [adjustFontSize, resetFontSize]);

  useEffect(() => {
    const handleRefreshShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'r') return;
      event.preventDefault();
      event.stopPropagation();
      void handleRefreshCurrentChat();
    };
    window.addEventListener('keydown', handleRefreshShortcut, true);
    return () => window.removeEventListener('keydown', handleRefreshShortcut, true);
  }, [handleRefreshCurrentChat]);

  useEffect(() => {
    localStorage.setItem('chatWidth', chatWidth.toString());
    document.documentElement.style.setProperty('--message-max-width', `${chatWidth}px`);
  }, [chatWidth]);

  useEffect(() => {
    localStorage.setItem('messageMapOpen', isMessageMapOpen ? '1' : '0');
  }, [isMessageMapOpen]);

  useEffect(() => {
    const handleGlobalMiddleDown = (event: MouseEvent) => {
      if (event.button !== 1) return;
      markMiddlePasteSuppressed();
    };
    window.addEventListener('mousedown', handleGlobalMiddleDown, true);
    return () => window.removeEventListener('mousedown', handleGlobalMiddleDown, true);
  }, [markMiddlePasteSuppressed]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [inputValue]);

  useEffect(() => {
    if (activeConvId) {
      localStorage.setItem(lastConvStorageKey, activeConvId);
      activeConvIdRef.current = activeConvId;
    } else {
      localStorage.removeItem(lastConvStorageKey);
      activeConvIdRef.current = null;
    }
  }, [activeConvId, lastConvStorageKey]);

  useEffect(() => {
    if (!isPanning) {
      if (panRaf.current) cancelAnimationFrame(panRaf.current);
      panScrollTargetRef.current = null;
      return;
    }
    const handleMouseMove = (e: MouseEvent) => { panCurrent.current = { x: e.clientX, y: e.clientY }; };
    const handleMouseUp = (e: MouseEvent) => { if (e.button === 1) setIsPanning(false); };
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp, { passive: true });
    const scrollLoop = () => {
      if (panScrollTargetRef.current) {
        const dy = panCurrent.current.y - panStart.current.y;
        if (Math.abs(dy) > 5) {
          const speed = (dy - Math.sign(dy) * 5) * 0.15;
          panScrollTargetRef.current.scrollBy(0, speed);
        }
      }
      panRaf.current = requestAnimationFrame(scrollLoop);
    };
    panRaf.current = requestAnimationFrame(scrollLoop);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (panRaf.current) cancelAnimationFrame(panRaf.current);
    };
  }, [isPanning]);

  useEffect(() => {
    if (fullscreenImage) setImageMenu(null);
  }, [fullscreenImage]);

  useEffect(() => {
    setViewportVisibleMessageIds([]);
  }, [activeConvId]);

  useEffect(() => {
    if (!fullscreenImage) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (imageMenu) setImageMenu(null);
        else setFullscreenImage(null);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [fullscreenImage, imageMenu]);

  const handleCopyFullscreenImage = useCallback(async () => {
    if (!fullscreenImage) return;
    const result = await window.electronAPI.invoke('api:copyImageToClipboard', {
      src: fullscreenImage,
      conversationId: activeConvId || undefined,
    });
    if (!result?.success) {
      console.error('Copy image failed:', result?.error || 'unknown error');
    }
    setImageMenu(null);
  }, [fullscreenImage, activeConvId]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    if (isAiMode) {
      setBridgeComposerStatus(null);
      return;
    }
    if (window.electronAPI.onBridgeComposerStatus) {
      const maybeUnsub = window.electronAPI.onBridgeComposerStatus((status: BridgeComposerStatus) => {
        setBridgeComposerStatus(status || null);
      });
      if (typeof maybeUnsub === 'function') unsubscribe = maybeUnsub;
    }
    window.electronAPI.invoke('api:getBridgeComposerStatus')
      .then((status: BridgeComposerStatus) => setBridgeComposerStatus(status || null))
      .catch((error) => console.warn('Failed to get initial bridge status', error));
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [isAiMode]);

  useEffect(() => {
    bridgeComposerStatusRef.current = bridgeComposerStatus;
  }, [bridgeComposerStatus]);

  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    const init = async () => {
      try {
        if (isAiMode) {
          setIsSyncing(true);
          try {
            const existing = await invokeMode('db:getConversations');
            if (!Array.isArray(existing) || existing.length === 0) {
              await window.electronAPI.invoke('ai:importTakeout', { path: AI_MODE_TAKEOUT_DEFAULT_PATH });
            }
          } finally {
            setIsSyncing(false);
          }
        }
        await checkAuth();
        const savedId = localStorage.getItem(lastConvStorageKey);
        if (savedId) {
          await selectConversationRef.current(savedId, true, true);
        } else if (!isAiMode) {
          window.electronAPI.invoke('api:prewarmConversation', { conversationId: null })
            .catch((error) => console.warn('Failed to prewarm new chat bridge', error));
        }
      } catch (error) {
        console.error('Workspace initialization failed', error);
        setSendError(`Workspace initialization failed: ${String((error as Error)?.message || error)}`);
      }
    };
    void init();
  }, [checkAuth, invokeMode, isAiMode, lastConvStorageKey]);

  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
              const reader = new FileReader();
              reader.onload = (event) => { setPastedImage(event.target?.result as string); };
              reader.readAsDataURL(blob);
            }
          }
        }
      }
    };
    window.addEventListener('paste', handleGlobalPaste);
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (showModelMenu && !target.closest('.model-picker-container')) {
        setShowModelMenu(false);
      }
      if (conversationContextMenu && !target.closest('.conversation-context-menu')) {
        setConversationContextMenu(null);
      }
    };
    const handleAnyScroll = () => {
      setConversationContextMenu(null);
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleAnyScroll, true);
    return () => {
      window.removeEventListener('paste', handleGlobalPaste);
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleAnyScroll, true);
    };
  }, [showModelMenu, conversationContextMenu]);

  const startPanning = (e: React.MouseEvent, scrollTarget?: HTMLElement | null) => {
    if (e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      panScrollTargetRef.current = scrollTarget || scrollerRef.current;
      setPanPosition({ x: e.clientX, y: e.clientY });
      panStart.current = { x: e.clientX, y: e.clientY };
      panCurrent.current = { x: e.clientX, y: e.clientY };
    }
  };

  const updateViewportNavHighlight = useCallback(() => {
    if (!isMessageMapOpen) return;
    if (Date.now() < mapJumpLockUntilRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportTop = scrollerRect.top;
    const viewportBottom = scrollerRect.bottom;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.message-row[data-message-id]'));
    const navigableIds = new Set(displayMessages.filter(isNavigableMessage).map((m) => m.id));
    const visibleIds: string[] = [];

    for (const row of rows) {
      const msgId = row.dataset.messageId || null;
      if (!msgId || !navigableIds.has(msgId)) continue;
      const rect = row.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, viewportTop);
      const visibleBottom = Math.min(rect.bottom, viewportBottom);
      const visiblePx = Math.max(0, visibleBottom - visibleTop);
      const minVisiblePx = Math.min(28, Math.max(10, rect.height * 0.2));
      if (visiblePx >= minVisiblePx) visibleIds.push(msgId);
    }

    if (visibleIds.length === 0) {
      for (const row of rows) {
        const msgId = row.dataset.messageId || null;
        if (!msgId || !navigableIds.has(msgId)) continue;
        const rect = row.getBoundingClientRect();
        if (rect.top >= viewportTop) {
          visibleIds.push(msgId);
          break;
        }
      }
    }

    setViewportVisibleMessageIds((prev) => {
      if (prev.length === visibleIds.length && prev.every((id, idx) => id === visibleIds[idx])) {
        return prev;
      }
      pushOomDebug('map-visible-update', {
        prevCount: prev.length,
        nextCount: visibleIds.length,
        topId: visibleIds[0] || null,
        bottomId: visibleIds[visibleIds.length - 1] || null,
      });
      return visibleIds;
    });
  }, [displayMessages, isMessageMapOpen, pushOomDebug]);

  useEffect(() => {
    updateViewportNavHighlightRef.current = updateViewportNavHighlight;
  }, [updateViewportNavHighlight]);

  const handleMessageRangeChanged = useCallback(() => {
    updateViewportNavHighlight();
  }, [updateViewportNavHighlight]);

  useEffect(() => {
    mapOpenRef.current = isMessageMapOpen;
    if (isMessageMapOpen) {
      scheduleViewportHighlightUpdate();
    }
  }, [isMessageMapOpen, scheduleViewportHighlightUpdate]);

  useEffect(() => {
    window.addEventListener('resize', scheduleViewportHighlightUpdate, { passive: true });
    return () => {
      window.removeEventListener('resize', scheduleViewportHighlightUpdate);
    };
  }, [scheduleViewportHighlightUpdate]);

  useEffect(() => () => {
    if (viewportHighlightRafRef.current !== null) {
      cancelAnimationFrame(viewportHighlightRafRef.current);
      viewportHighlightRafRef.current = null;
    }
    if (scrollerRef.current) {
      scrollerRef.current.removeEventListener('scroll', handleMessageScroll);
    }
  }, [handleMessageScroll]);

  useEffect(() => {
    updateNearBottom();
  }, [displayMessagesForView.length, updateNearBottom]);

  useEffect(() => {
    if (!isMessageMapOpen) return;
    const timer = window.setTimeout(() => updateViewportNavHighlight(), 0);
    return () => window.clearTimeout(timer);
  }, [displayMessages, updateViewportNavHighlight, isMessageMapOpen]);

  useEffect(() => {
    if (!isMessageMapOpen) return;
    const mapList = mapListRef.current;
    const anchorId = viewportVisibleMessageIds[0];
    if (!mapList || !anchorId) return;

    const target = mapList.querySelector<HTMLElement>(`.content-nav-item[data-message-id="${anchorId}"]`);
    if (!target) return;

    const padding = 10;
    const viewTop = mapList.scrollTop + padding;
    const viewBottom = mapList.scrollTop + mapList.clientHeight - padding;
    const itemTop = target.offsetTop;
    const itemBottom = itemTop + target.offsetHeight;

    if (itemTop < viewTop) {
      mapList.scrollTop = Math.max(0, itemTop - padding);
      return;
    }
    if (itemBottom > viewBottom) {
      mapList.scrollTop = Math.max(0, itemBottom - mapList.clientHeight + padding);
    }
  }, [viewportVisibleMessageIds, isMessageMapOpen]);

  useEffect(() => {
    oomDebugStateRef.current = {
      mapQuery: mapSearchQuery,
      navCount: navigationMessages.length,
      visibleCount: viewportVisibleMessageIds.length,
      displayCount: displayMessages.length,
      displayViewCount: displayMessagesForView.length,
    };
  }, [mapSearchQuery, navigationMessages.length, viewportVisibleMessageIds.length, displayMessages.length, displayMessagesForView.length]);

  useEffect(() => {
    const api = {
      enable: () => {
        localStorage.setItem('oomDebug', '1');
        oomDebugEnabledRef.current = true;
        console.info('[oom-debug] enabled');
      },
      disable: () => {
        localStorage.removeItem('oomDebug');
        oomDebugEnabledRef.current = false;
        console.info('[oom-debug] disabled');
      },
      clear: () => {
        oomDebugEntriesRef.current = [];
        console.info('[oom-debug] cleared');
      },
      dump: () => {
        const rows = oomDebugEntriesRef.current.map((entry) => ({
          iso: new Date(entry.ts).toISOString(),
          event: entry.event,
          ...entry.payload,
        }));
        console.table(rows);
        return rows;
      },
      snapshot: () => ({
        now: new Date().toISOString(),
        heap: getHeapSnapshot(),
        ...oomDebugStateRef.current,
      }),
    };
    (window as Window & { __chatgptOomDebug?: typeof api }).__chatgptOomDebug = api;
    return () => {
      const win = window as Window & { __chatgptOomDebug?: typeof api };
      if (win.__chatgptOomDebug === api) delete win.__chatgptOomDebug;
    };
  }, [getHeapSnapshot]);

  useEffect(() => {
    if (!oomDebugEnabledRef.current) return;
    pushOomDebug('render-stats', {
      mapQueryLen: mapSearchQuery.length,
      navCount: navigationMessages.length,
      visibleCount: viewportVisibleMessageIds.length,
      displayCount: displayMessages.length,
      displayViewCount: displayMessagesForView.length,
    });
  }, [mapSearchQuery.length, navigationMessages.length, viewportVisibleMessageIds.length, displayMessages.length, displayMessagesForView.length, pushOomDebug]);

  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending) return;
    if (!viewportVisibleMessageIds.includes(pending.msgId)) return;
    pushOomDebug('map-jump-settled', {
      msgId: pending.msgId,
      elapsedMs: Date.now() - pending.startedAt,
      visibleCount: viewportVisibleMessageIds.length,
    });
    pendingJumpRef.current = null;
  }, [viewportVisibleMessageIds, pushOomDebug]);

  useEffect(() => {
    if (!oomDebugEnabledRef.current) return;
    if (typeof PerformanceObserver === 'undefined') return;
    let obs: PerformanceObserver | null = null;
    try {
      obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (const entry of entries) {
          if (entry.duration >= 120) {
            pushOomDebug('longtask', {
              name: entry.name,
              startTime: Math.round(entry.startTime),
              durationMs: Math.round(entry.duration),
            });
          }
        }
      });
      obs.observe({ entryTypes: ['longtask'] as any });
    } catch {
      // longtask not supported in this runtime
    }
    return () => {
      if (obs) obs.disconnect();
    };
  }, [pushOomDebug]);

  useEffect(() => {
    if (!oomDebugEnabledRef.current) return;
    const id = window.setInterval(() => {
      pushOomDebug('heartbeat', {
        mapQueryLen: oomDebugStateRef.current.mapQuery.length,
        navCount: oomDebugStateRef.current.navCount,
        visibleCount: oomDebugStateRef.current.visibleCount,
        displayCount: oomDebugStateRef.current.displayCount,
        displayViewCount: oomDebugStateRef.current.displayViewCount,
      });
    }, 2000);
    return () => window.clearInterval(id);
  }, [pushOomDebug]);

  if (!isAiMode && isAuth === null) return <div className="auth-overlay">Loading...</div>;
  if (!isAiMode && isAuth === false) return (
    <div className="auth-overlay">
      <h1>ChatGPT Desktop</h1>
      <p>Please log in to your ChatGPT Plus account</p>
      <button className="login-btn" onClick={handleLogin}>Login with Browser</button>
    </div>
  );

  const mapHighlightQuery = mapSearchQuery.trim().length >= 2 ? mapSearchQuery.trim() : '';
  const trimmedSearchQuery = searchQuery.trim();
  const searchMatchCount = trimmedSearchQuery ? searchTotalCount : 0;
  const searchMatchCountLabel = `${searchMatchCount}${searchTotalIsLowerBound ? '+' : ''}`;
  const hasSendableInput = !!inputValue.trim() || !!pastedImage || attachedFiles.length > 0;
  const isSendDisabled = isAiMode || isSending || !hasSendableInput || !isBridgeReadyForActiveConversation;
  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => {
      if (prev && activeResizer === 'sidebar') {
        panelResizeRef.current = null;
        setActiveResizer(null);
      }
      return !prev;
    });
  };
  const appContainerStyle = {
    ['--sidebar-width' as any]: `${sidebarWidth}px`,
    ['--content-nav-width' as any]: `${mapPanelWidth}px`,
  } as React.CSSProperties;

  return (
    <div className="app-container" style={appContainerStyle}>
      {isPanning && (
        <div className="pan-overlay">
          <div className="pan-center" style={{ left: panPosition.x, top: panPosition.y }} />
        </div>
      )}
      {isSidebarOpen ? (
        <div className="sidebar">
          <div className="sidebar-header">
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="new-chat-btn" onClick={() => {
                saveVirtuosoState(activeConvIdRef.current);
                setActiveConvId(null);
                setMessages([]);
                activeConvIdRef.current = null;
                setRestoreVirtuosoState(null);
                if (!isAiMode) {
                  window.electronAPI.invoke('api:prewarmConversation', { conversationId: null }).catch((error) => console.warn('Failed to prewarm new chat bridge', error));
                }
              }}>+ New Chat</button>
              <button className="search-trigger-btn" onClick={() => setShowSearch(true)} title="Search Chats">
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
              </button>
            </div>
          </div>
          <div className="conversations-list" onMouseDown={(e) => startPanning(e, conversationsScrollerRef.current || (e.currentTarget as HTMLElement))}>
            <Virtuoso
              data={conversations}
              endReached={loadMoreConversations}
              scrollerRef={handleConversationsScrollerRef as any}
              itemContent={(_index, conv) => (
                <ConversationItem 
                  key={conv.id} 
                  conv={conv} 
                  markerState={uncachedConversationIds.has(conv.id) ? 'uncached' : !isAiMode && dirtyConversationIds.has(conv.id) ? 'dirty' : 'none'}
                  active={activeConvId === conv.id} 
                  onClick={() => selectConversation(conv.id)} 
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConversationContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      conversationId: conv.id,
                    });
                  }}
                />
              )}
              components={{ Footer: () => isLoadingMoreConvs ? <div style={{ padding: '10px', textAlign: 'center', fontSize: '12px', color: '#c5c5d2' }}>Loading more...</div> : null }}
            />
          </div>
          <div className="sidebar-footer">
            <div className="cache-stats-container">
              <div className="cache-stats-text">
                <div className="cache-stats-line">
                  <span className="stats-label">Cached:</span>
                  <span className="stats-value">{cacheStats.cachedCount} / {cacheStats.localCount}</span>
                </div>
                <div className="cache-stats-line" title="Uncached chats split by known failed fetches vs unknown/no-data cases">
                  <span className="stats-label">Uncached:</span>
                  <span className="stats-value">{cacheDiagnostics.uncachedCount}</span>
                  <span className="stats-subvalue">fail {cacheDiagnostics.failedCount} · unknown {cacheDiagnostics.unknownCount}</span>
                </div>
                <div className="cache-stats-line" title="Cached chats that need a full sync">
                  <span className="stats-label">Needs sync:</span>
                  <span className="stats-value">{cacheDiagnostics.dirtyCount}</span>
                </div>
                {cacheRunStatus ? (
                  <div className="cache-stats-line" title={cacheRunStatus}>
                    <span className="stats-label">Status:</span>
                    <span className="stats-subvalue">{cacheRunStatus}</span>
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {!isAiMode ? (
                  <>
                    {isCachingAll ? (
                      <button
                        className="cache-all-btn"
                        onClick={handleStopCache}
                        title="Stop the active cache sync"
                      >
                        Stop
                      </button>
                    ) : null}
                    <button
                      className="cache-all-btn"
                      onClick={handleRetryFailedCache}
                      disabled={isCachingAll || cacheDiagnostics.failedCount === 0}
                      title="Retry only conversations with known cache failures"
                    >
                      Retry failed
                    </button>
                    <button
                      className={`cache-all-btn ${isCachingAll ? 'spinning' : ''}`}
                      onClick={handleCacheAll}
                      disabled={isCachingAll || (cacheDiagnostics.uncachedCount === 0 && cacheDiagnostics.dirtyCount === 0)}
                      title="Cache missing chats and refresh chats that need a full sync"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                      </svg>
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="footer-actions">
              <button className="sync-btn-sidebar" onClick={() => activeConvId && selectConversation(activeConvId, true, true)} title="Sync current chat">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
              </button>
              <button className="settings-btn" onClick={() => setShowSettings(true)}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
                Settings
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isSidebarOpen ? (
        <div
          className={`panel-resizer sidebar-resizer ${activeResizer === 'sidebar' ? 'active' : ''}`}
          onMouseDown={handleSidebarResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat list panel"
        />
      ) : null}
      <div className={`main-content ${isSidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${isMessageMapOpen ? 'map-open' : 'map-closed'}`}>
        <button
          className="workspace-home-btn"
          onClick={onGoHome}
          title="Home"
          aria-label="Home"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
            <path d="M12 3l9 8.5-1.4 1.5L18 11.4V21h-5v-6H11v6H6v-9.6L4.4 13 3 11.5 12 3z" />
          </svg>
        </button>
        <button
          className={`sidebar-toggle ${isSidebarOpen ? 'open' : 'closed'}`}
          onClick={toggleSidebar}
          title={isSidebarOpen ? 'Hide chat list' : 'Show chat list'}
          aria-label={isSidebarOpen ? 'Hide chat list' : 'Show chat list'}
        >
          {isSidebarOpen ? '‹' : '›'}
        </button>
        <div className="chat-body">
          <div className="chat-pane">
            {isSyncing && <div className="sync-indicator">Syncing...</div>}
            <div className="messages-container" onMouseDown={(e) => startPanning(e, scrollerRef.current)}>
              <Virtuoso key={activeConvId || '__new_chat__'} ref={virtuosoRef} scrollerRef={handleMessageScrollerRef as any} data={displayMessagesForView} initialTopMostItemIndex={displayMessagesForView.length > 0 ? displayMessagesForView.length - 1 : 0} restoreStateFrom={restoreVirtuosoState || undefined} followOutput={false} defaultItemHeight={180} increaseViewportBy={{ top: mapSearchNeedle ? 420 : 1200, bottom: mapSearchNeedle ? 240 : 400 }} overscan={mapSearchNeedle ? { main: 260, reverse: 320 } : { main: 1000, reverse: 1400 }} isScrolling={(isScrolling) => { if (isScrolling) scheduleViewportHighlightUpdate(); else updateViewportNavHighlight(); }} rangeChanged={handleMessageRangeChanged}
                itemContent={(_index, msg) => {
                  const isTarget = targetMessageId === msg.id;
                  const shouldMapHighlight = !!mapHighlightQuery && mapMatchMessageIds.has(msg.id);
                  const messageIsHighlightSafe = shouldMapHighlight
                    ? countNeedleHits(msg.content || '', mapHighlightQuery.toLowerCase()) <= MAX_MESSAGE_HIGHLIGHT_HITS
                    : true;
                  const highlightQuery = (shouldMapHighlight && messageIsHighlightSafe) ? mapHighlightQuery : (isTarget ? activeHighlightQuery : '');
                  return (
                    <MessageRow
                      key={msg.id}
                      msg={msg}
                      highlightQuery={highlightQuery}
                      isTarget={isTarget}
                      onOpenImage={setFullscreenImage}
                      citationRegistry={citationRegistry}
                    />
                  );
                }}
              />
            </div>
          </div>
          {isMessageMapOpen ? (
            <div
              className={`panel-resizer content-nav-resizer ${activeResizer === 'map' ? 'active' : ''}`}
              onMouseDown={handleMapResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize message map panel"
            />
          ) : null}
          <button
            className={`content-nav-toggle ${isMessageMapOpen ? 'open' : 'closed'}`}
            onClick={() => setIsMessageMapOpen((prev) => !prev)}
            title={isMessageMapOpen ? 'Hide message map' : 'Show message map'}
            aria-label={isMessageMapOpen ? 'Hide message map' : 'Show message map'}
          >
            {isMessageMapOpen ? '›' : '‹'}
          </button>
          <aside className={`content-nav ${isMessageMapOpen ? '' : 'collapsed'}`} aria-label="Chat message navigation">
            <div className="content-nav-header">
              <span>Message Map</span>
            </div>
            <div ref={mapListRef} className="content-nav-list" onMouseDown={(e) => startPanning(e, e.currentTarget as HTMLElement)}>
              {navigationMessages.map((msg) => (
                <button
                  key={msg.id}
                  data-message-id={msg.id}
                  className={`content-nav-item ${msg.role === 'user' ? 'role-user' : 'role-assistant'} ${activeMapMessageIds.has(msg.id) ? 'active' : ''} ${mapMatchMessageIds.has(msg.id) ? 'match' : ''}`}
                  onClick={() => jumpToMessageInCurrentChat(msg.id)}
                  title={msg.preview}
                >
                  <span className="content-nav-index">{msg.navIndex}</span>
                  <span className="content-nav-text">{msg.preview}</span>
                </button>
              ))}
            </div>
            <div className="content-nav-search">
              <input
                type="text"
                className="content-nav-search-input"
                placeholder="Find in this chat..."
                value={mapSearchQuery}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onPaste={(e) => {
                  const text = e.clipboardData?.getData('text') || '';
                  if (!text) return;
                  e.preventDefault();
                  const next = sanitizeMapSearchQuery(text);
                  if (text.length > MAX_MAP_SEARCH_QUERY_LEN) {
                    pushOomDebug('map-search-truncated', {
                      rawLen: text.length,
                      keptLen: next.length,
                      source: 'paste',
                    });
                  }
                  pushOomDebug('map-search-change', {
                    queryLen: next.length,
                    navCount: navigationMessages.length,
                    source: 'paste',
                  });
                  setMapSearchQuery(next);
                }}
                onChange={(e) => {
                  const rawNext = e.target.value;
                  const next = sanitizeMapSearchQuery(rawNext);
                  if (rawNext.length > MAX_MAP_SEARCH_QUERY_LEN) {
                    pushOomDebug('map-search-truncated', {
                      rawLen: rawNext.length,
                      keptLen: next.length,
                    });
                  }
                  pushOomDebug('map-search-change', {
                    queryLen: next.length,
                    navCount: navigationMessages.length,
                  });
                  setMapSearchQuery(next);
                }}
              />
            </div>
          </aside>
        </div>
        <div className="input-area">
            <div className="input-container">
              {sendError && (
                <div className="send-error-banner">
                  <span>{sendError}</span>
                  <button className="send-error-dismiss" onClick={() => setSendError(null)} aria-label="Dismiss send error">×</button>
                </div>
              )}
              {pastedImage && <div className="image-preview"><img src={pastedImage} alt="Pasted" /><button className="remove-image" onClick={() => setPastedImage(null)}>×</button></div>}
              {attachedFiles.length > 0 && (
                <div className="file-preview-list">
                  {attachedFiles.map((file) => (
                    <div key={file.id} className="file-preview-chip" title={file.name}>
                      <span className="file-preview-name">{file.name}</span>
                      <button className="file-preview-remove" onClick={() => setAttachedFiles((prev) => prev.filter((f) => f.id !== file.id))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  handleAttachFiles(e.target.files).catch((err) => console.error('Attach failed', err));
                  e.currentTarget.value = '';
                }}
              />
	              <div className="input-wrapper">
	                {!isAiMode ? (
	                  <div className="model-picker-container">
	                    <button className={`model-picker-trigger ${showModelMenu ? 'active' : ''}`} onClick={() => setShowModelMenu(!showModelMenu)} title="Select Model"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14l5-5 5 5z"/></svg></button>
	                    <button className="attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach files">
	                      <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16.5 6.5l-7.79 7.79a2 2 0 1 0 2.83 2.83l7.08-7.08a4 4 0 1 0-5.66-5.66L5.17 12.17a6 6 0 1 0 8.49 8.49l6.36-6.36-1.41-1.41-6.36 6.36a4 4 0 1 1-5.66-5.66l7.79-7.79a2 2 0 1 1 2.83 2.83l-7.08 7.08-.71-.71 6.72-6.72 1.41 1.41-6.72 6.72a2 2 0 0 1-2.83-2.83l7.79-7.79 1.41 1.41z"/></svg>
	                    </button>
	                    {showModelMenu && <div className="model-picker-menu">{['Auto', 'Instant 5.3', 'Thinking 5.4 Standard', 'Thinking 5.4 Extended', 'Thinking 5.5 Standard', 'Thinking 5.5 Extended'].map(m => <button key={m} className={`model-picker-option ${selectedModel === m ? 'active' : ''}`} onClick={() => { setSelectedModel(m); setShowModelMenu(false); }}>{m}</button>)}</div>}
	                  </div>
	                ) : null}
			              <textarea
			                ref={textareaRef}
			                className="chat-input"
			                placeholder={isAiMode ? 'Imported AI Mode archive (read-only)' : 'Send a message...'}
		                rows={1}
			                value={inputValue}
			                disabled={isAiMode}
			                onChange={(e) => setInputValue(e.target.value)}
		                onPointerDownCapture={(e) => {
		                  if (e.button !== 1) return;
		                  markMiddlePasteSuppressed();
		                  e.preventDefault();
		                }}
		                onMouseDown={(e) => {
		                  if (e.button !== 1) return;
		                  markMiddlePasteSuppressed();
		                  e.preventDefault();
		                }}
		                onMouseUp={(e) => {
		                  if (e.button !== 1) return;
		                  e.preventDefault();
		                }}
		                onAuxClick={(e) => {
		                  if (e.button !== 1) return;
		                  e.preventDefault();
		                }}
		                onPaste={(e) => {
		                  const shouldSuppress = suppressMiddlePasteRef.current || Date.now() < suppressMiddlePasteUntilRef.current;
		                  if (!shouldSuppress) return;
		                  e.preventDefault();
		                  suppressMiddlePasteRef.current = false;
		                  suppressMiddlePasteUntilRef.current = 0;
		                }}
		                onKeyDown={(e) => {
		                  if (e.key === 'Enter' && !e.shiftKey) {
		                    e.preventDefault();
		                    handleSend();
		                  }
		                }}
		                onBlur={() => {
		                  suppressMiddlePasteRef.current = false;
		                  suppressMiddlePasteUntilRef.current = 0;
		                }}
		              />
	              {bridgeActivityLabel && !sendError && (
	                <span className={`bridge-status-inline ${bridgeComposerStatus?.state === 'error' ? 'error' : ''}`}>
	                  {bridgeActivityLabel}
	                </span>
	              )}
	              <button className={`send-btn ${isBridgeReadyForActiveConversation ? 'ready' : 'not-ready'}`} onClick={handleSend} disabled={isSendDisabled}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
	            </div>
          </div>
        </div>
      </div>
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="close-modal" onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="setting-item">
              <label>Font Size <span className="setting-value">{fontSize}pt</span></label>
              <input type="range" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} value={fontSize} onChange={(e) => setFontSize(clampFontSize(parseInt(e.target.value, 10)))} />
            </div>
            <div className="setting-item">
              <label>Chat Column Width <span className="setting-value">{chatWidth}px</span></label>
              <input type="range" min="400" max="5000" step="50" value={chatWidth} onChange={(e) => setChatWidth(parseInt(e.target.value))} />
            </div>
            <div className="setting-item">
              <label>Account & Sync</label>
              <div className="settings-action-list">
	                {!isAiMode ? (
	                  <>
	                    <button className="settings-action-btn" onClick={handleAudit} title="Check for chats deleted on web and mark local cache accordingly">
	                      Check for auto deletions
	                    </button>
	                    <button className="settings-action-btn" onClick={handleReauth} disabled={isReauthenticating} title="Clear ChatGPT session data and log in again">
	                      {isReauthenticating ? 'Re-authenticating...' : 'Re-authenticate'}
	                    </button>
	                  </>
	                ) : (
	                  <div className="settings-note">AI Mode uses imported takeout plus live bridge sync from Google AI Mode history.</div>
	                )}
	              </div>
	            </div>
          </div>
        </div>
      )}
      {showSearch && (
        <div className="modal-backdrop" onClick={() => setShowSearch(false)}>
          <div className="search-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Search Conversations</h2>
              <button className="close-modal" onClick={() => setShowSearch(false)}>×</button>
            </div>
            <div className="search-input-container">
              <input
                autoFocus
                type="text"
                placeholder="Search all messages..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
              />
            </div>
	            {trimmedSearchQuery && (
	              <div className="search-results-meta">
	                {searchMatchCountLabel} match{searchMatchCount === 1 && !searchTotalIsLowerBound ? '' : 'es'}
	              </div>
	            )}
	            <div className="search-results">
	              {searchResults.length === 0 && trimmedSearchQuery !== '' && (
	                <div className="no-results">No messages found matching "{searchQuery}"</div>
	              )}
              {searchResults.map(res => (
                <div key={res.id} className="search-result-item" onClick={(e) => jumpToMessage(e, res.conversation_id, res.id)}>
                  <div className="search-result-header">
                    <span className="search-result-title">{res.conversation_title}</span>
                    <span className="search-result-role">{res.role}</span>
                  </div>
	                  <div className="search-result-content">
	                    {(() => {
		                      const text = res.content;
		                      const terms = searchQuery
		                        .toLowerCase()
		                        .split(/\s+/)
		                        .map(term => term.trim())
		                        .filter(Boolean);
		                      const lowered = text.toLowerCase();
		                      const phraseTerms = terms.map(term => escapeRegExp(term));
		                      const escapedTerms = terms
		                        .map(term => escapeRegExp(term))
		                        .sort((a, b) => b.length - a.length);
		                      const phrasePattern = phraseTerms.length > 1
		                        ? new RegExp(phraseTerms.map(term => `${term}[a-z0-9_-]*`).join('[^a-z0-9]+'), 'i')
		                        : null;
		                      const phraseMatch = phrasePattern ? lowered.match(phrasePattern) : null;
		                      const indices = escapedTerms
		                        .map(term => lowered.search(new RegExp(`${term}[a-z0-9_-]*`, 'i')))
		                        .filter(idx => idx >= 0);
		                      const idx = phraseMatch?.index ?? (indices.length > 0 ? Math.min(...indices) : lowered.indexOf(searchQuery.toLowerCase()));
		                      const previewIndex = Math.max(0, idx);
		                      const start = Math.max(0, previewIndex - 60);
		                      const end = Math.min(text.length, previewIndex + 100);
		                      const preview = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
		                      if (terms.length === 0) {
		                        return preview;
		                      }
		                      const parts = preview.split(new RegExp(`(${escapedTerms.map(term => `${term}[a-z0-9_-]*`).join('|')})`, 'gi'));
		                      return parts.map((part, i) => terms.some(term => part.toLowerCase().startsWith(term)) ? <span key={i} className="search-highlight">{part}</span> : part);
		                    })()}
	                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {conversationContextMenu && (
        <div
          className="conversation-context-menu"
          style={{ left: conversationContextMenu.x, top: conversationContextMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="conversation-context-menu-item"
            onClick={() => handleDeleteConversation(conversationContextMenu.conversationId)}
          >
            Delete locally
          </button>
        </div>
      )}
      {fullscreenImage && (
        <div className="image-lightbox" onClick={() => { setImageMenu(null); setFullscreenImage(null); }}>
          <button className="image-lightbox-close" onClick={() => setFullscreenImage(null)} aria-label="Close image preview">×</button>
          <img
            className="image-lightbox-content"
            src={fullscreenImage}
            alt="Full size chat image"
            onClick={(e) => { e.stopPropagation(); setImageMenu(null); }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setImageMenu({ x: e.clientX, y: e.clientY });
            }}
          />
          {imageMenu && (
            <div
              className="image-context-menu"
              style={{ left: imageMenu.x, top: imageMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="image-context-menu-item" onClick={handleCopyFullscreenImage}>Copy image</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const WorkspaceHome = ({ onSelectChatGPT, onSelectAiMode }: { onSelectChatGPT: () => void; onSelectAiMode: () => void }) => {
  return (
    <div className="workspace-shell workspace-home-shell">
      <div className="workspace-home-panel">
        <div className="workspace-home-eyebrow">Home</div>
        <h1>Choose a workspace</h1>
        <p>ChatGPT uses the bridge-backed live chat. AI Mode shows imported takeout chats in the same interface.</p>
        <div className="workspace-choice-list">
          <button className="workspace-choice-card" onClick={onSelectChatGPT}>
            <div className="workspace-choice-card-title">ChatGPT</div>
            <div className="workspace-choice-card-subtitle">Current app</div>
          </button>
          <button className="workspace-choice-card" onClick={onSelectAiMode}>
            <div className="workspace-choice-card-title">AI Mode</div>
            <div className="workspace-choice-card-subtitle">Imported takeout chats</div>
          </button>
        </div>
      </div>
    </div>
  );
};

function App() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('home');

  useEffect(() => {
    const rawFont = Number(localStorage.getItem('fontSize'));
    const fontSize = Number.isFinite(rawFont) && rawFont > 0 ? clampFontSize(rawFont) : FONT_SIZE_DEFAULT;
    const chatWidth = Number(localStorage.getItem('chatWidth')) || 800;
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}pt`);
    document.documentElement.style.setProperty('--message-max-width', `${chatWidth}px`);
  }, []);

  if (workspaceMode === 'home') {
    return (
      <WorkspaceHome
        onSelectChatGPT={() => setWorkspaceMode('chatgpt')}
        onSelectAiMode={() => setWorkspaceMode('aimode')}
      />
    );
  }

  if (workspaceMode === 'aimode') {
    return <ChatGPTApp workspaceMode="aimode" onGoHome={() => setWorkspaceMode('home')} />;
  }

  return <ChatGPTApp workspaceMode="chatgpt" onGoHome={() => setWorkspaceMode('home')} />;
}

export default App;
