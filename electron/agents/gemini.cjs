const path = require('path');
const { importAiModeTakeout } = require('../aimode-takeout.cjs');
const { compactTitle, createAssetStore, findNamedFiles, materializeBackupPath } = require('./utils.cjs');

const GEMINI_LABELS = [
  ['Your prompt:', 'user'],
  ['Your message:', 'user'],
  ['Prompt:', 'user'],
  ["Gemini's response:", 'assistant'],
  ['Gemini response:', 'assistant'],
  ['Response:', 'assistant'],
];

function decodeGeminiHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
    })
    .replace(/&#([0-9]+);/g, (_match, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
    });
}

function stripGeminiTags(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function cleanGeminiMarkdown(value) {
  return decodeGeminiHtmlEntities(value)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convertGeminiTable(tableHtml) {
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch = null;
  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const cells = [];
    const cellPattern = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch = null;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      const cell = htmlToMarkdown(cellMatch[2])
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      cells.push(cell);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';

  const columnCount = Math.max(...rows.map((row) => row.length));
  const padRow = (row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill('')];
  const renderRow = (row) => `| ${padRow(row).join(' | ')} |`;
  const separator = `| ${Array(columnCount).fill('---').join(' | ')} |`;
  return `\n\n${renderRow(rows[0])}\n${separator}${rows.slice(1).map((row) => `\n${renderRow(row)}`).join('')}\n\n`;
}

function htmlToMarkdown(html) {
  let source = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const protectedBlocks = [];
  const protect = (value) => {
    const token = `\u0000GEMINI_BLOCK_${protectedBlocks.length}\u0000`;
    protectedBlocks.push(value);
    return token;
  };

  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, body) => {
    const code = decodeGeminiHtmlEntities(stripGeminiTags(body)).replace(/^\n+|\n+$/g, '');
    return protect(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
  });
  source = source.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => convertGeminiTable(table));
  source = source.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, body) => {
    const code = decodeGeminiHtmlEntities(stripGeminiTags(body)).replace(/\s+/g, ' ').trim();
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  });
  source = source.replace(/<a\b[^>]*\bhref\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _quote, href, body) => {
    const label = cleanGeminiMarkdown(stripGeminiTags(body));
    const url = decodeGeminiHtmlEntities(href).trim();
    return label && url ? `[${label}](${url})` : label || url;
  });
  source = source.replace(/<img\b[^>]*\balt\s*=\s*(['"])(.*?)\1[^>]*>/gi, (_match, _quote, alt) => alt ? `[${cleanGeminiMarkdown(alt)}]` : '');
  source = source
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n')
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n')
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~')
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, body) => `\n\n${cleanGeminiMarkdown(stripGeminiTags(body)).split('\n').map((line) => `> ${line}`).join('\n')}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(li|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<\/(p|div|section|article|header|footer|tr|table)>/gi, '\n\n')
    .replace(/<(p|div|section|article|header|footer|table|thead|tbody|tr)\b[^>]*>/gi, '\n\n')
    .replace(/<t[hd]\b[^>]*>/gi, ' | ')
    .replace(/<\/t[hd]>/gi, ' ')
    .replace(/<[^>]+>/g, '');

  source = cleanGeminiMarkdown(source);
  return source.replace(/\u0000GEMINI_BLOCK_(\d+)\u0000/g, (_match, index) => protectedBlocks[Number(index)] || '').trim();
}

function resolveTakeoutPath(inputPath) {
  const candidates = findNamedFiles(inputPath, ['MyActivity.json', 'myactivity.json']);
  if (candidates.length === 0) throw new Error('No Google MyActivity.json file was found.');
  return candidates.find((candidate) => /(?:^|[\\/])Gemini Apps?(?:[\\/]|$)/i.test(candidate))
    || candidates.find((candidate) => path.basename(path.dirname(candidate)).toLowerCase().includes('gemini'))
    || candidates[0];
}

function normalizeTitle(value) {
  return compactTitle(String(value || '').replace(/^(?:Prompted|Asked)\s+/i, ''), 'Gemini chat');
}

function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const sourceFile = resolveTakeoutPath(materialized.path);
    const assetStore = createAssetStore(db, 'gemini');
    return {
      sourcePath: inputPath,
      ...importAiModeTakeout(db, sourceFile, {
        replaceExisting,
        acceptedHeaders: ['Gemini Apps', 'Gemini'],
        labels: GEMINI_LABELS,
        normalizeTitle,
        conversationPrefix: 'gemini',
        messagePrefix: 'gemsg',
        formatHtml: htmlToMarkdown,
        messageMetadata: { source: 'gemini-web-export' },
        inferPromptFromTitle: true,
        attachmentRoot: path.dirname(sourceFile),
        assetStore,
      }),
    };
  } finally {
    materialized.cleanup();
  }
}

module.exports = {
  id: 'gemini',
  name: 'Gemini',
  description: 'Gemini web conversations from official Google exports',
  accent: '#8e75b2',
  capabilities: { importBackup: true },
  importBackup,
  formatMessage: htmlToMarkdown,
};
