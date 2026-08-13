export const SEARCH_MATCH_HIGHLIGHT_NAME = 'chat-search-matches';
export const SEARCH_ACTIVE_HIGHLIGHT_NAME = 'chat-search-active';

const SEARCH_HIGHLIGHT_STYLE_ID = 'chat-search-highlight-styles';
const DEFAULT_MAX_RANGES = 2000;
const DEFAULT_MAX_RANGES_PER_ROW = 500;
const DEFAULT_MAX_TEXT_NODES = 20000;
const DEFAULT_MAX_SCANNED_CHARS = 1_000_000;
const SEARCH_BLOCK_SELECTOR = 'p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,figcaption,caption,dt,dd';
const SEARCH_EXCLUDED_SELECTOR = 'script,style,noscript,textarea,input,select,option,[hidden],.katex-mathml';

export type SearchTextSegment<TNode = Text> = {
  node: TNode;
  text: string;
};

export type SegmentedTextMatch<TNode = Text> = {
  startNode: TNode;
  startOffset: number;
  endNode: TNode;
  endOffset: number;
};

export type NativeSearchRangeRecord = {
  range: StaticRange;
  messageId: string;
  occurrenceInMessage: number;
};

export type NativeSearchScanResult = {
  records: NativeSearchRangeRecord[];
  rangesByMessage: Map<string, StaticRange[]>;
  scannedChars: number;
  scannedTextNodes: number;
  capped: boolean;
};

type NativeSearchScanOptions = {
  maxRanges?: number;
  maxRangesPerRow?: number;
  maxTextNodes?: number;
  maxScannedChars?: number;
};

export const supportsNativeSearchHighlights = () => (
  typeof CSS !== 'undefined'
  && 'highlights' in CSS
  && typeof Highlight === 'function'
  && typeof StaticRange === 'function'
);

export const createWhitespaceFlexibleSearchRegExp = (query: string, flags: string) => {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return null;

  let source = '';
  let previousWasWhitespace = false;
  for (const character of normalizedQuery) {
    if (/\s/u.test(character)) {
      if (!previousWasWhitespace) source += '\\s+';
      previousWasWhitespace = true;
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    previousWasWhitespace = false;
  }
  return new RegExp(source, flags);
};

export const countSearchTextMatches = (text: string, query: string, maxMatches = Number.POSITIVE_INFINITY) => {
  if (!text || !query || maxMatches <= 0) return 0;
  const matcher = createWhitespaceFlexibleSearchRegExp(query, 'giu');
  if (!matcher) return 0;

  let count = 0;
  while (count < maxMatches && matcher.exec(text)) count += 1;
  return count;
};

const ensureNativeSearchHighlightStyles = () => {
  if (document.getElementById(SEARCH_HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SEARCH_HIGHLIGHT_STYLE_ID;
  style.textContent = `
    ::highlight(${SEARCH_MATCH_HIGHLIGHT_NAME}) {
      background-color: #ffde03;
      color: #000;
    }
    ::highlight(${SEARCH_ACTIVE_HIGHLIGHT_NAME}) {
      background-color: #ff8a00;
      color: #000;
      text-decoration: underline;
      text-decoration-color: rgba(0, 0, 0, 0.45);
    }
  `;
  document.head.append(style);
};

export const findSegmentedTextMatches = <TNode>(
  segments: SearchTextSegment<TNode>[],
  query: string,
  maxMatches: number
): SegmentedTextMatch<TNode>[] => {
  if (!query || maxMatches <= 0) return [];

  const indexedSegments: Array<SearchTextSegment<TNode> & { start: number; end: number }> = [];
  let fullText = '';
  for (const segment of segments) {
    if (!segment.text) continue;
    const start = fullText.length;
    fullText += segment.text;
    indexedSegments.push({ ...segment, start, end: fullText.length });
  }
  if (!fullText) return [];

  const matcher = createWhitespaceFlexibleSearchRegExp(query, 'giu');
  if (!matcher) return [];
  const output: SegmentedTextMatch<TNode>[] = [];
  let startSegmentIndex = 0;

  let match = matcher.exec(fullText);
  while (match && output.length < maxMatches) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    while (
      startSegmentIndex < indexedSegments.length
      && matchStart >= indexedSegments[startSegmentIndex].end
    ) {
      startSegmentIndex += 1;
    }
    const startSegment = indexedSegments[startSegmentIndex];
    if (!startSegment) break;

    let endSegmentIndex = startSegmentIndex;
    while (
      endSegmentIndex < indexedSegments.length
      && matchEnd > indexedSegments[endSegmentIndex].end
    ) {
      endSegmentIndex += 1;
    }
    const endSegment = indexedSegments[endSegmentIndex];
    if (!endSegment) break;

    output.push({
      startNode: startSegment.node,
      startOffset: matchStart - startSegment.start,
      endNode: endSegment.node,
      endOffset: matchEnd - endSegment.start,
    });
    match = matcher.exec(fullText);
  }

  return output;
};

const isSearchableTextNode = (node: Text, row: HTMLElement) => {
  if (!node.data || !node.data.trim()) return false;
  const parent = node.parentElement;
  if (!parent || parent.closest('.message-row[data-message-id]') !== row) return false;
  if (!parent.closest('.markdown-body')) return false;
  if (parent.closest(SEARCH_EXCLUDED_SELECTOR)) return false;

  const ariaHiddenAncestor = parent.closest('[aria-hidden="true"]');
  if (ariaHiddenAncestor && !ariaHiddenAncestor.classList.contains('katex-html')) return false;
  return true;
};

const getSearchGroup = (node: Text) => {
  const parent = node.parentElement;
  if (!parent) return null;
  const markdownBody = parent.closest<HTMLElement>('.markdown-body');
  if (!markdownBody) return null;

  const semanticBlock = parent.closest<HTMLElement>(SEARCH_BLOCK_SELECTOR);
  if (semanticBlock && markdownBody.contains(semanticBlock)) return semanticBlock;

  let topLevelChild: HTMLElement = parent;
  while (topLevelChild.parentElement && topLevelChild.parentElement !== markdownBody) {
    topLevelChild = topLevelChild.parentElement;
  }
  return topLevelChild === markdownBody ? markdownBody : topLevelChild;
};

export const buildNativeSearchRanges = (
  container: Element,
  query: string,
  options: NativeSearchScanOptions = {}
): NativeSearchScanResult => {
  const normalizedQuery = query.trim();
  const maxRanges = Math.max(1, options.maxRanges ?? DEFAULT_MAX_RANGES);
  const maxRangesPerRow = Math.max(1, options.maxRangesPerRow ?? DEFAULT_MAX_RANGES_PER_ROW);
  const maxTextNodes = Math.max(1, options.maxTextNodes ?? DEFAULT_MAX_TEXT_NODES);
  const maxScannedChars = Math.max(1, options.maxScannedChars ?? DEFAULT_MAX_SCANNED_CHARS);
  const records: NativeSearchRangeRecord[] = [];
  const rangesByMessage = new Map<string, StaticRange[]>();
  let scannedChars = 0;
  let scannedTextNodes = 0;
  let capped = false;

  if (!normalizedQuery || !supportsNativeSearchHighlights()) {
    return { records, rangesByMessage, scannedChars, scannedTextNodes, capped };
  }

  const rows = Array.from(container.querySelectorAll<HTMLElement>('.message-row[data-message-id]'));
  for (const row of rows) {
    if (records.length >= maxRanges || scannedTextNodes >= maxTextNodes || scannedChars >= maxScannedChars) {
      capped = true;
      break;
    }
    const messageId = row.dataset.messageId || '';
    if (!messageId || messageId.startsWith('__bridge-status__')) continue;

    const groups = new Map<HTMLElement, SearchTextSegment<Text>[]>();
    const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      if (scannedTextNodes >= maxTextNodes || scannedChars >= maxScannedChars) {
        capped = true;
        break;
      }
      const textNode = current as Text;
      if (isSearchableTextNode(textNode, row)) {
        const group = getSearchGroup(textNode);
        const remainingChars = maxScannedChars - scannedChars;
        const text = textNode.data.slice(0, remainingChars);
        if (group && text) {
          const segments = groups.get(group) || [];
          segments.push({ node: textNode, text });
          groups.set(group, segments);
          scannedChars += text.length;
          scannedTextNodes += 1;
          if (text.length < textNode.data.length) capped = true;
        }
      }
      current = walker.nextNode();
    }

    const rowRanges: StaticRange[] = [];
    let occurrenceInMessage = 0;
    for (const segments of groups.values()) {
      const remainingForRow = maxRangesPerRow - rowRanges.length;
      const remainingGlobally = maxRanges - records.length;
      const remaining = Math.min(remainingForRow, remainingGlobally);
      if (remaining <= 0) {
        capped = true;
        break;
      }

      const matches = findSegmentedTextMatches(segments, normalizedQuery, remaining + 1);
      if (matches.length > remaining) capped = true;
      for (const match of matches.slice(0, remaining)) {
        try {
          const range = new StaticRange({
            startContainer: match.startNode,
            startOffset: match.startOffset,
            endContainer: match.endNode,
            endOffset: match.endOffset,
          });
          rowRanges.push(range);
          records.push({ range, messageId, occurrenceInMessage });
          occurrenceInMessage += 1;
        } catch {
          // The virtualized row changed during the scan. The next mutation refresh retries it.
        }
      }
    }
    if (rowRanges.length > 0) rangesByMessage.set(messageId, rowRanges);
  }

  return { records, rangesByMessage, scannedChars, scannedTextNodes, capped };
};

export const registerNativeSearchHighlights = (
  records: NativeSearchRangeRecord[],
  activeRange: StaticRange | null
) => {
  if (!supportsNativeSearchHighlights()) return;
  ensureNativeSearchHighlightStyles();
  CSS.highlights.delete(SEARCH_MATCH_HIGHLIGHT_NAME);
  CSS.highlights.delete(SEARCH_ACTIVE_HIGHLIGHT_NAME);

  if (records.length > 0) {
    const matches = new Highlight();
    for (const record of records) matches.add(record.range);
    matches.priority = 0;
    CSS.highlights.set(SEARCH_MATCH_HIGHLIGHT_NAME, matches);
  }
  if (activeRange) {
    const active = new Highlight(activeRange);
    active.priority = 1;
    CSS.highlights.set(SEARCH_ACTIVE_HIGHLIGHT_NAME, active);
  }
};

export const clearNativeSearchHighlights = () => {
  if (!supportsNativeSearchHighlights()) return;
  CSS.highlights.delete(SEARCH_MATCH_HIGHLIGHT_NAME);
  CSS.highlights.delete(SEARCH_ACTIVE_HIGHLIGHT_NAME);
};

export const getNativeSearchRangeRect = (range: AbstractRange | null) => {
  if (!range) return null;
  try {
    const liveRange = document.createRange();
    liveRange.setStart(range.startContainer, range.startOffset);
    liveRange.setEnd(range.endContainer, range.endOffset);
    const rect = liveRange.getClientRects()[0] || liveRange.getBoundingClientRect();
    liveRange.detach();
    return rect || null;
  } catch {
    return null;
  }
};
