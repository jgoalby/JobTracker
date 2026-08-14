const entityMap = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', bull: '•', middot: '·', hellip: '…',
};

export function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entityMap[name.toLowerCase()] ?? match);
}

export function htmlToText(html = '') {
  return decodeHtmlEntities(
    String(html)
      .replace(/<\s*(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function cleanText(value = '') {
  return String(value)
    .replace(/\r/g, '')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u00a0]+\n/g, '\n')
    .replace(/\n[ \u00a0]+/g, '\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textLines(value = '') {
  return cleanText(value)
    .split('\n')
    .map((line) => line.replace(/^[•·\-–—]\s*/, '').trim())
    .filter(Boolean);
}

export function normalizeInput({ plainText = '', html = '' } = {}) {
  const htmlText = html ? htmlToText(html) : '';
  return {
    plainText: cleanText(plainText || htmlText),
    html: String(html || ''),
    combinedText: cleanText([plainText, htmlText].filter(Boolean).join('\n')),
  };
}

export function extractAnchors(html = '') {
  const anchors = [];
  const pattern = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    anchors.push({
      url: decodeHtmlEntities(match[1] || match[2] || match[3] || ''),
      text: cleanText(htmlToText(match[4] || '')),
      index: match.index,
      length: match[0].length,
    });
  }
  return anchors;
}

export function extractUrls(text = '') {
  return [...String(text).matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((match) => match[0].replace(/[.,;:!?]+$/, ''));
}

export function extractMarkdownLinks(text = '') {
  const links = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = pattern.exec(String(text)))) {
    links.push({
      text: cleanText(match[1].replace(/\*+/g, '')),
      url: match[2],
      index: match.index,
    });
  }
  return links;
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
