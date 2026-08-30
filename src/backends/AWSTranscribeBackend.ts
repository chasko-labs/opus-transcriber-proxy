/**
 * Amazon Transcribe Streaming backend.
 *
 * Uses the AWS SDK v3 StartStreamTranscription API. Authentication is handled by
 * the default AWS credential chain (ECS task role, instance profile, or env
 * credentials) — no API key is embedded or required.
 *
 * Audio: Transcribe Streaming wants PCM signed 16-bit little-endian. This backend
 * requests l16 at config.awsTranscribe.sampleRate (default 16000) via
 * getDesiredAudioFormat(); the proxy's decoder produces PCM already at that rate,
 * so no in-backend resample is needed (opus -> OpusAudioDecoder(16000);
 * l16 -> L16Decoder resamples 24000->16000; ogg -> Cascaded).
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
		this.audioSource.push(Buffer.from(audioBase64, 'base64'));
	}

	forceCommit(): void {
		// Transcribe Streaming finalizes on detected silence automatically; there is
		// no explicit flush verb. Best-effort: push a zero-length chunk to nudge the
		// service to emit any pending partial as it processes the input boundary.
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
 * SDK's StartStreamTranscriptionCommand expects. Backpressure is unbounded (the
 * proxy already paces audio at real time), so the queue stays small.
 */
class AudioStreamSource {
	private queue: Buffer[] = [];
	private wake: (() => void) | undefined;
	private done = false;

	push(chunk: Buffer): void {
		if (this.done) return;
		this.queue.push(chunk);
		this.wake?.();
		this.wake = undefined;
	}

	end(): void {
		this.done = true;
		this.wake?.();
		this.wake = undefined;
	}

	async *stream(): AsyncGenerator<AudioStream> {
		while (true) {
			if (this.queue.length === 0 && !this.done) {
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
			}
			while (this.queue.length > 0) {
				const chunk = this.queue.shift();
				if (chunk && chunk.length > 0) {
					yield { AudioEvent: { AudioChunk: new Uint8Array(chunk) } };
				}
			}
			if (this.done) return;
		}
	}
}

export default AWSTranscribeBackend;
