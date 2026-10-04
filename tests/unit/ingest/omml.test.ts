import { describe, expect, it } from 'vitest';
import { ommlToLinear, serialize } from '../../../server/src/ingest/omml.ts';
import { parseXml } from '../../../server/src/ingest/xml.ts';

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/** Parse an OMML fragment wrapped in m:oMath and linearize it. */
function lin(inner: string): string {
  return ommlToLinear(parseXml(Buffer.from(`<m:oMath xmlns:m="${M}">${inner}</m:oMath>`), { maxBytes: 1e6 }));
}

const r = (t: string) => `<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>${t}</m:t></m:r>`;

describe('ommlToLinear', () => {
  it('reads runs and ignores property elements', () => {
    expect(lin(`${r('x')}${r('+1')}<m:ctrlPr><m:t>IGNORED</m:t></m:ctrlPr>`)).toBe('x+1');
  });

  it('linearizes fractions, parenthesizing compound parts', () => {
    expect(lin(`<m:f><m:fPr/><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`)).toBe('a/b');
    expect(lin(`<m:f><m:num>${r('a+b')}</m:num><m:den>${r('2')}</m:den></m:f>`)).toBe('(a+b)/2');
    expect(lin(`<m:f><m:num>${r('1')}</m:num><m:den>${r('x−1')}</m:den></m:f>`)).toBe('1/(x−1)');
  });

  it('linearizes superscripts, subscripts and both', () => {
    expect(lin(`<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`)).toBe('x^2');
    expect(lin(`<m:sSub><m:e>${r('x')}</m:e><m:sub>${r('1')}</m:sub></m:sSub>`)).toBe('x_1');
    expect(lin(`<m:sSubSup><m:e>${r('x')}</m:e><m:sub>${r('i')}</m:sub><m:sup>${r('n+1')}</m:sup></m:sSubSup>`)).toBe('x_i^(n+1)');
  });

  it('linearizes square roots and keeps the degree of other roots', () => {
    expect(lin(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r('x')}</m:e></m:rad>`)).toBe('√(x)');
    const cube = lin(`<m:rad><m:deg>${r('3')}</m:deg><m:e>${r('x')}</m:e></m:rad>`);
    expect(cube).toContain('3');
    expect(cube).toContain('√(x)');
  });

  it('linearizes delimiters with default and custom characters', () => {
    expect(lin(`<m:d><m:dPr/><m:e>${r('a+b')}</m:e></m:d>`)).toBe('(a+b)');
    expect(lin(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${r('0')}</m:e><m:e>${r('1')}</m:e></m:d>`)).toBe('[0, 1]');
    expect(lin(`<m:d><m:dPr><m:begChr m:val="{"/><m:sepChr m:val=";"/><m:endChr m:val="}"/></m:dPr><m:e>${r('a')}</m:e><m:e>${r('b')}</m:e></m:d>`)).toBe('{a;b}');
  });

  it('linearizes n-ary operators (sum with limits, default integral)', () => {
    expect(lin(`<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${r('i=1')}</m:sub><m:sup>${r('n')}</m:sup><m:e>${r('i')}</m:e></m:nary>`)).toBe('∑_(i=1)^n i');
    expect(lin(`<m:nary><m:naryPr/><m:sub>${r('0')}</m:sub><m:sup>${r('1')}</m:sup><m:e>${r('x dx')}</m:e></m:nary>`)).toBe('∫_0^1 x dx');
  });

  it('linearizes functions, matrices, equation arrays, accents and bars', () => {
    expect(lin(`<m:func><m:fName>${r('sin')}</m:fName><m:e>${r('θ')}</m:e></m:func>`)).toBe('sin(θ)');
    const matrix = `<m:m><m:mr><m:e>${r('1')}</m:e><m:e>${r('0')}</m:e></m:mr><m:mr><m:e>${r('0')}</m:e><m:e>${r('1')}</m:e></m:mr></m:m>`;
    expect(lin(matrix)).toBe('[1, 0; 0, 1]');
    expect(lin(`<m:eqArr><m:e>${r('x=1')}</m:e><m:e>${r('y=2')}</m:e></m:eqArr>`)).toBe('x=1; y=2');
    expect(lin(`<m:acc><m:accPr><m:chr m:val="→"/></m:accPr><m:e>${r('v')}</m:e></m:acc>`)).toBe('v→');
    expect(lin(`<m:bar><m:e>${r('x')}</m:e></m:bar>`)).toBe('x̅');
  });

  it('linearizes lower and upper limits', () => {
    expect(lin(`<m:limLow><m:e>${r('lim')}</m:e><m:lim>${r('n→∞')}</m:lim></m:limLow>`)).toBe('lim_(n→∞)');
    expect(lin(`<m:limUpp><m:e>${r('x')}</m:e><m:lim>${r('2')}</m:lim></m:limUpp>`)).toBe('x^2');
  });

  it('linearizes the sample deck distance formula', () => {
    const dist =
      `${r('d=')}<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>` +
      `<m:sSup><m:e><m:d><m:dPr/><m:e><m:sSub><m:e>${r('x')}</m:e><m:sub>${r('2')}</m:sub></m:sSub>${r('−')}<m:sSub><m:e>${r('x')}</m:e><m:sub>${r('1')}</m:sub></m:sSub></m:e></m:d></m:e><m:sup>${r('2')}</m:sup></m:sSup>` +
      `${r('+')}` +
      `<m:sSup><m:e><m:d><m:dPr/><m:e><m:sSub><m:e>${r('y')}</m:e><m:sub>${r('2')}</m:sub></m:sSub>${r('−')}<m:sSub><m:e>${r('y')}</m:e><m:sub>${r('1')}</m:sub></m:sSub></m:e></m:d></m:e><m:sup>${r('2')}</m:sup></m:sSup>` +
      `</m:e></m:rad>`;
    expect(lin(dist)).toBe('d=√((x_2−x_1)^2+(y_2−y_1)^2)');
  });

  it('collapses whitespace', () => {
    expect(lin(`${r('  a  ')}${r('\n b ')}`)).toBe('a b');
  });
});

describe('serialize', () => {
  it('re-emits the OMML subtree with escaped text and attributes', () => {
    const node = parseXml(Buffer.from(`<m:oMath xmlns:m="${M}"><m:r><m:t>a&lt;b &amp; "c"</m:t></m:r><m:chr m:val="&quot;&lt;"/></m:oMath>`), { maxBytes: 1e6 });
    const out = serialize(node);
    expect(out).toBe('<m:oMath><m:r><m:t>a&lt;b &amp; "c"</m:t></m:r><m:chr m:val="&quot;&lt;"></m:chr></m:oMath>');
    // The serialized form parses back to the same text.
    expect(ommlToLinear(parseXml(Buffer.from(out.replace('<m:oMath>', `<m:oMath xmlns:m="${M}">`)), { maxBytes: 1e6 }))).toBe('a<b & "c"');
  });

  it('truncates very large equations with an ellipsis', () => {
    const node = parseXml(Buffer.from(`<m:oMath xmlns:m="${M}">${r('x'.repeat(500))}</m:oMath>`), { maxBytes: 1e6 });
    const out = serialize(node, 100);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(101);
  });
});
