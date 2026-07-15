// Detection engine: identifies the container format (extension + magic
// bytes), the specific Lua variant, and -- when recognizable -- which
// obfuscator/protection wrapped the code. Every label here is only used when
// a concrete signature/pattern actually matched; unrecognized cases are
// reported as "Tidak terdeteksi" rather than guessed.

import { getExtension, calculateEntropy } from "../utils/fileUtils.js";
import { detectProtection as detectProtectionByName } from "../detectors/obfuscatorDetector.js";
import { detectEncryption as detectEncryptionType } from "../detectors/encryptionDetector.js";

export { detectEncryptionType };

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const LUA_SIGNATURE = Buffer.from([0x1b, 0x4c, 0x75, 0x61]); // ESC L u a
const LUAJIT_SIGNATURE = Buffer.from([0x1b, 0x4c, 0x4a]); // ESC L J
const RAR_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]); // "Rar!\x1a\x07" (RAR4 + RAR5)
const SEVEN_ZIP_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]); // "7z\xBC\xAF\x27\x1C"
const MZ_SIGNATURE = Buffer.from([0x4d, 0x5a]); // "MZ" -- Windows PE (EXE/DLL share this magic)

const LABELS = {
  ".lua": "Lua source",
  ".luac": "Lua bytecode",
  ".js": "JavaScript source",
  ".py": "Python source",
  ".txt": "Plain text",
  ".json": "JSON",
  ".zip": "ZIP archive",
  ".rar": "RAR archive",
  ".7z": "7-Zip archive",
  ".exe": "Windows executable (EXE)",
  ".dll": "Windows library (DLL)",
};

/**
 * Detect a file's container type from its extension and (when useful) magic
 * bytes.
 * @param {string} filename
 * @param {Buffer} buffer
 */
export function detectFileType(filename, buffer) {
  const extension = getExtension(filename);
  const isZipByMagic =
    buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(ZIP_SIGNATURE) ||
      buffer.subarray(0, 4).equals(ZIP_EMPTY_SIGNATURE));
  const isLuaByMagic =
    buffer.length >= 4 && buffer.subarray(0, 4).equals(LUA_SIGNATURE);
  const isLuaJitByMagic =
    buffer.length >= 3 && buffer.subarray(0, 3).equals(LUAJIT_SIGNATURE);
  const isRarByMagic = buffer.length >= 6 && buffer.subarray(0, 6).equals(RAR_SIGNATURE);
  const isSevenZipByMagic =
    buffer.length >= 6 && buffer.subarray(0, 6).equals(SEVEN_ZIP_SIGNATURE);
  const isMzByMagic = buffer.length >= 2 && buffer.subarray(0, 2).equals(MZ_SIGNATURE);

  const supported = Object.keys(LABELS).includes(extension);

  return {
    extension,
    label: LABELS[extension] || "Tidak dikenali",
    supported,
    isZip: extension === ".zip" || isZipByMagic,
    isLuac: extension === ".luac" || isLuaByMagic || isLuaJitByMagic,
    isLuaJit: isLuaJitByMagic,
    // RAR/7z/EXE/DLL are recognized by container/executable signature but
    // are not decompiled/disassembled here (no such library is available)
    // -- they still get entropy + raw-string indicator scanning, reported
    // honestly as a limited-analysis container rather than fabricating a
    // full extraction.
    isRar: extension === ".rar" || isRarByMagic,
    isSevenZip: extension === ".7z" || isSevenZipByMagic,
    isExe: extension === ".exe" || (isMzByMagic && extension !== ".dll"),
    isDll: extension === ".dll",
    isLimitedContainer:
      extension === ".rar" ||
      extension === ".7z" ||
      extension === ".exe" ||
      extension === ".dll" ||
      isRarByMagic ||
      isSevenZipByMagic ||
      isMzByMagic,
    // A mismatch between extension and magic bytes is itself a mild signal
    // (e.g. a renamed executable pretending to be a .txt file).
    extensionMismatch:
      (extension === ".zip" && !isZipByMagic) ||
      (extension !== ".zip" && isZipByMagic) ||
      (extension === ".luac" && !isLuaByMagic && !isLuaJitByMagic) ||
      (extension !== ".exe" && extension !== ".dll" && isMzByMagic),
  };
}

// Entropy thresholds (bits/byte, max 8). Near-random binary (real
// encryption or compression) sits close to 8; base64-heavy text sits
// around 6 because it only draws from a 64-symbol alphabet; plain source
// code is usually well under 5. These are signals, never proof on their
// own -- always reported alongside whatever else was found.
const HIGH_ENTROPY_THRESHOLD = 7.5;
const MODERATE_ENTROPY_THRESHOLD = 6.2;

/**
 * Analyze raw byte entropy as one signal towards "this looks encrypted or
 * packed", independent of any text-based pattern matching.
 * @param {Buffer} buffer
 */
export function detectEncryption(buffer) {
  const entropy = calculateEntropy(buffer);
  if (entropy >= HIGH_ENTROPY_THRESHOLD) {
    return {
      entropy,
      level: "high",
      note: `Entropy sangat tinggi (${entropy}/8 bit) -- pola byte mendekati acak, indikasi kuat data terenkripsi atau di-pack.`,
    };
  }
  if (entropy >= MODERATE_ENTROPY_THRESHOLD) {
    return {
      entropy,
      level: "moderate",
      note: `Entropy cukup tinggi (${entropy}/8 bit) -- bisa jadi berisi banyak data ter-encode (mis. base64) atau sebagian terenkripsi.`,
    };
  }
  return { entropy, level: "low", note: null };
}

/**
 * Identify which protection/obfuscator (if any) produced this content.
 * Delegates to detectors/obfuscatorDetector.js, which carries the full
 * signature list (MoonSec, IronBrew, IronBrew2, Luraph, PSU, Prometheus,
 * Hydrogen, Aztup, Sigma, Hercules, LuaVM, LuaU, Custom VM) plus the
 * structural/encoded-density fallbacks.
 * @param {string} text decoded text of the file (best-effort)
 */
export function detectProtection(text) {
  return detectProtectionByName(text);
}

/**
 * Classify which flavor of Lua this file most likely is, based on
 * everything gathered about it so far. Multiple labels can apply
 * conceptually, but we report the single most specific one that fits.
 */
export function classifyLuaVariant({
  extension,
  isLuaBytecode,
  isLuaJit,
  text,
  printable,
  protection,
  astParsed,
}) {
  if (isLuaJit) return "LuaJIT bytecode";
  if (isLuaBytecode) return "Lua bytecode";
  if (extension !== ".lua" && !text) return null;

  const isMoonLoader =
    !!text &&
    /require\s*\(\s*["']moonloader["']\s*\)|script_name\s*\(|sampGetPlayerNickname|sampfuncs/i.test(
      text,
    );
  if (isMoonLoader) return "MoonLoader script";

  if (protection?.matched) return `Obfuscated Lua (${protection.name})`;

  if (!printable || printable < 0.5) return "Packed Lua";

  const heavyEncoding =
    !!text && (text.match(/(?:[A-Za-z0-9+/]{60,}={0,2})/g) || []).length > 2;
  if (heavyEncoding) return "Encoded Lua";

  if (text) {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const avgLineLength = text.length / Math.max(1, lines.length);
    if (avgLineLength > 300 && lines.length < 5) return "Minified Lua";
  }

  if (astParsed) return "Lua source";
  return text ? "Lua source (tidak dapat diverifikasi penuh)" : null;
}
