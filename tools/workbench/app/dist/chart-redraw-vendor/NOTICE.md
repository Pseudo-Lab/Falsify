Falsify chart redraw
Chart.js 4.6.1
https://github.com/chartjs/Chart.js
MIT. @kurkle/color ^0.3.0 (MIT, already inside the official UMD; Chart.js declares it).
Official distribution dist/chart.umd.js, npm integrity sha512-hJyniucsFmq//EvXYvJ6c6mahPoI3kaxdjVH8awTaJ/fDNWeSqqqArixMJWkWNN6fcYvPU3HneSANFNYtRi61g==.

chartjs-chart-error-bars 4.4.5
https://github.com/sgratzl/chartjs-chart-error-bars
MIT. Copyright 2019-2023 Samuel Gratzl.
Official distribution build/index.umd.js, peer chart.js ^4.1.0, npm integrity sha512-JXdPy0AsgllDgjGUG/Kyz4oIFPPqbaa4zgAN+JqhDq0MaYYSCq17467BYDwdJEeOjmPRhtldf/7DF3p8873eTg==.
Upstream chart types: line, bar, scatter, lineWithErrorBars, barWithErrorBars, scatterWithErrorBars.
Point fields yMin and yMax carry explicit yLow and yHigh. Sample points are not given error bars.

LMRoman7-Regular
GUST Font License. Unmodified font bytes from app/dist/font-assets/LMRoman7-Regular.otf.
SHA-256 48c4b46ab255eec96588fb992fba1ed6102e53d051da480738a61cc6cdb328c3. Loaded in the canvas as FalsifyChartText.

Vendored files are unchanged. The browser bundle is app/dist/paper-chart-redraw.js.
Rebuild from app/: node scripts/build-chart-redraw.mjs
esbuild 0.28.2 bundles only the Falsify adapter. It does not rebuild Chart.js.
