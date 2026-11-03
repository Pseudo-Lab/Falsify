const Chart = globalThis.__FalsifyChartRedrawVendor.Chart;
const ChartErrorBars = globalThis.__FalsifyChartRedrawVendor.ChartErrorBars;
const FONT_BASE64 = globalThis.__FALSIFY_CHART_FONT_BASE64__;
const FONT = 'FalsifyChartText';
const PIXEL_RATIO = 2;
const PALETTE = ['#1b4f72', '#b03a2e', '#1e8449', '#6c3483', '#b9770e', '#117a65'];
const KINDS = ['line', 'scatter', 'bar'];
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^(?:rgb|hsl)a?\([0-9.,%\s/]+\)$/;
const fontLoads = new WeakMap();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function controller(id) {
  const item = Chart.registry.getController(id);
  if (!item || item.id !== id) fail('chart-runtime-missing');
}

if (!Chart || Chart.version !== '4.6.1' || !ChartErrorBars?.LineWithErrorBarsController || typeof FONT_BASE64 !== 'string') {
  fail('chart-runtime-missing');
}
for (const id of ['line', 'bar', 'scatter', 'lineWithErrorBars', 'barWithErrorBars', 'scatterWithErrorBars']) controller(id);
for (const id of ['linear', 'logarithmic']) {
  if (!Chart.registry.getScale(id)) fail('chart-runtime-missing');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function pickScale(...values) {
  for (const value of values) {
    if (value === 'linear' || value === 'log') return value;
  }
  return 'linear';
}

function seriesColor(input, index) {
  if (input == null || input === '') return PALETTE[index % PALETTE.length];
  if (typeof input !== 'string' || !COLOR.test(input)) fail('chart-color-invalid');
  return input;
}

function seriesId(input, index) {
  return typeof input === 'string' && input.trim() ? input : 'series-' + (index + 1);
}

function cleanAxis(raw) {
  if (!raw || typeof raw !== 'object' || (raw.scale !== 'linear' && raw.scale !== 'log')) fail('chart-scale-invalid');
  const axis = {scale: raw.scale};
  if (typeof raw.label === 'string' && raw.label.trim()) axis.label = raw.label;
  if (raw.min != null) {
    if (!finite(raw.min)) fail('chart-axis-range-invalid');
    axis.min = raw.min;
  }
  if (raw.max != null) {
    if (!finite(raw.max)) fail('chart-axis-range-invalid');
    axis.max = raw.max;
  }
  return axis;
}

function reportedAxis(source, scale, calibrated) {
  const axis = {scale};
  if (source && typeof source === 'object') {
    if (typeof source.label === 'string' && source.label.trim()) axis.label = source.label;
    else if (typeof source.unit === 'string' && source.unit.trim()) axis.label = source.unit;
    if (source.min != null) axis.min = source.min;
    if (source.max != null) axis.max = source.max;
  }
  const ticks=calibrated?.points;
  if(Array.isArray(ticks)&&ticks.length>=2&&ticks.every(point=>finite(point?.value))){
    if(axis.min==null)axis.min=Math.min(...ticks.map(point=>point.value));
    if(axis.max==null)axis.max=Math.max(...ticks.map(point=>point.value));
  }
  return cleanAxis(axis);
}

function copyPoint(point) {
  if (!point || typeof point !== 'object') fail('chart-points-invalid');
  const out = {x: point.x, y: point.y};
  if (point.yLow != null || point.yHigh != null) {
    out.yLow = point.yLow;
    out.yHigh = point.yHigh;
  }
  return out;
}

function validate(chart) {
  if (!chart || !KINDS.includes(chart.kind)) fail('chart-kind-invalid');
  for (const axisName of ['xAxis', 'yAxis']) {
    const axis = chart[axisName];
    if (!axis || (axis.scale !== 'linear' && axis.scale !== 'log')) fail('chart-scale-invalid');
    if (axis.min != null && axis.max != null && !(axis.min < axis.max)) fail('chart-axis-range-invalid');
    if (axis.scale === 'log' && ((axis.min != null && axis.min <= 0) || (axis.max != null && axis.max <= 0))) fail('chart-log-nonpositive');
  }
  if (!Array.isArray(chart.series) || chart.series.length < 1 || chart.series.length > 64) fail('chart-series-invalid');
  for (const series of chart.series) {
    if (!series || !Array.isArray(series.points) || series.points.length < 1 || series.points.length > 4096) fail('chart-points-invalid');
    for (const point of series.points) {
      if (!finite(point.x) || !finite(point.y)) fail('chart-nonfinite');
      if ((chart.xAxis.scale === 'log' && point.x <= 0) || (chart.yAxis.scale === 'log' && point.y <= 0)) fail('chart-log-nonpositive');
      const low = point.yLow != null;
      const high = point.yHigh != null;
      if (low !== high) fail('chart-errorbar-incomplete');
      if (low) {
        if (!finite(point.yLow) || !finite(point.yHigh) || point.yLow > point.yHigh) fail('chart-errorbar-invalid');
        if (chart.yAxis.scale === 'log' && (point.yLow <= 0 || point.yHigh <= 0)) fail('chart-log-nonpositive');
      }
    }
  }
  return chart;
}

function fromChartModel(data) {
  if (!Array.isArray(data.series)) fail('chart-series-invalid');
  const chart = {
    kind: data.kind,
    title: typeof data.title === 'string' ? data.title : '',
    xAxis: cleanAxis(data.xAxis),
    yAxis: cleanAxis(data.yAxis),
    series: data.series.map((series, index) => {
      if (!series || typeof series !== 'object' || !Array.isArray(series.points)) fail('chart-series-invalid');
      const id = seriesId(series.id, index);
      return {
        id,
        name: typeof series.name === 'string' && series.name.trim() ? series.name : id,
        color: seriesColor(series.color, index),
        points: series.points.map(copyPoint),
      };
    }),
  };
  return validate(chart);
}

function bindingOf(series, geometry) {
  if (!series || typeof series !== 'object') fail('chart-series-invalid');
  if (series.axisBinding === 'ambiguous' || series.traceAmbiguous === true) fail('chart-series-ambiguous');
  if (series.axisBinding === 'left' || series.axisBinding === 'right') return series.axisBinding;
  if (series.axisBinding != null) fail('chart-series-ambiguous');
  const axes = geometry.axes || {};
  if (axes.left && axes.right) fail('chart-y-axis-ambiguous');
  if (axes.right && !axes.left) return 'right';
  return 'left';
}

function fromGeometry(record, geometry) {
  if (!Array.isArray(geometry.series) || geometry.series.length < 1) fail('chart-series-invalid');
  const bindings = geometry.series.map(series => bindingOf(series, geometry));
  const distinct = new Set(bindings);
  if (distinct.size > 1) fail('chart-y-axis-ambiguous');
  const binding = bindings[0];
  const reported = record === geometry ? null : record.axes;
  const xReported = record === geometry ? geometry.axes?.x : reported?.x;
  const yReported = record === geometry ? geometry.axes?.[binding] : reported?.y;
  const chartType = record === geometry ? '' : record.chartType;
  const kind = KINDS.includes(chartType) ? chartType : 'line';
  const chart = {
    kind,
    title: typeof record.title === 'string' ? record.title : '',
    xAxis: reportedAxis(xReported, pickScale(xReported?.scale, geometry.axes?.x?.scale),geometry.axes?.x),
    yAxis: reportedAxis(yReported, pickScale(yReported?.scale, geometry.axes?.[binding]?.scale),geometry.axes?.[binding]),
    series: geometry.series.map((series, index) => {
      if (!Array.isArray(series.points)) fail('chart-points-invalid');
      const id = seriesId(series.id, index);
      return {
        id,
        name: typeof series.name === 'string' && series.name.trim() ? series.name : id,
        color: seriesColor(series.color, index),
        points: series.points.map(point => {
          if (point && point.y == null && point.valueCandidates) fail('chart-series-ambiguous');
          return copyPoint(point);
        }),
      };
    }),
  };
  return validate(chart);
}

function fromAnalysis(data) {
  if (!data || typeof data !== 'object') fail('chart-analysis-unsupported');
  if (data.kind != null || (data.xAxis && data.yAxis && Array.isArray(data.series) && data.geometry == null && data.schema !== 'falsify.chart-geometry.v1')) return fromChartModel(data);
  const geometry = data.schema === 'falsify.chart-geometry.v1' ? data : data.geometry;
  if (!geometry || typeof geometry !== 'object' || !Array.isArray(geometry.series)) fail('chart-analysis-unsupported');
  return fromGeometry(data, geometry);
}

function assertSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 1600 || height > 1600) {
    fail('chart-size-invalid');
  }
}

function pngSize(png) {
  if (png.length < 32 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) fail('chart-png-invalid');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) fail('chart-png-invalid');
  return {width, height};
}

function dataUrlToBytes(url, view) {
  const comma = url.indexOf(',');
  if (comma < 0) fail('chart-png-invalid');
  const binary = view.atob(url.slice(comma + 1));
  const png = new view.Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
  return png;
}

async function ensureFont(documentRef) {
  const cached = fontLoads.get(documentRef);
  if (cached) return cached;
  const pending = loadFont(documentRef);
  fontLoads.set(documentRef, pending);
  try {
    await pending;
  } catch (error) {
    fontLoads.delete(documentRef);
    throw error;
  }
}

async function loadFont(documentRef) {
  const view = documentRef.defaultView;
  if (!view || typeof view.FontFace !== 'function' || !documentRef.fonts || typeof view.atob !== 'function') fail('chart-font-unavailable');
  const binary = view.atob(FONT_BASE64);
  const bytes = new view.Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const face = new view.FontFace(FONT, bytes, {style: 'normal', weight: '400', display: 'block'});
  const loaded = await face.load();
  documentRef.fonts.add(loaded);
  await documentRef.fonts.load('16px "' + FONT + '"');
}

function scaleOptions(axis, kind, horizontal) {
  const options = {
    type: axis.scale === 'log' ? 'logarithmic' : 'linear',
    beginAtZero: false,
    offset: kind === 'bar' && horizontal,
    title: {
      display: typeof axis.label === 'string' && axis.label.length > 0,
      text: axis.label || '',
      color: '#1a1a1a',
      font: {family: FONT, size: 13},
    },
    ticks: {color: '#1a1a1a', font: {family: FONT, size: 11}, maxRotation: 0, autoSkip: true},
    grid: {color: '#ececec', tickLength: 4},
    border: {color: '#222222'},
  };
  if (axis.min != null) options.min = axis.min;
  if (axis.max != null) options.max = axis.max;
  if (axis.min != null && axis.max != null) options.grace = 0;
  return options;
}

function withErrorBars(chart) {
  return chart.series.some(series => series.points.some(point => point.yLow != null));
}

function dataset(series, index, kind) {
  const color = series.color || PALETTE[index % PALETTE.length];
  const data = series.points.map(point => {
    const row = {x: point.x, y: point.y};
    if (point.yLow != null) {
      row.yMin = point.yLow;
      row.yMax = point.yHigh;
    }
    return row;
  });
  return {
    label: series.name || series.id,
    data,
    borderColor: color,
    backgroundColor: color,
    pointBackgroundColor: color,
    pointBorderColor: color,
    pointBorderWidth: 0,
    borderWidth: kind === 'line' ? 2 : 0,
    pointRadius: kind === 'scatter' ? 4 : kind === 'line' && series.points.length <= 24 ? 3 : 0,
    pointHoverRadius: 0,
    tension: 0,
    fill: false,
    spanGaps: false,
    showLine: kind === 'line',
    clip: false,
    barPercentage: 0.72,
    categoryPercentage: 0.8,
    errorBarColor: () => color,
    errorBarWhiskerColor: () => color,
    errorBarLineWidth: () => 1.5,
    errorBarWhiskerLineWidth: () => 1.5,
    errorBarWhiskerRatio: () => 0,
    errorBarWhiskerSize: () => 8,
  };
}

const background = {
  id: 'falsifyChartBackground',
  beforeDraw(chart) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, chart.canvas.width, chart.canvas.height);
    ctx.restore();
  },
};

async function render(request) {
  if (!request || typeof request !== 'object') fail('chart-analysis-unsupported');
  const chart = fromAnalysis(request.chart);
  assertSize(request.width, request.height);
  const documentRef = request.document || globalThis.document;
  if (!documentRef || typeof documentRef.createElement !== 'function') fail('chart-document-missing');
  await ensureFont(documentRef);
  const kind = chart.kind;
  const errorBars = withErrorBars(chart);
  const type = errorBars ? {line: 'lineWithErrorBars', scatter: 'scatterWithErrorBars', bar: 'barWithErrorBars'}[kind] : kind;
  const showLegend = chart.series.length > 1;
  const canvas = documentRef.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  canvas.style.width = request.width + 'px';
  canvas.style.height = request.height + 'px';
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.pointerEvents = 'none';
  canvas.setAttribute('aria-hidden', 'true');
  const parent = documentRef.body || documentRef.documentElement;
  parent.appendChild(canvas);
  let chartJs;
  try {
    chartJs = new Chart(canvas, {
      type,
      data: {datasets: chart.series.map((series, index) => dataset(series, index, kind))},
      plugins: [background],
      options: {
        responsive: false,
        maintainAspectRatio: false,
        devicePixelRatio: PIXEL_RATIO,
        animation: false,
        events: [],
        locale: 'en-US',
        font: {family: FONT, size: 12},
        layout: {padding: 8},
        elements: {
          line: {tension: 0, fill: false, borderJoinStyle: 'round', borderCapStyle: 'round'},
          point: {hoverRadius: 0},
          bar: {borderWidth: 0},
        },
        plugins: {
          colors: {enabled: false},
          decimation: {enabled: false},
          tooltip: {enabled: false},
          subtitle: {display: false},
          legend: {
            display: showLegend,
            labels: {color: '#1a1a1a', font: {family: FONT, size: 12}, boxWidth: 12, boxHeight: 8},
          },
          title: {
            display: chart.title.length > 0,
            text: chart.title,
            color: '#1a1a1a',
            font: {family: FONT, size: 16},
          },
        },
        scales: {
          x: scaleOptions(chart.xAxis, kind, true),
          y: scaleOptions(chart.yAxis, kind, false),
        },
      },
    });
    const view = documentRef.defaultView;
    const png = dataUrlToBytes(canvas.toDataURL('image/png'), view);
    const size = pngSize(png);
    if (size.width !== request.width * PIXEL_RATIO || size.height !== request.height * PIXEL_RATIO) {
      fail('chart-png-invalid:' + size.width + 'x' + size.height);
    }
    return {png, width: size.width, height: size.height};
  } finally {
    if (chartJs) chartJs.destroy();
    canvas.remove();
  }
}

const provenance = {
  chartJs: '4.6.1',
  chartJsLicense: 'MIT',
  errorBars: '4.4.5',
  errorBarsLicense: 'MIT',
  font: 'LMRoman7-Regular',
  fontSha256: '48c4b46ab255eec96588fb992fba1ed6102e53d051da480738a61cc6cdb328c3',
  fontLicense: 'GUST Font License',
  pixelRatio: PIXEL_RATIO,
};

globalThis.FalsifyChartRedraw = {fromAnalysis, render, pixelRatio: PIXEL_RATIO, provenance};
