// Encryption/packing type detection. Combines named-cipher markers (AES,
// RC4, XOR) found in text with the byte-level entropy signal to decide
// whether -- and how -- a file appears encrypted. Never claims a specific
// cipher without a textual marker; falls back to "Custom Encrypt" only when
// entropy is high but no named cipher was recognized, and to "Tidak
// terdeteksi" when there's no sign of encryption at all.

import { calculateEntropy } from "../utils/fileUtils.js";

const HIGH_ENTROPY_THRESHOLD = 7.5;
const MODERATE_ENTROPY_THRESHOLD = 6.2;

const NAMED_CIPHERS = [
  { name: "AES", pattern: /\bAES\b|aes\.(encrypt|decrypt)|aes(128|192|256)/i },
  { name: "RC4", pattern: /\bRC4\b|rc4\.(encrypt|decrypt)/i },
  { name: "XOR", pattern: /\bbxor\s*\(|\^\s*key\b|xor_?(key|decrypt|encrypt)/i },
];

/**
 * @param {string} text decoded text (best-effort)
 * @param {Buffer} buffer raw file bytes
 */
export function detectEncryption(text, buffer) {
  const entropy = calculateEntropy(buffer);

  for (const cipher of NAMED_CIPHERS) {
    if (text && cipher.pattern.test(text)) {
      return {
        type: cipher.name,
        matched: true,
        entropy,
        note: `Pola ${cipher.name} terdeteksi pada isi file.`,
      };
    }
  }

  if (entropy >= HIGH_ENTROPY_THRESHOLD) {
    return {
      type: "Custom Encrypt",
      matched: true,
      entropy,
      note: `Entropy sangat tinggi (${entropy}/8 bit) -- pola byte mendekati acak, indikasi kuat data dienkripsi atau di-pack dengan metode kustom.`,
    };
  }
  if (entropy >= MODERATE_ENTROPY_THRESHOLD) {
    return {
      type: "Kemungkinan Encoded",
      matched: false,
      entropy,
      note: `Entropy cukup tinggi (${entropy}/8 bit) -- bisa jadi berisi banyak data ter-encode (mis. base64) atau sebagian terenkripsi.`,
    };
  }

  return { type: "Tidak terdeteksi", matched: false, entropy, note: null };
}
