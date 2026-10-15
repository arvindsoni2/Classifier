/**
 * Phase 1 Task 8 item 6: safe spawns.
 *
 * Just before spawning ffprobe or pdfinfo the extractor lstats the path and
 * refuses anything that is not a regular file, recording `failed` with a
 * `NOT_A_REGULAR_FILE` error — without spawning the tool at all. A FIFO swapped
 * in after the scan would otherwise block the whole extraction pass.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTool } from '../../src/catalogue/metadata/proc.js';
import { pdfinfoExtractor } from '../../src/catalogue/metadata/pdfinfo.js';
import { ffprobeExtractor } from '../../src/catalogue/metadata/ffprobe.js';
import { NOT_A_REGULAR_FILE } from '../../src/catalogue/open.js';
import { makeFixture, type Fixture } from './fixtures.js';
import { makePdfWithInfo } from '../fixtures/documents.js';
import { makeWav } from '../fixtures/media.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fifoPath(fixture: Fixture, name: string): string {
  const path = join(fixture.root, name);
  execFileSync('mkfifo', [path]);
  cleanups.push(() => execFileSync('rm', ['-f', path]));
  return path;
}

describe('safe spawns (Task 8 item 6)', () => {
  it('pdfinfo refuses a FIFO without spawning', async () => {
    const available = await runTool('pdfinfo', ['-v'], { timeoutMs: 5000 }).catch(() => null);
    if (available === null || available.spawnFailed) {
      // Cannot meaningfully test without pdfinfo; the lstat guard is what
      // matters and is covered below by the throw.
    }
    const fixture = makeFixture('spawn-pdfinfo');
    const pipe = fifoPath(fixture, 'pipe.pdf');

    // The extractor must throw before spawning: no writer ever comes, so a
    // plain open would block forever. The test itself is under a timeout.
    let thrown: Error | undefined;
    try {
      await pdfinfoExtractor.extract(pipe, new AbortController().signal);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error & { code?: string }).code).toBe(NOT_A_REGULAR_FILE);
    expect((thrown as Error).message).toContain(NOT_A_REGULAR_FILE);
  });

  it('ffprobe refuses a FIFO without spawning', async () => {
    const fixture = makeFixture('spawn-ffprobe');
    const pipe = fifoPath(fixture, 'pipe.wav');

    let thrown: Error | undefined;
    try {
      await ffprobeExtractor.extract(pipe, new AbortController().signal);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error & { code?: string }).code).toBe(NOT_A_REGULAR_FILE);
  });

  it('a real file still reaches the tool', async (context) => {
    const available = await runTool('pdfinfo', ['-v'], { timeoutMs: 5000 }).catch(() => null);
    if (available === null || available.spawnFailed) {
      context.skip('pdfinfo is not installed');
      return;
    }
    const fixture = makeFixture('spawn-real');
    fixture.put('report.pdf', makePdfWithInfo({ Title: 'Real' }, 1));
    const fields = await pdfinfoExtractor.extract(join(fixture.root, 'report.pdf'), new AbortController().signal);
    expect(fields.title).toBe('Real');
  });

  it('ffprobe still reaches the tool for a real audio file', async (context) => {
    const available = await runTool('ffprobe', ['-version'], { timeoutMs: 5000 }).catch(() => null);
    if (available === null || available.spawnFailed) {
      context.skip('ffprobe is not installed');
      return;
    }
    const fixture = makeFixture('spawn-real-audio');
    fixture.put('tone.wav', makeWav({ seconds: 1 }));
    const fields = await ffprobeExtractor.extract(join(fixture.root, 'tone.wav'), new AbortController().signal);
    expect(fields.codec).toBe('pcm_s16le');
  });
});
