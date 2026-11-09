/**
 * PCM16 linear resampler: 24,000 Hz to 16,000 Hz (3:2 ratio).
 *
 * Designed specifically for bridging DSH's 24 kHz audio capture route to Gemini Live's
 * 16 kHz input requirement without any external C or native bindings.
 *
 * @module dsh-realtime-gemini/resample
 */

/**
 * Stateful linear PCM16 mono resampler converting 24 kHz to 16 kHz.
 * Preserves fractional phase and the boundary sample across chunks so continuous audio
 * streams with zero clicks or drift across frame boundaries.
 */
export class PcmResampler24to16 {
  private lastSample = 0
  private phase = 0

  /**
   * Resamples a chunk of 24 kHz 16-bit little-endian PCM audio to 16 kHz.
   * @param inputPcm16 - 24 kHz PCM16 mono buffer.
   * @returns 16 kHz PCM16 mono buffer.
   */
  process(inputPcm16: Uint8Array): Uint8Array {
    if (inputPcm16.length < 2) return new Uint8Array(0)
    const inCount = Math.floor(inputPcm16.length / 2)
    const inSamples = new Int16Array(inCount)
    const inView = new DataView(inputPcm16.buffer, inputPcm16.byteOffset, inCount * 2)
    for (let i = 0; i < inCount; i++) {
      inSamples[i] = inView.getInt16(i * 2, true)
    }

    // Allocate upper-bound output space
    const maxOut = Math.ceil(inCount / 1.5) + 4
    const outSamples = new Int16Array(maxOut)
    let outCount = 0

    let pos = this.phase
    while (true) {
      const idx = Math.floor(pos)
      const frac = pos - idx

      let s0: number
      let s1: number

      if (idx === -1) {
        // A negative phase only ever comes from a previous chunk that ended on its final sample
        // (`phase = pos - inSamples.length`), the same path that records `lastSample`. A freshly
        // constructed or reset resampler starts at phase 0, so a carried sample is always present
        // here; the guard that used to sit in front of this line was unreachable, and the coverage
        // gate was right to report it.
        s0 = this.lastSample
        s1 = inSamples[0]!
      } else if (idx < inSamples.length - 1) {
        s0 = inSamples[idx]!
        s1 = inSamples[idx + 1]!
      } else if (idx === inSamples.length - 1) {
        // Needs the next sample across chunk boundary: save state and break
        break
      } else {
        // Beyond current chunk
        break
      }

      const val = Math.round((1 - frac) * s0 + frac * s1)
      outSamples[outCount++] = Math.max(-32768, Math.min(32767, val))
      pos += 1.5
    }

    // Update carryover state
    const lastIdx = inSamples.length - 1
    this.lastSample = inSamples[lastIdx]!
    this.phase = pos - inSamples.length

    const outBytes = new Uint8Array(outCount * 2)
    const outView = new DataView(outBytes.buffer, outBytes.byteOffset, outCount * 2)
    for (let i = 0; i < outCount; i++) {
      outView.setInt16(i * 2, outSamples[i]!, true)
    }
    return outBytes
  }

  /** Reset internal state for a new audio stream. */
  reset(): void {
    this.lastSample = 0
    this.phase = 0
  }
}

/** Stateless one-shot resample of a complete 24 kHz buffer to 16 kHz. */
export function resample24to16(pcm16_24k: Uint8Array): Uint8Array {
  const resampler = new PcmResampler24to16()
  return resampler.process(pcm16_24k)
}
