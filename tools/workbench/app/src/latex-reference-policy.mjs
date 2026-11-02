const diagnostic = (code, message) => ({code, message, severity: 'error'});

/** Return a bounded, explicit source replacement; never mutate the project. */
export function buildReferencePatch(project, node, {after, mode} = {}) {
  const diagnostics = [];
  const anchor = node && {projectId: project?.id, nodeId: node.id, path: node.path, start: node.start, end: node.end, kind: node.kind};
  const fail = (code, message) => ({anchor, afterSource: null, diagnostics: [diagnostic(code, message)]});
  if (!project || !node || typeof after !== 'string' || !['content', 'display-override'].includes(mode)) return fail('invalid-reference-edit', 'Choose a source node, replacement and edit mode.');
  const file = project.files?.find(f => f.path === node.path);
  if (!file || !Number.isInteger(node.start) || !Number.isInteger(node.end)) return fail('stale-anchor', 'The source node is no longer available; select it again.');
  const source = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(file.bytes);
  const original = source.slice(node.start, node.end);
  if (node.sourceText !== original) return fail('stale-anchor', 'The source changed; select the node again.');
  if (mode === 'content') {
    if (!Number.isInteger(node.contentStart) || !Number.isInteger(node.contentEnd) || node.contentStart < node.start || node.contentEnd > node.end) return fail('unsupported-content', 'Select editable source content.');
    let replacement = after;
    if (node.kind === 'citation') {
      if (!/^[A-Za-z0-9_:.\/-]+(?:\s*,\s*[A-Za-z0-9_:.\/-]+)*$/.test(after)) return fail('invalid-citation', 'Enter citation keys separated by commas.');
    } else if (node.kind === 'footnote' || node.kind === 'superscript' || node.kind === 'subscript' || node.kind === 'text') {
      const escapes = {'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','%':'\\%','_':'\\_','~':'\\textasciitilde{}','^':'\\textasciicircum{}'};
      replacement = after.replace(/[\\{}$&#%_~^]/g, c => escapes[c]);
    } else return fail('unsupported-content', 'Use the source content patch for this node.');
    return {anchor, afterSource:source.slice(node.start,node.contentStart) + replacement + source.slice(node.contentEnd,node.end), diagnostics};
  }
  if (!/^\d+$/.test(after)) return fail('invalid-marker', 'Enter a numeric display marker.');
  if (node.kind === 'superscript') {
    const match = /^(\\textsuperscript\s*\{)([^{}]*)(\})$/.exec(original);
    if (match) return {anchor, afterSource: match[1] + after + match[3], diagnostics};
  }
  if (node.kind === 'citation') {
    const match=/^\\cite\s*\{([A-Za-z0-9_:.-]+)\}$/.exec(original);
    const files=project.files.filter(f=>/\.tex$/i.test(f.path)).map(f=>new TextDecoder().decode(f.bytes)).join('\n');
    const hyperref=/\\usepackage(?:\[[^\]]*\])?\s*\{[^}]*\bhyperref\b[^}]*\}/.test(files);
    const incompatible=/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{[^}]*(?:natbib|biblatex)[^}]*\}|\\(?:re)?newcommand\s*\{?\\cite\b/.test(files);
    if (match && hyperref && !incompatible) return {anchor,afterSource:`\\begingroup\\expandafter\\def\\csname b@${match[1]}\\endcsname{\\hyperlink{cite.${match[1]}}{${after}}}${original}\\endgroup`,diagnostics};
    return fail('unsupported-citation-override', 'Display override requires a single standard citation with hyperref; edit this citation in source for other styles.');
  }
  if (node.kind === 'footnote') {
    // Increment and link the mark once; typeset the body with the restored counter format.
    const match = /^\\footnote(\s*\{[\s\S]*\})$/.exec(original);
    if (match) return {anchor, afterSource: `\\begingroup\\renewcommand{\\thefootnote}{${after}}\\footnotemark\\endgroup\\footnotetext${match[1]}`, diagnostics};
  }
  return fail('unsupported-display-override', 'This marker cannot be safely overridden. Edit its source explicitly or select a supported standard marker.');
}
