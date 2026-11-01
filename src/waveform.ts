import { audioURL } from './staticBackend';

/** Display amplitude and audition-start measurements from a recording's actual decoded audio.
 * Nothing here describes sections, mood or RTP; RTP remains a whole-recording prediction.
 */
export type WaveformData = { peaks: number[]; duration: number; sampleRate: number; suggestion: number | null };
export const WAVEFORM_BINS = 600;
/** Decoding at 22.05 kHz bounds browser memory for long recordings; content above 11 kHz is not drawn. */
export const DECODE_RATE = 22050;
export const LOUDNESS_WINDOW_SECONDS = 3;
const FRAME_SECONDS = .1;

/** Peak absolute sample value per bin, taken across every channel (no mixing, so no phase cancellation). */
export function peakEnvelope(channels: Float32Array[], bins = WAVEFORM_BINS): number[] {
  const length = Math.min(...channels.map(channel => channel.length));
  if (!channels.length || !length) return [];
  const count = Math.min(bins, length);
  return Array.from({ length: count }, (_, bin) => {
    const start = Math.floor(bin * length / count), end = Math.floor((bin + 1) * length / count);
    let peak = 0;
    for (const channel of channels) for (let i = start; i < end; i++) { const value = Math.abs(channel[i]); if (value > peak) peak = value; }
    return Math.min(1, peak);
  });
}

/** Suggested audition start: the first point from which the next 3 seconds reach the recording's median 3-second RMS
 * loudness. It skips quiet introductions and leaves a short lead-in. Returns null when that point is within the first 2 s
 * (no quiet introduction) or leaves less than 10 s of audio.
 */
export function suggestedStart(channels: Float32Array[], sampleRate: number): number | null {
  const length = Math.min(...channels.map(channel => channel.length));
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS)), frames = Math.floor(length / frame);
  const window = Math.round(LOUDNESS_WINDOW_SECONDS / FRAME_SECONDS);
  if (!channels.length || frames < window) return null;
  const power = Array.from({ length: frames }, (_, index) => {
    let sum = 0;
    for (const channel of channels) for (let i = index * frame; i < (index + 1) * frame; i++) sum += channel[i] * channel[i];
    return sum / (frame * channels.length);
  });
  const loudness: number[] = [];
  let running = power.slice(0, window).reduce((a, b) => a + b, 0);
  for (let index = 0; index + window <= frames; index++) {
    if (index) running += power[index + window - 1] - power[index - 1];
    loudness.push(Math.sqrt(Math.max(0, running) / window));
  }
  const sorted = [...loudness].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  const first = loudness.findIndex(value => value >= median);
  const seconds = first * FRAME_SECONDS, duration = length / sampleRate;
  if (first < 0 || seconds < 2 || duration - seconds < 10) return null;
  return Math.round(seconds * 10) / 10;
}

const cache = new Map<string, WaveformData>();

/** Fetch the same published playback copy and decode it locally; results are kept in memory for this tab only. */
export async function analyzeRecording(recordingId: string, signal: AbortSignal): Promise<WaveformData> {
  const known = cache.get(recordingId);
  if (known) return known;
  const response = await fetch(audioURL(recordingId), { signal });
  if (!response.ok) throw new Error('Waveform unavailable');
  const bytes = await response.arrayBuffer();
  const buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const data = { peaks: peakEnvelope(channels), duration: buffer.duration, sampleRate: buffer.sampleRate, suggestion: suggestedStart(channels, buffer.sampleRate) };
  if (cache.size >= 40) cache.delete(cache.keys().next().value!);
  cache.set(recordingId, data);
  return data;
}
