// Public Confluence gateway only. OAuth client secret, session key and paper records never belong in this file.
// provider is fixed: the workbench has no private D1/R2 record backend in the UI.
globalThis.FalsifyCloudConfig = Object.freeze({
  apiBase: 'https://falsify-cloud-api.ai-gongbu.workers.dev',
  provider: 'confluence'
});
