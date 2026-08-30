/**
 * Amazon Transcribe Streaming backend.
 *
 * Uses the AWS SDK v3 StartStreamTranscription API. Authentication is handled by
 * the default AWS credential chain (ECS task role, instance profile, or env
 * credentials) — no API key is embedded or required.
 *
 * Audio: Transcribe Streaming wants PCM signed 16-bit little-endian, mono. This
 * backend requests l16 at config.awsTranscribe.sampleRate (default 16000) via
 * getDesiredAudioFormat(); the proxy's OpusAudioDecoder is constructed with
 * { sampleRate, channels: 1 }, so libopus resamples to that rate AND downmixes
 * to mono before the bytes reach sendAudio() — the forwarded PCM already matches
 * MediaSampleRateHertz as mono 16-bit LE, so no in-backend resample/downmix is
 * needed (this mirrors DeepgramBackend, which drives the same decoder at mono).
 *
 * Language: default is IdentifyMultipleLanguages across config.awsTranscribe
 * .languageOptions ('en-US,es-US') for a bilingual room. A per-connection
 * BackendConfig.language, or a global AWS_TRANSCRIBE_LANGUAGE, pins a fixed
 * LanguageCode and disables auto-detect (used when auto-detect proves flaky).
 */

import {
	TranscribeStreamingClient,
	StartStreamTranscriptionCommand,
	MediaEncoding,
	type AudioStream,
	type LanguageCode,
	type StartStreamTranscriptionCommandInput,
	type TranscriptResultStream,
} from '@aws-sdk/client-transcribe-streaming';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import logger from '../logger';
import type { AudioFormat } from '../AudioFormat';
import type { BackendConfig, TranscriptionBackend } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';

type BackendStatus = 'pending' | 'connected' | 'failed' | 'closed';

export class AWSTranscribeBackend implements TranscriptionBackend {
	private status: BackendStatus = 'pending';
	private client: TranscribeStreamingClient | undefined;
	private audioSource: AudioStreamSource | undefined;
	private readonly tag: string;
	private readonly participantInfo: { id: string; tag?: string };
	/** Candidate languages for auto-detect (used only when no fixed language is set). */
	private languageOptions: string[] = [];
	/** Fixed language code; when set, auto-detect is disabled. */
	private fixedLanguage: string | undefined;

	// Callbacks — assigned by OutgoingConnection.
	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
	onClosed?: () => void;

	constructor(tag: string, participantInfo: { id: string; tag?: string }) {
		this.tag = tag;
		this.participantInfo = participantInfo;
	}

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		// Request PCM16 at the Transcribe sample rate. The proxy decoder resamples to
		// this rate (e.g. its l16@24000 default down to 16000) before sendAudio(),
		// so the bytes we forward are already at MediaSampleRateHertz.
		return { encoding: 'l16', sampleRate: config.awsTranscribe.sampleRate };
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		// Language precedence: per-connection override > global fixed language >
		// auto-detect across languageOptions.
		this.languageOptions = config.awsTranscribe.languageOptions
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		this.fixedLanguage = backendConfig.language || config.awsTranscribe.language || undefined;

		this.audioSource = new AudioStreamSource();

		const input: StartStreamTranscriptionCommandInput = {
			MediaEncoding: MediaEncoding.PCM,
			MediaSampleRateHertz: config.awsTranscribe.sampleRate,
			AudioStream: this.audioSource.stream(),
			...this.buildLanguageParams(),
		};

		try {
			this.client = new TranscribeStreamingClient({
				region: config.awsTranscribe.region,
			});
			const response = await this.client.send(new StartStreamTranscriptionCommand(input));
			this.status = 'connected';

			logger.info(
				`[${this.tag}] Amazon Transcribe stream started ` +
					`(session=${response.SessionId ?? 'unknown'}, ` +
					`${this.fixedLanguage ? `language=${this.fixedLanguage}` : `identify=[${this.languageOptions.join(',')}]`}, ` +
					`rate=${config.awsTranscribe.sampleRate})`,
			);

			// Consume results for the lifetime of the session. Not awaited — runs in
			// the background; errors are surfaced via onError as recoverable.
			this.processResultStream(response.TranscriptResultStream).catch((err: unknown) => {
				if (this.status === 'closed') return; // expected on shutdown
				const message = err instanceof Error ? err.message : String(err);
				logger.error(`[${this.tag}] Amazon Transcribe result stream error: ${message}`);
				this.status = 'failed';
				this.onError?.('stream_error', message, true);
			});
		} catch (err: unknown) {
			this.status = 'failed';
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`[${this.tag}] Amazon Transcribe connection failed: ${message}`);
			// Recoverable: OutgoingConnection reconnects the backend in place rather
			// than tearing down the participant connection.
			this.onError?.('connection_error', message, true);
			throw err;
		}
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (this.status !== 'connected' || !this.audioSource) return;
		const pcm = Buffer.from(audioBase64, 'base64');
		this.audioSource.push(pcm);
		this.recordThroughput(pcm.length);
	}

	// --- Gated throughput instrumentation --------------------------------
	// Confirms, on a live run, that non-empty PCM is actually reaching the
	// Transcribe AudioStream at the sample rate the stream was opened with.
	// interims=0/finals=0 with zero bytes/sec here => audio never left the
	// backend (generator stall); non-zero bytes/sec that mismatch the expected
	// rate => a format problem. LOG_LEVEL=debug only; no allocation otherwise.
	private throughputBytes = 0;
	private throughputWindowStart = 0;

	private recordThroughput(byteLen: number): void {
		if (!logger.isLevelEnabled('debug')) return;
		const now = Date.now();
		if (this.throughputWindowStart === 0) this.throughputWindowStart = now;
		this.throughputBytes += byteLen;
		const elapsedMs = now - this.throughputWindowStart;
		if (elapsedMs < 1000) return;
		const rate = config.awsTranscribe.sampleRate;
		// mono 16-bit LE => 2 bytes/sample => expected bytes/sec = rate * 2
		const bytesPerSec = Math.round((this.throughputBytes * 1000) / elapsedMs);
		const expectedBps = rate * 2;
		logger.debug(
			`[${this.tag}] Transcribe audio throughput: ${bytesPerSec} bytes/sec ` +
				`(expected ~${expectedBps} for mono 16-bit @ ${rate}Hz), ` +
				`window=${elapsedMs}ms bytes=${this.throughputBytes}`,
		);
		this.throughputBytes = 0;
		this.throughputWindowStart = now;
	}

	forceCommit(): void {
		// Transcribe Streaming finalizes on detected silence automatically; there is
		// no explicit flush verb. Best-effort: fire the audio source's signal so a
		// parked stream generator re-checks its queue. The zero-length buffer itself
		// is dropped by AudioStreamSource.push() (Transcribe rejects empty chunks).
		if (this.status !== 'connected' || !this.audioSource) return;
		this.audioSource.push(Buffer.alloc(0));
	}

	updatePrompt(_prompt: string): void {
		// Transcribe Streaming has no prompt concept. Vocabulary filters / custom
		// language models are configured at the service level, not per-utterance.
		logger.debug(`[${this.tag}] updatePrompt is a no-op for Amazon Transcribe`);
	}

	close(): void {
		if (this.status === 'closed') return;
		this.status = 'closed';
		logger.debug(`[${this.tag}] Closing Amazon Transcribe backend`);

		this.audioSource?.end();
		this.audioSource = undefined;
		this.client?.destroy();
		this.client = undefined;

		this.onClosed?.();
	}

	getStatus(): BackendStatus {
		return this.status;
	}

	/**
	 * Build the mutually-exclusive language parameters. Transcribe requires exactly
	 * one of LanguageCode | IdentifyLanguage | IdentifyMultipleLanguages.
	 */
	private buildLanguageParams(): Partial<StartStreamTranscriptionCommandInput> {
		if (this.fixedLanguage) {
			return { LanguageCode: this.fixedLanguage as LanguageCode };
		}
		if (this.languageOptions.length > 1) {
			// Multiple candidates in one stream -> multi-language identification.
			return {
				IdentifyMultipleLanguages: true,
				LanguageOptions: this.languageOptions.join(','),
			};
		}
		if (this.languageOptions.length === 1) {
			// A single candidate is just a fixed language.
			return { LanguageCode: this.languageOptions[0] as LanguageCode };
		}
		// No options configured -> single-language identification (Transcribe picks one).
		return { IdentifyLanguage: true, LanguageOptions: 'en-US,es-US' };
	}

	private async processResultStream(stream: AsyncIterable<TranscriptResultStream> | undefined): Promise<void> {
		if (!stream) {
			logger.warn(`[${this.tag}] Amazon Transcribe returned no result stream`);
			return;
		}

		for await (const event of stream) {
			if (this.status === 'closed') break;

			const results = event.TranscriptEvent?.Transcript?.Results;
			if (!results?.length) continue;

			for (const result of results) {
				const alternative = result.Alternatives?.[0];
				const text = alternative?.Transcript ?? '';
				if (!text.trim()) continue;

				const isInterim = result.IsPartial ?? true;
				// Transcribe reports the detected language per result when identifying.
				const language = result.LanguageCode ?? this.fixedLanguage ?? this.languageOptions[0];
				const confidence = averageItemConfidence(alternative);

				const message = this.buildMessage(text, isInterim, language, confidence);
				if (isInterim) {
					this.onInterimTranscription?.(message);
				} else {
					this.onCompleteTranscription?.(message);
				}
			}
		}
	}

	private buildMessage(
		text: string,
		isInterim: boolean,
		language: string | undefined,
		confidence: number | undefined,
	): TranscriptionMessage {
		return {
			transcript: [
				{
					// Omit confidence when unknown (matches DeepgramBackend behaviour).
					...(confidence !== undefined && { confidence }),
					text,
				},
			],
			is_interim: isInterim,
			message_id: randomUUID(),
			type: 'transcription-result',
			event: 'transcription-result',
			participant: this.participantInfo,
			timestamp: Date.now(),
			...(language !== undefined && { language }),
		};
	}
}

/**
 * Mean confidence across the word-level Items in an alternative, when Transcribe
 * supplies per-item confidences. Returns undefined when no confidences are present
 * so the field is omitted from the message rather than reported as a single word's
 * score.
 */
function averageItemConfidence(alternative: { Items?: Array<{ Confidence?: number }> } | undefined): number | undefined {
	const items = alternative?.Items;
	if (!items?.length) return undefined;
	const scored = items.map((i) => i.Confidence).filter((c): c is number => typeof c === 'number');
	if (!scored.length) return undefined;
	return scored.reduce((a, b) => a + b, 0) / scored.length;
}

/**
 * Bridges imperative push()/end() calls into the AsyncIterable<AudioStream> the
 * SDK's StartStreamTranscriptionCommand expects.
 *
 * The generator must never lose a wakeup: the previous check-then-await version
 * evaluated `queue.length === 0` and only then created the wake promise, so a
 * push() landing in that gap (when `wake` was still undefined) queued a chunk
 * without arming any waiter — the generator then awaited a promise that only
 * resolved on the *next* push, parking the stream. With one participant pushing
 * ~20ms Opus frames that gap opens routinely; a single miss stalls the stream
 * and Amazon Transcribe kills it after 15s with no audio received (interims=0,
 * finals=0, reconnect loop). See feat/aws-transcribe-audio-fix.
 *
 * Fix: a single reusable "signal" promise that push()/end() always resolve, and
 * that the generator recreates only while holding the knowledge that the queue
 * is empty. The generator re-checks the queue after every wait, so a chunk that
 * arrives concurrently with (or just before) the wait is always drained rather
 * than stranded.
 */
class AudioStreamSource {
	private queue: Buffer[] = [];
	private done = false;
	/** Resolves whenever new data is pushed or the stream is ended. */
	private signal: Promise<void>;
	private resolveSignal!: () => void;

	constructor() {
		this.signal = new Promise<void>((resolve) => {
			this.resolveSignal = resolve;
		});
	}

	/** Wake any current waiter and arm a fresh signal for the next wait. */
	private fire(): void {
		const resolve = this.resolveSignal;
		this.signal = new Promise<void>((r) => {
			this.resolveSignal = r;
		});
		resolve();
	}

	push(chunk: Buffer): void {
		if (this.done) return;
		// Drop zero-length chunks here: they carry no audio and forceCommit()'s
		// best-effort nudge must not enqueue empty AudioEvents (Transcribe rejects
		// a zero-length AudioChunk). We still fire the signal so a parked generator
		// re-checks the queue.
		if (chunk.length > 0) {
			this.queue.push(chunk);
		}
		this.fire();
	}

	end(): void {
		this.done = true;
		this.fire();
	}

	async *stream(): AsyncGenerator<AudioStream> {
		while (true) {
			// Drain everything currently queued before waiting again.
			while (this.queue.length > 0) {
				const chunk = this.queue.shift();
				if (chunk && chunk.length > 0) {
					yield { AudioEvent: { AudioChunk: new Uint8Array(chunk) } };
				}
			}
			if (this.done) return;
			// Queue is empty and not done: wait for the next push()/end(). Capture
			// the signal reference BEFORE awaiting so a push() that fires between
			// the drain above and this await still resolves the promise we await —
			// no wakeup can be lost.
			await this.signal;
		}
	}
}

export default AWSTranscribeBackend;
