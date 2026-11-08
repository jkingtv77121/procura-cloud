const MAX_TEXT_CHARS = 450000;
const utf8 = new TextDecoder("utf-8", { fatal: false });
const latin = new TextDecoder("latin1");

export function cleanExtractedText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

export async function extractDocumentText(filename, bytes) {
  const name = String(filename || "").toLowerCase();
  let text = "";
  if (/\.(txt|md|csv)$/.test(name)) {
    text = utf8.decode(bytes);
  } else if (name.endsWith(".pdf")) {
    text = await extractPdf(bytes);
  } else if (name.endsWith(".docx")) {
    text = await extractDocx(bytes);
  } else {
    throw new Error("Choose a PDF, DOCX, TXT, MD, or CSV file.");
  }
  text = cleanExtractedText(text);
  if (text.length < 20) {
    if (name.endsWith(".pdf")) throw new Error("This PDF has no selectable text. Run OCR on the scanned pages, save it, and upload it again.");
    throw new Error("No readable text was found in this file.");
  }
  return {
    text,
    word_count: text.split(/\s+/).filter(Boolean).length,
    truncated: text.length >= MAX_TEXT_CHARS,
    extraction_method: name.endsWith(".pdf") ? "native_pdf" : "native",
  };
}

function decodePdfLiteral(raw) {
  let value = raw
    .replace(/\\r\\n|\\n|\\r/g, "")
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c] || c);
  value = value.replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  if (value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff) {
    let decoded = "";
    for (let i = 2; i + 1 < value.length; i += 2) decoded += String.fromCharCode((value.charCodeAt(i) << 8) | value.charCodeAt(i + 1));
    return decoded;
  }
  return value;
}

function decodePdfHex(raw) {
  const clean = raw.replace(/\s/g, "");
  const padded = clean.length % 2 ? clean + "0" : clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let result = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) result += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return result;
  }
  return latin.decode(bytes);
}

function pdfTextFromOperators(source) {
  const output = [];
  const literal = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|TJ|['"])/g;
  const hex = /<([0-9a-fA-F\s]{4,})>\s*Tj/g;
  const arrays = /\[((?:\\.|[^\]])*)\]\s*TJ/g;
  for (const match of source.matchAll(literal)) output.push(decodePdfLiteral(match[1]));
  for (const match of source.matchAll(hex)) output.push(decodePdfHex(match[1]));
  for (const match of source.matchAll(arrays)) {
    const item = /<([0-9a-fA-F\s]{4,})>|\(((?:\\.|[^\\)])*)\)/g;
    for (const value of match[1].matchAll(item)) output.push(value[1] ? decodePdfHex(value[1]) : decodePdfLiteral(value[2]));
  }
  return output.join("\n");
}

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

async function extractPdf(bytes) {
  const source = latin.decode(bytes);
  let text = pdfTextFromOperators(source);
  const streamBytes = new TextEncoder().encode("stream");
  const endstreamBytes = new TextEncoder().encode("\nendstream");
  let cursor = 0;
  while (cursor < bytes.length) {
    const marker = findBytes(bytes, streamBytes, cursor);
    if (marker < 0) break;
    const lineBreak = bytes.indexOf(10, marker + streamBytes.length);
    const endMarker = lineBreak < 0 ? -1 : findBytes(bytes, endstreamBytes, lineBreak + 1);
    if (lineBreak < 0 || endMarker < 0) break;
    const before = latin.decode(bytes.subarray(Math.max(0, marker - 600), marker));
    let compressed = bytes.subarray(lineBreak + 1, endMarker);
    if (compressed.at(-1) === 13) compressed = compressed.subarray(0, compressed.length - 1);
    cursor = endMarker + 10;
    if (!/\/FlateDecode\b/.test(before)) continue;
    try {
      const inflated = await inflate(compressed, "deflate");
      text += " " + pdfTextFromOperators(latin.decode(inflated));
    } catch {
      try {
        const inflated = await inflate(compressed, "deflate-raw");
        text += " " + pdfTextFromOperators(latin.decode(inflated));
      } catch {
        // Other PDF filters and malformed streams are skipped; empty scans fail clearly below.
      }
    }
    if (text.length >= MAX_TEXT_CHARS) break;
  }
  return text;
}

function findEndOfCentralDirectory(bytes) {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return -1;
}

function xmlToText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)));
}

async function extractDocx(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error("This DOCX file is damaged or is not a valid Word document.");
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const pieces = [];
  const xmlTargets = /^(word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml)$/i;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const filenameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const path = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + filenameLength));
    cursor += 46 + filenameLength + extraLength + commentLength;
    if (!xmlTargets.test(path) || uncompressedSize > 5_000_000 || localOffset + 30 > bytes.length) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + compressedSize);
    if (compressed.length !== compressedSize) throw new Error("This DOCX file is incomplete.");
    let xmlBytes;
    if (method === 0) xmlBytes = compressed;
    else if (method === 8) xmlBytes = await inflate(compressed, "deflate-raw");
    else continue;
    if (xmlBytes.length > 5_000_000) throw new Error("This DOCX contains an unusually large document part.");
    pieces.push(xmlToText(utf8.decode(xmlBytes)));
  }
  if (!pieces.length) throw new Error("No readable Word document text was found.");
  return pieces.join("\n");
}
