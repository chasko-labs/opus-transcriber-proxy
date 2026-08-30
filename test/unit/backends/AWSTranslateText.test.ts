/**
 * Tests for AWSTranslateText and the additive translation-caption logic (issue #99).
 *
 * The @aws-sdk/client-translate client is mocked so send() returns a controllable
 * TranslatedText (or throws). Tests assert:
 *  - mapToTranslateCode collapses en-US/es-US to en/es and rejects other languages
 *  - translate() returns the mocked TranslatedText and swallows errors (returns undefined)
 *  - buildTranslationCaption: a FINAL en-US produces a second frame in es-US (and vice versa)
 *  - interims produce NO translated frame
 *  - a translate error does not throw and yields no second frame (original is untouched)
 *  - the translated frame matches the transcription-result schema JVB Exporter consumes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';

// --- Mock the AWS SDK ------------------------------------------------------
// A shared controller lets each test set the translated text or force an error.
interface MockController {
	lastInput: any;
	translatedText: string | undefined;
	sendError: Error | undefined;
	sendCalls: number;
}

const controller: MockController = {
	lastInput: undefined,
	translatedText: undefined,
	sendError: undefined,
	sendCalls: 0,
};

vi.mock('@aws-sdk/client-translate', () => {
	class TranslateTextCommand {
		input: any;
		constructor(input: any) {
			this.input = input;
			controller.lastInput = input;
		}
	}
	class TranslateClient {
		async send(command: any) {
			controller.sendCalls++;
			if (controller.sendError) throw controller.sendError;
			return { TranslatedText: controller.translatedText };
		}
		destroy() {}
	}
	return { TranslateClient, TranslateTextCommand };
});

vi.mock('../../../src/logger', () => ({
	default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), isLevelEnabled: vi.fn(() => false) },
}));

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// Import after mocks are registered.
import { AWSTranslateText, mapToTranslateCode, toTranscribeLangTag, buildTranslationCaption } from '../../../src/backends/AWSTranslateText';

function finalMessage(text: string, language: string | undefined): TranscriptionMessage {
	return {
		transcript: [{ text }],
		is_interim: false,
		message_id: 'orig-id',
		type: 'transcription-result',
		event: 'transcription-result',
		participant: { id: 'abc123', tag: 'abc123-mic' },
		timestamp: 1000,
		...(language !== undefined && { language }),
	};
}

beforeEach(() => {
	controller.lastInput = undefined;
	controller.translatedText = undefined;
	controller.sendError = undefined;
	controller.sendCalls = 0;
});

describe('mapToTranslateCode', () => {
	it('maps en-US and es-US to 2-letter codes', () => {
		expect(mapToTranslateCode('en-US')).toBe('en');
		expect(mapToTranslateCode('es-US')).toBe('es');
	});

	it('collapses other regional variants by primary subtag', () => {
		expect(mapToTranslateCode('en-GB')).toBe('en');
		expect(mapToTranslateCode('es-ES')).toBe('es');
	});

	it('returns undefined for unsupported or missing languages', () => {
		expect(mapToTranslateCode('fr-FR')).toBeUndefined();
		expect(mapToTranslateCode(undefined)).toBeUndefined();
		expect(mapToTranslateCode('')).toBeUndefined();
	});
});

describe('toTranscribeLangTag', () => {
	it('maps 2-letter codes back to region-qualified tags', () => {
		expect(toTranscribeLangTag('en')).toBe('en-US');
		expect(toTranscribeLangTag('es')).toBe('es-US');
	});
});

describe('AWSTranslateText.translate', () => {
	it('returns the TranslatedText from the Translate service', async () => {
		controller.translatedText = 'hola mundo';
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		const out = await t.translate('hello world', 'en', 'es');
		expect(out).toBe('hola mundo');
		expect(controller.lastInput).toEqual({ Text: 'hello world', SourceLanguageCode: 'en', TargetLanguageCode: 'es' });
	});

	it('returns undefined (and does not throw) when the service errors', async () => {
		controller.sendError = new Error('ThrottlingException');
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		const out = await t.translate('hello', 'en', 'es');
		expect(out).toBeUndefined();
	});

	it('skips empty text without calling the service', async () => {
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		const out = await t.translate('   ', 'en', 'es');
		expect(out).toBeUndefined();
		expect(controller.sendCalls).toBe(0);
	});
});

describe('buildTranslationCaption', () => {
	it('produces an es-US frame from a final en-US transcript', async () => {
		controller.translatedText = 'hola mundo';
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		const frame = await buildTranslationCaption(finalMessage('hello world', 'en-US'), t);
		expect(frame).toBeDefined();
		expect(frame!.language).toBe('es-US');
		expect(frame!.transcript).toEqual([{ text: 'hola mundo' }]);
		expect(frame!.is_interim).toBe(false);
		expect(frame!.type).toBe('transcription-result');
		expect(frame!.event).toBe('transcription-result');
		// participant preserved; message_id distinct from the original frame
		expect(frame!.participant).toEqual({ id: 'abc123', tag: 'abc123-mic' });
		expect(frame!.message_id).not.toBe('orig-id');
		// Translate was asked to go en->es
		expect(controller.lastInput.SourceLanguageCode).toBe('en');
		expect(controller.lastInput.TargetLanguageCode).toBe('es');
	});

	it('produces an en-US frame from a final es-US transcript', async () => {
		controller.translatedText = 'hello world';
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		const frame = await buildTranslationCaption(finalMessage('hola mundo', 'es-US'), t);
		expect(frame).toBeDefined();
		expect(frame!.language).toBe('en-US');
		expect(frame!.transcript).toEqual([{ text: 'hello world' }]);
		expect(controller.lastInput.SourceLanguageCode).toBe('es');
		expect(controller.lastInput.TargetLanguageCode).toBe('en');
	});

	it('produces NO translated frame for an interim', async () => {
		controller.translatedText = 'hola';
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		const interim: TranscriptionMessage = { ...finalMessage('hello', 'en-US'), is_interim: true };
		const frame = await buildTranslationCaption(interim, t);
		expect(frame).toBeUndefined();
		// Translate should not even be called for interims.
		expect(controller.sendCalls).toBe(0);
	});

	it('produces NO translated frame for an unsupported source language', async () => {
		controller.translatedText = 'whatever';
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		const frame = await buildTranslationCaption(finalMessage('bonjour', 'fr-FR'), t);
		expect(frame).toBeUndefined();
		expect(controller.sendCalls).toBe(0);
	});

	it('does not suppress or throw when the translate call fails', async () => {
		controller.sendError = new Error('service unavailable');
		const t = new AWSTranslateText(new (await import('@aws-sdk/client-translate')).TranslateClient() as any);
		// Should resolve to undefined (no second frame) rather than reject; the caller
		// has already emitted the original caption, which is untouched.
		await expect(buildTranslationCaption(finalMessage('hello', 'en-US'), t)).resolves.toBeUndefined();
	});
});
