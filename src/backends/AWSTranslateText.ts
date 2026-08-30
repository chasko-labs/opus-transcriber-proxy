/**
 * Amazon Translate text-translation wrapper.
 *
 * Thin wrapper around the AWS SDK v3 TranslateTextCommand. Used by the /transcribe
 * result path to translate a FINAL transcription's text from its detected source
 * language to the other supported language (en<->es), producing a second caption
 * frame. This is additive text translation, NOT the OpenAI speech-to-speech
 * /translate path — no third-party key, no realtime socket.
 *
 * Authentication is handled by the default AWS credential chain (ECS task role /
 * instance profile / env credentials) — the task role grants translate:TranslateText,
 * so no API key is embedded or required. This mirrors AWSTranscribeBackend.
 *
 * Language codes: Amazon Transcribe reports region-qualified codes (en-US, es-US)
 * while Amazon Translate expects the 2-letter ISO code (en, es). mapToTranslateCode()
 * maps between them; unsupported source languages return undefined so the caller can
 * skip translation rather than emit a wrong-language caption.
 */

import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import logger from '../logger';
import type { TranscriptionMessage } from '../transcriberproxy';

/**
 * Map an Amazon Transcribe language code to the 2-letter code Amazon Translate uses.
 * Returns undefined for languages outside the supported en<->es pair so the caller
 * skips translation instead of guessing.
 */
export function mapToTranslateCode(transcribeLang: string | undefined): 'en' | 'es' | undefined {
	if (!transcribeLang) return undefined;
	// Match on the primary subtag so en-US, en-GB, es-US, es-ES all collapse correctly.
	const primary = transcribeLang.toLowerCase().split('-')[0];
	if (primary === 'en') return 'en';
	if (primary === 'es') return 'es';
	return undefined;
}

export class AWSTranslateText {
	private client: TranslateClient;

	constructor(client?: TranslateClient) {
		// Region precedence mirrors AWSTranscribeBackend: AWS_TRANSLATE_REGION, then
		// AWS_REGION, then us-west-2 (resolved in config.awsTranslate.region).
		this.client = client ?? new TranslateClient({ region: config.awsTranslate.region });
	}

	/**
	 * Translate `text` from `sourceLangCode` to `targetLangCode`. Codes are the
	 * 2-letter Translate codes (en, es). Returns the translated string, or undefined
	 * if translation fails — a translate failure must NEVER break the base caption,
	 * so the caller simply skips the translated frame on undefined.
	 */
	async translate(text: string, sourceLangCode: string, targetLangCode: string): Promise<string | undefined> {
		if (!text.trim()) return undefined;
		try {
			const response = await this.client.send(
				new TranslateTextCommand({
					Text: text,
					SourceLanguageCode: sourceLangCode,
					TargetLanguageCode: targetLangCode,
				}),
			);
			return response.TranslatedText;
		} catch (err: unknown) {
			// Log and swallow: the original-language caption has already been sent, so a
			// translate failure just means no second frame this time.
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`Amazon Translate ${sourceLangCode}->${targetLangCode} failed: ${message}`);
			return undefined;
		}
	}
}

/**
 * Map a 2-letter Translate code back to the region-qualified Transcribe-style code
 * used in the transcription-result `language` field, so the translated frame is
 * tagged consistently with original-language frames (which carry en-US / es-US).
 */
export function toTranscribeLangTag(translateCode: 'en' | 'es'): string {
	return translateCode === 'en' ? 'en-US' : 'es-US';
}

/**
 * Build the second (translated) transcription-result frame from the original final
 * frame. Preserves the exact schema JVB Exporter consumes — same field names and
 * casing as AWSTranscribeBackend.buildMessage — replacing only the text, the
 * language tag, and the message_id (a distinct id so downstream dedup treats it as
 * its own caption). Always is_interim:false (we only translate finals).
 */
export function buildTranslatedFrame(
	original: TranscriptionMessage,
	translatedText: string,
	targetTranslateCode: 'en' | 'es',
): TranscriptionMessage {
	return {
		transcript: [{ text: translatedText }],
		is_interim: false,
		message_id: randomUUID(),
		type: 'transcription-result',
		event: 'transcription-result',
		participant: original.participant,
		timestamp: Date.now(),
		language: toTranscribeLangTag(targetTranslateCode),
		...(original.speaker !== undefined && { speaker: original.speaker }),
	};
}

/**
 * Given a FINAL transcription-result frame, translate it to the OTHER supported
 * language and return the second frame to emit — or undefined when no translated
 * frame should be sent (translation disabled, interim, unsupported/undetected
 * source language, empty text, or a translate failure). Purely additive: the
 * caller has already emitted the original frame and only sends this extra frame
 * when a value is returned.
 */
export async function buildTranslationCaption(
	original: TranscriptionMessage,
	translator: AWSTranslateText,
): Promise<TranscriptionMessage | undefined> {
	// Finals only. Interims are excluded to bound latency and Translate cost.
	if (original.is_interim) return undefined;

	const sourceCode = mapToTranslateCode(original.language);
	if (!sourceCode) {
		// Source is neither en nor es (or undetected): skip rather than mistranslate.
		return undefined;
	}
	const targetCode: 'en' | 'es' = sourceCode === 'en' ? 'es' : 'en';

	const text = (original.transcript ?? [])
		.map((t) => t.text ?? '')
		.join(' ')
		.trim();
	if (!text) return undefined;

	const translated = await translator.translate(text, sourceCode, targetCode);
	if (!translated || !translated.trim()) return undefined;

	return buildTranslatedFrame(original, translated, targetCode);
}

export default AWSTranslateText;
