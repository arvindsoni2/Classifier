/**
 * `ffprobe`: container, codec, geometry and the standard media tags
 * (plan Task 4).
 *
 * The tool is invoked with an argument array, never through a shell, under the
 * deadline and output cap in `proc.ts`. Only named fields are copied into the
 * result: ffprobe can emit a great deal per stream, and the catalogue stores
 * what a later phase needs to explain a file, not everything the tool knows.
 */
import type { Extractor } from './types.js';
import { runTool } from './proc.js';
import { NOT_A_REGULAR_FILE } from '../open.js';
import { lstat } from 'node:fs/promises';

const VERSION = 'ffprobe@1.0.0';
const TOOL = 'ffprobe';
const TOOL_TIMEOUT_MS = 10_000;

/** The tags worth keeping, in ffprobe's own naming. */
const KEPT_TAGS = [
  'title',
  'artist',
  'album',
  'album_artist',
  'track',
  'disc',
  'date',
  'genre',
] as const;

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  tags?: Record<string, string>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    tags?: Record<string, string>;
  };
}

/** Present, absent or unparseable, each handled without throwing at the caller. */
function parseJson(text: string): FfprobeOutput | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as FfprobeOutput) : null;
  } catch {
    return null;
  }
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function keptTags(tags: Record<string, string> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const tag of KEPT_TAGS) {
    const value = tags?.[tag];
    if (typeof value === 'string' && value !== '') kept[tag] = value;
  }
  return kept;
}

export const ffprobeExtractor: Extractor = {
  name: 'ffprobe',
  version: VERSION,

  appliesTo(kind) {
    return kind === 'audio' || kind === 'video';
  },

  async available() {
    const probe = await runTool(TOOL, ['-version'], { timeoutMs: TOOL_TIMEOUT_MS });
    return !probe.spawnFailed && probe.code === 0;
  },

  async extract(absPath, signal) {
    // Never spawn a tool for something that is not a regular file.
    const stat = await lstat(absPath).catch(() => null);
    if (stat !== null && !stat.isFile()) {
      const error = new Error(`${NOT_A_REGULAR_FILE}: ${absPath} is not a regular file`) as Error & { code?: string };
      error.code = NOT_A_REGULAR_FILE;
      throw error;
    }

    const run = await runTool(
      TOOL,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
      { timeoutMs: TOOL_TIMEOUT_MS, signal },
    );
    if (run.spawnFailed) throw new Error('ffprobe is not available on this machine');
    if (run.timedOut) throw new Error(`ffprobe timed out after ${TOOL_TIMEOUT_MS}ms`);
    if (run.code !== 0) {
      throw new Error(`ffprobe exited ${String(run.code)}: ${run.stderr.trim().slice(0, 200)}`);
    }

    const parsed = parseJson(run.stdout.toString('utf8'));
    if (parsed === null) throw new Error('ffprobe returned output that is not JSON');

    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const primary = video ?? audio ?? streams[0];
    const tags = keptTags(parsed.format?.tags);

    return {
      container: parsed.format?.format_name,
      duration: numberOrUndefined(parsed.format?.duration),
      codec: primary?.codec_name,
      width: video?.width,
      height: video?.height,
      sampleRate: audio?.sample_rate === undefined ? undefined : Number(audio.sample_rate),
      // Stream-level tags fill gaps the container did not carry.
      tags: Object.keys(tags).length > 0 ? tags : keptTags(primary?.tags),
    };
  },
};