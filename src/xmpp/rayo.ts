/**
 * Rayo protocol (XEP-0327) handler for Jitsi transcription.
 *
 * Jitsi's web client sends a Rayo <dial> IQ to start transcription.
 * This module handles:
 * - Accepting dial requests (responding with <ref>)
 * - Creating a RayoSession that bridges XMPP presence events to the
 *   existing WebSocket transcription pipeline
 * - Handling hangup requests to tear down sessions
 *
 * The Rayo dial from Jitsi looks like:
 * <iq type="set" to="jitsi_meet_transcribe.meet.jitsi" from="...">
 *   <dial xmlns="urn:xmpp:rayo:1">
 *     <header name="JvbRoomName" value="roomname@conference.meet.jitsi"/>
 *   </dial>
 * </iq>
 */
import { xml } from '@xmpp/component';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import logger from '../logger';
import type { XmppComponent } from './component';

const RAYO_NS = 'urn:xmpp:rayo:1';
const OOBAND_NS = 'urn:ooband:oob-otp:otp1';

/**
 * A single Rayo transcription session. Created when a dial arrives,
 * destroyed on hangup or error.
 */
export class RayoSession extends EventEmitter {
	readonly callId: string;
	readonly roomJid: string;
	readonly initiator: string;
	private closed = false;
	private component: XmppComponent;

	constructor(component: XmppComponent, callId: string, roomJid: string, initiator: string) {
		super();
		this.component = component;
		this.callId = callId;
		this.roomJid = roomJid;
		this.initiator = initiator;
	}

	/**
	 * Send a transcription event back to the MUC as a Jigasi-compatible
	 * transcript event presence stanza.
	 */
	async sendTranscriptionEvent(
		participant: { id: string; name?: string },
		text: string,
		isInterim: boolean,
		language?: string,
		messageId?: string,
	): Promise<void> {
		if (this.closed) return;

		const transcriptEvent = xml(
			'message',
			{
				type: 'groupchat',
				to: this.roomJid,
			},
			xml(
				'json-message',
				{ xmlns: 'http://jitsi.org/jitmeet' },
				JSON.stringify({
					type: 'transcription-result',
					message_id: messageId || randomUUID(),
					participant: { id: participant.id, name: participant.name },
					transcript: [{ text }],
					language: language || 'en',
					is_interim: isInterim,
				}),
			),
		);

		try {
			await this.component.send(transcriptEvent);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`[Rayo:${this.callId}] Failed to send transcription event: ${msg}`);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit('closed');
		this.removeAllListeners();
	}

	isClosed(): boolean {
		return this.closed;
	}
}

/**
 * Handle an incoming IQ stanza and dispatch to the appropriate Rayo handler.
 */
export function handleRayoStanza(component: XmppComponent, iq: any): void {
	const type = iq.attrs?.type;
	const id = iq.attrs?.id;
	const from = iq.attrs?.from;
	const to = iq.attrs?.to;

	if (type !== 'set') {
		// Rayo only uses IQ type=set; ignore get/result/error
		return;
	}

	// Check for <dial> child
	const dial = iq.getChild('dial', RAYO_NS);
	if (dial) {
		handleDial(component, iq, dial, id, from, to);
		return;
	}

	// Check for <hangup> child (on an existing call URI)
	const hangup = iq.getChild('hangup', RAYO_NS);
	if (hangup) {
		handleHangup(component, iq, id, from, to);
		return;
	}

	// Unknown IQ set — respond with feature-not-implemented
	sendIqError(component, id, from, to, 'feature-not-implemented');
}

/**
 * Handle a Rayo <dial> IQ. Extract the room JID from headers and create a session.
 */
function handleDial(component: XmppComponent, iq: any, dial: any, id: string, from: string, to: string): void {
	// Extract room name from dial headers
	let roomJid = '';

	// Jitsi puts room info in <header> elements
	const headers = dial.getChildren('header');
	for (const header of headers) {
		const name = header.attrs?.name;
		const value = header.attrs?.value;
		if (name === 'JvbRoomName' && value) {
			roomJid = value;
		}
	}

	if (!roomJid) {
		// Try the 'to' attribute of the dial element itself
		roomJid = dial.attrs?.to || '';
	}

	if (!roomJid) {
		logger.warn(`[Rayo] Dial from ${from} missing room JID`);
		sendIqError(component, id, from, to, 'bad-request');
		return;
	}

	// Generate a unique call ID for this session
	const callId = randomUUID();
	const callUri = `xmpp:${callId}@${component['config']?.domain || 'jitsi_meet_transcribe'}`;

	logger.info(`[Rayo] Dial from ${from} for room ${roomJid} — callId=${callId}`);

	// Create the Rayo session
	const session = new RayoSession(component, callId, roomJid, from);
	component.sessions.set(callId, session);

	// Respond with <ref> (call accepted)
	const response = xml('iq', { type: 'result', id, from: to, to: from }, xml('ref', { xmlns: RAYO_NS, uri: callUri }));

	component.send(response).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[Rayo] Failed to send dial response: ${msg}`);
	});

	// Emit event so the server can wire this session to the transcription pipeline
	component.emit('rayo:session', session);
}

/**
 * Handle a Rayo <hangup> IQ. The hangup arrives addressed to the call URI.
 */
function handleHangup(component: XmppComponent, iq: any, id: string, from: string, to: string): void {
	// Extract call ID from the 'to' address (format: callId@component-domain)
	const toLocal = to?.split('@')[0] || '';
	// The callId might be prefixed with 'xmpp:' — strip it
	const callId = toLocal.replace(/^xmpp:/, '');

	const session = component.sessions.get(callId);
	if (!session) {
		logger.warn(`[Rayo] Hangup for unknown call ${callId} from ${from}`);
		sendIqError(component, id, from, to, 'item-not-found');
		return;
	}

	logger.info(`[Rayo] Hangup for call ${callId} from ${from}`);

	// Close the session
	session.close();
	component.sessions.delete(callId);

	// Respond with result (success)
	const response = xml('iq', { type: 'result', id, from: to, to: from });
	component.send(response).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[Rayo] Failed to send hangup response: ${msg}`);
	});
}

/**
 * Send an IQ error response.
 */
function sendIqError(component: XmppComponent, id: string, from: string, to: string, condition: string): void {
	const response = xml(
		'iq',
		{ type: 'error', id, from: to, to: from },
		xml('error', { type: 'cancel' }, xml(condition, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' })),
	);

	component.send(response).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[Rayo] Failed to send error response: ${msg}`);
	});
}
