/**
 * Transcript-finalization tests for TranslatorConnection. The /v1/realtime/translations endpoint emits
 * session.output_transcript.delta but NO session.output_transcript.done, so the final transcript is emitted at the
 * same silence boundary as the audio talk-stop (finalizePendingTranscript, driven by the silence timer) — re-emitting
 * the last interim with isInterim=false. On the general /v1/realtime endpoint the transcript-done event still emits
 * the authoritative final and suppresses the boundary-driven one. Fake timers make the silence timer deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslatorConnection } from '../../src/TranslatorConnection';
import type { TranslationRuntime } from '../../src/translate/runtime';

const TALK_TIMEOUT_MS = 300;

interface FakeWs {
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	addEventListener: (type: string, cb: (ev?: any) => void) => void;
	readyState: number;
	fireOpen: () => void;
	fireMessage: (data: string) => void;
}

function makeFakeWebSocket(): FakeWs {
	const listeners: Record<string, (ev?: any) => void> = {};
	return {
		send: vi.fn(),
		close: vi.fn(),
		addEventListener: (type, cb) => {
			listeners[type] = cb;
		},
		readyState: 1,
		fireOpen: () => listeners.open?.(),
		fireMessage: (data) => listeners.message?.({ data }),
	};
}

/** Runtime with transcripts enabled and an encoder that emits one Opus frame per audio delta. */
function makeHarness(): { runtime: TranslationRuntime; sockets: FakeWs[] } {
	const sockets: FakeWs[] = [];
	const runtime: TranslationRuntime = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		config: {
			openaiApiKey: 'k',
			translationModel: 'm',
			emitTranscripts: true,
			debug: false,
			translationUsageUrl: '',
			usageReportIntervalMs: 0,
			talkSilenceTimeoutMs: TALK_TIMEOUT_MS,
		},
		writeMetric: () => {},
		createMetricBatcher: () => ({ increment: () => {}, flush: () => {} }),
		createOutboundWebSocket: () => {
			const ws = makeFakeWebSocket();
			sockets.push(ws);
			return ws as any;
		},
		createOpusDecoder: () =>
			({
				ready: Promise.resolve(),
				decodeFrame: () => ({ audioData: new Uint8Array(0), samplesDecoded: 0, sampleRate: 24000, channels: 1, errors: [] }),
				conceal: () => ({ audioData: new Uint8Array(0), samplesDecoded: 0, sampleRate: 24000, channels: 1, errors: [] }),
				reset: () => {},
				free: () => {},
			}) as any,
		createOpusEncoder: () =>
			({ ready: Promise.resolve(), encodeFrame: () => [new Uint8Array([1, 2, 3])], reset: () => {}, free: () => {} }) as any,
		buildServerInfo: () => undefined,
	};
	return { runtime, sockets };
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const audioDelta = () => JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' });
const transcriptDelta = (text: string) => JSON.stringify({ type: 'session.output_transcript.delta', delta: text });
const transcriptDone = (text: string) => JSON.stringify({ type: 'session.output_transcript.done', transcript: text });

describe('TranslatorConnection transcript finalization', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Returns the connection plus a capture of every onTranscription call as [text, isInterim].
	async function connect(): Promise<{ conn: TranslatorConnection; ws: FakeWs; transcripts: Array<[string, boolean]> }> {
		const { runtime, sockets } = makeHarness();
		const conn = new TranslatorConnection('55555555-a0', { targetLanguage: 'hi' }, runtime);
		const transcripts: Array<[string, boolean]> = [];
		conn.onTranscription = (text, _lang, isInterim) => transcripts.push([text, isInterim]);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		sockets[0].fireOpen();
		return { conn, ws: sockets[0], transcripts };
	}

	const advancePastSilence = () => vi.advanceTimersByTimeAsync(TALK_TIMEOUT_MS + 3000);

	it('accumulates fragment deltas and finalizes the whole utterance at the silence boundary', async () => {
		const { ws, transcripts } = await connect();

		ws.fireMessage(audioDelta()); // start a talk (arms the silence timer)
		// Deltas are incremental fragments, not a cumulative hypothesis — each is forwarded verbatim as an interim.
		ws.fireMessage(transcriptDelta('hola'));
		ws.fireMessage(transcriptDelta(' mundo'));
		expect(transcripts).toEqual([
			['hola', true],
			[' mundo', true],
		]);

		await advancePastSilence(); // silence timer fires -> finalize the CONCATENATION of the fragments
		expect(transcripts).toEqual([
			['hola', true],
			[' mundo', true],
			['hola mundo', false], // final = accumulated run, not just the last fragment
		]);
	});

	it('does not double-finalize when a transcript-done event is present (general endpoint)', async () => {
		const { ws, transcripts } = await connect();

		ws.fireMessage(audioDelta());
		ws.fireMessage(transcriptDelta('hi'));
		ws.fireMessage(transcriptDone('hi there')); // authoritative final; clears the pending interim
		expect(transcripts).toEqual([
			['hi', true],
			['hi there', false],
		]);

		// The silence timer must not emit a second (duplicate) final.
		await advancePastSilence();
		expect(transcripts.filter(([, isInterim]) => !isInterim)).toEqual([['hi there', false]]);
	});

	it('finalizes a pending transcript when the connection closes', async () => {
		const { conn, ws, transcripts } = await connect();

		ws.fireMessage(audioDelta());
		ws.fireMessage(transcriptDelta('adiós'));
		conn.close();
		expect(transcripts).toContainEqual(['adiós', false]);
	});

	it('emits nothing when no transcript deltas were received', async () => {
		const { ws, transcripts } = await connect();
		ws.fireMessage(audioDelta()); // audio only, no transcript
		await advancePastSilence();
		expect(transcripts).toEqual([]);
	});
});
