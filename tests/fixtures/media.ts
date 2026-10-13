/**
 * Synthetic media fixtures (plan Task 4). Byte construction only: no encoder,
 * no network, no third-party tool generates these, so a test run is the same
 * on every machine.
 */

/** A RIFF/WAVE file: a real header, a real `fmt ` chunk and real PCM samples. */
export function makeWav(options: { seconds?: number; sampleRate?: number; title?: string; artist?: string } = {}): Buffer {
  const seconds = options.seconds ?? 1;
  const sampleRate = options.sampleRate ?? 8000;
  const sampleCount = Math.round(seconds * sampleRate);
  const bytesPerSample = 2;
  const channels = 1;
  const dataSize = sampleCount * bytesPerSample;
  const pcm = Buffer.alloc(dataSize);
  for (let i = 0; i < sampleCount; i += 1) {
    // A quiet 440 Hz tone, so the file is not silent and not noise.
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 4000);
    pcm.writeInt16LE(value, i * bytesPerSample);
  }

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 16);
  fmt.writeUInt16LE(channels * bytesPerSample, 20);
  fmt.writeUInt16LE(bytesPerSample * 8, 22);

  const data = Buffer.alloc(8 + dataSize);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(dataSize, 4);
  pcm.copy(data, 8);

  const info = makeInfoList(options);
  const parts = [makeRiffId('WAVE'), fmt, data, ...(info === null ? [] : [info])];
  const body = Buffer.concat(parts);
  return Buffer.concat([makeRiffId('RIFF'), u32(4 + body.length), body]);
}

/** A LIST/INFO chunk, which is how a WAV carries basic tags. */
function makeInfoList(options: { title?: string; artist?: string }): Buffer | null {
  const tags: [string, string][] = [];
  if (options.title !== undefined) tags.push(['INAM', options.title]);
  if (options.artist !== undefined) tags.push(['IART', options.artist]);
  if (tags.length === 0) return null;

  const chunks = tags.map(([id, value]) => {
    const text = Buffer.from(`${value}\0`, 'utf8');
    const padded = text.length % 2 === 0 ? text : Buffer.concat([text, Buffer.alloc(1)]);
    const header = Buffer.alloc(8);
    header.write(id, 0, 'latin1');
    header.writeUInt32LE(text.length, 4);
    return Buffer.concat([header, padded]);
  });
  const type = Buffer.alloc(4);
  type.write('INFO', 0, 'latin1');
  const payload = Buffer.concat([type, ...chunks]);
  const list = Buffer.alloc(8);
  list.write('LIST', 0, 'latin1');
  list.writeUInt32LE(payload.length, 4);
  return Buffer.concat([list, payload]);
}

function makeRiffId(id: string): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.write(id, 0, 'latin1');
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}