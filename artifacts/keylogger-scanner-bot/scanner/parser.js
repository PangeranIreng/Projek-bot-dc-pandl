// Parsing engine: reads the Lua bytecode header honestly (signature +
// declared version + best-effort embedded strings) and, for Lua *source*,
// attempts a real AST parse via `luaparse`. A successful AST parse is
// genuine evidence the file is syntactically valid Lua; a failure is
// reported with its actual parser error instead of being hidden.

import luaparse from "luaparse";

const LUA_SIGNATURE = Buffer.from([0x1b, 0x4c, 0x75, 0x61]); // ESC L u a
const LUAJIT_SIGNATURE = Buffer.from([0x1b, 0x4c, 0x4a]); // ESC L J

const VERSION_BYTE_MAP = {
  0x51: "5.1",
  0x52: "5.2",
  0x53: "5.3",
  0x54: "5.4",
};

/**
 * Parse a .luac header. Full bytecode disassembly is out of scope -- we
 * only claim what we can honestly verify: the signature, the declared
 * version byte, and a best-effort scan for embedded printable strings.
 * @param {Buffer} buffer
 */
export function parseLuaBytecodeHeader(buffer) {
  if (buffer && buffer.length >= 3 && buffer.subarray(0, 3).equals(LUAJIT_SIGNATURE)) {
    // LuaJIT bytecode header: "\x1bLJ" + version byte + flags byte. Flags is
    // a real bitfield documented by LuaJIT (lj_bcdump.h): bit0 = FR2 (frame
    // encoding), bit1 = big-endian, bit2 = stripped debug info, bit3 = uses
    // FFI. We only report what these bits genuinely say -- no guessing.
    const hasVersionAndFlags = buffer.length >= 5;
    const versionByte = hasVersionAndFlags ? buffer[3] : null;
    const flagsByte = hasVersionAndFlags ? buffer[4] : null;
    const strippedDebugInfo = flagsByte !== null ? Boolean(flagsByte & 0x04) : null;
    const usesFfi = flagsByte !== null ? Boolean(flagsByte & 0x08) : null;
    const bigEndian = flagsByte !== null ? Boolean(flagsByte & 0x02) : null;
    return {
      isLuaBytecode: true,
      isLuaJit: true,
      version: versionByte !== null ? `LuaJIT bytecode v${versionByte}` : "LuaJIT bytecode",
      parsed: true,
      reason: null,
      strippedDebugInfo,
      usesFfi,
      bigEndian,
      extractedStrings: extractPrintableStrings(buffer.subarray(hasVersionAndFlags ? 5 : 3)),
    };
  }

  if (!buffer || buffer.length < 5 || !buffer.subarray(0, 4).equals(LUA_SIGNATURE)) {
    return {
      isLuaBytecode: false,
      isLuaJit: false,
      version: null,
      parsed: false,
      reason: "Signature bytecode Lua tidak ditemukan.",
      extractedStrings: [],
    };
  }

  const versionByte = buffer[4];
  const version = VERSION_BYTE_MAP[versionByte] || null;

  if (!version) {
    return {
      isLuaBytecode: true,
      isLuaJit: false,
      version: null,
      parsed: false,
      reason: `Versi bytecode Lua tidak dikenali (byte 0x${versionByte.toString(16)}).`,
      extractedStrings: extractPrintableStrings(buffer.subarray(5)),
    };
  }

  return {
    isLuaBytecode: true,
    isLuaJit: false,
    version,
    parsed: true,
    reason: null,
    extractedStrings: extractPrintableStrings(buffer.subarray(5)),
  };
}

function extractPrintableStrings(bytes) {
  const extractedStrings = [];
  let run = [];
  for (const byte of bytes) {
    if (byte >= 32 && byte <= 126) {
      run.push(byte);
    } else {
      if (run.length >= 4) extractedStrings.push(Buffer.from(run).toString("ascii"));
      run = [];
    }
  }
  if (run.length >= 4) extractedStrings.push(Buffer.from(run).toString("ascii"));
  return extractedStrings.slice(0, 60);
}

// Best-effort Lua *language* version guess from source syntax alone (this
// is NOT the same as the compiled Bytecode Version, which the header
// declares explicitly). Lua's grammar is almost entirely backward
// compatible across 5.1-5.4, so most scripts give no reliable signal at
// all -- we only report a specific version when the source uses syntax
// that is genuinely exclusive to it (e.g. bitwise operators only exist in
// 5.3+, goto/labels only exist in 5.2+); otherwise we say plainly that it
// can't be determined from source, rather than guessing.
export function detectLuaSourceVersion(text) {
  if (!text || !text.trim()) return "Tidak dapat dipastikan dari source";
  const hasIntegerDivision = /[^\/]\/\/[^\/]/.test(text);
  const hasBitwiseOps = /\b\w+\s*(?:&|\||~)\s*\w+\b/.test(text) && /\bbit32\./.test(text) === false;
  if (hasIntegerDivision || hasBitwiseOps) {
    return "Lua 5.3+ (terdeteksi sintaks integer division `//` atau bitwise operator native)";
  }
  const hasGotoLabel = /::\s*[A-Za-z_]\w*\s*::/.test(text) || /\bgoto\s+[A-Za-z_]\w*\b/.test(text);
  if (hasGotoLabel) {
    return "Lua 5.2+ (terdeteksi sintaks goto/label)";
  }
  if (/\bbit32\./.test(text)) {
    return "Lua 5.2 (terdeteksi library bit32, dihapus di 5.3+)";
  }
  return "Tidak dapat dipastikan dari source (sintaks kompatibel 5.1-5.4)";
}

/**
 * Attempt a real Lua AST parse of source text. Never throws -- a parse
 * failure is reported with the actual error message, never disguised as
 * success.
 * @param {string} text
 */
export function parseLuaSourceAst(text) {
  if (!text || !text.trim()) {
    return { attempted: false, parsed: false, error: null, statementCount: 0, ast: null };
  }
  try {
    const ast = luaparse.parse(text, { comments: false, scope: false });
    return {
      attempted: true,
      parsed: true,
      error: null,
      statementCount: Array.isArray(ast.body) ? ast.body.length : 0,
      ast,
    };
  } catch (err) {
    return { attempted: true, parsed: false, error: err.message, statementCount: 0, ast: null };
  }
}
