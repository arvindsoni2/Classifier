/**
 * `epub`: the package document named by the container (plan Task 4).
 *
 * An EPUB is a ZIP, and its metadata is not at a fixed path — it is whatever
 * `META-INF/container.xml` points at. Two entries are read and no others: the
 * container, then the OPF it names. Both go through the shared ZIP reader, so
 * the 20 MiB inflate budget and the ZIP64 refusal apply exactly as they do for
 * the extraction adapter.
 */
import type { Extractor } from './types.js';
import { openRegularFile } from '../open.js';
import { elementAttribute, elementText } from '../../shared/xml.js';
import { readZipEntryFromHandle, ZIP_INFLATE_BUDGET_BYTES } from '../../shared/zip.js';

/** OPF metadata elements, mapped to the catalogue's field names. */
const OPF_FIELDS: readonly (readonly [string, string])[] = [
  ['title', 'title'],
  ['creator', 'creator'],
  ['subject', 'subject'],
  ['language', 'language'],
  ['publisher', 'publisher'],
  ['date', 'date'],
];

export const epubExtractor: Extractor = {
  name: 'epub',
  version: 'epub@1.1.0',

  appliesTo(kind, ext) {
    return kind === 'ebook' && ext === 'epub';
  },

  async available() {
    // The ZIP and XML readers are imported above, so reaching here means they load.
    return true;
  },

  async extract(absPath, signal) {
    const handle = await openRegularFile(absPath);
    try {
      const container = await readZipEntryFromHandle(handle, 'META-INF/container.xml', ZIP_INFLATE_BUDGET_BYTES, signal);
      const opfPath = elementAttribute(container, 'rootfile', 'full-path');
      if (opfPath === undefined || opfPath === '') {
        throw new Error('EPUB container names no package document');
      }

      const opf = await readZipEntryFromHandle(handle, opfPath, ZIP_INFLATE_BUDGET_BYTES, signal);
      const fields: Record<string, unknown> = {};
      for (const [element, field] of OPF_FIELDS) {
        const value = elementText(opf, element);
        if (value !== undefined && value !== '') fields[field] = value;
      }
      if (Object.keys(fields).length === 0) {
        throw new Error(`EPUB package document ${opfPath} carries no metadata elements`);
      }
      return fields;
    } finally {
      await handle.close();
    }
  },
};