/**
 * The minimum XML reading the catalogue needs, shared with the extraction
 * adapter (plan Tasks 3 and 4).
 *
 * No parser, no tree, no namespace resolution beyond a local name: a forward
 * scan for one element's text, with entities decoded. Documents here are
 * untrusted data from a user's filesystem, so nothing in this file resolves
 * external references, follows relationships or executes anything.
 */

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Entities must reference real code points: no out-of-range or lone surrogates. */
function invalidCodePoint(codePoint: number): boolean {
  return (
    !Number.isFinite(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

/** Decodes the five named entities plus numeric ones, rejecting bad code points. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const named = XML_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      if (invalidCodePoint(codePoint)) {
        throw new RangeError(`invalid XML code point in entity ${match}`);
      }
      return String.fromCodePoint(codePoint);
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      if (invalidCodePoint(codePoint)) {
        throw new RangeError(`invalid XML code point in entity ${match}`);
      }
      return String.fromCodePoint(codePoint);
    }
    return match;
  });
}

/**
 * The first start tag for `localName`, capturing any namespace prefix so the
 * matching end tag can be found with the same prefix.
 */
function openTagOf(xml: string, localName: string): { index: number; tag: string; prefix: string } | null {
  const pattern = new RegExp(`<([a-zA-Z0-9_.-]+:)?${localName}(\\s[^>]*)?/?>`, 'g');
  const match = pattern.exec(xml);
  if (match === null) return null;
  return { index: match.index, tag: match[0], prefix: match[1] ?? '' };
}

/** Removes comments and any remaining tags, leaving the text content. */
function stripTags(fragment: string): string {
  return fragment.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
}

/**
 * Text of the first element with this local name, or undefined when absent.
 * Nested markup is stripped rather than concatenated, so a title that contains
 * an inline tag yields its text and never a child element's name.
 */
export function elementText(xml: string | Buffer, localName: string): string | undefined {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  const open = openTagOf(text, localName);
  if (open === null) return undefined;
  const afterOpen = open.index + open.tag.length;
  if (open.tag.endsWith('/>')) return '';

  const closeTag = `</${open.prefix}${localName}>`;
  const close = text.indexOf(closeTag, afterOpen);
  const inner = text.slice(afterOpen, close < 0 ? text.length : close);
  return decodeXmlEntities(stripTags(inner)).trim();
}

/** Value of one attribute on the first element with this local name. */
export function elementAttribute(xml: string | Buffer, localName: string, attribute: string): string | undefined {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  const open = openTagOf(text, localName);
  if (open === null) return undefined;
  const match = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*"([^"]*)"`).exec(open.tag);
  if (match === null) return undefined;
  return decodeXmlEntities(match[1] ?? '').trim();
}

/** True when the element appears at all, whatever its content. */
export function hasElement(xml: string | Buffer, localName: string): boolean {
  return openTagOf(Buffer.isBuffer(xml) ? xml.toString('utf8') : xml, localName) !== null;
}