/**
 * chartjs-chart-error-bars
 * https://github.com/sgratzl/chartjs-chart-error-bars
 *
 * Copyright (c) 2019-2023 Samuel Gratzl <samu@sgratzl.com>
 */

(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('chart.js'), require('chart.js/helpers')) :
    typeof define === 'function' && define.amd ? define(['exports', 'chart.js', 'chart.js/helpers'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.ChartErrorBars = {}, global.Chart, global.Chart.helpers));
})(this, (function (exports, chart_js, helpers) { 'use strict';

    const allModelKeys = ['xMin', 'xMax', 'yMin', 'yMax'];
    function modelKeys(horizontal) {
        return (horizontal ? allModelKeys.slice(0, 2) : allModelKeys.slice(2));
    }
    function calculateScale(properties, data, index, scale, reset) {
        const keys = [`${scale.axis}Min`, `${scale.axis}Max`];
        const base = scale.getBasePixel();
        for (const key of keys) {
            const v = data[key];
            if (Array.isArray(v)) {
                properties[key] = v.map((d) => (reset ? base : scale.getPixelForValue(d, index)));
            }
            else if (typeof v === 'number') {
                properties[key] = reset ? base : scale.getPixelForValue(v, index);
            }
            else {
                properties[key] = null;
            }
        }
    }
    function calculatePolarScale(properties, data, scale, reset, options) {
        const animationOpts = options.animation;
        const keys = [`${scale.axis}Min`, `${scale.axis}Max`];
        const toAngle = (v) => {
            const valueRadius = scale.getDistanceFromCenterForValue(v);
            const resetRadius = animationOpts.animateScale ? 0 : valueRadius;
            return reset ? resetRadius : valueRadius;
        };
        for (const key of keys) {
            const v = data[key];
            if (Array.isArray(v)) {
                properties[key] = v.map(toAngle);
            }
            else if (typeof v === 'number') {
                properties[key] = toAngle(v);
            }
            else {
                properties[key] = null;
            }
        }
    }
    const NUMERIC_SCALE_TYPES = ['linear', 'logarithmic', 'time', 'timeseries'];
    function isNumericScale(scale) {
        return NUMERIC_SCALE_TYPES.includes(scale.type);
    }

    const errorBarDefaults = {
        errorBarLineWidth: { v: [1, 3] },
        errorBarColor: { v: ['#2c2c2c', '#1f1f1f'] },
        errorBarWhiskerLineWidth: { v: [1, 3] },
        errorBarWhiskerRatio: { v: [0.2, 0.25] },
        errorBarWhiskerSize: { v: [20, 24] },
        errorBarWhiskerColor: { v: ['#2c2c2c', '#1f1f1f'] },
    };
    const errorBarDescriptors = {
        _scriptable: true,
        _indexable: (name) => name !== 'v',
    };
    const styleKeys = Object.keys(errorBarDefaults);
    function resolveMulti(vMin, vMax) {
        const vMinArr = Array.isArray(vMin) ? vMin : [vMin];
        const vMaxArr = Array.isArray(vMax) ? vMax : [vMax];
        if (vMinArr.length === vMaxArr.length) {
            return vMinArr.map((v, i) => [v, vMaxArr[i]]);
        }
        const max = Math.max(vMinArr.length, vMaxArr.length);
        return Array(max).map((_, i) => [vMinArr[i % vMinArr.length], vMaxArr[i % vMaxArr.length]]);
    }
    function resolveOption(val, index) {
        if (typeof val === 'string' || typeof val === 'number') {
            return val;
        }
        const v = Array.isArray(val) ? val : val.v;
        return v[index % v.length];
    }
    function calculateHalfSize(total, options, i) {
        const ratio = resolveOption(options.errorBarWhiskerRatio, i);
        if (total != null && ratio > 0) {
            return total * ratio * 0.5;
        }
        const size = resolveOption(options.errorBarWhiskerSize, i);
        return size * 0.5;
    }
    function drawErrorBarVertical(props, vMin, vMax, options, ctx) {
        ctx.save();
        ctx.translate(props.x, 0);
        const bars = resolveMulti(vMin == null ? props.y : vMin, vMax == null ? props.y : vMax);
        bars.reverse().forEach(([mi, ma], j) => {
            const i = bars.length - j - 1;
            const halfWidth = calculateHalfSize(props.width, options, i);
            ctx.lineWidth = resolveOption(options.errorBarLineWidth, i);
            ctx.strokeStyle = resolveOption(options.errorBarColor, i);
            ctx.beginPath();
            ctx.moveTo(0, mi);
            ctx.lineTo(0, ma);
            ctx.stroke();
            ctx.lineWidth = resolveOption(options.errorBarWhiskerLineWidth, i);
            ctx.strokeStyle = resolveOption(options.errorBarWhiskerColor, i);
            ctx.beginPath();
            ctx.moveTo(-halfWidth, mi);
            ctx.lineTo(halfWidth, mi);
            ctx.moveTo(-halfWidth, ma);
            ctx.lineTo(halfWidth, ma);
            ctx.stroke();
        });
        ctx.restore();
    }
    function drawErrorBarHorizontal(props, vMin, vMax, options, ctx) {
        ctx.save();
        ctx.translate(0, props.y);
        const bars = resolveMulti(vMin == null ? props.x : vMin, vMax == null ? props.x : vMax);
        bars.reverse().forEach(([mi, ma], j) => {
            const i = bars.length - j - 1;
            const halfHeight = calculateHalfSize(props.height, options, i);
            ctx.lineWidth = resolveOption(options.errorBarLineWidth, i);
            ctx.strokeStyle = resolveOption(options.errorBarColor, i);
            ctx.beginPath();
            ctx.moveTo(mi, 0);
            ctx.lineTo(ma, 0);
            ctx.stroke();
            ctx.lineWidth = resolveOption(options.errorBarWhiskerLineWidth, i);
            ctx.strokeStyle = resolveOption(options.errorBarWhiskerColor, i);
            ctx.beginPath();
            ctx.moveTo(mi, -halfHeight);
            ctx.lineTo(mi, halfHeight);
            ctx.moveTo(ma, -halfHeight);
            ctx.lineTo(ma, halfHeight);
            ctx.stroke();
        });
        ctx.restore();
    }
    function renderErrorBar(elem, ctx) {
        var _a, _b, _c, _d;
        const props = elem.getProps(['x', 'y', 'width', 'height', 'xMin', 'xMax', 'yMin', 'yMax']);
        if (props.xMin != null || props.xMax != null) {
            drawErrorBarHorizontal(props, (_a = props.xMin) !== null && _a !== void 0 ? _a : null, (_b = props.xMax) !== null && _b !== void 0 ? _b : null, elem.options, ctx);
        }
        if (props.yMin != null || props.yMax != null) {
            drawErrorBarVertical(props, (_c = props.yMin) !== null && _c !== void 0 ? _c : null, (_d = props.yMax) !== null && _d !== void 0 ? _d : null, elem.options, ctx);
        }
    }
    function drawErrorBarArc(props, vMin, vMax, options, ctx) {
        ctx.save();
        ctx.translate(props.x, props.y);
        const angle = (props.startAngle + props.endAngle) / 2;
        const cosAngle = Math.cos(angle);
        const sinAngle = Math.sin(angle);
        const v = {
            x: -sinAngle,
            y: cosAngle,
        };
        const length = Math.sqrt(v.x * v.x + v.y * v.y);
        v.x /= length;
        v.y /= length;
        const bars = resolveMulti(vMin !== null && vMin !== void 0 ? vMin : props.outerRadius, vMax !== null && vMax !== void 0 ? vMax : props.outerRadius);
        bars.reverse().forEach(([mi, ma], j) => {
            const i = bars.length - j - 1;
            const minCos = mi * cosAngle;
            const minSin = mi * sinAngle;
            const maxCos = ma * cosAngle;
            const maxSin = ma * sinAngle;
            const halfHeight = calculateHalfSize(null, options, i);
            const eX = v.x * halfHeight;
            const eY = v.y * halfHeight;
            ctx.lineWidth = resolveOption(options.errorBarLineWidth, i);
            ctx.strokeStyle = resolveOption(options.errorBarColor, i);
            ctx.beginPath();
            ctx.moveTo(minCos, minSin);
            ctx.lineTo(maxCos, maxSin);
            ctx.stroke();
            ctx.lineWidth = resolveOption(options.errorBarWhiskerLineWidth, i);
            ctx.strokeStyle = resolveOption(options.errorBarWhiskerColor, i);
            ctx.beginPath();
            ctx.moveTo(minCos + eX, minSin + eY);
            ctx.lineTo(minCos - eX, minSin - eY);
            ctx.moveTo(maxCos + eX, maxSin + eY);
            ctx.lineTo(maxCos - eX, maxSin - eY);
            ctx.stroke();
        });
        ctx.restore();
    }
    function renderErrorBarArc(elem, ctx) {
        const props = elem.getProps(['x', 'y', 'startAngle', 'endAngle', 'rMin', 'rMax', 'outerRadius']);
        if (props.rMin != null || props.rMax != null) {
            drawErrorBarArc(props, props.rMin, props.rMax, elem.options, ctx);
        }
    }

    class BarWithErrorBar extends chart_js.BarElement {
        draw(ctx) {
            super.draw(ctx);
            renderErrorBar(this, ctx);
        }
    }
    BarWithErrorBar.id = 'barWithErrorBar';
    BarWithErrorBar.defaults = { ...chart_js.BarElement.defaults, ...errorBarDefaults };
    BarWithErrorBar.defaultRoutes = chart_js.BarElement.defaultRoutes;
    BarWithErrorBar.descriptors = errorBarDescriptors;

    class PointWithErrorBar extends chart_js.PointElement {
        draw(ctx, area) {
            super.draw.call(this, ctx, area);
            renderErrorBar(this, ctx);
        }
    }
    PointWithErrorBar.id = 'pointWithErrorBar';
    PointWithErrorBar.defaults = { ...chart_js.PointElement.defaults, ...errorBarDefaults };
    PointWithErrorBar.defaultRoutes = chart_js.PointElement.defaultRoutes;
    PointWithErrorBar.descriptors = errorBarDescriptors;

    class ArcWithErrorBar extends chart_js.ArcElement {
        draw(ctx) {
            super.draw(ctx);
            renderErrorBarArc(this, ctx);
        }
    }
    ArcWithErrorBar.id = 'arcWithErrorBar';
    ArcWithErrorBar.defaults = { ...chart_js.ArcElement.defaults, ...errorBarDefaults };
    ArcWithErrorBar.defaultRoutes = chart_js.ArcElement.defaultRoutes;
    ArcWithErrorBar.descriptors = errorBarDescriptors;

    function reverseOrder(v) {
        return Array.isArray(v) ? v.slice().reverse() : v;
    }
    function generateBarTooltip(item) {
        const keys = modelKeys(item.element.horizontal);
        const base = chart_js.Tooltip.defaults.callbacks.label.call(this, item);
        const v = item.chart.data.datasets[item.datasetIndex].data[item.dataIndex];
        if (v == null || keys.every((k) => v[k] == null)) {
            return base;
        }
        return `${base} (${reverseOrder(v[keys[0]])} .. ${v[keys[1]]})`;
    }
    function generateTooltipScatter(item) {
        const v = item.chart.data.datasets[item.datasetIndex].data[item.dataIndex];
        const subLabel = (base, horizontal) => {
            const keys = modelKeys(horizontal);
            if (v == null || keys.every((k) => v[k] == null)) {
                return base;
            }
            return `${base} [${reverseOrder(v[keys[0]])} .. ${v[keys[1]]}]`;
        };
        return `(${subLabel(item.label, true)}, ${subLabel(item.parsed.y, false)})`;
    }
    function generateTooltipPolar(item) {
        const base = chart_js.PolarAreaController.overrides.plugins.tooltip.callbacks.label.call(this, item);
        const v = item.chart.data.datasets[item.datasetIndex].data[item.dataIndex];
        const keys = ['rMin', 'rMax'];
        if (v == null || keys.every((k) => v[k] == null)) {
            return base;
        }
        return `${base} [${reverseOrder(v[keys[0]])} .. ${v[keys[1]]}]`;
    }

    const interpolators = {
        color(from, to, factor) {
            const f = from || 'transparent';
            const t = to || 'transparent';
            if (f === t) {
                return to;
            }
            const c0 = helpers.color(f);
            const c1 = c0.valid && helpers.color(t);
            return c1 && c1.valid ? c1.mix(c0, factor).hexString() : to;
        },
        number(from, to, factor) {
            if (from === to) {
                return to;
            }
            return from + (to - from) * factor;
        },
    };
    function interpolateArrayOption(from, to, factor, type, interpolator) {
        if (typeof from === type && typeof to === type) {
            return interpolator(from, to, factor);
        }
        if (Array.isArray(from) && Array.isArray(to)) {
            return from.map((f, i) => interpolator(f, to[i], factor));
        }
        const isV = (t) => t && Array.isArray(t.v);
        if (isV(from) && isV(to)) {
            return { v: from.v.map((f, i) => interpolator(f, to.v[i], factor)) };
        }
        return to;
    }
    function interpolateNumberOptionArray(from, to, factor) {
        return interpolateArrayOption(from, to, factor, 'number', interpolators.number);
    }
    function interpolateColorOptionArray(from, to, factor) {
        return interpolateArrayOption(from, to, factor, 'string', interpolators.color);
    }
    const animationHints = {
        animations: {
            numberArray: {
                fn: interpolateNumberOptionArray,
                properties: allModelKeys.concat(styleKeys.filter((d) => !d.endsWith('Color')), ['rMin', 'rMax']),
            },
            colorArray: {
                fn: interpolateColorOptionArray,
                properties: styleKeys.filter((d) => d.endsWith('Color')),
            },
        },
    };

    function getMinMax(scale, superMethod) {
        const { axis } = scale;
        scale.axis = `${axis}MinMin`;
        const { min } = superMethod(scale);
        scale.axis = `${axis}MaxMax`;
        const { max } = superMethod(scale);
        scale.axis = axis;
        return { min, max };
    }
    function computeExtrema(v, vm, op) {
        if (Array.isArray(vm)) {
            return op(v, ...vm);
        }
        if (typeof vm === 'number') {
            return op(v, vm);
        }
        return v;
    }
    function parseErrorNumberData(parsed, scale, data, start, count) {
        const axis = typeof scale === 'string' ? scale : scale.axis;
        const vMin = `${axis}Min`;
        const vMax = `${axis}Max`;
        const vMinMin = `${axis}MinMin`;
        const vMaxMax = `${axis}MaxMax`;
        for (let i = 0; i < count; i += 1) {
            const index = i + start;
            const p = parsed[i];
            p[vMin] = typeof data[index] === 'object' ? data[index][vMin] : null;
            p[vMax] = typeof data[index] === 'object' ? data[index][vMax] : null;
            p[vMinMin] = computeExtrema(p[axis], p[vMin], Math.min);
            p[vMaxMax] = computeExtrema(p[axis], p[vMax], Math.max);
        }
    }
    function parseErrorLabelData(parsed, scale, start, count) {
        const { axis } = scale;
        const labels = scale.getLabels();
        for (let i = 0; i < count; i += 1) {
            const index = i + start;
            const p = parsed[i];
            p[axis] = scale.parse(labels[index], index);
        }
    }

    function patchController(type, config, controller, elements = [], scales = []) {
        chart_js.registry.addControllers(controller);
        if (Array.isArray(elements)) {
            chart_js.registry.addElements(...elements);
        }
        else {
            chart_js.registry.addElements(elements);
        }
        if (Array.isArray(scales)) {
            chart_js.registry.addScales(...scales);
        }
        else {
            chart_js.registry.addScales(scales);
        }
        const c = config;
        c.type = type;
        return c;
    }

    class BarWithErrorBarsController extends chart_js.BarController {
        getMinMax(scale, canStack) {
            return getMinMax(scale, (patchedScale) => super.getMinMax(patchedScale, canStack));
        }
        parsePrimitiveData(meta, data, start, count) {
            const parsed = super.parsePrimitiveData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseObjectData(meta, data, start, count) {
            const parsed = super.parseObjectData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseErrorData(parsed, meta, data, start, count) {
            parseErrorNumberData(parsed, meta.vScale, data, start, count);
            const iScale = meta.iScale;
            const hasNumberIScale = isNumericScale(iScale);
            if (hasNumberIScale) {
                parseErrorNumberData(parsed, meta.iScale, data, start, count);
            }
            else {
                parseErrorLabelData(parsed, meta.iScale, start, count);
            }
        }
        updateElement(element, index, properties, mode) {
            if (typeof index === 'number') {
                calculateScale(properties, this.getParsed(index), index, this._cachedMeta.vScale, mode === 'reset');
            }
            super.updateElement(element, index, properties, mode);
        }
    }
    BarWithErrorBarsController.id = 'barWithErrorBars';
    BarWithErrorBarsController.defaults = helpers.merge({}, [
        chart_js.BarController.defaults,
        animationHints,
        {
            dataElementType: BarWithErrorBar.id,
        },
    ]);
    BarWithErrorBarsController.overrides = helpers.merge({}, [
        chart_js.BarController.overrides,
        {
            plugins: {
                tooltip: {
                    callbacks: {
                        label: generateBarTooltip,
                    },
                },
            },
        },
    ]);
    BarWithErrorBarsController.defaultRoutes = chart_js.BarController.defaultRoutes;
    class BarWithErrorBarsChart extends chart_js.Chart {
        constructor(item, config) {
            super(item, patchController('barWithErrorBars', config, BarWithErrorBarsController, BarWithErrorBar, [
                chart_js.LinearScale,
                chart_js.CategoryScale,
            ]));
        }
    }
    BarWithErrorBarsChart.id = BarWithErrorBarsController.id;

    class LineWithErrorBarsController extends chart_js.LineController {
        getMinMax(scale, canStack) {
            return getMinMax(scale, (patchedScale) => super.getMinMax(patchedScale, canStack));
        }
        parsePrimitiveData(meta, data, start, count) {
            const parsed = super.parsePrimitiveData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseObjectData(meta, data, start, count) {
            const parsed = super.parseObjectData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseErrorData(parsed, meta, data, start, count) {
            parseErrorNumberData(parsed, meta.vScale, data, start, count);
            const iScale = meta.iScale;
            const hasNumberIScale = isNumericScale(iScale);
            if (hasNumberIScale) {
                parseErrorNumberData(parsed, meta.iScale, data, start, count);
            }
            else {
                parseErrorLabelData(parsed, meta.iScale, start, count);
            }
        }
        updateElement(element, index, properties, mode) {
            if (element instanceof PointWithErrorBar && typeof index === 'number') {
                this.updateElementScale(index, properties, mode);
            }
            super.updateElement(element, index, properties, mode);
        }
        updateElementScale(index, properties, mode) {
            calculateScale(properties, this.getParsed(index), index, this._cachedMeta.vScale, mode === 'reset');
            const iScale = this._cachedMeta.iScale;
            const hasNumberIScale = isNumericScale(iScale);
            if (hasNumberIScale) {
                calculateScale(properties, this.getParsed(index), index, this._cachedMeta.iScale, mode === 'reset');
            }
        }
        updateElements(points, start, count, mode) {
            const reset = mode === 'reset';
            const c = this.chart;
            const directUpdate = c._animationsDisabled || reset || mode === 'none';
            super.updateElements(points, start, count, mode);
            if (!directUpdate) {
                return;
            }
            for (let i = start; i < start + count; ++i) {
                const point = points[i];
                if (point instanceof PointWithErrorBar) {
                    this.updateElementScale(i, point, mode);
                }
            }
        }
    }
    LineWithErrorBarsController.id = 'lineWithErrorBars';
    LineWithErrorBarsController.defaults = helpers.merge({}, [
        chart_js.LineController.defaults,
        animationHints,
        {
            dataElementType: PointWithErrorBar.id,
        },
    ]);
    LineWithErrorBarsController.overrides = helpers.merge({}, [
        chart_js.LineController.overrides,
        {
            plugins: {
                tooltip: {
                    callbacks: {
                        label: generateBarTooltip,
                    },
                },
            },
        },
    ]);
    LineWithErrorBarsController.defaultRoutes = chart_js.LineController.defaultRoutes;
    class LineWithErrorBarsChart extends chart_js.Chart {
        constructor(item, config) {
            super(item, patchController('lineWithErrorBars', config, LineWithErrorBarsController, PointWithErrorBar, [
                chart_js.LinearScale,
                chart_js.CategoryScale,
            ]));
        }
    }
    LineWithErrorBarsChart.id = LineWithErrorBarsController.id;

    class ScatterWithErrorBarsController extends chart_js.ScatterController {
        getMinMax(scale, canStack) {
            return getMinMax(scale, (patchedScale) => super.getMinMax(patchedScale, canStack));
        }
        parsePrimitiveData(meta, data, start, count) {
            const parsed = super.parsePrimitiveData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseObjectData(meta, data, start, count) {
            const parsed = super.parseObjectData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseErrorData(parsed, meta, data, start, count) {
            parseErrorNumberData(parsed, meta.xScale, data, start, count);
            parseErrorNumberData(parsed, meta.yScale, data, start, count);
        }
        updateElement(element, index, properties, mode) {
            if (element instanceof PointWithErrorBar && typeof index === 'number') {
                this.updateElementScale(index, properties, mode);
            }
            super.updateElement(element, index, properties, mode);
        }
        updateElementScale(index, properties, mode) {
            calculateScale(properties, this.getParsed(index), index, this._cachedMeta.xScale, mode === 'reset');
            calculateScale(properties, this.getParsed(index), index, this._cachedMeta.yScale, mode === 'reset');
        }
        updateElements(points, start, count, mode) {
            const reset = mode === 'reset';
            const c = this.chart;
            const directUpdate = c._animationsDisabled || reset || mode === 'none';
            super.updateElements(points, start, count, mode);
            if (!directUpdate) {
                return;
            }
            for (let i = start; i < start + count; ++i) {
                const point = points[i];
                if (point instanceof PointWithErrorBar) {
                    this.updateElementScale(i, point, mode);
                }
            }
        }
    }
    ScatterWithErrorBarsController.id = 'scatterWithErrorBars';
    ScatterWithErrorBarsController.defaults = helpers.merge({}, [
        chart_js.ScatterController.defaults,
        animationHints,
        {
            dataElementType: PointWithErrorBar.id,
        },
    ]);
    ScatterWithErrorBarsController.overrides = helpers.merge({}, [
        chart_js.ScatterController.overrides,
        {
            plugins: {
                tooltip: {
                    callbacks: {
                        label: generateTooltipScatter,
                    },
                },
            },
        },
    ]);
    ScatterWithErrorBarsController.defaultRoutes = chart_js.LineController.defaultRoutes;
    class ScatterWithErrorBarsChart extends chart_js.Chart {
        constructor(item, config) {
            super(item, patchController('scatterWithErrorBars', config, ScatterWithErrorBarsController, PointWithErrorBar, [chart_js.LinearScale]));
        }
    }
    ScatterWithErrorBarsChart.id = ScatterWithErrorBarsController.id;

    class PolarAreaWithErrorBarsController extends chart_js.PolarAreaController {
        getMinMaxImpl(scale) {
            const t = this._cachedMeta;
            const e = {
                min: Number.POSITIVE_INFINITY,
                max: Number.NEGATIVE_INFINITY,
            };
            t.data.forEach((_, i) => {
                const s = this.getParsed(i)[scale.axis];
                if (Number.isNaN(s) || !this.chart.getDataVisibility(i)) {
                    return;
                }
                if (s < e.min) {
                    e.min = s;
                }
                if (s > e.max) {
                    e.max = s;
                }
            });
            return e;
        }
        getMinMax(scale) {
            return getMinMax(scale, (patchedScale) => this.getMinMaxImpl(patchedScale));
        }
        countVisibleElements() {
            const meta = this._cachedMeta;
            return meta.data.reduce((acc, _, index) => {
                if (!Number.isNaN(meta._parsed[index].r) && this.chart.getDataVisibility(index)) {
                    return acc + 1;
                }
                return acc;
            }, 0);
        }
        parsePrimitiveData(meta, data, start, count) {
            const parsed = super.parsePrimitiveData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseObjectData(meta, data, start, count) {
            const parsed = super.parseObjectData(meta, data, start, count);
            this.parseErrorData(parsed, meta, data, start, count);
            return parsed;
        }
        parseErrorData(parsed, meta, data, start, count) {
            const scale = meta.rScale;
            for (let i = 0; i < count; i += 1) {
                const index = i + start;
                const item = data[index];
                const v = scale.parse(item[scale.axis], index);
                parsed[i] = {
                    [scale.axis]: v,
                };
            }
            parseErrorNumberData(parsed, scale, data, start, count);
        }
        updateElement(element, index, properties, mode) {
            if (typeof index === 'number') {
                calculatePolarScale(properties, this.getParsed(index), this._cachedMeta.rScale, mode === 'reset', this.chart.options);
            }
            super.updateElement(element, index, properties, mode);
        }
        updateElements(arcs, start, count, mode) {
            const scale = this.chart.scales.r;
            const bak = scale.getDistanceFromCenterForValue;
            scale.getDistanceFromCenterForValue = function getDistanceFromCenterForValue(v) {
                if (typeof v === 'number') {
                    return bak.call(this, v);
                }
                return bak.call(this, v.r);
            };
            super.updateElements(arcs, start, count, mode);
            scale.getDistanceFromCenterForValue = bak;
        }
    }
    PolarAreaWithErrorBarsController.id = 'polarAreaWithErrorBars';
    PolarAreaWithErrorBarsController.defaults = helpers.merge({}, [
        chart_js.PolarAreaController.defaults,
        animationHints,
        {
            dataElementType: ArcWithErrorBar.id,
        },
    ]);
    PolarAreaWithErrorBarsController.overrides = helpers.merge({}, [
        chart_js.PolarAreaController.overrides,
        {
            plugins: {
                tooltip: {
                    callbacks: {
                        label: generateTooltipPolar,
                    },
                },
            },
        },
    ]);
    PolarAreaWithErrorBarsController.defaultRoutes = chart_js.PolarAreaController.defaultRoutes;
    class PolarAreaWithErrorBarsChart extends chart_js.Chart {
        constructor(item, config) {
            super(item, patchController('polarAreaWithErrorBars', config, PolarAreaWithErrorBarsController, ArcWithErrorBar, [
                chart_js.RadialLinearScale,
            ]));
        }
    }
    PolarAreaWithErrorBarsChart.id = PolarAreaWithErrorBarsController.id;

    chart_js.registry.addControllers(BarWithErrorBarsController, LineWithErrorBarsController, PolarAreaWithErrorBarsController, ScatterWithErrorBarsController);
    chart_js.registry.addElements(BarWithErrorBar, ArcWithErrorBar, PointWithErrorBar);

    exports.ArcWithErrorBar = ArcWithErrorBar;
    exports.BarWithErrorBar = BarWithErrorBar;
    exports.BarWithErrorBarsChart = BarWithErrorBarsChart;
    exports.BarWithErrorBarsController = BarWithErrorBarsController;
    exports.LineWithErrorBarsChart = LineWithErrorBarsChart;
    exports.LineWithErrorBarsController = LineWithErrorBarsController;
    exports.PointWithErrorBar = PointWithErrorBar;
    exports.PolarAreaWithErrorBarsChart = PolarAreaWithErrorBarsChart;
    exports.PolarAreaWithErrorBarsController = PolarAreaWithErrorBarsController;
    exports.ScatterWithErrorBarsChart = ScatterWithErrorBarsChart;
    exports.ScatterWithErrorBarsController = ScatterWithErrorBarsController;

}));
//# sourceMappingURL=index.umd.js.map
