export const latexRuntimeCatalog = Object.freeze({
  name: 'TeXlyre BusyTeX', version: '1.4.1', source: '61b83cde2836d42cf941f6559d36c9678d52cbf2',
  profiles: Object.freeze({
    basic: Object.freeze({assets: Object.freeze(['texlive-basic.js']), packages: Object.freeze(['article', 'geometry', 'graphicx', 'longtable'])}),
    lua: Object.freeze({assets: Object.freeze(['texlive-basic.js', 'texlive-lua-profile.js']), packages: Object.freeze(['article', 'geometry', 'graphicx', 'longtable', 'fontspec', 'microtype'])})
  })
});
export function latexRuntimeAssets(engine) {
  return latexRuntimeCatalog.profiles[engine === 'lualatex' ? 'lua' : 'basic'].assets;
}
export function latexEngineManifest(engine) {
  return {name:latexRuntimeCatalog.name,version:latexRuntimeCatalog.version,source:latexRuntimeCatalog.source,engine:'combined',data:engine==='lualatex'?'texlive-basic+falsify-lua-profile':'texlive-basic',...(engine==='lualatex'?{profile:'falsify.latex-lua-profile.v1',manifestSha256:'90fd272bbdd003afb3e869dfeb369b881a814ea47dd27a98b4b87639559f6deb'}:{})};
}
