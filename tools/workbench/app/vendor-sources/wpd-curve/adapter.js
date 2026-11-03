// Falsify's bridge; the three WPD source files above remain unchanged.
globalThis.FalsifyWPDCurve = Object.freeze({
  step: wpd.AveragingWindowWithStepSizeAlgo,
  interpolate: wpd.XStepWithInterpolationAlgo,
  commit: '3a3ecb11606945d0701c8a488777e6861be70056'
});
