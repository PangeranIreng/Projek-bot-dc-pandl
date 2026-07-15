// Obfuscator/protector name detection. Every name below is only reported
// when a concrete signature/marker actually matched in the analyzed text --
// generated code from these tools tends to leave behind characteristic
// comments, banner strings, or wrapper/function names. If nothing matches
// but the content still looks structurally obfuscated (or has a lot of
// encoded content) we say "Unknown Obfuscator" rather than guessing a name;
// if there's no sign of obfuscation at all we say so honestly.

const KNOWN_SIGNATURES = [
  { name: "MoonSec", pattern: /moonsec/i },
  { name: "IronBrew2", pattern: /iron\s*brew\s*2|ironbrew2/i },
  { name: "IronBrew", pattern: /iron\s*brew/i },
  { name: "Luraph", pattern: /luraph/i },
  { name: "PSU", pattern: /\bpsu\b.{0,20}(obfuscat|protect)/i },
  { name: "Prometheus", pattern: /\bprometheus\b/i },
  { name: "Hydrogen", pattern: /\bhydrogen\b.{0,20}(obfuscat|loader|protect)/i },
  { name: "AztupBrew", pattern: /aztup\s*brew|aztupbrew/i },
  { name: "Aztup", pattern: /\baztup\b/i },
  { name: "Sigma", pattern: /\bsigma\b.{0,20}(obfuscat|spy|protect)/i },
  { name: "Hercules", pattern: /hercules/i },
  { name: "LuaU", pattern: /\bluau\b/i },
  { name: "LuaVM", pattern: /\bluavm\b/i },
  { name: "Custom VM", pattern: /custom\s*vm\b/i },
  { name: "LuaObfuscator", pattern: /luaobfuscator(\.com)?|lua\s*obfuscator\b/i },
  { name: "Xen", pattern: /\bxen\s*(obfuscator|protect)\b|xenobfuscator/i },
  { name: "Hydra", pattern: /\bhydra\b.{0,20}(obfuscat|loader|protect|executor)/i },
  { name: "Xenon", pattern: /\bxenon\b.{0,20}(executor|obfuscat|protect)/i },
  { name: "Synapse", pattern: /\bsynapse\s*x?\b.{0,20}(executor|obfuscat)|getsynasset|syn\.protect_gui/i },
  { name: "Script-Ware", pattern: /script[\s_-]?ware/i },
  { name: "Solara", pattern: /\bsolara\b.{0,20}(executor|hub|obfuscat)/i },
  { name: "Luarmor", pattern: /luarmor(\.com)?/i },
];

// Structural signals that something is obfuscated even without a known
// signature: obfuscators commonly (a) wrap the whole program body inside
// deeply nested self-invoking functions, (b) generate huge single-line
// files, and (c) rename every local to a meaningless numeric identifier.
function looksStructurallyObfuscated(text) {
  if (!text) return false;
  const longestLine = Math.max(0, ...text.split("\n").map((l) => l.length));
  const numericLocals = (text.match(/\blocal\s+[A-Za-z_][\w]{0,2}\d{2,}\b/g) || []).length;
  const selfInvokedWrappers = (text.match(/\(function\s*\([^)]*\)/g) || []).length;
  return longestLine > 2000 || numericLocals > 15 || selfInvokedWrappers > 8;
}

/**
 * Identify which protection/obfuscator (if any) produced this content.
 *
 * `matched` means "there is real evidence of an obfuscation/protection
 * layer" (used by the Risk Score's obfuscation signal) -- `recognized`
 * means "we can actually name which tool it is". A file can be `matched:
 * true, recognized: false` (structurally suspicious but unidentifiable);
 * per spec, that case reports its name as literally "UNKNOWN" rather than
 * inventing a descriptive label.
 * @param {string} text decoded text of the file (best-effort)
 * @returns {{name:string, matched:boolean, recognized:boolean}}
 */
export function detectProtection(text) {
  if (!text) {
    return { name: "Tidak terdeteksi", matched: false, recognized: false };
  }
  for (const sig of KNOWN_SIGNATURES) {
    if (sig.pattern.test(text)) {
      return { name: sig.name, matched: true, recognized: true };
    }
  }
  if (looksStructurallyObfuscated(text)) {
    return { name: "UNKNOWN", matched: true, recognized: false };
  }
  // Heavy encoded content without a matching known-obfuscator signature is
  // still evidence of *some* protection, just not one we can name.
  const encodedDensity =
    (text.match(/(?:[A-Za-z0-9+/]{60,}={0,2})|(?:\\x[0-9a-fA-F]{2}){8,}/g) || []).length;
  if (encodedDensity > 3) {
    return { name: "UNKNOWN", matched: true, recognized: false };
  }
  return { name: "Tidak terdeteksi", matched: false, recognized: false };
}

export const KNOWN_OBFUSCATOR_NAMES = KNOWN_SIGNATURES.map((s) => s.name);
