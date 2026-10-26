# Workbench 0.2.0-alpha.10

This rolls forward the complete [alpha.9 visual workflow](release-alpha9.md) with versioned changed entry assets. A previously open GitHub Pages tab could retain the old index and scripts in its browser cache; the changed navigation, role and Confluence scripts and stylesheet now carry the same release suffix. The release packager rejects a stale suffix. Original records and Confluence sessions are preserved.

Open https://shinick-han.github.io/falsify-workbench/?v=0.2.0-alpha.10 for an immediate fresh entry, or hard-refresh an existing tab. Future version bumps must also update the versioned URLs in app/dist/index.html. Static module-order checks resolve URL paths while separately checking release versions.

All visual workflow behavior, licenses, user-facing controls and validation boundaries are documented in alpha.9. No new model execution, record publication, PDF editor/native change or API migration is introduced by this cache fix. Existing alpha.9 tags/artifacts remain immutable.
