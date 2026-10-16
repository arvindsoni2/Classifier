/**
 * `office`: core document properties from an OOXML package (plan Task 4).
 *
 * Word, Excel and PowerPoint files all keep the same properties in the same
 * place — `docProps/core.xml` — so one extractor covers all three. Exactly one
 * entry is read, through the shared ZIP reader, so the inflate budget and the
 * ZIP64 refusal apply as they do everywhere else.
 */
import type { Extractor } from './types.js';
import { openRegularFile } from '../open.js';
import { elementText } from '../../shared/xml.js';
import { readZipEntryFromHandle, ZIP_INFLATE_BUDGET_BYTES } from '../../shared/zip.js';

const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx']);

/** Property elements, mapped to the catalogue's field names. */
const CORE_FIELDS: readonly (readonly [string, string])[] = [
  ['title', 'title'],
  ['creator', 'creator'],
  ['subject', 'subject'],
  ['keywords', 'keywords'],
  ['created', 'created'],
  ['modified', 'modified'],
];

export const officeExtractor: Extractor = {
  name: 'office',
  version: 'office@1.1.0',

  appliesTo(kind, ext) {
    return OFFICE_EXTENSIONS.has(ext);
  },

  async available() {
    return true;
  },

  async extract(absPath, signal) {
    const handle = await openRegularFile(absPath);
    try {
      const core = await readZipEntryFromHandle(handle, 'docProps/core.xml', ZIP_INFLATE_BUDGET_BYTES, signal);
      const fields: Record<string, unknown> = {};
      for (const [element, field] of CORE_FIELDS) {
        const value = elementText(core, element);
        if (value !== undefined && value !== '') fields[field] = value;
      }
      return fields;
    } finally {
      await handle.close();
    }
  },
};