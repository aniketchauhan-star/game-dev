import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { descendants, kid, kids, num, parseXml, path, textContent, XmlRejection, type XNode } from '../../../server/src/ingest/xml.ts';
import { must, rejectionOf, TempDir } from './helpers.ts';

const LIMITS = { maxBytes: 1024 * 1024 };
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const xml = (s: string) => Buffer.from(s, 'utf8');

async function xmlRejection(buf: Buffer, code: XmlRejection['code'], limits: Parameters<typeof parseXml>[1] = LIMITS): Promise<XmlRejection> {
  const err = await rejectionOf(() => parseXml(buf, limits), XmlRejection);
  expect(err.code).toBe(code);
  return err;
}

let tmp: TempDir;
beforeAll(() => {
  tmp = new TempDir('nexus-xml-test-');
});
afterAll(() => tmp.cleanup());

describe('parseXml — tree and namespaces', () => {
  it('builds an ordered tree with attributes and text', () => {
    const root = parseXml(xml(`<p:sld xmlns:p="${P}" xmlns:a="${A}" show="0"><a:t>Hello</a:t><a:br/><a:t>World</a:t></p:sld>`), LIMITS);
    expect(root.name).toBe('p:sld');
    expect(root.attrs).toEqual({ show: '0' });
    expect(kids(root).map((k) => k.name)).toEqual(['a:t', 'a:br', 'a:t']);
    expect(textContent(root)).toBe('HelloWorld');
  });

  it('maps namespace URIs to canonical prefixes regardless of the prefixes a producer chose', () => {
    const root = parseXml(xml(`<x:sld xmlns:x="${P}" xmlns:dml="${A}" xmlns:rel="${R}"><dml:blip rel:embed="rId7"/></x:sld>`), LIMITS);
    expect(root.name).toBe('p:sld');
    const blip = must(kid(root, 'a:blip'));
    expect(blip.attrs).toEqual({ 'r:embed': 'rId7' });
  });

  it('maps a default namespace and Strict OOXML (purl.oclc.org) namespaces', () => {
    const root = parseXml(
      xml(`<presentation xmlns="http://purl.oclc.org/ooxml/presentationml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"><sldIdLst><sldId id="256" r:id="rId2"/></sldIdLst></presentation>`),
      LIMITS,
    );
    expect(root.name).toBe('p:presentation');
    expect(must(path(root, 'p:sldIdLst', 'p:sldId')).attrs).toEqual({ id: '256', 'r:id': 'rId2' });
  });

  it('keeps unknown namespaces under their own prefix and drops xmlns declarations', () => {
    const root = parseXml(xml(`<root xmlns:z="urn:example:z"><z:thing z:attr="1" plain="2"/></root>`), LIMITS);
    expect(root.name).toBe('root');
    expect(root.attrs).toEqual({});
    expect(must(kid(root, 'z:thing')).attrs).toEqual({ 'z:attr': '1', plain: '2' });
  });

  it('decodes only the predefined entities and character references', () => {
    const root = parseXml(xml('<t a="&quot;q&quot;">&lt;b&gt; &amp; &apos;x&apos; &#65;&#x42;</t>'), LIMITS);
    expect(textContent(root)).toBe(`<b> & 'x' AB`);
    expect(root.attrs.a).toBe('"q"');
  });

  it('keeps CDATA text', () => {
    expect(textContent(parseXml(xml('<t><![CDATA[a < b && c]]></t>'), LIMITS))).toBe('a < b && c');
  });

  it('decodes UTF-8 with a BOM and UTF-16 (LE and BE) with a BOM', () => {
    const doc = '<?xml version="1.0"?><t>Ünïcødé — ✓</t>';
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(doc, 'utf8')]);
    expect(textContent(parseXml(utf8, LIMITS))).toBe('Ünïcødé — ✓');
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(doc.replace('?>', ' encoding="UTF-16"?>'), 'utf16le')]);
    expect(textContent(parseXml(le, LIMITS))).toBe('Ünïcødé — ✓');
    const leBody = Buffer.from(doc.replace('?>', ' encoding="UTF-16"?>'), 'utf16le');
    const be = Buffer.alloc(leBody.length);
    for (let i = 0; i + 1 < leBody.length; i += 2) {
      be[i] = leBody[i + 1]!;
      be[i + 1] = leBody[i]!;
    }
    expect(textContent(parseXml(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), LIMITS))).toBe('Ünïcødé — ✓');
  });
});

describe('parseXml — security limits', () => {
  it('rejects any DOCTYPE, even a harmless one', async () => {
    await xmlRejection(xml('<?xml version="1.0"?><!DOCTYPE root><root/>'), 'xml-dtd');
  });

  it('rejects a "billion laughs" entity bomb immediately, without expanding it', async () => {
    let ents = '<!ENTITY lol0 "lol">';
    for (let i = 1; i <= 9; i++) ents += `<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`;
    const bomb = xml(`<?xml version="1.0"?><!DOCTYPE lolz [${ents}]><lolz>&lol9;</lolz>`);
    const started = performance.now();
    await xmlRejection(bomb, 'xml-dtd');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('rejects external entities (XXE) and never reads the referenced file', async () => {
    const secret = `TOP-SECRET-${Math.random().toString(36).slice(2)}`;
    const file = tmp.write('secret.txt', secret);
    const doc = xml(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file://${file}">]><r>&xxe;</r>`);
    const err = await xmlRejection(doc, 'xml-dtd');
    expect(err.message).not.toContain(secret);
  });

  it('rejects parameter entities and external DTD subsets', async () => {
    await xmlRejection(xml('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY % p SYSTEM "http://example.invalid/x.dtd"> %p;]><r/>'), 'xml-dtd');
    await xmlRejection(xml('<?xml version="1.0"?><!DOCTYPE r SYSTEM "http://example.invalid/evil.dtd"><r/>'), 'xml-dtd');
  });

  it('treats an undeclared entity reference as malformed instead of resolving it', async () => {
    await xmlRejection(xml('<r>&xxe;</r>'), 'xml-malformed');
  });

  it('rejects documents larger than maxBytes before parsing', async () => {
    const body = xml(`<r>${'x'.repeat(2048)}</r>`);
    await xmlRejection(body, 'xml-too-large', { maxBytes: body.length - 1 });
    expect(parseXml(body, { maxBytes: body.length }).name).toBe('r');
  });

  it('rejects excessive nesting depth', async () => {
    const deep = xml(`${'<d>'.repeat(40)}${'</d>'.repeat(40)}`);
    await xmlRejection(deep, 'xml-too-deep', { maxBytes: 1e6, maxDepth: 20 });
    expect(parseXml(deep, { maxBytes: 1e6, maxDepth: 64 }).name).toBe('d');
  });

  it('rejects documents with too many elements', async () => {
    const many = xml(`<r>${'<e/>'.repeat(200)}</r>`);
    await xmlRejection(many, 'xml-too-many-nodes', { maxBytes: 1e6, maxNodes: 100 });
    expect(kids(parseXml(many, { maxBytes: 1e6, maxNodes: 201 })).length).toBe(200);
  });

  it.each([
    ['an unclosed element', '<r><a></r>'],
    ['two root elements', '<a/><b/>'],
    ['a bad attribute', '<r a=1/>'],
    ['an empty document', ''],
    ['whitespace only', '   \n  '],
    ['plain text', 'not xml at all'],
  ])('rejects %s as malformed', async (_label, src) => {
    await xmlRejection(xml(src), 'xml-malformed');
  });
});

describe('XML traversal helpers', () => {
  const root: XNode = parseXml(
    xml(`<p:sp xmlns:p="${P}" xmlns:a="${A}"><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p><a:p><a:r><a:t>B</a:t></a:r><a:r><a:t>C</a:t></a:r></a:p></p:txBody></p:sp>`),
    LIMITS,
  );

  it('kid/kids/path/descendants navigate by canonical names', () => {
    expect(must(path(root, 'p:nvSpPr', 'p:nvPr', 'p:ph')).attrs.type).toBe('title');
    expect(path(root, 'p:nvSpPr', 'p:missing', 'p:ph')).toBeUndefined();
    expect(kids(kid(root, 'p:txBody'), 'a:p')).toHaveLength(2);
    expect(descendants(root, 'a:t').map(textContent)).toEqual(['A', 'B', 'C']);
    expect(kids(undefined)).toEqual([]);
    expect(kid(undefined, 'x')).toBeUndefined();
    expect(textContent(undefined)).toBe('');
  });

  it('num() parses numbers with a fallback for missing or invalid values', () => {
    expect(num('12192000')).toBe(12192000);
    expect(num('-5')).toBe(-5);
    expect(num(undefined, 7)).toBe(7);
    expect(num('abc', 3)).toBe(3);
    expect(num('Infinity', 1)).toBe(1);
  });
});
