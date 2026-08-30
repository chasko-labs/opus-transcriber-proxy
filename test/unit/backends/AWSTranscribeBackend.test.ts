/**
 * Tests for AWSTranscribeBackend.
 *
 * The @aws-sdk/client-transcribe-streaming client is mocked so send() returns a
 * controllable TranscriptResultStream. Tests assert:
 *  - getDesiredAudioFormat returns l16 at the configured rate (16000)
 *  - a partial TranscriptEvent fires onInterimTranscription
 *  - a final TranscriptEvent fires onCompleteTranscription
 *  - the emitted message matches the proxy's TranscriptionMessage shape
 *  - language params are IdentifyMultipleLanguages by default and a fixed
 *    LanguageCode when BackendConfig.language is supplied
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';

// --- Mock the AWS SDK ------------------------------------------------------
// Captures the command input on construction and lets each test drive the
// result stream via a shared controller.

interface MockController {
	lastInput: any;
	resultEvents: any[];
	sendError: Error | undefined;
	/** When true, the mock does NOT drain AudioStream; the test drives it via captured generator. */
	captureAudioStream: boolean;
	/** The AudioStream async iterable handed to the SDK, captured for manual draining. */
	capturedAudioStream: AsyncIterable<any> | undefined;
	/**
	 * When true, send() mimics real Amazon Transcribe: its returned promise does
	 * NOT resolve until the AudioStream generator has yielded its first chunk (the
	 * service withholds its response until audio arrives). This surfaces the
	 * connect()/sendAudio() deadlock that captureAudioStream=false (eager resolve)
	 * hides. Requires audio to be pushed while connect() is still in flight.
	 */
	sendResolvesOnFirstAudio: boolean;
	/** Chunks the mock has drained from the AudioStream, base64-encoded, in order. */
	drainedChunks: string[];
}

const controller: MockController = {
	lastInput: undefined,
	resultEvents: [],
	sendError: undefined,
	captureAudioStream: false,
	capturedAudioStream: undefined,
	sendResolvesOnFirstAudio: false,
	drainedChunks: [],
};

vi.mock('@aws-sdk/client-transcribe-streaming', () => {
	class StartStreamTranscriptionCommand {
		input: any;
		constructor(input: any) {
			this.input = input;
			controller.lastInput = input;
		}
	}
	class TranscribeStreamingClient {
		async send(command: any) {
			if (controller.sendError) throw controller.sendError;
			controller.capturedAudioStream = command.input.AudioStream;

			if (controller.sendResolvesOnFirstAudio) {
				// Real-service model: consume the AudioStream here and do not resolve
				// until the FIRST chunk arrives. If sendAudio() is gated on status
				// === 'connected' (which is set only after this resolves), no chunk
				// ever arrives and this await hangs — reproducing the production
				// 15s no-audio deadlock as an unresolved connect() in the test.
				const iterator = command.input.AudioStream[Symbol.asyncIterator]();
				const first = await iterator.next(); // wait for the first pushed AudioEvent
				if (!first.done && first.value?.AudioEvent?.AudioChunk) {
					controller.drainedChunks.push(Buffer.from(first.value.AudioEvent.AudioChunk).toString('base64'));
				}
				// Continue draining the rest in the background so later pushes don't
				// block; record each chunk so tests can assert order without creating
				// a second competing iterator over the same generator.
				void (async () => {
					try {
						let next = await iterator.next();
						while (!next.done) {
							if (next.value?.AudioEvent?.AudioChunk) {
								controller.drainedChunks.push(Buffer.from(next.value.AudioEvent.AudioChunk).toString('base64'));
							}
							next = await iterator.next();
						}
					} catch {
						// ignore
					}
				})();
			} else if (!controller.captureAudioStream) {
				// Drain the AudioStream generator lazily in the background so the
				// backend's push()/end() calls don't block; we don't assert on it here.
				void (async () => {
					try {
						for await (const _chunk of command.input.AudioStream) {
							// consume
						}
					} catch {
						// ignore
					}
				})();
			}
			async function* results() {
				for (const ev of controller.resultEvents) {
					yield ev;
				}
			}
			return { SessionId: 'test-session', TranscriptResultStream: results() };
		}
		destroy() {}
	}
	return {
		TranscribeStreamingClient,
		StartStreamTranscriptionCommand,
		MediaEncoding: { PCM: 'pcm' },
	};
});

vi.mock('../../../src/logger', () => ({
	default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), isLevelEnabled: vi.fn(() => false) },
}));

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// Import after mocks are registered.
import { AWSTranscribeBackend } from '../../../src/backends/AWSTranscribeBackend';
import type { BackendConfig } from '../../../src/backends/TranscriptionBackend';

function transcriptEvent(text: string, isPartial: boolean, languageCode?: string, itemConfidences?: number[]) {
	return {
		TranscriptEvent: {
			Transcript: {
				Results: [
					{
						IsPartial: isPartial,
						LanguageCode: languageCode,
						Alternatives: [
							{
								Transcript: text,
								Items: (itemConfidences ?? []).map((c) => ({ Confidence: c })),
							},
						],
					},
				],
			},
		},
	};
}

// Small helper to let the background result-stream loop run.
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

describe('AWSTranscribeBackend', () => {
	const participant = { id: 'participant-1', tag: 'p1' };

	beforeEach(() => {
		controller.lastInput = undefined;
		controller.resultEvents = [];
		controller.sendError = undefined;
		controller.captureAudioStream = false;
		controller.capturedAudioStream = undefined;
		controller.sendResolvesOnFirstAudio = false;
		controller.drainedChunks = [];
		// Ensure a deterministic config: default auto-detect, 16000.
		delete process.env.AWS_TRANSCRIBE_LANGUAGE;
		delete process.env.AWS_TRANSCRIBE_LANGUAGE_OPTIONS;
		delete process.env.AWS_TRANSCRIBE_SAMPLE_RATE;
		delete process.env.AWS_TRANSCRIBE_REGION;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('requests l16 PCM at 16000 Hz', () => {
		const backend = new AWSTranscribeBackend('p1', participant);
		const fmt = backend.getDesiredAudioFormat({ encoding: 'opus', sampleRate: 48000 });
		expect(fmt.encoding).toBe('l16');
		expect(fmt.sampleRate).toBe(16000);
	});

	it('defaults to multi-language identification across en-US,es-US', async () => {
		const backend = new AWSTranscribeBackend('p1', participant);
		await backend.connect({});
		expect(controller.lastInput.IdentifyMultipleLanguages).toBe(true);
		expect(controller.lastInput.LanguageOptions).toBe('en-US,es-US');
		expect(controller.lastInput.LanguageCode).toBeUndefined();
		expect(controller.lastInput.MediaEncoding).toBe('pcm');
		expect(controller.lastInput.MediaSampleRateHertz).toBe(16000);
		backend.close();
	});

	it('honors a per-connection fixed LanguageCode and disables auto-detect', async () => {
		const backend = new AWSTranscribeBackend('p1', participant);
		const cfg: BackendConfig = { language: 'es-US' };
		await backend.connect(cfg);
		expect(controller.lastInput.LanguageCode).toBe('es-US');
		expect(controller.lastInput.IdentifyMultipleLanguages).toBeUndefined();
		expect(controller.lastInput.IdentifyLanguage).toBeUndefined();
		backend.close();
	});

	it('fires onInterimTranscription for a partial result with the correct message shape', async () => {
		controller.resultEvents = [transcriptEvent('hola mundo', true, 'es-US')];
		const backend = new AWSTranscribeBackend('p1', participant);

		const interim: TranscriptionMessage[] = [];
		const finals: TranscriptionMessage[] = [];
		backend.onInterimTranscription = (m) => interim.push(m);
		backend.onCompleteTranscription = (m) => finals.push(m);

		await backend.connect({});
		await flush();

		expect(finals).toHaveLength(0);
		expect(interim).toHaveLength(1);
		const msg = interim[0];
		expect(msg.type).toBe('transcription-result');
		expect(msg.event).toBe('transcription-result');
		expect(msg.is_interim).toBe(true);
		expect(msg.language).toBe('es-US');
		expect(msg.participant).toEqual(participant);
		expect(msg.transcript).toEqual([{ text: 'hola mundo' }]);
		expect(typeof msg.message_id).toBe('string');
		expect(typeof msg.timestamp).toBe('number');
		backend.close();
	});

	it('fires onCompleteTranscription for a final result and averages item confidence', async () => {
		controller.resultEvents = [transcriptEvent('hello world', false, 'en-US', [0.9, 0.7])];
		const backend = new AWSTranscribeBackend('p1', participant);

		const finals: TranscriptionMessage[] = [];
		backend.onCompleteTranscription = (m) => finals.push(m);

		await backend.connect({});
		await flush();

		expect(finals).toHaveLength(1);
		const msg = finals[0];
		expect(msg.is_interim).toBe(false);
		expect(msg.language).toBe('en-US');
		expect(msg.transcript[0].text).toBe('hello world');
		// mean of 0.9 and 0.7
		expect(msg.transcript[0].confidence).toBeCloseTo(0.8, 5);
		backend.close();
	});

	it('omits confidence when Transcribe supplies no item confidences', async () => {
		controller.resultEvents = [transcriptEvent('sin confianza', false, 'es-US')];
		const backend = new AWSTranscribeBackend('p1', participant);
		const finals: TranscriptionMessage[] = [];
		backend.onCompleteTranscription = (m) => finals.push(m);

		await backend.connect({});
		await flush();

		expect(finals[0].transcript[0]).not.toHaveProperty('confidence');
		backend.close();
	});

	it('skips empty/whitespace-only transcripts', async () => {
		controller.resultEvents = [transcriptEvent('   ', true, 'en-US'), transcriptEvent('', false, 'en-US')];
		const backend = new AWSTranscribeBackend('p1', participant);
		const interim: TranscriptionMessage[] = [];
		const finals: TranscriptionMessage[] = [];
		backend.onInterimTranscription = (m) => interim.push(m);
		backend.onCompleteTranscription = (m) => finals.push(m);

		await backend.connect({});
		await flush();

		expect(interim).toHaveLength(0);
		expect(finals).toHaveLength(0);
		backend.close();
	});

	it('reports a connection failure as recoverable and rethrows', async () => {
		controller.sendError = new Error('boom');
		const backend = new AWSTranscribeBackend('p1', participant);
		const errors: Array<{ type: string; msg: string; recoverable?: boolean }> = [];
		backend.onError = (type, msg, recoverable) => errors.push({ type, msg, recoverable });

		await expect(backend.connect({})).rejects.toThrow('boom');
		expect(backend.getStatus()).toBe('failed');
		expect(errors).toHaveLength(1);
		expect(errors[0].recoverable).toBe(true);
	});

	it('transitions to closed and invokes onClosed', async () => {
		const backend = new AWSTranscribeBackend('p1', participant);
		const closed = vi.fn();
		backend.onClosed = closed;
		await backend.connect({});
		backend.close();
		expect(backend.getStatus()).toBe('closed');
		expect(closed).toHaveBeenCalledOnce();
	});

	// --- Audio path: format + no-stall (feat/aws-transcribe-audio-fix) --------
	// These drive the AudioStream generator by hand (captureAudioStream=true) so
	// they exercise the real push()->generator handoff the SDK performs, rather
	// than the eager background drain the other tests rely on.

	/** Build a mono 16-bit LE PCM buffer of `samples` samples, base64-encoded. */
	function pcmBase64(samples: number, seed = 1): string {
		const buf = Buffer.alloc(samples * 2);
		for (let i = 0; i < samples; i++) {
			buf.writeInt16LE(((i * seed) % 30000) - 15000, i * 2);
		}
		return buf.toString('base64');
	}

	it('forwards mono 16-bit LE PCM whose framing matches MediaSampleRateHertz', async () => {
		controller.captureAudioStream = true;
		const backend = new AWSTranscribeBackend('p1', participant);
		await backend.connect({});

		// Stream is opened as PCM at 16000 Hz.
		expect(controller.lastInput.MediaEncoding).toBe('pcm');
		expect(controller.lastInput.MediaSampleRateHertz).toBe(16000);

		const it0 = controller.capturedAudioStream![Symbol.asyncIterator]();

		// Push one 20ms mono frame (16000 Hz * 0.02s = 320 samples => 640 bytes).
		const b64 = pcmBase64(320);
		await backend.sendAudio(b64);

		const { value, done } = await it0.next();
		expect(done).toBe(false);
		const chunk: Uint8Array = value.AudioEvent.AudioChunk;
		// 16-bit samples => even byte length; must equal the exact pushed bytes.
		expect(chunk.byteLength % 2).toBe(0);
		expect(Buffer.from(chunk).toString('base64')).toBe(b64);
		// 320 samples of mono 16-bit == 640 bytes.
		expect(chunk.byteLength).toBe(640);

		backend.close();
	});

	it('does not stall when audio is pushed AFTER the generator parks on an empty queue', async () => {
		// This is the regression: the old check-then-await source could park
		// forever if a push landed in the check/await gap. Here we deliberately let
		// the generator reach its await (empty queue) BEFORE pushing, and assert the
		// chunk is still delivered.
		controller.captureAudioStream = true;
		const backend = new AWSTranscribeBackend('p1', participant);
		await backend.connect({});

		const iter = controller.capturedAudioStream![Symbol.asyncIterator]();

		// Start the pull first: with an empty queue the generator awaits its signal.
		const pending = iter.next();
		// Yield to the event loop so the generator actually reaches `await signal`.
		await new Promise((r) => setTimeout(r, 10));

		// Now push — a lost-wakeup bug would leave `pending` unresolved forever.
		const b64 = pcmBase64(160, 3);
		await backend.sendAudio(b64);

		const settled = await Promise.race([
			pending.then((v) => ({ ok: true as const, v })),
			new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), 500)),
		]);
		expect(settled.ok).toBe(true);
		if (settled.ok) {
			expect(Buffer.from(settled.v.value.AudioEvent.AudioChunk).toString('base64')).toBe(b64);
		}
		backend.close();
	});

	it('delivers every pushed frame in order across many push/pull cycles', async () => {
		controller.captureAudioStream = true;
		const backend = new AWSTranscribeBackend('p1', participant);
		await backend.connect({});
		const iter = controller.capturedAudioStream![Symbol.asyncIterator]();

		const frames = Array.from({ length: 25 }, (_, i) => pcmBase64(320, i + 1));

		// Interleave push and pull with the generator repeatedly draining then
		// parking — the exact pattern that stalled before the fix.
		const received: string[] = [];
		for (const f of frames) {
			await backend.sendAudio(f);
			const { value } = await iter.next();
			received.push(Buffer.from(value.AudioEvent.AudioChunk).toString('base64'));
			await new Promise((r) => setTimeout(r, 1));
		}

		expect(received).toEqual(frames);
		backend.close();
	});

	it('drops zero-length forceCommit nudges rather than yielding empty AudioChunks', async () => {
		controller.captureAudioStream = true;
		const backend = new AWSTranscribeBackend('p1', participant);
		await backend.connect({});
		const iter = controller.capturedAudioStream![Symbol.asyncIterator]();

		// A forceCommit nudge (zero-length) followed by a real frame: the generator
		// must yield only the real frame, never an empty AudioChunk (Transcribe
		// rejects empty chunks with the same no-audio symptom we are fixing).
		backend.forceCommit();
		const b64 = pcmBase64(80, 7);
		await backend.sendAudio(b64);

		const { value } = await iter.next();
		expect(value.AudioEvent.AudioChunk.byteLength).toBeGreaterThan(0);
		expect(Buffer.from(value.AudioEvent.AudioChunk).toString('base64')).toBe(b64);
		backend.close();
	});

	// --- Deadlock regression (feat/aws-transcribe-deadlock-fix) ---------------
	// Amazon Transcribe's StartStreamTranscription does not respond — so
	// client.send() does not resolve, so status never becomes 'connected' — until
	// audio has flowed. The previous sendAudio() gated on status === 'connected',
	// dropping every frame that arrived during the 'pending' window, so the
	// AudioStream generator starved, send() never resolved, and the service killed
	// the stream after 15s (interims=0, finals=0, reconnect loop). These tests
	// pin the fix: audio pushed while connect() is still in flight must reach the
	// AudioStream and thereby let connect() resolve.

	it('does NOT gate sendAudio on connected: audio pushed while connect() is in flight reaches the stream and resolves connect()', async () => {
		// send() resolves only after the first AudioEvent — exactly like the real
		// service. A status-gated sendAudio would drop the pre-connected frame and
		// this connect() would hang forever.
		controller.sendResolvesOnFirstAudio = true;

		const backend = new AWSTranscribeBackend('p1', participant);

		// Kick off connect() but do NOT await it yet — it cannot resolve until we
		// feed audio, which is the whole point.
		const connectPromise = backend.connect({});

		// Let connect() run up to `await client.send(...)`. Status is still 'pending'.
		await new Promise((r) => setTimeout(r, 10));
		expect(backend.getStatus()).toBe('pending');

		// Push a frame during the pending window. The fixed sendAudio() must accept
		// it (buffer into audioSource) rather than dropping it on the status gate.
		await backend.sendAudio(pcmBase64(320, 5));

		// With the frame delivered, the mock's send() resolves, connect() completes,
		// and status transitions to 'connected'. A 500ms race guards against the
		// regression (unresolved connect() == the production hang).
		const settled = await Promise.race([
			connectPromise.then(() => 'resolved' as const),
			new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 500)),
		]);
		expect(settled).toBe('resolved');
		expect(backend.getStatus()).toBe('connected');
		backend.close();
	});

	it('declares acceptsAudioBeforeConnected so OutgoingConnection feeds audio during the pending window', () => {
		// The capability flag is what tells OutgoingConnection to hand audio over
		// while the backend is 'pending' instead of queuing it (the queue would
		// only flush after connect() resolves, which for this backend never happens
		// without audio — the deadlock). WebSocket backends must NOT set this.
		const backend = new AWSTranscribeBackend('p1', participant);
		expect(backend.acceptsAudioBeforeConnected).toBe(true);
	});

	it('buffers pre-connected frames so none are lost before status reaches connected', async () => {
		controller.sendResolvesOnFirstAudio = true;
		const backend = new AWSTranscribeBackend('p1', participant);

		const connectPromise = backend.connect({});
		await new Promise((r) => setTimeout(r, 10));
		expect(backend.getStatus()).toBe('pending');

		// Push several frames while still pending. The first unblocks send(); all
		// must be preserved in order in the AudioStream (none dropped by a gate).
		const frames = [pcmBase64(320, 1), pcmBase64(320, 2), pcmBase64(320, 3)];
		for (const f of frames) await backend.sendAudio(f);

		await connectPromise;
		expect(backend.getStatus()).toBe('connected');

		// The mock records every chunk it drains from the AudioStream. Let its
		// background drain catch up, then confirm every pushed frame arrived in order.
		await flush();
		expect(controller.drainedChunks).toEqual(frames);
		backend.close();
	});
});
