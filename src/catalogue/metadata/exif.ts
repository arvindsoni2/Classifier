/**
 * `exif`: camera and capture fields from an image's EXIF block (plan Task 4).
 *
 * The rule that shapes this file is that GPS coordinates are never stored. The
 * catalogue keeps `hasGps`, a boolean, because "this photo knows where it was
 * taken" is a fact a later phase may need to explain a file — but the location
 * itself is not the organiser's business and does not belong in a database on
 * the user's disk. Fields are therefore copied one by one from a named list;
 * nothing from the parsed object is spread wholesale.
 */
import exifr from 'exifr';
import type { Extractor } from './types.js';
import { readFileBounded, MAX_EXTRACTOR_INPUT_BYTES } from './readfile.js';

/** The only EXIF fields copied into the catalogue. */
const KEPT_FIELDS = ['Make', 'Model', 'DateTimeOriginal'] as const;

interface ExifResult {
  Make?: unknown;
  Model?: unknown;
  DateTimeOriginal?: unknown;
  /** EXIF PixelXDimension / PixelYDimension. */
  ExifImageWidth?: unknown;
  ExifImageHeight?: unknown;
  /** Some writers use the shorter spelling. */
  ImageWidth?: unknown;
  ImageHeight?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  GPSLatitude?: unknown;
  GPSLongitude?: unknown;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export const exifExtractor: Extractor = {
  name: 'exif',
  version: 'exif@1.0.0',

  appliesTo(kind) {
    return kind === 'image';
  },

  async available() {
    // The module is imported above, so reaching here means it loaded.
    return true;
  },

  async extract(absPath, signal) {
    const bytes = await readFileBounded(absPath, MAX_EXTRACTOR_INPUT_BYTES, signal);
    const parsed = (await exifr.parse(bytes, {
      tiff: true,
      exif: true,
      gps: true,
      // Revision info and thumbnails are large and unused.
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      mergeOutput: true,
    })) as ExifResult | undefined;

    // An image with no EXIF at all is a normal thing to own, not a failure.
    if (parsed === undefined || parsed === null) return {};

    const fields: Record<string, unknown> = {};
    for (const field of KEPT_FIELDS) {
      const value = stringOrUndefined(parsed[field]);
      if (value !== undefined) fields[field] = value;
    }
    const width = numberOrUndefined(parsed.ExifImageWidth ?? parsed.ImageWidth);
    const height = numberOrUndefined(parsed.ExifImageHeight ?? parsed.ImageHeight);
    if (width !== undefined) fields.width = width;
    if (height !== undefined) fields.height = height;

    // Presence only: the coordinates themselves are deliberately not read out.
    fields.hasGps =
      parsed.latitude !== undefined ||
      parsed.longitude !== undefined ||
      parsed.GPSLatitude !== undefined ||
      parsed.GPSLongitude !== undefined;
    return fields;
  },
};