const GENUI_START = 'genui';
const GENUI_END = '';

const findBalancedJsonEnd = (value: string, start: number): number => {
  let cursor = start;
  while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;
  if (value[cursor] !== '{' && value[cursor] !== '[') return -1;

  const stack = [value[cursor]];
  let inString = false;
  let escaped = false;
  for (cursor += 1; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    if (stack.at(-1) !== expected) return -1;
    stack.pop();
    if (stack.length === 0) return cursor + 1;
  }
  return -1;
};

const stripGenUiArtifacts = (value: string): string => {
  const input = String(value || '');
  let output = '';
  let cursor = 0;
  while (cursor < input.length) {
    const markerStart = input.indexOf(GENUI_START, cursor);
    if (markerStart < 0) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, markerStart);
    const payloadStart = markerStart + GENUI_START.length;
    const jsonEnd = findBalancedJsonEnd(input, payloadStart);
    const markerEnd = input.indexOf(GENUI_END, payloadStart);
    let artifactEnd = jsonEnd;
    if (artifactEnd >= 0 && input.startsWith(GENUI_END, artifactEnd)) artifactEnd += GENUI_END.length;
    if (artifactEnd < 0 && markerEnd >= 0) artifactEnd = markerEnd + GENUI_END.length;
    if (artifactEnd < 0) {
      const lineEnd = input.indexOf('\n', payloadStart);
      artifactEnd = lineEnd >= 0 ? lineEnd : input.length;
    }
    cursor = artifactEnd;
  }
  return output;
};

const stripWritingDirectives = (value: string): string => (
  String(value || '')
    .replace(/(^|\n)[ \t]*:::writing(?:\{[^\n]*\})?[ \t]*/gi, '$1')
    .replace(/:::writing(?:\{[^\n]*\})?[ \t]*/gi, '')
    .replace(/(^|\n)[ \t]*:::[ \t]*(?=\n|$)/g, '$1')
    .replace(/[ \t]+:::[ \t]*(?=\n|$)/g, '\n')
);

const normalizeFileCitationMarkers = (value: string): string => {
  const citationNumbers = new Map<string, number>();

  const citationNumber = (id: string) => {
    if (!citationNumbers.has(id)) citationNumbers.set(id, citationNumbers.size + 1);
    return citationNumbers.get(id)!;
  };

  return String(value || '')
    .replace(/filecite([^]+)/g, (_match, rawRefs: string) => {
      const refs = rawRefs.split('').map((ref) => ref.trim()).filter(Boolean);
      const groups: string[][] = [];
      for (const ref of refs) {
        if (/^turn\d+[a-z]+\d+$/i.test(ref) || groups.length === 0) groups.push([ref]);
        else groups.at(-1)!.push(ref);
      }
      return groups.map(([id, ...details]) => {
        const label = [citationNumber(id), ...details].join(' · ');
        return `[${label}](citation://${id})`;
      }).join(' ');
    })
    .replace(/filecite/g, '');
};

export const formatChatGptContent = (value: string): string => (
  normalizeFileCitationMarkers(stripWritingDirectives(stripGenUiArtifacts(value)))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);
