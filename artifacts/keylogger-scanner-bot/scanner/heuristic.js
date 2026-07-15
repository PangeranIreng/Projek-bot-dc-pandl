// Backward-compatible re-export -- the real indicator categories now live
// in heuristic/indicators.js (modular layout: scanner/ heuristic/ embed/
// buttons/ detectors/ utils/ config/). Kept as a thin shim so existing
// relative imports inside scanner/ don't need to change.
export { scanIndicators, INDICATOR_CATEGORIES } from "../heuristic/indicators.js";
