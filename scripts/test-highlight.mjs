import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const { HighlightText } = await server.ssrLoadModule('/src/components/HighlightText.tsx');
  const {
    countSearchTextMatches,
    findSegmentedTextMatches,
  } = await server.ssrLoadModule('/src/search/nativeHighlights.ts');

  const MappedParagraph = ({ children }) => React.createElement(
    'p',
    null,
    React.createElement(HighlightText, { query: '32' }, children)
  );
  const MappedBlockquote = ({ children }) => React.createElement(
    'blockquote',
    null,
    React.createElement(HighlightText, { query: '32' }, children)
  );

  const nestedMappedMarkup = renderToStaticMarkup(
    React.createElement(
      MappedBlockquote,
      null,
      React.createElement(MappedParagraph, null, 'A nested value of 32')
    )
  );
  assert.equal((nestedMappedMarkup.match(/class="chat-highlight"/g) || []).length, 1);

  const tableCellMarkup = renderToStaticMarkup(
    React.createElement(
      'td',
      null,
      React.createElement(
        HighlightText,
        { query: '32' },
        React.createElement('strong', null, 'Runs on 24–32 GB cards')
      )
    )
  );
  assert.match(tableCellMarkup, /24–<mark class="chat-highlight">32<\/mark> GB/);

  const crossNodeMatches = findSegmentedTextMatches([
    { node: 'plain', text: 'Use ' },
    { node: 'inline-code', text: 'inline ' },
    { node: 'syntax-token', text: 'code 32' },
    { node: 'tail', text: ' safely' },
  ], 'inline code 32', 10);
  assert.deepEqual(crossNodeMatches, [{
    startNode: 'inline-code',
    startOffset: 0,
    endNode: 'syntax-token',
    endOffset: 7,
  }]);

  const cappedMatches = findSegmentedTextMatches([
    { node: 'repeated', text: '32 32 32 32' },
  ], '32', 2);
  assert.equal(cappedMatches.length, 2);

  const narrowNoBreakSpace = '32\u202fGiB';
  assert.equal(countSearchTextMatches(`${narrowNoBreakSpace} and 32 GiB`, '32 GiB'), 2);
  const whitespaceVariantMarkup = renderToStaticMarkup(
    React.createElement(HighlightText, { query: '32 GiB' }, `Capacity: ${narrowNoBreakSpace}`)
  );
  assert.match(whitespaceVariantMarkup, /Capacity: <mark class="chat-highlight">32 GiB<\/mark>/);
  assert.deepEqual(findSegmentedTextMatches([
    { node: 'capacity', text: narrowNoBreakSpace },
  ], '32 GiB', 10), [{
    startNode: 'capacity',
    startOffset: 0,
    endNode: 'capacity',
    endOffset: narrowNoBreakSpace.length,
  }]);

  console.log('Highlight regression checks passed.');
} finally {
  await server.close();
}
