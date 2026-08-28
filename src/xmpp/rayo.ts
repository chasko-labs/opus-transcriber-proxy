import { EventEmitter } from 'events';
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import logger from '../logger';
import type { XmppConfig } from './client';

/**
 * Represents an active Rayo transcription session initiated by Jicofo.
 * When Jicofo dials us via Rayo, we create a RayoSession that tracks the
 * conference room and call lifecycle.
 */
export class RayoSession extends EventEmitter {
	public readonly callId: string;
	public readonly roomJid: string;
	public readonly from: string;
	private closed = false;

	constructor(callId: string, roomJid: string, from: string) {
		super();
		this.callId = callId;
		this.roomJid = roomJid;
		this.from = from;
	}

	/**
	 * Send a transcription event as a JSON message to the MUC room.
	 * This is how transcription results are delivered back to the conference.
	 */
	sendTranscriptionEvent(xmpp: any, mucDomain: string, data: Record<string, unknown>): void {
		if (this.closed) return;

		const message = xml(
			'message',
			{ to: this.roomJid, type: 'groupchat' },
			xml('json-message', { xmlns: 'http://jitsi.org/jitmeet' }, JSON.stringify(data)),
		);

		xmpp.send(message).catch((err: Error) => {
			logger.error(`[Rayo] Failed to send transcription event for ${this.callId}: ${err.message}`);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit('closed');
	}

	get isClosed(): boolean {
		return this.closed;
	}
}

/**
 * Handle an incoming Rayo dial IQ from Jicofo.
 * Jicofo sends a dial when a user requests transcription (CC button).
 *
 * Expected IQ format:
 *   <iq type="set" from="jicofo@..." id="...">
 *     <dial xmlns="urn:xmpp:rayo:1" to="room@conference.meet.jitsi" from="...">
 *       <header name="JvbRoomName" value="room@conference.meet.jitsi"/>
 *     </dial>
 *   </iq>
 */
export function handleRayoDial(
	stanza: Element,
	xmpp: any,
	config: XmppConfig,
): RayoSession | null {
	const from = stanza.attrs.from;
	const id = stanza.attrs.id;
	const dialChild = stanza.getChild('dial', 'urn:xmpp:rayo:1');

	if (!dialChild) {
		logger.error('[Rayo] Dial IQ missing <dial> child');
		sendIqError(xmpp, from, id, 'bad-request');
		return null;
	}

	// Extract the room JID from the dial "to" attribute or header
	let roomJid = dialChild.attrs.to || '';

	// Also check headers for JvbRoomName (Jicofo's convention)
	const headers = dialChild.getChildren('header');
	for (const header of headers) {
		if (header.attrs.name === 'JvbRoomName' && header.attrs.value) {
			roomJid = header.attrs.value;
			break;
		}
	}

	if (!roomJid) {
		logger.error('[Rayo] Dial IQ missing room JID (no "to" attr or JvbRoomName header)');
		sendIqError(xmpp, from, id, 'bad-request');
		return null;
	}

	// Generate a unique call ID for this session
	const callId = `otp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	logger.info(`[Rayo] Accepting dial: callId=${callId} room=${roomJid} from=${from}`);

	// Send success result IQ back to Jicofo
	const resultIq = xml(
		'iq',
		{ type: 'result', to: from, id },
		xml('ref', {
			xmlns: 'urn:xmpp:rayo:1',
			uri: `xmpp:${callId}@${config.domain}`,
		}),
	);
	xmpp.send(resultIq).catch((err: Error) => {
		logger.error(`[Rayo] Failed to send dial result: ${err.message}`);
	});

	// Create and return the session
	const session = new RayoSession(callId, roomJid, from);
	return session;
}

/**
 * Handle an incoming Rayo hangup IQ.
 * Jicofo sends this when transcription should stop for a conference.
 */
export function handleRayoHangup(
	stanza: Element,
	sessions: Map<string, RayoSession>,
	xmpp: any,
): void {
	const from = stanza.attrs.from;
	const id = stanza.attrs.id;

	// Find the session to hang up — check the "to" attribute for the call URI,
	// or fall back to closing the session associated with this Jicofo
	const hangupChild = stanza.getChild('hangup', 'urn:xmpp:rayo:1');
	const targetUri = hangupChild?.attrs.uri || '';

	let sessionToClose: RayoSession | undefined;

	// Try to match by call ID extracted from URI
	if (targetUri) {
		const callIdMatch = targetUri.match(/^xmpp:([^@]+)@/);
		if (callIdMatch) {
			sessionToClose = sessions.get(callIdMatch[1]);
		}
	}

	// Fall back: close the session initiated by this Jicofo instance
	if (!sessionToClose) {
		for (const [, session] of sessions) {
			if (session.from === from) {
				sessionToClose = session;
				break;
			}
		}
	}

	if (sessionToClose) {
		logger.info(`[Rayo] Hanging up session: callId=${sessionToClose.callId}`);
		sessionToClose.close();
	} else {
		logger.warn(`[Rayo] Hangup received but no matching session found (from=${from})`);
	}

	// Send result IQ (acknowledge the hangup regardless)
	const resultIq = xml('iq', { type: 'result', to: from, id });
	xmpp.send(resultIq).catch((err: Error) => {
		logger.error(`[Rayo] Failed to send hangup result: ${err.message}`);
	});
}

/**
 * Send an IQ error response.
 */
function sendIqError(xmpp: any, to: string, id: string, condition: string): void {
	const errorIq = xml(
		'iq',
		{ type: 'error', to, id },
		xml('error', { type: 'cancel' },
			xml(condition, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
		),
	);
	xmpp.send(errorIq).catch(() => {});
}
