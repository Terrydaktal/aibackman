import React from 'react';
import { createWhitespaceFlexibleSearchRegExp } from '../search/nativeHighlights';

const MAX_HIGHLIGHT_TEXT_LEN = 20000;
const MAX_HIGHLIGHT_MATCHES = 160;
const MAX_HIGHLIGHT_NODE_TEXT_LEN = 60000;
const MAX_HIGHLIGHT_TREE_NODES = 1200;
const MAX_HIGHLIGHT_TREE_DEPTH = 24;

type HighlightTraversalState = {
  visitedNodes: number;
  matches: number;
};

type HighlightableElementProps = {
  children?: React.ReactNode;
  className?: unknown;
};

const highlightReactChildren = (
  children: React.ReactNode,
  matcher: RegExp,
  state: HighlightTraversalState,
  depth = 0
): React.ReactNode => React.Children.map(children, (child) => {
  if (state.visitedNodes >= MAX_HIGHLIGHT_TREE_NODES || depth > MAX_HIGHLIGHT_TREE_DEPTH) {
    return child;
  }
  state.visitedNodes += 1;

  if (typeof child === 'string') {
    if (!child || child.length > MAX_HIGHLIGHT_TEXT_LEN || state.matches >= MAX_HIGHLIGHT_MATCHES) return child;
    matcher.lastIndex = 0;
    let match = matcher.exec(child);
    if (!match) return child;

    const output: React.ReactNode[] = [];
    let cursor = 0;
    while (match && state.matches < MAX_HIGHLIGHT_MATCHES) {
      const idx = match.index;
      const end = idx + match[0].length;
      if (idx > cursor) output.push(child.slice(cursor, idx));
      const matchKey = state.matches;
      output.push(
        <mark key={`hl-${idx}-${matchKey}`} className="chat-highlight">
          {child.slice(idx, end)}
        </mark>
      );
      cursor = end;
      state.matches += 1;
      match = matcher.exec(child);
    }
    if (cursor < child.length) output.push(child.slice(cursor));
    return output;
  }

  if (!React.isValidElement(child)) return child;
  const childProps = child.props as HighlightableElementProps;
  if (childProps.children == null) return child;

  // ReactMarkdown's mapped components can contain one another. Descending into a
  // function component here causes each component to wrap the other in another
  // HighlightText during render, growing the tree until Chromium runs out of memory.
  // Each mapped component highlights its own children, so only inspect host elements
  // and fragments in this traversal.
  if (typeof child.type !== 'string' && child.type !== React.Fragment) return child;

  const className = typeof childProps.className === 'string' ? childProps.className : '';
  const tagName = typeof child.type === 'string' ? child.type : '';
  if (
    className.includes('katex')
    || className.includes('math')
    || tagName === 'code'
    || tagName === 'pre'
    || tagName === 'mark'
    || tagName === 'script'
    || tagName === 'style'
  ) {
    return child;
  }

  const childText = typeof childProps.children === 'string' ? childProps.children : null;
  if (childText && childText.length > MAX_HIGHLIGHT_NODE_TEXT_LEN) return child;
  const highlightedChildren = highlightReactChildren(
    childProps.children,
    matcher,
    state,
    depth + 1
  );
  return React.cloneElement(
    child as React.ReactElement<HighlightableElementProps>,
    undefined,
    highlightedChildren
  );
});

export const HighlightText = ({ children, query }: { children: React.ReactNode, query: string }): React.ReactNode => {
  const normalizedQuery = typeof query === 'string' ? query.trim() : '';
  if (!normalizedQuery) return children;
  if (normalizedQuery.length < 2 || normalizedQuery.length > 80) return children;
  const matcher = createWhitespaceFlexibleSearchRegExp(normalizedQuery, 'giu');
  if (!matcher) return children;

  return highlightReactChildren(
    children,
    matcher,
    { visitedNodes: 0, matches: 0 }
  );
};
