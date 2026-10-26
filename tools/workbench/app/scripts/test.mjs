import {spawnSync} from 'node:child_process';

for (const file of ['document-red.spec.cjs', 'document-blue.spec.cjs', 'harness-core.spec.cjs', 'harness-wrapper.spec.cjs', 'harness-profile.spec.cjs', 'cleanup-static.spec.cjs', 'local-bridge.spec.cjs', 'red-binding.spec.cjs', 'cli-selection.spec.cjs', 'ledger-provenance.spec.cjs', 'cloud-records-core.spec.mjs', 'cloud-ledger-hooks.spec.cjs', 'cloud-records-ui.spec.cjs', 'account-password.spec.cjs', 'pending-job-recovery.spec.cjs', 'editor-export.spec.cjs', 'quality-reread.spec.cjs', 'pdf-preview.spec.cjs', 'paper-analysis.spec.cjs', 'image-editor.spec.cjs']) {
  const result = spawnSync(process.execPath, ['tests/' + file], {stdio: 'inherit'});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
