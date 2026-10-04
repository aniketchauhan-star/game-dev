import { writeZip, type RawEntry } from './zip-writer.ts';

/**
 * Builds real OOXML presentation packages for the bundled sample and for tests.
 * Slide part numbers can differ from presentation order to prove the importer
 * follows presentation.xml instead of file names.
 */

export interface SlideSpec {
  /** Part number: ppt/slides/slide{partNumber}.xml */
  partNumber: number;
  layout: 'title' | 'content';
  title?: string;
  subtitle?: string;
  bullets?: Array<string | { text: string; level: number }>;
  notes?: string[];
  hidden?: boolean;
  image?: { file: string; png: Buffer; alt: string; x: number; y: number; w: number; h: number };
  table?: string[][];
  group?: Array<{ text: string; x: number; y: number; w: number; h: number }>;
  equation?: { omml: string; fallback: string };
  /** Adds an "Appear" entrance animation on the body placeholder. */
  animate?: boolean;
  /** Extra free text boxes (non-placeholder). */
  textBoxes?: Array<{ text: string; x: number; y: number; w: number; h: number }>;
  /** Test-only: chart graphic frame referencing a chart part with this title. */
  chartTitle?: string;
  /** Test-only: SmartArt graphic frame with these node texts. */
  smartArt?: string[];
  /** Test-only: picture referencing an external (linked) image. */
  externalImage?: boolean;
  /** Test-only: picture in an unsupported format (EMF). */
  emfImage?: boolean;
}

export interface BuildOptions {
  slides: SlideSpec[];
  /** Presentation order as a list of part numbers. Defaults to the order of `slides`. */
  order?: number[];
  title?: string;
  /** Test-only hooks to produce hostile or unusual packages. */
  mainContentType?: string;
  extraEntries?: RawEntry[];
  extraContentTypes?: string;
  dropEntries?: string[];
  replaceEntries?: Record<string, string | Buffer>;
}

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  a14: 'http://schemas.microsoft.com/office/drawing/2010/main',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
};
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EMU = 12700; // per point
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NSDECL = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;

function rels(list: Array<{ id: string; type: string; target: string; external?: boolean }>): string {
  return `${XML}<Relationships xmlns="${NS.rel}">${list
    .map((r) => `<Relationship Id="${r.id}" Type="${RT}/${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`;
}

function run(text: string, size?: number, bold = false): string {
  return `<a:r><a:rPr lang="en-US"${size ? ` sz="${size}"` : ''}${bold ? ' b="1"' : ''} dirty="0"/><a:t>${esc(text)}</a:t></a:r>`;
}

function para(text: string, level = 0, opts: { bullet?: boolean; size?: number; bold?: boolean } = {}): string {
  const lines = text.split('\n');
  const runs = lines.map((l, i) => (i > 0 ? '<a:br><a:rPr lang="en-US"/></a:br>' : '') + run(l, opts.size, opts.bold)).join('');
  const pPr = level > 0 || opts.bullet === false ? `<a:pPr${level > 0 ? ` lvl="${level}"` : ''}>${opts.bullet === false ? '<a:buNone/>' : ''}</a:pPr>` : '';
  return `<a:p>${pPr}${runs}</a:p>`;
}

function xfrm(x: number, y: number, w: number, h: number, tag = 'a:xfrm'): string {
  return `<${tag}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></${tag}>`;
}

function nvGrp(): string {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

function placeholder(id: number, name: string, ph: string, body: string, pos?: [number, number, number, number]): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${pos ? xfrm(...pos) : ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function textBox(id: number, name: string, text: string, x: number, y: number, w: number, h: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${text
    .split('\n\n')
    .map((t) => para(t, 0, { bullet: false, size: 2000 }))
    .join('')}</p:txBody></p:sp>`;
}

const THEME = `${XML}<a:theme xmlns:a="${NS.a}" name="NEXUS Sample"><a:themeElements><a:clrScheme name="NEXUS"><a:dk1><a:srgbClr val="1B2533"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3A5F"/></a:dk2><a:lt2><a:srgbClr val="E8F1FA"/></a:lt2><a:accent1><a:srgbClr val="1F5FAD"/></a:accent1><a:accent2><a:srgbClr val="D9480F"/></a:accent2><a:accent3><a:srgbClr val="1B7F45"/></a:accent3><a:accent4><a:srgbClr val="6B3FD1"/></a:accent4><a:accent5><a:srgbClr val="0E7C8A"/></a:accent5><a:accent6><a:srgbClr val="B3261E"/></a:accent6><a:hlink><a:srgbClr val="1F5FAD"/></a:hlink><a:folHlink><a:srgbClr val="6B3FD1"/></a:folHlink></a:clrScheme><a:fontScheme name="NEXUS"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="NEXUS"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const CLRMAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

function master(): string {
  const title = placeholder(2, 'Title Placeholder 1', '<p:ph type="title"/>', para('Master title'), [838200, 365125, 10515600, 1325563]);
  const body = placeholder(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', para('Master text'), [838200, 1825625, 10515600, 4351338]);
  return `${XML}<p:sldMaster ${NSDECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${nvGrp()}${title}${body}</p:spTree></p:cSld>${CLRMAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2400"/></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2000"/></a:lvl2pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

function layout(kind: 'title' | 'content'): string {
  const shapes =
    kind === 'title'
      ? placeholder(2, 'Title 1', '<p:ph type="ctrTitle"/>', para('Title'), [1524000, 1122363, 9144000, 2387600]) +
        placeholder(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', para('Subtitle'), [1524000, 3602038, 9144000, 1655762])
      : placeholder(2, 'Title 1', '<p:ph type="title"/>', para('Title')) + placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', para('Text'));
  return `${XML}<p:sldLayout ${NSDECL} type="${kind === 'title' ? 'title' : 'obj'}" preserve="1"><p:cSld name="${kind === 'title' ? 'Title Slide' : 'Title and Content'}"><p:spTree>${nvGrp()}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function notesMaster(): string {
  const body = placeholder(2, 'Notes Placeholder 1', '<p:ph type="body" sz="quarter" idx="1"/>', para('Notes'), [685800, 4400550, 5486400, 3600450]);
  return `${XML}<p:notesMaster ${NSDECL}><p:cSld><p:spTree>${nvGrp()}${body}</p:spTree></p:cSld>${CLRMAP}</p:notesMaster>`;
}

function notesSlide(lines: string[]): string {
  const img = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>';
  const body = placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" idx="1"/>', lines.map((l) => para(l, 0, { bullet: false })).join(''));
  return `${XML}<p:notes ${NSDECL}><p:cSld><p:spTree>${nvGrp()}${img}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function animationTiming(spid: number): string {
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="5" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst><p:bldP spid="${spid}" grpId="0" build="p"/></p:bldLst></p:timing>`;
}

function tableFrame(id: number, rows: string[][], x: number, y: number, w: number): string {
  const colW = Math.floor(w / (rows[0]?.length ?? 1));
  const rowH = 457200;
  const grid = (rows[0] ?? []).map(() => `<a:gridCol w="${colW}"/>`).join('');
  const trs = rows
    .map(
      (r, ri) =>
        `<a:tr h="${rowH}">${r
          .map((cell) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(cell, 0, { bullet: false, size: 2000, bold: ri === 0 })}</a:txBody><a:tcPr/></a:tc>`)
          .join('')}</a:tr>`,
    )
    .join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm(x, y, colW * (rows[0]?.length ?? 1), rowH * rows.length, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function picture(id: number, rid: string, name: string, alt: string, x: number, y: number, w: number, h: number, linkAttr = 'r:embed'): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}" descr="${esc(alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip ${linkAttr}="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

interface SlideParts {
  xml: string;
  rels: Array<{ id: string; type: string; target: string; external?: boolean }>;
  extra: RawEntry[];
  contentTypes: string[];
}

function buildSlide(spec: SlideSpec): SlideParts {
  const relsList: SlideParts['rels'] = [{ id: 'rId1', type: 'slideLayout', target: `../slideLayouts/slideLayout${spec.layout === 'title' ? 1 : 2}.xml` }];
  const extra: RawEntry[] = [];
  const contentTypes: string[] = [];
  let shapes = '';
  let nextId = 2;
  let bodyId = 0;
  if (spec.layout === 'title') {
    shapes += placeholder(nextId++, 'Title 1', '<p:ph type="ctrTitle"/>', para(spec.title ?? ''));
    if (spec.subtitle !== undefined) shapes += placeholder(nextId++, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', para(spec.subtitle));
  } else {
    if (spec.title !== undefined) shapes += placeholder(nextId++, 'Title 1', '<p:ph type="title"/>', para(spec.title));
    if (spec.bullets && spec.bullets.length > 0) {
      bodyId = nextId;
      const body = spec.bullets.map((b) => (typeof b === 'string' ? para(b) : para(b.text, b.level))).join('');
      const pos: [number, number, number, number] | undefined = spec.image || spec.table ? [838200, 1825625, 5181600, 4351338] : undefined;
      shapes += placeholder(nextId++, 'Content Placeholder 2', '<p:ph idx="1"/>', body, pos);
    }
  }
  if (spec.equation) {
    const p = `<a:p><mc:AlternateContent xmlns:mc="${NS.mc}"><mc:Choice xmlns:a14="${NS.a14}" Requires="a14"><a14:m><m:oMathPara xmlns:m="${NS.m}"><m:oMath>${spec.equation.omml}</m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback>${run(spec.equation.fallback)}</mc:Fallback></mc:AlternateContent></a:p>`;
    shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${nextId}" name="Equation ${nextId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(1524000, 4600000, 9144000, 900000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${p}</p:txBody></p:sp>`;
    nextId++;
  }
  if (spec.table) shapes += tableFrame(nextId++, spec.table, 6400800, 1825625, 4953000);
  if (spec.image) {
    const rid = `rId${relsList.length + 1}`;
    relsList.push({ id: rid, type: 'image', target: `../media/${spec.image.file}` });
    shapes += picture(nextId++, rid, `Picture ${nextId}`, spec.image.alt, spec.image.x, spec.image.y, spec.image.w, spec.image.h);
    extra.push({ name: `ppt/media/${spec.image.file}`, data: spec.image.png, method: 'store' });
  }
  if (spec.externalImage) {
    const rid = `rId${relsList.length + 1}`;
    relsList.push({ id: rid, type: 'image', target: 'file:///etc/passwd', external: true });
    shapes += picture(nextId++, rid, 'Linked picture', 'linked', 0, 0, 914400, 914400, 'r:link');
  }
  if (spec.emfImage) {
    const rid = `rId${relsList.length + 1}`;
    relsList.push({ id: rid, type: 'image', target: `../media/vector${spec.partNumber}.emf` });
    const emf = Buffer.alloc(88);
    emf.writeUInt32LE(1, 0);
    emf.write(' EMF', 40, 'latin1');
    extra.push({ name: `ppt/media/vector${spec.partNumber}.emf`, data: emf });
    shapes += picture(nextId++, rid, 'Vector diagram', 'vector diagram', 914400, 914400, 914400, 914400);
  }
  if (spec.group && spec.group.length > 0) {
    const xs = spec.group.map((g) => g.x), ys = spec.group.map((g) => g.y);
    const x2 = spec.group.map((g) => g.x + g.w), y2 = spec.group.map((g) => g.y + g.h);
    const minX = Math.min(...xs), minY = Math.min(...ys), w = Math.max(...x2) - minX, h = Math.max(...y2) - minY;
    // Children are stored in a half-scale child coordinate space, so the
    // importer must apply the group transform to recover slide positions.
    const half = (v: number) => Math.round(v / 2);
    const kids = spec.group
      .map((g) => textBox(nextId++, `Group text ${nextId}`, g.text, half(g.x - minX), half(g.y - minY), half(g.w), half(g.h)))
      .join('');
    shapes += `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${nextId++}" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${minX}" y="${minY}"/><a:ext cx="${w}" cy="${h}"/><a:chOff x="0" y="0"/><a:chExt cx="${half(w)}" cy="${half(h)}"/></a:xfrm></p:grpSpPr>${kids}</p:grpSp>`;
  }
  for (const tb of spec.textBoxes ?? []) shapes += textBox(nextId++, `TextBox ${nextId}`, tb.text, tb.x, tb.y, tb.w, tb.h);
  if (spec.chartTitle) {
    const rid = `rId${relsList.length + 1}`;
    relsList.push({ id: rid, type: 'chart', target: `../charts/chart${spec.partNumber}.xml` });
    extra.push({
      name: `ppt/charts/chart${spec.partNumber}.xml`,
      data: `${XML}<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(spec.chartTitle)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea/></c:chart></c:chartSpace>`,
    });
    contentTypes.push(`<Override PartName="/ppt/charts/chart${spec.partNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
    shapes += `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nextId++}" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(0, 0, 4000000, 3000000, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="${NS.c}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  }
  if (spec.smartArt) {
    const rid = `rId${relsList.length + 1}`;
    relsList.push({ id: rid, type: 'diagramData', target: `../diagrams/data${spec.partNumber}.xml` });
    const pts = spec.smartArt
      .map((t, i) => `<dgm:pt modelId="{0000000${i}-0000-0000-0000-000000000000}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></dgm:t></dgm:pt>`)
      .join('');
    extra.push({
      name: `ppt/diagrams/data${spec.partNumber}.xml`,
      data: `${XML}<dgm:dataModel xmlns:dgm="${NS.dgm}" xmlns:a="${NS.a}"><dgm:ptLst><dgm:pt modelId="{99999999-0000-0000-0000-000000000000}" type="doc"><dgm:prSet/><dgm:spPr/></dgm:pt>${pts}</dgm:ptLst></dgm:dataModel>`,
    });
    contentTypes.push(`<Override PartName="/ppt/diagrams/data${spec.partNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>`);
    shapes += `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nextId++}" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(0, 3000000, 6000000, 3000000, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="${NS.dgm}" r:dm="${rid}" r:lo="rIdX" r:qs="rIdY" r:cs="rIdZ"/></a:graphicData></a:graphic></p:graphicFrame>`;
  }
  if (spec.notes && spec.notes.length > 0) {
    relsList.push({ id: `rId${relsList.length + 1}`, type: 'notesSlide', target: `../notesSlides/notesSlide${spec.partNumber}.xml` });
  }
  const timing = spec.animate && bodyId ? animationTiming(bodyId) : '';
  const xml = `${XML}<p:sld ${NSDECL}${spec.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${nvGrp()}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${timing}</p:sld>`;
  return { xml, rels: relsList, extra, contentTypes };
}

export function buildPptx(opts: BuildOptions): Buffer {
  const entries: RawEntry[] = [];
  const order = opts.order ?? opts.slides.map((s) => s.partNumber);
  const overrides: string[] = [];
  const hasNotes = opts.slides.some((s) => s.notes && s.notes.length > 0);

  for (const s of opts.slides) {
    const parts = buildSlide(s);
    entries.push({ name: `ppt/slides/slide${s.partNumber}.xml`, data: parts.xml });
    entries.push({ name: `ppt/slides/_rels/slide${s.partNumber}.xml.rels`, data: rels(parts.rels) });
    entries.push(...parts.extra);
    overrides.push(`<Override PartName="/ppt/slides/slide${s.partNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`, ...parts.contentTypes);
    if (s.notes && s.notes.length > 0) {
      entries.push({ name: `ppt/notesSlides/notesSlide${s.partNumber}.xml`, data: notesSlide(s.notes) });
      entries.push({
        name: `ppt/notesSlides/_rels/notesSlide${s.partNumber}.xml.rels`,
        data: rels([
          { id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
          { id: 'rId2', type: 'slide', target: `../slides/slide${s.partNumber}.xml` },
        ]),
      });
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${s.partNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
    }
  }

  const presRels: Array<{ id: string; type: string; target: string }> = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }];
  const sldIds: string[] = [];
  order.forEach((partNumber, i) => {
    const rid = `rId${100 + i}`;
    presRels.push({ id: rid, type: 'slide', target: `slides/slide${partNumber}.xml` });
    sldIds.push(`<p:sldId id="${256 + partNumber}" r:id="${rid}"/>`);
  });
  if (hasNotes) presRels.push({ id: 'rId2', type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' });
  presRels.push({ id: 'rId3', type: 'theme', target: 'theme/theme1.xml' });
  presRels.push({ id: 'rId4', type: 'presProps', target: 'presProps.xml' });
  presRels.push({ id: 'rId5', type: 'viewProps', target: 'viewProps.xml' });
  presRels.push({ id: 'rId6', type: 'tableStyles', target: 'tableStyles.xml' });

  const presentation = `${XML}<p:presentation ${NSDECL} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' : ''}<p:sldIdLst>${sldIds.join('')}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`;

  const mainType = opts.mainContentType ?? 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
  const contentTypes = `${XML}<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/ppt/presentation.xml" ContentType="${mainType}"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${hasNotes ? '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : ''}<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides.join('')}${opts.extraContentTypes ?? ''}</Types>`;

  const base: RawEntry[] = [
    { name: '[Content_Types].xml', data: contentTypes },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${RT}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${RT}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(opts.title ?? 'Presentation')}</dc:title><dc:creator>NEXUS Play Studio sample</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`,
    },
    {
      name: 'docProps/app.xml',
      data: `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>NEXUS Play Studio</Application><Slides>${order.length}</Slides></Properties>`,
    },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master() },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: rels([
        { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: 'slideLayout', target: '../slideLayouts/slideLayout2.xml' },
        { id: 'rId3', type: 'theme', target: '../theme/theme1.xml' },
      ]),
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout('title') },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]) },
    { name: 'ppt/slideLayouts/slideLayout2.xml', data: layout('content') },
    { name: 'ppt/slideLayouts/_rels/slideLayout2.xml.rels', data: rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]) },
    { name: 'ppt/theme/theme1.xml', data: THEME },
    { name: 'ppt/presProps.xml', data: `${XML}<p:presentationPr ${NSDECL}/>` },
    { name: 'ppt/viewProps.xml', data: `${XML}<p:viewPr ${NSDECL}/>` },
    { name: 'ppt/tableStyles.xml', data: `${XML}<a:tblStyleLst xmlns:a="${NS.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
  ];
  if (hasNotes) {
    base.push(
      { name: 'ppt/notesMasters/notesMaster1.xml', data: notesMaster() },
      { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels([{ id: 'rId1', type: 'theme', target: '../theme/theme2.xml' }]) },
      { name: 'ppt/theme/theme2.xml', data: THEME },
    );
  }

  let all = [...base, ...entries, ...(opts.extraEntries ?? [])];
  if (opts.dropEntries) all = all.filter((e) => !opts.dropEntries!.includes(e.name));
  if (opts.replaceEntries) {
    all = all.map((e) => (opts.replaceEntries![e.name] !== undefined ? { ...e, data: opts.replaceEntries![e.name]! } : e));
  }
  return writeZip(all);
}

export const EMU_PER_POINT = EMU;
export const SLIDE_SIZE = { cx: SLIDE_W, cy: SLIDE_H };
