import {
	TranscribeStreamingClient,
	StartStreamTranscriptionCommand,
	type AudioStream,
	MediaEncoding,
	type TranscriptResultStream,
} from '@aws-sdk/client-transcribe-streaming';
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import { randomUUID } from 'crypto';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
import type { AudioFormat } from '../AudioFormat';
import type { TranscriptionMessage } from '../transcriberproxy';

// ---------------------------------------------------------------------------
// Language mapping helpers
// ---------------------------------------------------------------------------

/** Map AWS Transcribe language codes to AWS Translate language codes */
const TRANSCRIBE_TO_TRANSLATE_LANG: Record<string, string> = {
	'en-US': 'en',
	'en-GB': 'en',
	'en-AU': 'en',
	'es-US': 'es',
	'es-ES': 'es',
	'fr-FR': 'fr',
	'fr-CA': 'fr',
	'de-DE': 'de',
	'it-IT': 'it',
	'pt-BR': 'pt',
	'ja-JP': 'ja',
	'ko-KR': 'ko',
	'zh-CN': 'zh',
};

function getTranslateLangCode(transcribeLang: string): string {
	return TRANSCRIBE_TO_TRANSLATE_LANG[transcribeLang] ?? transcribeLang.split('-')[0];
}

/**
 * Given a detected language and the configured language options,
 * return the opposite language for translation target.
 */
function getTranslationTarget(detectedLang: string, languageOptions: string[]): string | undefined {
	const detectedBase = getTranslateLangCode(detectedLang);
	for (const option of languageOptions) {
		const optionBase = getTranslateLangCode(option);
		if (optionBase !== detectedBase) {
			return optionBase;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const AWS_TRANSCRIBE_REGION = process.env.AWS_TRANSCRIBE_REGION ?? 'us-west-2';
const AWS_TRANSCRIBE_LANGUAGE_OPTIONS = process.env.AWS_TRANSCRIBE_LANGUAGE_OPTIONS ?? 'en-US,es-US';
const AWS_TRANSLATE_ENABLED = process.env.AWS_TRANSLATE_ENABLED !== 'false';

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export class AWSTranscribeBackend implements TranscriptionBackend {
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private transcribeClient: TranscribeStreamingClient | undefined;
	private translateClient: TranslateClient | undefined;
	private audioGenerator: AsyncAudioGenerator | undefined;
	private tag: string;
	private participantInfo: any;
	private languageOptions: string[] = [];

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
	}

	// Callback hooks — assigned by the proxy framework
	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
	onClosed?: () => void;

	// -------------------------------------------------------------------------
	// Public interface
	// -------------------------------------------------------------------------

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		return { encoding: 'l16', sampleRate: 16000 };
	}

	async connect(config: BackendConfig): Promise<void> {
		this.languageOptions = AWS_TRANSCRIBE_LANGUAGE_OPTIONS.split(',').map((s) => s.trim());

		try {
			this.transcribeClient = new TranscribeStreamingClient({
				region: AWS_TRANSCRIBE_REGION,
			});

			if (AWS_TRANSLATE_ENABLED) {
				this.translateClient = new TranslateClient({
					region: AWS_TRANSCRIBE_REGION,
				});
			}

			this.audioGenerator = new AsyncAudioGenerator();

			const command = new StartStreamTranscriptionCommand({
				MediaEncoding: MediaEncoding.PCM,
				MediaSampleRateHertz: 16000,
				IdentifyMultipleLanguages: true,
				LanguageOptions: this.languageOptions.join(','),
				AudioStream: this.audioGenerator.stream(),
			});

			const response = await this.transcribeClient.send(command);
			this.status = 'connected';

			logger.info(
				`[AWSTranscribeBackend] Connected. SessionId=${response.SessionId ?? 'unknown'}, ` + `Languages=${this.languageOptions.join(',')}`,
			);

			// Process results in background — do not await (it runs for the session lifetime)
			this.processResultStream(response.TranscriptResultStream).catch((err: Error) => {
				if (this.status !== 'closed') {
					logger.error(`[AWSTranscribeBackend] Result stream error: ${err.message}`);
					this.onError?.('transcribe_error', err.message, true);
					this.status = 'failed';
				}
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`[AWSTranscribeBackend] Connection failed: ${message}`);
			this.status = 'failed';
			this.onError?.('timeout', `Connection failed: ${message}`, true);
			throw err;
		}
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (this.status !== 'connected') {
			return;
		}
		const buffer = Buffer.from(audioBase64, 'base64');
		this.audioGenerator?.push(buffer);
	}

	forceCommit(): void {
		if (this.status !== 'connected') {
			return;
		}
		// Send an empty audio chunk to trigger Transcribe to finalize pending partials
		this.audioGenerator?.push(Buffer.alloc(0));
	}

	updatePrompt(_prompt: string): void {
		// AWS Transcribe Streaming does not support mid-stream prompt updates.
		// Vocabulary filters or custom language models should be configured at
		// the Transcribe service level.
		logger.debug('[AWSTranscribeBackend] updatePrompt called — no-op for Transcribe Streaming');
	}

	close(): void {
		if (this.status === 'closed') {
			return;
		}
		this.status = 'closed';
		logger.info('[AWSTranscribeBackend] Closing stream');

		this.audioGenerator?.end();
		this.transcribeClient?.destroy();
		this.translateClient?.destroy();

		this.transcribeClient = undefined;
		this.translateClient = undefined;
		this.audioGenerator = undefined;

		this.onClosed?.();
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	// -------------------------------------------------------------------------
	// Private — result stream processing
	// -------------------------------------------------------------------------

	private async processResultStream(stream: AsyncIterable<TranscriptResultStream> | undefined): Promise<void> {
		if (!stream) {
			logger.warn('[AWSTranscribeBackend] No result stream received');
			return;
		}

		for await (const event of stream) {
			if (this.status === 'closed') {
				break;
			}

			if (event.TranscriptEvent?.Transcript?.Results) {
				for (const result of event.TranscriptEvent.Transcript.Results) {
					if (!result.Alternatives?.length) {
						continue;
					}

					const alternative = result.Alternatives[0];
					const text = alternative.Transcript ?? '';
					if (!text.trim()) {
						continue;
					}

					const detectedLanguage = result.LanguageCode ?? this.languageOptions[0];
					const confidence = result.Alternatives[0]?.Items?.[0]?.Confidence;
					const isPartial = result.IsPartial ?? true;

					const message = this.buildMessage(text, isPartial, detectedLanguage, confidence);

					if (isPartial) {
						this.onInterimTranscription?.(message);
					} else {
						// Emit the original-language final transcription
						this.onCompleteTranscription?.(message);

						// Translate to the other configured language if enabled
						if (AWS_TRANSLATE_ENABLED && this.translateClient) {
							await this.translateAndEmit(text, detectedLanguage, confidence);
						}
					}
				}
			}
		}
	}

	private async translateAndEmit(text: string, sourceLang: string, confidence: number | undefined): Promise<void> {
		const targetLang = getTranslationTarget(sourceLang, this.languageOptions);
		if (!targetLang) {
			return;
		}

		const sourceCode = getTranslateLangCode(sourceLang);

		try {
			const command = new TranslateTextCommand({
				Text: text,
				SourceLanguageCode: sourceCode,
				TargetLanguageCode: targetLang,
			});

			const response = await this.translateClient!.send(command);
			const translatedText = response.TranslatedText;

			if (translatedText && translatedText !== text) {
				const translatedMessage = this.buildMessage(translatedText, false, targetLang, confidence);
				this.onCompleteTranscription?.(translatedMessage);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`[AWSTranscribeBackend] Translation failed (${sourceCode} -> ${targetLang}): ${message}`);
			// Translation failure is non-fatal — original transcription was already emitted
		}
	}

	private buildMessage(text: string, isInterim: boolean, language: string, confidence: number | undefined): TranscriptionMessage {
		return {
			transcript: [{ text, confidence }],
			is_interim: isInterim,
			message_id: randomUUID(),
			type: 'transcription-result',
			event: 'transcription-result',
			participant: this.participantInfo,
			timestamp: Date.now(),
			language,
		};
	}
}

// ---------------------------------------------------------------------------
// Async generator adapter for the Transcribe streaming input
// ---------------------------------------------------------------------------

/**
 * Bridges imperative push() calls into an AsyncIterable<AudioStream> that
 * the AWS SDK StartStreamTranscriptionCommand expects.
 */
class AsyncAudioGenerator {
	private queue: Buffer[] = [];
	private resolve: (() => void) | undefined;
	private done = false;

	push(chunk: Buffer): void {
		if (this.done) {
			return;
		}
		this.queue.push(chunk);
		if (this.resolve) {
			this.resolve();
			this.resolve = undefined;
		}
	}

	end(): void {
		this.done = true;
		if (this.resolve) {
			this.resolve();
			this.resolve = undefined;
		}
	}

	async *stream(): AsyncGenerator<AudioStream> {
		while (true) {
			if (this.queue.length === 0 && !this.done) {
				await new Promise<void>((r) => {
					this.resolve = r;
				});
			}

			while (this.queue.length > 0) {
				const chunk = this.queue.shift()!;
				yield { AudioEvent: { AudioChunk: chunk } };
			}

			if (this.done) {
				return;
			}
		}
	}
}

export default AWSTranscribeBackend;
