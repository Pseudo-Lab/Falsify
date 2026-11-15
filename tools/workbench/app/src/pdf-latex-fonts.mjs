import {getBundledFonts} from './bundled-fonts.mjs';

export const FONT_LINE_METRICS = Object.freeze({
  'Latin Modern Roman': Object.freeze({avgCharEm: 0.48, wordSpaceEm: 0.333}),
  'Computer Modern': Object.freeze({avgCharEm: 0.48, wordSpaceEm: 0.333}),
  'Liberation Serif': Object.freeze({avgCharEm: 0.445, wordSpaceEm: 0.25}),
  'TeX Gyre Termes': Object.freeze({avgCharEm: 0.445, wordSpaceEm: 0.25}),
  'TeX Gyre Pagella': Object.freeze({avgCharEm: 0.47, wordSpaceEm: 0.25}),
  'Times New Roman': Object.freeze({avgCharEm: 0.445, wordSpaceEm: 0.25}),
  'Liberation Sans': Object.freeze({avgCharEm: 0.49, wordSpaceEm: 0.278})
});

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round4 = n => Math.round(n * 10000) / 10000;

/** Load the four publication faces only when creating a flow project. */
export async function loadReconstructionFonts({fetch=globalThis.fetch,signal,family='Liberation Serif'}={}) {
  const baseFamily = family === 'Liberation Sans' ? 'Liberation Sans' : 'Liberation Serif';
  const fonts=await getBundledFonts([
    {family:baseFamily}, {family:baseFamily,bold:true},
    {family:baseFamily,italic:true}, {family:baseFamily,bold:true,italic:true},
    {family:baseFamily,text:'∗∼'}
  ],{fetch:(url,options)=>fetch(url,{...options,signal})});
  return fonts.map(f=>({path:`${f.postscriptName}.${f.family==='STIX Two Math'?'otf':'ttf'}`,bytes:f.bytes.slice(),role:f.family==='STIX Two Math'?'math':'serif',style:f.weight>=700?(f.italic?'bolditalic':'bold'):(f.italic?'italic':'regular')}));
}

/** Validate whole-document font family selection while keeping overrides strictly opt-in. */
export function resolveFlowFontFamily(profile, fontPaths) {
  if (fontPaths?.has('regular')) return {customFiles: true, family: 'FalsifyPublication', overridden: false};
  const serif = profile?.fonts?.serif;
  if (serif === 'Latin Modern Roman') return {customFiles: false, family: serif, overridden: false};
  const explicitOverride = profile?.fonts?.allowOverride === true || profile?.diagnostics?.some(d => d.source === 'override' && d.field === 'fonts');
  if (!explicitOverride || typeof serif !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(serif.trim())) return null;
  return {customFiles: false, family: serif.trim(), overridden: true};
}

function hasMeasurableParaLines(item) {
  if (!item || item.kind !== 'paragraph' || item.assetId || typeof item.text !== 'string' || item.text.length < 120) return false;
  return Number.isInteger(item.extensions?.lineCount) && item.extensions.lineCount >= 3 && Array.isArray(item.evidence) && item.evidence.length > 0;
}

function measureParagraphCharEm(item, defaultSizeBp) {
  if (!hasMeasurableParaLines(item)) return null;
  const x0 = Math.min(...item.evidence.map(e => e.bbox[0]));
  const x1 = Math.max(...item.evidence.map(e => e.bbox[2]));
  const lineWidthBp = x1 - x0;
  const sizeBp = item.extensions.typography?.fontSizeBp || defaultSizeBp;
  if (!Number.isFinite(lineWidthBp) || lineWidthBp < 80 || !Number.isFinite(sizeBp) || sizeBp <= 0) return null;
  const measuredCharEm = (lineWidthBp * Math.max(1, item.extensions.lineCount - 0.45)) / (item.text.length * sizeBp);
  return measuredCharEm >= 0.25 && measuredCharEm <= 0.85 ? {measuredCharEm, chars: item.text.length} : null;
}

function computeLineFitTuning(opt, bodySize, ratio) {
  const wordSpaceScale = round4(clamp(Number.isFinite(opt?.wordSpaceScale) ? opt.wordSpaceScale : Math.min(1, ratio), 0.80, 1.15));
  const autoScale = ratio < 0.96 ? clamp(0.95 + (ratio - 0.85) * 0.45, 0.95, 0.995) : 1;
  const horizontalScale = round4(clamp(Number.isFinite(opt?.horizontalScale) ? opt.horizontalScale : autoScale, 0.90, 1.05));
  const emergencystretchBp = round4(clamp(Number.isFinite(opt?.emergencystretchBp) ? opt.emergencystretchBp : bodySize * 1.2, 0, 72));
  return {wordSpaceScale, horizontalScale, emergencystretchBp};
}

function resolveTargetMetric(profile, fontFamily) {
  const targetName = fontFamily || profile?.fonts?.serif || 'Latin Modern Roman';
  return FONT_LINE_METRICS[targetName] || FONT_LINE_METRICS['Latin Modern Roman'];
}

function inactiveLineFit(reason, ratio, measuredCharEm, targetCharEm) {
  return {applied: false, reason, ratio, measuredCharEm, targetCharEm, wordSpaceScale: 1, horizontalScale: 1, emergencystretchBp: 0};
}

/** Compute calibrated or opt-in \fontdimen2 / \emergencystretch / horizontal scale tuning for dense paragraphs. */
export function calibrateFontLineFit(model, profile, {fontFamily} = {}) {
  const opt = profile?.lineFit ?? profile?.fonts?.lineFit;
  const targetMetric = resolveTargetMetric(profile, fontFamily);
  if (opt === false || opt?.enabled === false) return inactiveLineFit('disabled', 1, null, targetMetric.avgCharEm);
  const bodySize = profile?.roles?.body?.sizeBp || 10;
  const samples = (model?.items || []).map(i => measureParagraphCharEm(i, bodySize)).filter(Boolean);
  const measuredCharEm = median(samples.map(s => s.measuredCharEm));
  const totalChars = samples.reduce((sum, s) => sum + s.chars, 0);
  const ratio = measuredCharEm ? measuredCharEm / targetMetric.avgCharEm : 1;
  const roundedEm = measuredCharEm ? round4(measuredCharEm) : null;
  const explicit = opt === true || Boolean(opt?.enabled);
  const autoDense = (samples.length >= 3 || totalChars >= 800) && ratio < 0.98;
  if (!explicit && !autoDense) return inactiveLineFit('none', round4(ratio), roundedEm, targetMetric.avgCharEm);
  return {applied: true, reason: explicit ? 'explicit' : 'measured-dense-paragraphs', ratio: round4(ratio), measuredCharEm: roundedEm, targetCharEm: targetMetric.avgCharEm, ...computeLineFitTuning(opt, bodySize, ratio)};
}
