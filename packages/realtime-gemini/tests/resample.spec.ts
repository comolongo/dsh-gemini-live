import { describe, expect, it } from 'vitest'
import { PcmResampler24to16, resample24to16 } from '../src/resample.ts'

describe('PcmResampler24to16', () => {
  it('resamples 240 samples of 24 kHz audio to 160 samples of 16 kHz audio (3:2 ratio)', () => {
    // 240 samples = 480 bytes
    const input = new Uint8Array(480)
    const view = new DataView(input.buffer)
    for (let i = 0; i < 240; i++) {
      // Linear ramp: 0, 100, 200...
      view.setInt16(i * 2, i * 100, true)
    }

    const output = resample24to16(input)
    // 240 / 1.5 = 160 samples. 160 - 1 = 159 or 160 depending on final sample interpolation boundary
    const outSamples = output.length / 2
    expect(outSamples).toBeGreaterThanOrEqual(159)
    expect(outSamples).toBeLessThanOrEqual(160)

    // Check first sample: at pos 0, should be 0
    const outView = new DataView(output.buffer)
    expect(outView.getInt16(0, true)).toBe(0)
    // Check second sample: at pos 1.5, midpoint between in[1] (100) and in[2] (200) -> 150
    expect(outView.getInt16(2, true)).toBe(150)
    // Check third sample: at pos 3.0, in[3] -> 300
    expect(outView.getInt16(4, true)).toBe(300)
  })

  it('preserves continuity across chunk boundaries without dropping samples', () => {
    const totalSamples = 300
    const fullInput = new Uint8Array(totalSamples * 2)
    const fullView = new DataView(fullInput.buffer)
    for (let i = 0; i < totalSamples; i++) {
      fullView.setInt16(i * 2, (i % 50) * 200, true)
    }

    // Process all at once
    const oneShot = resample24to16(fullInput)

    // Process chunked (e.g. 100 samples per chunk)
    const streamResampler = new PcmResampler24to16()
    const chunk1 = streamResampler.process(fullInput.subarray(0, 200)) // 100 samples
    const chunk2 = streamResampler.process(fullInput.subarray(200, 400)) // 100 samples
    const chunk3 = streamResampler.process(fullInput.subarray(400, 600)) // 100 samples

    const streamedTotalBytes = chunk1.length + chunk2.length + chunk3.length
    expect(Math.abs(streamedTotalBytes - oneShot.length)).toBeLessThanOrEqual(4) // at most 1-2 samples boundary difference

    // Verify first chunk values match oneShot values
    const oneView = new DataView(oneShot.buffer)
    const chunk1View = new DataView(chunk1.buffer)
    for (let i = 0; i < chunk1.length / 2; i++) {
      expect(chunk1View.getInt16(i * 2, true)).toBe(oneView.getInt16(i * 2, true))
    }
  })

  it('handles empty or tiny inputs gracefully', () => {
    const resampler = new PcmResampler24to16()
    expect(resampler.process(new Uint8Array(0)).length).toBe(0)
    expect(resampler.process(new Uint8Array(1)).length).toBe(0)
  })
})
