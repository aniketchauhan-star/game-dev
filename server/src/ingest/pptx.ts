import fs from 'node:fs';
import posix from 'node:path/posix';
import type {
  Bounds,
  ExtractionWarning,
  ExtractionWarningCode,
  Paragraph,
  SlideEquation,
  SlideExtract,
  SlideImage,
  SlideTable,
  TextBlock,
} from '@shared/schemas/source.ts';
import { sha256 } from '../storage.ts';
import { ommlToLinear, serialize } from './omml.ts';
import { sniff } from './sniff.ts';
import { descendants, kid, kids, num, parseXml, path, textContent, XmlRejection, type XNode } from './xml.ts';
import { SafeZip, ZipRejection, type ZipRejectionCode } from './zip.ts';

/**
 * PowerPoint (.pptx) ingestion. The package is treated as untrusted structured
 * data: nothing embedded is executed, external relationships are never
 * followed, and slide order comes from presentation.xml + relationships.
 */

export interface PptxLimits {
  maxSlides: number;
  maxEntries: number;
  maxExpandedBytes: number;
  maxXmlBytes: number;
  maxAssetBytes: number;
}

export type PptxRejectionCode =
  | ZipRejectionCode
  | 'legacy-ppt'
  | 'ole'
  | 'macro'
  | 'not-presentation'
  | 'too-many-slides'
  | 'no-slides'
  | 'xml'
  | 'external-slide'
  | 'unsupported-format';

export class PptxRejection extends Error {
  constructor(
    readonly code: PptxRejectionCode,
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface ExtractedSlide {
  slideNumber: number;
  pptxSlideId: number;
  partName: string;
  hidden: boolean;
  extract: SlideExtract;
  contentHash: string;
}

export interface MediaRef {
  partName: string;
  contentType: string;
  /** (slideNumber, imageId) pairs that reference this media part. */
  usedBy: Array<{ slideNumber: number; imageId: string }>;
}

export interface PptxResult {
  slideSize: { cx: number; cy: number };
  slides: ExtractedSlide[];
  media: Map<string, MediaRef>;
  packageWarnings: string[];
  readPart: (partName: string, maxBytes: number) => Promise<Buffer>;
  close: () => void;
}

const MACRO_CONTENT_TYPES = [
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml',
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml',
  'application/vnd.ms-powerpoint.addin.macroEnabled.main+xml',
  'application/vnd.ms-office.vbaProject',
];
const PRESENTATION_MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const SHOW_OR_TEMPLATE = [
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
];

export const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/tiff']);

interface Rel {
  id: string;
  type: string;
  target: string | null;
  external: boolean;
  rawTarget: string;
}

interface PlaceholderInfo {
  type: string;
  idx: string | undefined;
  xfrm: { x: number; y: number; w: number; h: number } | null;
}

type Transform = (x: number, y: number, w: number, h: number) => { x: number; y: number; w: number; h: number };
const IDENTITY: Transform = (x, y, w, h) => ({ x, y, w, h });

function relTypeSuffix(type: string): string {
  const i = type.lastIndexOf('/');
  return i >= 0 ? type.slice(i + 1) : type;
}

/** Resolve a relationship target relative to its source part. Returns null if it escapes the package. */
export function resolvePartTarget(sourcePart: string, target: string): string | null {
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    // keep raw
  }
  if (t.includes('\0') || t.includes('\\')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // URL schemes are never package parts
  const joined = t.startsWith('/') ? t.slice(1) : posix.join(posix.dirname(sourcePart), t);
  const norm = posix.normalize(joined);
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/') || norm === '.') return null;
  return norm;
}

function relsPathFor(part: string): string {
  const dir = posix.dirname(part);
  const base = posix.basename(part);
  return dir === '.' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

function xfrmOf(node: XNode | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!node) return null;
  const off = kid(node, 'a:off');
  const ext = kid(node, 'a:ext');
  if (!off || !ext) return null;
  return { x: num(off.attrs.x), y: num(off.attrs.y), w: num(ext.attrs.cx), h: num(ext.attrs.cy) };
}

function cleanText(s: string): string {
  return s.replace(/[\t ]/g, ' ').replace(/ {2,}/g, ' ').replace(/ *\n */g, '\n').trim();
}

class SlideWalker {
  blocks: TextBlock[] = [];
  tables: SlideTable[] = [];
  equations: SlideEquation[] = [];
  images: SlideImage[] = [];
  private warningMap = new Map<ExtractionWarningCode, { severity: ExtractionWarning['severity']; messages: string[] }>();
  private order = 0;
  private groupTextShapes = 0;
  private counters = { blk: 0, tbl: 0, eq: 0, img: 0 };

  constructor(
    private readonly slideW: number,
    private readonly slideH: number,
    private readonly rels: Map<string, Rel>,
    private readonly layoutPh: PlaceholderInfo[],
    private readonly masterPh: PlaceholderInfo[],
    private readonly loadPart: (part: string) => Promise<XNode | null>,
    private readonly contentTypeOf: (part: string) => string,
  ) {}

  warn(code: ExtractionWarningCode, severity: ExtractionWarning['severity'], message: string) {
    const entry = this.warningMap.get(code) ?? { severity, messages: [] };
    if (severity === 'warning') entry.severity = 'warning';
    if (!entry.messages.includes(message)) entry.messages.push(message);
    this.warningMap.set(code, entry);
  }

  warnings(): ExtractionWarning[] {
    return [...this.warningMap.entries()].map(([code, v]) => ({
      code,
      severity: v.severity,
      message: v.messages.length === 1 ? v.messages[0]! : `${v.messages[0]} (+${v.messages.length - 1} more)`,
    }));
  }

  bounds(raw: { x: number; y: number; w: number; h: number }, source: Bounds['source']): Bounds {
    return {
      x: raw.x,
      y: raw.y,
      w: raw.w,
      h: raw.h,
      nx: this.slideW ? raw.x / this.slideW : 0,
      ny: this.slideH ? raw.y / this.slideH : 0,
      nw: this.slideW ? raw.w / this.slideW : 0,
      nh: this.slideH ? raw.h / this.slideH : 0,
      source,
    };
  }

  private inherited(type: string, idx: string | undefined): { xfrm: PlaceholderInfo['xfrm']; source: Bounds['source'] } | null {
    if (idx !== undefined) {
      const byIdx = this.layoutPh.find((p) => p.idx === idx && p.xfrm);
      if (byIdx) return { xfrm: byIdx.xfrm, source: 'layout' };
    }
    const byType = this.layoutPh.find((p) => p.type === type && p.xfrm);
    if (byType) return { xfrm: byType.xfrm, source: 'layout' };
    const masterType = type === 'ctrTitle' || type === 'title' ? 'title' : type === 'dt' || type === 'ftr' || type === 'sldNum' ? type : 'body';
    const m = this.masterPh.find((p) => p.type === masterType && p.xfrm);
    if (m) return { xfrm: m.xfrm, source: 'master' };
    return null;
  }

  async walk(tree: XNode, transform: Transform, inGroup: boolean): Promise<void> {
    for (const c of tree.children) {
      if (typeof c === 'string') continue;
      switch (c.name) {
        case 'p:sp':
          this.shape(c, transform, inGroup);
          break;
        case 'p:pic':
          this.picture(c, transform, inGroup);
          break;
        case 'p:graphicFrame':
          await this.graphicFrame(c, transform, inGroup);
          break;
        case 'p:grpSp':
          await this.group(c, transform, inGroup);
          break;
        case 'p:cxnSp':
        case 'p:nvGrpSpPr':
        case 'p:grpSpPr':
        case 'p:extLst':
          break;
        case 'mc:AlternateContent': {
          const choices = kids(c, 'mc:Choice');
          const mathChoice = choices.find((ch) => descendants(ch, 'a14:m').length > 0);
          const branch = mathChoice ?? kid(c, 'mc:Fallback') ?? choices[0];
          if (branch) await this.walk(branch, transform, inGroup);
          break;
        }
        case 'p:contentPart':
          this.warn('ole-object', 'info', 'Ink or embedded content part was not extracted.');
          break;
        default:
          break;
      }
    }
  }

  private async group(grp: XNode, parent: Transform, nested: boolean): Promise<void> {
    const x = path(grp, 'p:grpSpPr', 'a:xfrm');
    const off = kid(x, 'a:off');
    const ext = kid(x, 'a:ext');
    const chOff = kid(x, 'a:chOff');
    const chExt = kid(x, 'a:chExt');
    let transform: Transform = parent;
    if (off && ext && chOff && chExt) {
      const ox = num(off.attrs.x), oy = num(off.attrs.y);
      const sx = num(chExt.attrs.cx) ? num(ext.attrs.cx) / num(chExt.attrs.cx) : 1;
      const sy = num(chExt.attrs.cy) ? num(ext.attrs.cy) / num(chExt.attrs.cy) : 1;
      const cx = num(chOff.attrs.x), cy = num(chOff.attrs.y);
      transform = (px, py, pw, ph) => parent(ox + (px - cx) * sx, oy + (py - cy) * sy, pw * sx, ph * sy);
    }
    const before = this.blocks.length + this.tables.length + this.images.length;
    await this.walk(grp, transform, true);
    // Count at the outermost group only, so objects in nested groups are counted once.
    const added = this.blocks.length + this.tables.length + this.images.length - before;
    if (!nested && added > 0) this.groupTextShapes += added;
  }

  groupWarning() {
    if (this.groupTextShapes > 0) {
      this.warn('group', 'info', `${this.groupTextShapes} object(s) were inside grouped shapes; positions were converted from the group's coordinate space. Check their reading order.`);
    }
  }

  private paragraphs(txBody: XNode | undefined, defaultBullet: boolean): Paragraph[] {
    const out: Paragraph[] = [];
    for (const p of kids(txBody, 'a:p')) {
      const pPr = kid(p, 'a:pPr');
      const level = Math.min(8, Math.max(0, num(pPr?.attrs.lvl, 0)));
      let bullet = defaultBullet;
      if (kid(pPr, 'a:buNone')) bullet = false;
      if (kid(pPr, 'a:buChar') || kid(pPr, 'a:buAutoNum')) bullet = true;
      let text = '';
      const runs = (node: XNode) => {
        for (const r of node.children) {
          if (typeof r === 'string') continue;
          if (r.name === 'a:r' || r.name === 'a:fld') text += kids(r, 'a:t').map(textContent).join('');
          else if (r.name === 'a:br') text += '\n';
          else if (r.name === 'mc:AlternateContent') {
            const choice = kids(r, 'mc:Choice').find((ch) => descendants(ch, 'a14:m').length > 0);
            if (choice) {
              for (const m of descendants(choice, 'a14:m')) text += ` ${this.equation(m)} `;
            } else {
              const fb = kid(r, 'mc:Fallback');
              if (fb) runs(fb);
            }
          } else if (r.name === 'a14:m') text += ` ${this.equation(r)} `;
        }
      };
      runs(p);
      const cleaned = cleanText(text);
      if (cleaned) out.push({ text: cleaned, level, bullet: bullet && cleaned.length > 0 });
    }
    return out;
  }

  private equation(m: XNode): string {
    const math = descendants(m, 'm:oMathPara')[0] ?? descendants(m, 'm:oMath')[0] ?? m;
    const linear = ommlToLinear(math);
    this.equations.push({ id: `eq-${++this.counters.eq}`, omml: serialize(math), linear, bounds: null, order: this.order++ });
    this.warn('equation', 'info', 'Equation kept as Office Math source; the linear text shown is an approximation — verify it.');
    return linear;
  }

  private shape(sp: XNode, transform: Transform, inGroup: boolean) {
    const cNvPr = path(sp, 'p:nvSpPr', 'p:cNvPr');
    const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
    const phType = ph ? (ph.attrs.type ?? 'obj') : null;
    if (phType === 'dt' || phType === 'ftr' || phType === 'sldNum') return;
    const own = xfrmOf(path(sp, 'p:spPr', 'a:xfrm'));
    let bounds: Bounds | null = null;
    if (own) bounds = this.bounds(transform(own.x, own.y, own.w, own.h), inGroup ? 'group' : 'shape');
    else if (ph && !inGroup) {
      const inh = this.inherited(phType!, ph.attrs.idx);
      if (inh?.xfrm) bounds = this.bounds(inh.xfrm, inh.source);
      else this.warn('placeholder-bounds', 'info', 'Some placeholder positions could not be resolved from the layout or master.');
    }
    const role: TextBlock['role'] =
      phType === 'title' || phType === 'ctrTitle' ? 'title' : phType === 'subTitle' ? 'subtitle' : phType === 'body' || phType === 'obj' ? 'body' : 'text';
    const paragraphs = this.paragraphs(kid(sp, 'p:txBody'), role === 'body');
    if (paragraphs.length === 0) return;
    this.blocks.push({
      id: `blk-${++this.counters.blk}`,
      shapeName: cNvPr?.attrs.name ?? '',
      role,
      paragraphs,
      bounds,
      order: this.order++,
      inGroup,
    });
  }

  private picture(pic: XNode, transform: Transform, inGroup: boolean) {
    const cNvPr = path(pic, 'p:nvPicPr', 'p:cNvPr');
    const nvPr = path(pic, 'p:nvPicPr', 'p:nvPr');
    if (kid(nvPr, 'a:videoFile') || kid(nvPr, 'a:audioFile') || kid(nvPr, 'a:quickTimeFile') || descendants(nvPr, 'p14:media').length > 0) {
      this.warn('media', 'warning', 'Slide contains video or audio. It is not imported; describe it in the slide notes or upload audio in the Asset library.');
    }
    const own = xfrmOf(path(pic, 'p:spPr', 'a:xfrm'));
    const bounds = own ? this.bounds(transform(own.x, own.y, own.w, own.h), inGroup ? 'group' : 'shape') : null;
    const blip = path(pic, 'p:blipFill', 'a:blip');
    if (!blip) return;
    if (blip.attrs['r:link'] && !blip.attrs['r:embed']) {
      this.warn('external-link', 'warning', 'A linked (external) image was not loaded. External links are never followed — insert the image into the deck instead.');
      return;
    }
    const rid = blip.attrs['r:embed'];
    if (!rid) return;
    const rel = this.rels.get(rid);
    if (!rel || rel.external || !rel.target) {
      this.warn(rel?.external ? 'external-link' : 'missing-part', 'warning', rel?.external ? 'An image points outside the presentation and was not loaded.' : 'An image reference is missing from the package.');
      return;
    }
    const contentType = this.contentTypeOf(rel.target);
    const supported = SUPPORTED_IMAGE_TYPES.has(contentType);
    if (!supported) {
      const fmt = posix.extname(rel.target).replace('.', '').toUpperCase() || contentType;
      this.warn('unsupported-image', 'warning', `Image format ${fmt} cannot be displayed in games. Re-save it as PNG or JPEG, or add a slide image for visual reference.`);
    }
    this.images.push({
      id: `img-${++this.counters.img}`,
      shapeName: cNvPr?.attrs.name ?? '',
      partName: rel.target,
      contentType,
      altText: cNvPr?.attrs.descr ?? '',
      bounds,
      order: this.order++,
      assetId: null,
      supported,
    });
  }

  private async graphicFrame(gf: XNode, transform: Transform, inGroup: boolean) {
    const cNvPr = path(gf, 'p:nvGraphicFramePr', 'p:cNvPr');
    const name = cNvPr?.attrs.name ?? '';
    const own = xfrmOf(kid(gf, 'p:xfrm'));
    const bounds = own ? this.bounds(transform(own.x, own.y, own.w, own.h), inGroup ? 'group' : 'shape') : null;
    const data = path(gf, 'a:graphic', 'a:graphicData');
    const uri = data?.attrs.uri ?? '';
    const tbl = kid(data, 'a:tbl');
    if (tbl) {
      const rows = kids(tbl, 'a:tr').map((tr) =>
        kids(tr, 'a:tc').map((tc) => {
          if (tc.attrs.hMerge === '1' || tc.attrs.vMerge === '1') return '';
          return this.paragraphs(kid(tc, 'a:txBody'), false)
            .map((p) => p.text)
            .join('\n');
        }),
      );
      this.tables.push({ id: `tbl-${++this.counters.tbl}`, shapeName: name, rows, bounds, order: this.order++ });
      return;
    }
    if (uri.endsWith('/chart')) {
      const rid = kid(data, 'c:chart')?.attrs['r:id'];
      const rel = rid ? this.rels.get(rid) : undefined;
      let title = '';
      if (rel?.target && !rel.external) {
        const chart = await this.loadPart(rel.target);
        const titleNode = chart ? descendants(chart, 'c:title')[0] : undefined;
        title = titleNode ? cleanText(descendants(titleNode, 'a:t').map(textContent).join(' ')) : '';
      }
      this.warn('chart', 'warning', `Chart${title ? ` “${title}”` : ''}: its data and visual meaning are not extracted. Describe it, or add a slide image for visual reference.`);
      return;
    }
    if (uri.endsWith('/diagram')) {
      const dm = kid(data, 'dgm:relIds')?.attrs['r:dm'];
      const rel = dm ? this.rels.get(dm) : undefined;
      const paragraphs: Paragraph[] = [];
      if (rel?.target && !rel.external) {
        const dataModel = await this.loadPart(rel.target);
        for (const pt of descendants(dataModel ?? undefined, 'dgm:pt')) {
          const t = pt.attrs.type;
          if (t && t !== 'node') continue;
          const text = cleanText(descendants(kid(pt, 'dgm:t'), 'a:t').map(textContent).join(' '));
          if (text) paragraphs.push({ text, level: 0, bullet: true });
        }
      }
      if (paragraphs.length > 0) {
        this.blocks.push({ id: `blk-${++this.counters.blk}`, shapeName: name, role: 'smartart', paragraphs, bounds, order: this.order++, inGroup });
      }
      this.warn('smartart', 'warning', 'SmartArt: its text was extracted, but its layout and relationships (arrows, hierarchy) were not reconstructed.');
      return;
    }
    if (uri.includes('/ole') || descendants(data, 'p:oleObj').length > 0) {
      this.warn('ole-object', 'warning', 'Embedded object (for example an Excel sheet or legacy equation) was not opened; its content is not extracted and is never executed.');
      return;
    }
    this.warn('ole-object', 'info', `Unsupported graphic frame (${uri || 'unknown type'}) was not extracted.`);
  }

  readingOrderCheck() {
    const placed = this.blocks.filter((b) => b.bounds && b.role !== 'title');
    if (placed.length < 2) return;
    const visual = placed.slice().sort((a, b) => {
      const dy = a.bounds!.ny - b.bounds!.ny;
      if (Math.abs(dy) > 0.04) return dy;
      return a.bounds!.nx - b.bounds!.nx;
    });
    const differs = visual.some((b, i) => b.id !== placed[i]!.id);
    if (differs) {
      this.warn('reading-order', 'info', 'Shape order (what screen readers follow) differs from the top-to-bottom visual order. Check the reading order of this slide.');
    }
  }
}

function placeholderIndex(root: XNode | null): PlaceholderInfo[] {
  if (!root) return [];
  const out: PlaceholderInfo[] = [];
  for (const sp of descendants(root, 'p:sp')) {
    const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
    if (!ph) continue;
    out.push({ type: ph.attrs.type ?? 'obj', idx: ph.attrs.idx, xfrm: xfrmOf(path(sp, 'p:spPr', 'a:xfrm')) });
  }
  return out;
}

export async function sniffUpload(file: string): Promise<'zip' | 'ole' | 'other'> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    await fd.read(buf, 0, 64, 0);
    const t = sniff(buf);
    return t === 'zip' ? 'zip' : t === 'ole' ? 'ole' : 'other';
  } finally {
    await fd.close();
  }
}

export async function extractPptx(
  file: string,
  originalName: string,
  limits: PptxLimits,
  onProgress: (message: string) => void = () => {},
): Promise<PptxResult> {
  const kind = await sniffUpload(file);
  const lowerName = originalName.toLowerCase();
  if (kind === 'ole') {
    if (lowerName.endsWith('.ppt') || lowerName.endsWith('.pps') || lowerName.endsWith('.pot')) {
      throw new PptxRejection('legacy-ppt', 'Legacy .ppt files are not supported.', 'Open the file in PowerPoint and use File → Save As → PowerPoint Presentation (.pptx).');
    }
    throw new PptxRejection(
      'ole',
      'This file is password-protected or encrypted (or is a legacy .ppt renamed to .pptx).',
      'Remove the password (File → Info → Protect Presentation) and save as .pptx, then upload again.',
    );
  }
  if (kind !== 'zip') {
    throw new PptxRejection('unsupported-format', 'This file is not a PowerPoint (.pptx) package.', 'Upload a .pptx file. Keynote and Google Slides decks can be exported as .pptx.');
  }

  let zip: SafeZip;
  try {
    zip = await SafeZip.open(file, {
      maxEntries: limits.maxEntries,
      maxExpandedBytes: limits.maxExpandedBytes,
      maxEntryBytes: Math.max(limits.maxXmlBytes, limits.maxAssetBytes),
    });
  } catch (err) {
    if (err instanceof ZipRejection) throw new PptxRejection(err.code, err.message, 'Re-save the presentation from PowerPoint as a regular .pptx file.');
    throw err;
  }
  onProgress(`Reading package (${zip.entries.size} entries)`);

  const packageWarnings: string[] = [];
  const xmlCache = new Map<string, XNode | null>();
  const loadXml = async (part: string, required: boolean): Promise<XNode | null> => {
    if (xmlCache.has(part)) return xmlCache.get(part)!;
    if (!zip.resolveName(part)) {
      if (required) throw new PptxRejection('corrupt', `The package is missing a required part (${part}).`, 'Re-save the presentation from PowerPoint and try again.');
      xmlCache.set(part, null);
      return null;
    }
    try {
      const node = parseXml(await zip.read(part, limits.maxXmlBytes), { maxBytes: limits.maxXmlBytes });
      xmlCache.set(part, node);
      return node;
    } catch (err) {
      if (err instanceof XmlRejection) {
        throw new PptxRejection('xml', `${part}: ${err.message}`, 'Re-save the presentation from PowerPoint. Files edited by other tools sometimes produce invalid XML.');
      }
      if (err instanceof ZipRejection) throw new PptxRejection(err.code, err.message, 'Re-save the presentation from PowerPoint as a regular .pptx file.');
      throw err;
    }
  };

  try {
    // Content types — also how macro-enabled packages are detected.
    const ct = await loadXml('[Content_Types].xml', true);
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    for (const d of kids(ct!, 'ct:Default')) defaults.set((d.attrs.Extension ?? '').toLowerCase(), d.attrs.ContentType ?? '');
    for (const o of kids(ct!, 'ct:Override')) overrides.set((o.attrs.PartName ?? '').replace(/^\//, '').toLowerCase(), o.attrs.ContentType ?? '');
    const contentTypeOf = (part: string) => overrides.get(part.toLowerCase()) ?? defaults.get(posix.extname(part).slice(1).toLowerCase()) ?? 'application/octet-stream';
    const allTypes = [...overrides.values(), ...defaults.values()];
    const hasVba = [...zip.entries.keys()].some((n) => /vbaProject\.bin$/i.test(n) || /vbaData\.xml$/i.test(n));
    if (hasVba || allTypes.some((t) => MACRO_CONTENT_TYPES.includes(t))) {
      throw new PptxRejection('macro', 'Macro-enabled presentations (.pptm) are not accepted.', 'Save a copy as a regular PowerPoint Presentation (.pptx) without macros, then upload that copy.');
    }

    const readRels = async (part: string): Promise<Map<string, Rel>> => {
      const rels = new Map<string, Rel>();
      const node = await loadXml(relsPathFor(part), false);
      for (const r of kids(node ?? undefined, 'rel:Relationship')) {
        const id = r.attrs.Id;
        const rawTarget = r.attrs.Target ?? '';
        if (!id) continue;
        const external = (r.attrs.TargetMode ?? '').toLowerCase() === 'external';
        const target = external ? null : resolvePartTarget(part, rawTarget);
        if (!external && target === null && rawTarget) packageWarnings.push(`Ignored a relationship with an unsafe target in ${part}.`);
        rels.set(id, { id, type: relTypeSuffix(r.attrs.Type ?? ''), target, external, rawTarget });
      }
      return rels;
    };

    const rootRels = await readRels('');
    const officeDoc = [...rootRels.values()].find((r) => r.type === 'officeDocument' && r.target);
    if (!officeDoc?.target) throw new PptxRejection('not-presentation', 'This package has no main document.', 'Upload a PowerPoint .pptx file.');
    const mainType = contentTypeOf(officeDoc.target);
    if (SHOW_OR_TEMPLATE.includes(mainType)) {
      throw new PptxRejection('not-presentation', 'PowerPoint Show (.ppsx) and template (.potx) files are not accepted.', 'Open it in PowerPoint and save as a PowerPoint Presentation (.pptx).');
    }
    if (mainType !== PRESENTATION_MAIN) {
      throw new PptxRejection('not-presentation', 'This file is an Office package, but not a PowerPoint presentation.', 'Upload a .pptx presentation (Word and Excel files are not supported).');
    }

    const presPart = officeDoc.target;
    const pres = (await loadXml(presPart, true))!;
    const sz = kid(pres, 'p:sldSz');
    const slideSize = sz ? { cx: num(sz.attrs.cx), cy: num(sz.attrs.cy) } : { cx: 12192000, cy: 6858000 };
    if (!sz) packageWarnings.push('Slide size missing; assumed 16:9.');
    const presRels = await readRels(presPart);
    const sldIds = kids(kid(pres, 'p:sldIdLst'), 'p:sldId');
    if (sldIds.length === 0) throw new PptxRejection('no-slides', 'The presentation has no slides.', 'Add slides to the deck and upload it again.');
    if (sldIds.length > limits.maxSlides) {
      throw new PptxRejection('too-many-slides', `The deck has ${sldIds.length} slides; the limit is ${limits.maxSlides}.`, 'Split the deck into smaller lessons, or raise MAX_SLIDES in the server configuration.');
    }

    // Presentation order comes from p:sldIdLst → relationships, never from file names.
    const ordered: Array<{ pptxSlideId: number; part: string }> = [];
    const seenParts = new Set<string>();
    for (const s of sldIds) {
      const rid = s.attrs['r:id'];
      const rel = rid ? presRels.get(rid) : undefined;
      if (!rel || rel.external || !rel.target || rel.type !== 'slide') {
        throw new PptxRejection('external-slide', 'A slide reference in presentation.xml is missing, external or invalid.', 'Re-save the presentation from PowerPoint and try again.');
      }
      if (seenParts.has(rel.target)) throw new PptxRejection('corrupt', 'The same slide is listed twice in presentation.xml.', 'Re-save the presentation from PowerPoint and try again.');
      seenParts.add(rel.target);
      ordered.push({ pptxSlideId: num(s.attrs.id), part: rel.target });
    }
    onProgress(`Ordering ${ordered.length} slides from presentation.xml`);

    const media = new Map<string, MediaRef>();
    const slides: ExtractedSlide[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const { pptxSlideId, part } = ordered[i]!;
      const slideNumber = i + 1;
      if (ordered.length <= 12 || slideNumber === 1 || slideNumber % 5 === 0 || slideNumber === ordered.length) {
        onProgress(`Extracting slide ${slideNumber} of ${ordered.length}`);
      }
      const sld = await loadXml(part, false);
      if (!sld) {
        throw new PptxRejection('corrupt', `Slide ${slideNumber} is listed but missing from the package.`, 'Re-save the presentation from PowerPoint and try again.');
      }
      const hidden = sld.attrs.show === '0' || sld.attrs.show === 'false';
      const rels = await readRels(part);
      const layoutRel = [...rels.values()].find((r) => r.type === 'slideLayout' && r.target);
      const layout = layoutRel?.target ? await loadXml(layoutRel.target, false) : null;
      let master: XNode | null = null;
      if (layoutRel?.target) {
        const layoutRels = await readRels(layoutRel.target);
        const masterRel = [...layoutRels.values()].find((r) => r.type === 'slideMaster' && r.target);
        master = masterRel?.target ? await loadXml(masterRel.target, false) : null;
      }

      const walker = new SlideWalker(
        slideSize.cx,
        slideSize.cy,
        rels,
        placeholderIndex(layout),
        placeholderIndex(master),
        (p) => loadXml(p, false),
        contentTypeOf,
      );
      const tree = path(sld, 'p:cSld', 'p:spTree');
      if (tree) await walker.walk(tree, IDENTITY, false);
      walker.groupWarning();
      walker.readingOrderCheck();

      // External relationships are never fetched or followed; they are only reported.
      const externalLinks = [...rels.values()].filter((r) => r.external && r.type !== 'hyperlink');
      if (externalLinks.length > 0) {
        walker.warn('external-link', 'warning', 'This slide references external files; they were not loaded.');
      }
      const webLinks = [...rels.values()].filter((r) => r.external && r.type === 'hyperlink').length;
      if (webLinks > 0) {
        walker.warn('external-link', 'info', `This slide contains ${webLinks} web link${webLinks === 1 ? '' : 's'}. Links are never opened and are not carried into games.`);
      }
      const timing = kid(sld, 'p:timing');
      if (timing) {
        const effects = ['p:animEffect', 'p:anim', 'p:set', 'p:animMotion', 'p:animScale', 'p:animRot', 'p:animClr'].reduce(
          (n, tag) => n + descendants(timing, tag).length,
          0,
        );
        if (effects > 0) {
          walker.warn('animation', 'warning', `Slide uses animations (${effects} effect${effects === 1 ? '' : 's'}). Explanations that depend on build order may not be captured — check the sequence.`);
        }
      }

      let notes: string[] = [];
      const notesRel = [...rels.values()].find((r) => r.type === 'notesSlide' && r.target);
      if (notesRel?.target) {
        const notesXml = await loadXml(notesRel.target, false);
        for (const sp of descendants(notesXml ?? undefined, 'p:sp')) {
          const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
          if (ph?.attrs.type !== 'body') continue;
          for (const p of kids(kid(sp, 'p:txBody'), 'a:p')) {
            const t = cleanText(
              p.children
                .filter((c): c is XNode => typeof c !== 'string')
                .map((c) => (c.name === 'a:r' || c.name === 'a:fld' ? kids(c, 'a:t').map(textContent).join('') : c.name === 'a:br' ? '\n' : ''))
                .join(''),
            );
            if (t) notes.push(t);
          }
        }
      }

      let totalChars = walker.blocks.reduce((n, b) => n + b.paragraphs.reduce((m, p) => m + p.text.length, 0), 0) + notes.join('').length;
      if (totalChars > 40_000) {
        notes = notes.slice(0, 40);
        walker.warn('truncated', 'warning', 'This slide has an unusually large amount of text; speaker notes were truncated.');
        totalChars = 0;
      }

      const titleBlock = walker.blocks.find((b) => b.role === 'title');
      const title = titleBlock ? titleBlock.paragraphs.map((p) => p.text.replace(/\n/g, ' ')).join(' ') : '';
      if (walker.blocks.length === 0 && walker.tables.length === 0 && walker.images.length === 0 && walker.equations.length === 0) {
        walker.warn('empty-slide', 'info', 'No text, tables or images were found on this slide.');
      }
      const extract: SlideExtract = {
        title,
        layoutName: layout ? (path(layout, 'p:cSld')?.attrs.name ?? null) : null,
        blocks: walker.blocks,
        tables: walker.tables,
        equations: walker.equations,
        images: walker.images,
        notes,
        warnings: walker.warnings(),
      };
      for (const img of walker.images) {
        const ref = media.get(img.partName) ?? { partName: img.partName, contentType: img.contentType, usedBy: [] };
        ref.usedBy.push({ slideNumber, imageId: img.id });
        media.set(img.partName, ref);
      }
      slides.push({ slideNumber, pptxSlideId, partName: part, hidden, extract, contentHash: sha256(JSON.stringify(extract)) });
    }

    return {
      slideSize,
      slides,
      media,
      packageWarnings,
      readPart: (p, maxBytes) => zip.read(p, maxBytes),
      close: () => zip.close(),
    };
  } catch (err) {
    zip.close();
    throw err;
  }
}
