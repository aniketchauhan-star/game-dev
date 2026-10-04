import { kid, kids, textContent, type XNode } from './xml.ts';

/**
 * Approximate linear text for Office Math (OMML). The original OMML is always
 * kept alongside; this text only helps creators and Claude read the equation.
 */

/** True when `t` is one balanced bracket group, e.g. "(a+b)" but not "(a)+(b)". */
function isSingleGroup(t: string): boolean {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const close = pairs[t[0] ?? ''];
  if (!close || !t.endsWith(close)) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === t[0]) depth++;
    else if (t[i] === close) depth--;
    if (depth === 0 && i < t.length - 1) return false;
  }
  return depth === 0;
}

function wrap(s: string): string {
  const t = s.trim();
  if (t.length <= 1 || /^[A-Za-z0-9.]+$/.test(t) || isSingleGroup(t)) return t;
  return `(${t})`;
}

function args(node: XNode | undefined): string {
  return node ? linearChildren(node) : '';
}

function linearChildren(node: XNode): string {
  let out = '';
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    out += linear(c);
  }
  return out;
}

function chrAttr(pr: XNode | undefined, name: string, fallback: string): string {
  const el = kid(pr, name);
  const v = el?.attrs['m:val'];
  return v === undefined ? fallback : v;
}

export function linear(node: XNode): string {
  switch (node.name) {
    case 'm:t':
      return textContent(node);
    case 'm:r':
      return kids(node, 'm:t').map(textContent).join('');
    case 'm:f': {
      const num = args(kid(node, 'm:num'));
      const den = args(kid(node, 'm:den'));
      return `${wrap(num)}/${wrap(den)}`;
    }
    case 'm:sSup':
      return `${wrap(args(kid(node, 'm:e')))}^${wrap(args(kid(node, 'm:sup')))}`;
    case 'm:sSub':
      return `${wrap(args(kid(node, 'm:e')))}_${wrap(args(kid(node, 'm:sub')))}`;
    case 'm:sSubSup':
      return `${wrap(args(kid(node, 'm:e')))}_${wrap(args(kid(node, 'm:sub')))}^${wrap(args(kid(node, 'm:sup')))}`;
    case 'm:sPre':
      return `_${wrap(args(kid(node, 'm:sub')))}^${wrap(args(kid(node, 'm:sup')))}${wrap(args(kid(node, 'm:e')))}`;
    case 'm:rad': {
      const deg = args(kid(node, 'm:deg')).trim();
      const e = args(kid(node, 'm:e'));
      return deg ? `${deg}√(${e})` : `√(${e})`;
    }
    case 'm:d': {
      const pr = kid(node, 'm:dPr');
      const beg = chrAttr(pr, 'm:begChr', '(');
      const end = chrAttr(pr, 'm:endChr', ')');
      const sep = chrAttr(pr, 'm:sepChr', '|');
      return `${beg}${kids(node, 'm:e').map((e) => args(e)).join(sep === '|' ? ', ' : sep)}${end}`;
    }
    case 'm:nary': {
      const pr = kid(node, 'm:naryPr');
      const op = chrAttr(pr, 'm:chr', '∫');
      const sub = args(kid(node, 'm:sub')).trim();
      const sup = args(kid(node, 'm:sup')).trim();
      return `${op}${sub ? `_${wrap(sub)}` : ''}${sup ? `^${wrap(sup)}` : ''} ${args(kid(node, 'm:e'))}`;
    }
    case 'm:func':
      return `${args(kid(node, 'm:fName'))}(${args(kid(node, 'm:e'))})`;
    case 'm:acc': {
      const chr = chrAttr(kid(node, 'm:accPr'), 'm:chr', '̂');
      return `${args(kid(node, 'm:e'))}${chr}`;
    }
    case 'm:bar':
      return `${args(kid(node, 'm:e'))}̅`;
    case 'm:limLow':
      return `${args(kid(node, 'm:e'))}_${wrap(args(kid(node, 'm:lim')))}`;
    case 'm:limUpp':
      return `${args(kid(node, 'm:e'))}^${wrap(args(kid(node, 'm:lim')))}`;
    case 'm:m':
      return `[${kids(node, 'm:mr').map((row) => kids(row, 'm:e').map((e) => args(e)).join(', ')).join('; ')}]`;
    case 'm:eqArr':
      return kids(node, 'm:e').map((e) => args(e)).join('; ');
    case 'm:groupChr':
    case 'm:box':
    case 'm:borderBox':
    case 'm:phant':
    case 'm:oMath':
    case 'm:oMathPara':
    case 'm:e':
    case 'm:num':
    case 'm:den':
    case 'm:sub':
    case 'm:sup':
    case 'm:deg':
    case 'm:lim':
    case 'm:fName':
      return linearChildren(node);
    default:
      // Property elements (…Pr) and unknown elements contribute no text of their own.
      if (node.name.endsWith('Pr')) return '';
      return linearChildren(node);
  }
}

export function ommlToLinear(node: XNode): string {
  return linear(node).replace(/\s+/g, ' ').trim();
}

/** Serialize the OMML subtree back to XML text (for preserving the source representation). */
export function serialize(node: XNode, limit = 20_000): string {
  let out = '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const walk = (n: XNode) => {
    if (out.length > limit) return;
    const attrs = Object.entries(n.attrs)
      .map(([k, v]) => ` ${k}="${esc(v).replace(/"/g, '&quot;')}"`)
      .join('');
    out += `<${n.name}${attrs}>`;
    for (const c of n.children) {
      if (typeof c === 'string') out += esc(c);
      else walk(c);
    }
    out += `</${n.name}>`;
  };
  walk(node);
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}
