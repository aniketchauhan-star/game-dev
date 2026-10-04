import { SaxesParser, type SaxesTagNS } from 'saxes';

/**
 * Minimal, ordered XML tree for OOXML parts. Security properties:
 *  - any DOCTYPE is rejected, so no internal or external entities can be declared;
 *  - only the predefined XML entities and character references are decoded;
 *  - document size, node count and depth are bounded.
 * Namespace URIs are mapped to canonical prefixes, so a producer that picks
 * unusual prefixes is read correctly (and Strict OOXML namespaces work too).
 */

export interface XNode {
  name: string; // canonical "prefix:local" (or "local" when no namespace)
  attrs: Record<string, string>;
  children: Array<XNode | string>;
}

export class XmlRejection extends Error {
  constructor(
    message: string,
    readonly code: 'xml-dtd' | 'xml-too-large' | 'xml-too-deep' | 'xml-too-many-nodes' | 'xml-malformed',
  ) {
    super(message);
  }
}

const NS: Record<string, string> = {
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'rel',
  'http://schemas.openxmlformats.org/package/2006/content-types': 'ct',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.microsoft.com/office/drawing/2010/main': 'a14',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://purl.oclc.org/ooxml/drawingml/diagram': 'dgm',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://purl.oclc.org/ooxml/drawingml/chart': 'c',
  'http://schemas.microsoft.com/office/powerpoint/2010/main': 'p14',
  'http://schemas.openxmlformats.org/drawingml/2006/table': 'tbl',
};

export interface XmlLimits {
  maxBytes: number;
  maxNodes?: number;
  maxDepth?: number;
}

function decode(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(buf.subarray(start));
}

function canonical(prefix: string, local: string, uri: string): string {
  const mapped = uri ? NS[uri] : undefined;
  if (mapped) return `${mapped}:${local}`;
  if (!uri) return local;
  return prefix ? `${prefix}:${local}` : local;
}

export function parseXml(buf: Buffer, limits: XmlLimits): XNode {
  if (buf.length > limits.maxBytes) {
    throw new XmlRejection(`XML part is larger than the ${Math.round(limits.maxBytes / 1048576)} MB limit`, 'xml-too-large');
  }
  const maxNodes = limits.maxNodes ?? 750_000;
  const maxDepth = limits.maxDepth ?? 256;
  const parser = new SaxesParser({ xmlns: true, position: false });
  const root: XNode = { name: '#document', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let nodes = 0;
  let failure: Error | null = null;

  parser.on('doctype', () => {
    throw new XmlRejection('XML document type declarations (DTDs) are not allowed in presentation files', 'xml-dtd');
  });
  parser.on('opentag', (tag: SaxesTagNS) => {
    if (++nodes > maxNodes) throw new XmlRejection('XML part has too many elements', 'xml-too-many-nodes');
    if (stack.length > maxDepth) throw new XmlRejection('XML part is nested too deeply', 'xml-too-deep');
    const attrs: Record<string, string> = {};
    for (const a of Object.values(tag.attributes)) {
      if (a.prefix === 'xmlns' || a.name === 'xmlns') continue;
      attrs[canonical(a.prefix, a.local, a.uri)] = a.value;
    }
    const node: XNode = { name: canonical(tag.prefix, tag.local, tag.uri), attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('text', (text) => {
    stack[stack.length - 1]!.children.push(text);
  });
  parser.on('cdata', (text) => {
    stack[stack.length - 1]!.children.push(text);
  });
  parser.on('error', (err) => {
    failure = err;
  });

  try {
    parser.write(decode(buf)).close();
  } catch (err) {
    if (err instanceof XmlRejection) throw err;
    throw new XmlRejection(`Malformed XML: ${(err as Error).message.split('\n')[0]}`, 'xml-malformed');
  }
  if (failure) throw new XmlRejection(`Malformed XML: ${(failure as Error).message.split('\n')[0]}`, 'xml-malformed');
  const first = root.children.find((c): c is XNode => typeof c !== 'string');
  if (!first) throw new XmlRejection('XML part is empty', 'xml-malformed');
  return first;
}

// ───────────── traversal helpers ─────────────

export function kids(node: XNode | undefined, name?: string): XNode[] {
  if (!node) return [];
  const out: XNode[] = [];
  for (const c of node.children) if (typeof c !== 'string' && (name === undefined || c.name === name)) out.push(c);
  return out;
}

export function kid(node: XNode | undefined, name: string): XNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

/** Follow a path of child names, e.g. path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph'). */
export function path(node: XNode | undefined, ...names: string[]): XNode | undefined {
  let cur = node;
  for (const n of names) cur = kid(cur, n);
  return cur;
}

export function descendants(node: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!node) return out;
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

export function textContent(node: XNode | undefined): string {
  if (!node) return '';
  let s = '';
  for (const c of node.children) s += typeof c === 'string' ? c : textContent(c);
  return s;
}

export function num(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
