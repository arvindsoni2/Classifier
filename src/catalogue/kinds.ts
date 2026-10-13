/**
 * Deterministic kind detection (plan Task 1).
 *
 * Two signals, no model: the file extension and the first bytes of the file.
 * The magic check exists for files with no extension, or with a misleading
 * one. Nothing here reads more than 16 bytes and nothing is executed.
 */

export type Kind =
  | 'document'
  | 'ebook'
  | 'audio'
  | 'video'
  | 'image'
  | 'archive'
  | 'installer'
  | 'code'
  | 'data'
  | 'other';

/** Number of leading bytes the magic check reads. */
export const MAGIC_PREFIX_BYTES = 16;

const BY_EXTENSION: Readonly<Record<string, Kind>> = {
  // Documents
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  txt: 'document',
  md: 'document',
  markdown: 'document',
  pages: 'document',
  tex: 'document',
  // Ebooks
  epub: 'ebook',
  mobi: 'ebook',
  azw: 'ebook',
  azw3: 'ebook',
  fb2: 'ebook',
  djvu: 'ebook',
  cbz: 'ebook',
  cbr: 'ebook',
  // Audio
  mp3: 'audio',
  flac: 'audio',
  wav: 'audio',
  wave: 'audio',
  m4a: 'audio',
  m4b: 'audio',
  aac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  wma: 'audio',
  aiff: 'audio',
  aif: 'audio',
  // Video
  mp4: 'video',
  m4v: 'video',
  mkv: 'video',
  avi: 'video',
  mov: 'video',
  wmv: 'video',
  flv: 'video',
  webm: 'video',
  mpg: 'video',
  mpeg: 'video',
  mts: 'video',
  m2ts: 'video',
  '3gp': 'video',
  // Images
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  heif: 'image',
  avif: 'image',
  svg: 'image',
  ico: 'image',
  raw: 'image',
  cr2: 'image',
  nef: 'image',
  arw: 'image',
  dng: 'image',
  // Archives
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  zst: 'archive',
  iso: 'archive',
  lz4: 'archive',
  // Installers
  deb: 'installer',
  rpm: 'installer',
  exe: 'installer',
  msi: 'installer',
  appimage: 'installer',
  dmg: 'installer',
  pkg: 'installer',
  apk: 'installer',
  snap: 'installer',
  flatpak: 'installer',
  bin: 'installer',
  run: 'installer',
  // Code
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  swift: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  sass: 'code',
  less: 'code',
  sql: 'code',
  r: 'code',
  m: 'code',
  scala: 'code',
  ex: 'code',
  exs: 'code',
  erl: 'code',
  lua: 'code',
  pl: 'code',
  vue: 'code',
  svelte: 'code',
  ipynb: 'code',
  // Data
  csv: 'data',
  tsv: 'data',
  json: 'data',
  jsonl: 'data',
  ndjson: 'data',
  xml: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  ini: 'data',
  cfg: 'data',
  conf: 'data',
  log: 'data',
  parquet: 'data',
  db: 'data',
  sqlite: 'data',
  sqlite3: 'data',
  npy: 'data',
  npz: 'data',
  pkl: 'data',
};

/**
 * Extensions whose file is itself a ZIP container. For these, a `PK\x03\x04`
 * magic agrees with the extension instead of contradicting it, so the more
 * specific extension-derived kind is kept (an .epub is an ebook, not an
 * archive). Every other extension/magic disagreement resolves to the magic.
 */
const ZIP_BASED_EXTENSIONS: ReadonlySet<string> = new Set([
  'epub',
  'docx',
  'odt',
  'xlsx',
  'pptx',
  'ods',
  'cbz',
  'jar',
  'apk',
  'ipa',
  'whl',
]);

/** Lower-case extension without the dot; empty string when there is none. */
export function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function kindFromExtension(name: string): Kind {
  return BY_EXTENSION[extensionOf(name)] ?? 'other';
}

function startsWith(head: Buffer, bytes: readonly number[]): boolean {
  if (head.length < bytes.length) return false;
  return bytes.every((byte, index) => head[index] === byte);
}

const PDF = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const ID3 = [0x49, 0x44, 0x33]; // ID3
const FLAC = [0x66, 0x4c, 0x61, 0x43]; // fLaC
const OGG = [0x4f, 0x67, 0x67, 0x53]; // OggS
const MATROSKA = [0x1a, 0x45, 0xdf, 0xa3];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06]; // PK\x05\x06 end-of-central-directory
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08];

/**
 * Kind implied by the leading bytes, or null when the bytes say nothing.
 * Reads only `MAGIC_PREFIX_BYTES`; callers pass what they already read.
 */
export function kindFromMagic(head: Buffer): Kind | null {
  if (startsWith(head, PDF)) return 'document';
  if (startsWith(head, PNG)) return 'image';
  if (startsWith(head, JPEG)) return 'image';
  if (startsWith(head, ZIP) || startsWith(head, ZIP_EMPTY) || startsWith(head, ZIP_SPANNED)) return 'archive';
  if (startsWith(head, ID3)) return 'audio';
  if (startsWith(head, FLAC)) return 'audio';
  if (startsWith(head, OGG)) return 'audio';
  if (startsWith(head, MATROSKA)) return 'video';
  // `ftyp` at offset 4: MP4/HEIF/AVIF and friends.
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'video';
  // `RIFF....WAVE`
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && head.length >= 12) {
    if (head.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio';
  }
  return null;
}

/**
 * The catalogue's kind for one file. Magic wins when it contradicts the
 * extension, because a misleading extension is exactly what this catches.
 */
export function detectKind(name: string, head?: Buffer | null): Kind {
  const fromExtension = kindFromExtension(name);
  if (head === undefined || head === null || head.length === 0) return fromExtension;
  const fromMagic = kindFromMagic(head);
  if (fromMagic === null) return fromExtension;
  if (fromMagic === 'archive' && fromExtension !== 'other' && ZIP_BASED_EXTENSIONS.has(extensionOf(name))) {
    return fromExtension;
  }
  return fromMagic;
}