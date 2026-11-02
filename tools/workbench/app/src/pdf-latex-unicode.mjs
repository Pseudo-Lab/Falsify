// Only wrap characters whose current glyph mapping loses extraction fidelity.
// In particular, a literal node around an en dash changes TeX line breaking.
const actualTextCharacters = new Set(['ï','á','é','ó','ú','í','ü','ä','ö','ñ','µ','μ']);
// PDF ActualText strings are UTF-16BE, including the byte order mark.
export function unicodeActualTextPreamble(macros) {
  return Object.entries(macros).map(([ch, glyph]) => {
    if ([...ch].length !== 1 || typeof glyph !== 'string') throw new TypeError('Invalid Unicode glyph declaration');
    const units = Array.from({length: ch.length}, (_, i) => ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')).join('');
    const code = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    if (!actualTextCharacters.has(ch)) return `\\DeclareUnicodeCharacter{${code}}{${glyph}}`;
    return `\\DeclareUnicodeCharacter{${code}}{\\pdfliteral direct{/Span <</ActualText <FEFF${units}>>> BDC}${glyph}\\pdfliteral direct{EMC}}`;
  }).join('\n') + '\n';
}
