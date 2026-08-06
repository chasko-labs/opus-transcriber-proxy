/**
 * Verifies the Opus DTX plumbing end-to-end through the real (built) encoder binaries: with DTX
 * enabled, libopus flags near-silence frames as `inDtx` (comfort noise) and voice frames as not; with
 * DTX disabled, `inDtx` is always false. This is the low-level guarantee the TranslatorConnection
 * talk-boundary logic (voice vs. silence) is built on, so it's exercised against BOTH backends.
 *
 * Requires `npm run build:wasm` (always) and, for the native case, `npm run build:native`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { IOpusEncoder, OpusEncoderConfig } from '../../src/OpusEncoder/opusEncoderTypes';

const SAMPLE_RATE = 24000;
const FRAME_SAMPLES = SAMPLE_RATE / 50; // 20 ms
const nativeAddonExists = fs.existsSync(path.join(__dirname, '../../build/Release/opus_native.node'));

/** N frames of a 440 Hz tone (voice-like energy). */
function tone(frames: number): Uint8Array {
	const out = new Uint8Array(frames * FRAME_SAMPLES * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < frames * FRAME_SAMPLES; i++) {
		view.setInt16(i * 2, Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)), true);
	}
	return out;
}

/** N frames of pure silence (zeros). */
function silence(frames: number): Uint8Array {
	return new Uint8Array(frames * FRAME_SAMPLES * 2);
}

async function makeEncoder(backend: 'wasm' | 'native', config: OpusEncoderConfig): Promise<IOpusEncoder> {
	if (backend === 'native') {
		const { OpusEncoderNative } = await import('../../src/OpusEncoder/OpusEncoderNative');
		const enc = new OpusEncoderNative(config);
		await enc.ready;
		return enc;
	}
	const { OpusEncoderWasm } = await import('../../src/OpusEncoder/OpusEncoderWasm');
	const { registerNodeOpusWasm } = await import('../../src/OpusDecoder/wasmSourceNode');
	await registerNodeOpusWasm();
	const enc = new OpusEncoderWasm(config);
	await enc.ready;
	return enc;
}

const backends: Array<'wasm' | 'native'> = nativeAddonExists ? ['wasm', 'native'] : ['wasm'];

describe.each(backends)('Opus DTX (%s backend)', (backend) => {
	const base: OpusEncoderConfig = { sampleRate: SAMPLE_RATE, channels: 1, application: 'voip' };

	it('flags silence as inDtx and voice as not, when DTX is enabled', async () => {
		const enc = await makeEncoder(backend, { ...base, dtx: true });
		try {
			const voice = enc.encodeFrame(tone(15));
			const quiet = enc.encodeFrame(silence(40));

			// Voice: libopus never enters DTX.
			expect(voice.length).toBeGreaterThan(0);
			expect(voice.every((f) => !f.inDtx)).toBe(true);

			// Silence: DTX engages after libopus's short hangover, so the tail is reliably flagged. (The
			// first several silence frames may still be non-DTX during the ramp — don't assert on those.
			// Frame sizes aren't asserted: DTX interleaves 1-byte no-transmit markers with larger periodic
			// comfort-noise updates, so "in DTX" is the flag, not the size.)
			expect(quiet.length).toBeGreaterThan(20);
			expect(quiet.slice(-10).every((f) => f.inDtx)).toBe(true);
		} finally {
			enc.free();
		}
	});

	it('never flags inDtx when DTX is disabled (default)', async () => {
		const enc = await makeEncoder(backend, base); // dtx omitted -> off
		try {
			const quiet = enc.encodeFrame(silence(40));
			expect(quiet.length).toBeGreaterThan(0);
			expect(quiet.every((f) => !f.inDtx)).toBe(true);
		} finally {
			enc.free();
		}
	});
});
