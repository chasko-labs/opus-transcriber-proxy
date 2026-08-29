import { EventEmitter } from 'events';
import { client, xml, jid } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import logger from '../logger';
import { handleRayoDial, handleRayoHangup, type RayoSession } from './rayo';

export interface XmppConfig {
	host: string;
	port: number;
	domain: string;
	authDomain: string;
	internalMucDomain: string;
	username: string;
	password: string;
	breweryRoom: string;
}

export class XmppClient extends EventEmitter {
	private xmpp: ReturnType<typeof client> | null = null;
	private config: XmppConfig;
	private connected = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingInterval: ReturnType<typeof setInterval> | null = null;
	// Whitespace keepalive fires well below Prosody's ~5s c2s reap window.
	// The 30s XEP-0199 IQ ping is far too slow — the socket died 6x before the
	// first ping ever fired. This raw '\n' write keeps the c2s session hot.
	private whitespaceTimer: ReturnType<typeof setInterval> | null = null;
	private stopping = false;
	private fullJid: string | null = null;
	// Stable resource for the lifetime of the process. Reconnects reuse the SAME
	// resource so the brewery presence is REPLACED, not duplicated. A new
	// otp-<timestamp> per reconnect left ghost jigasi instances in the brewery
	// that Jicofo then routed transcription requests to — those dead instances
	// never answered, producing "Transcribing failed".
	private readonly resource = `otp-${process.pid}-${Date.now()}`;
	public sessions: Map<string, RayoSession> = new Map();

	constructor(xmppConfig: XmppConfig) {
		super();
		this.config = xmppConfig;
	}

	async start(): Promise<void> {
		this.stopping = false;

		// SINGLE RECONNECT OWNER: @xmpp/client auto-loads @xmpp/reconnect, which
		// re-opens the stream on the SAME entity when it emits 'disconnect'. We
		// build the client exactly ONCE here and never tear it down on reconnect.
		// The previous code called this.xmpp.stop() at the top of every start(),
		// which raced the built-in reconnect (two lifecycle managers fighting)
		// and leaked sockets. If start() is somehow re-entered while a client
		// already exists, leave the existing one alone — reconnect owns it.
		if (this.xmpp) {
			logger.warn('[XMPP] start() called with an existing client; built-in reconnect owns the lifecycle, skipping rebuild');
			return;
		}

		const jidStr = `${this.config.username}@${this.config.authDomain}/${this.resource}`;

		logger.info(`[XMPP] Connecting as ${jidStr} to ${this.config.host}:${this.config.port}`);

		this.xmpp = client({
			service: `xmpp://${this.config.host}:${this.config.port}`,
			domain: this.config.authDomain,
			resource: this.resource,
			username: this.config.username,
			password: this.config.password,
		});

		this.xmpp.on('online', async (address) => {
			this.fullJid = address.toString();
			this.connected = true;
			logger.info(`[XMPP] Connected as ${this.fullJid}`);
			// OBSERVABILITY: report whether stream management (XEP-0198 smacks)
			// negotiated. @xmpp/client auto-sends <enable/> but swallows failure
			// silently — if Prosody's mod_smacks is not advertised there is no
			// smacks acking AND no whitespace keepalive from the plugin, which is
			// a prime suspect for the ~5s socket reap. On 0.13.6 the state lives
			// at this.xmpp.streamManagement.enabled.
			try {
				const sm = (this.xmpp as { streamManagement?: { enabled?: boolean } }).streamManagement;
				if (sm && typeof sm.enabled === 'boolean') {
					logger.info(`[XMPP] stream-management enabled=${sm.enabled}`);
				} else {
					logger.info('[XMPP] stream-management enabled=unknown (streamManagement.enabled not readable in @xmpp/client 0.13.6)');
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.info(`[XMPP] stream-management enabled=unknown (read failed: ${msg})`);
			}
			// Send initial self-presence FIRST to establish this as a live c2s
			// session. Without it, Prosody treats the bound resource as never
			// having come online and closes the stream after ~5s — which showed
			// up as a clean "Disconnected" every 5 seconds with no error.
			try {
				await this.xmpp.send(xml('presence', {}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn(`[XMPP] Initial presence failed: ${msg}`);
			}
			await this.joinBrewery();
			this.startPingInterval();
		});

		this.xmpp.on('offline', () => {
			this.connected = false;
			this.fullJid = null;
			this.stopPingInterval();
			logger.info('[XMPP] Disconnected');
			// NO app-level reconnect here. @xmpp/client's built-in @xmpp/reconnect
			// listens for the same 'disconnect' and re-opens the stream on this
			// entity, re-emitting 'online' (which re-sends presence + rejoins the
			// brewery — the 'online' handler is idempotent). A second reconnect
			// path here would race it and leak sockets.
		});

		this.xmpp.on('error', (err: Error) => {
			logger.error(`[XMPP] Error: ${err.message}`);
		});

		this.xmpp.on('stanza', (stanza: Element) => {
			this.handleStanza(stanza);
		});

		try {
			await this.xmpp.start();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`[XMPP] Failed to start: ${msg}`);
			// INITIAL-CONNECT failure only. Built-in @xmpp/reconnect does NOT retry
			// a connection that never came online (it only fires on 'disconnect'
			// after a prior success), so this fallback covers the disjoint case of
			// Prosody not being reachable at boot. Null the client so the retry can
			// rebuild cleanly past the start() "existing client" guard.
			try {
				await this.xmpp.stop();
			} catch {
				// ignore — the start already failed
			}
			this.xmpp = null;
			this.scheduleReconnect();
		}
	}

	/**
	 * Join the brewery MUC room with the CORRECT presence format that Jicofo's
	 * BaseBrewery.java recognizes.
	 *
	 * Jicofo looks for:
	 *   <stats xmlns="http://jitsi.org/protocol/colibri">
	 *     <stat name="..." value="..."/>
	 *   </stats>
	 *   <jigasi-status xmlns="http://jitsi.org/protocol/jigasi">idle</jigasi-status>
	 *
	 * NOT "stats-id" — that element name is not processed by BaseBrewery.
	 */
	private async joinBrewery(): Promise<void> {
		if (!this.xmpp || !this.fullJid) return;

		const roomJid = `${this.config.breweryRoom}@${this.config.internalMucDomain}`;
		const nick = jid(this.fullJid).getResource() || `otp-${Date.now()}`;
		const to = `${roomJid}/${nick}`;

		logger.info(`[XMPP] Joining brewery MUC: ${to}`);

		const presence = xml(
			'presence',
			{ to, xmlns: 'jabber:client' },
			xml('x', { xmlns: 'http://jabber.org/protocol/muc' }),
			xml(
				'stats',
				{ xmlns: 'http://jitsi.org/protocol/colibri' },
				xml('stat', { name: 'location', value: process.env.AWS_REGION || 'us-west-2' }),
				xml('stat', { name: 'version', value: 'opus-transcriber-proxy' }),
			),
			// Jigasi status: "idle" means ready to accept new sessions
			xml('jigasi-status', { xmlns: 'http://jitsi.org/protocol/jigasi' }, 'idle'),
		);

		await this.xmpp.send(presence);
		logger.info('[XMPP] Brewery presence sent with correct stats format');
	}

	/**
	 * Update jigasi status in the brewery (e.g. when a session is active).
	 */
	async updateBreweryStatus(status: 'idle' | 'busy'): Promise<void> {
		if (!this.xmpp || !this.fullJid) return;

		const roomJid = `${this.config.breweryRoom}@${this.config.internalMucDomain}`;
		const nick = jid(this.fullJid).getResource() || `otp-${Date.now()}`;
		const to = `${roomJid}/${nick}`;

		const presence = xml(
			'presence',
			{ to, xmlns: 'jabber:client' },
			xml(
				'stats',
				{ xmlns: 'http://jitsi.org/protocol/colibri' },
				xml('stat', { name: 'location', value: process.env.AWS_REGION || 'us-west-2' }),
				xml('stat', { name: 'version', value: 'opus-transcriber-proxy' }),
			),
			xml('jigasi-status', { xmlns: 'http://jitsi.org/protocol/jigasi' }, status),
		);

		await this.xmpp.send(presence);
		logger.debug(`[XMPP] Updated brewery status to: ${status}`);
	}

	/**
	 * Leave the brewery MUC room by sending unavailable presence.
	 */
	private async leaveBrewery(): Promise<void> {
		if (!this.xmpp || !this.fullJid) return;

		const roomJid = `${this.config.breweryRoom}@${this.config.internalMucDomain}`;
		const nick = jid(this.fullJid).getResource() || `otp-${Date.now()}`;
		const to = `${roomJid}/${nick}`;

		const presence = xml('presence', { to, type: 'unavailable' });
		try {
			await this.xmpp.send(presence);
			logger.info('[XMPP] Left brewery MUC');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn(`[XMPP] Error leaving brewery: ${msg}`);
		}
	}

	/**
	 * Keepalive. Two timers:
	 *  - 3s whitespace ping: a single raw '\n' written to the socket. This fires
	 *    strictly below Prosody's ~5s c2s reap window and is what actually keeps
	 *    the session alive. The prior 30s XEP-0199 IQ ping was far too slow — the
	 *    socket was reaped ~6x before the first IQ ping ever fired.
	 *  - 30s XEP-0199 ping IQ: retained as a higher-level liveness check that also
	 *    detects a half-open connection (no reply => something is wrong).
	 */
	private startPingInterval(): void {
		this.stopPingInterval();

		// 3s raw whitespace keepalive — below the ~5s teardown.
		this.whitespaceTimer = setInterval(() => {
			if (!this.connected) return;
			try {
				// @xmpp/client 0.13.x exposes the live connection socket on the
				// entity (@xmpp/connection sets this.socket and offers a raw
				// write()). A lone newline is ignorable XML stream whitespace per
				// RFC 6120 and resets Prosody's inactivity timer.
				const sock = (this.xmpp as { socket?: { write?: (s: string, cb?: (err?: Error) => void) => void } }).socket;
				if (sock?.write) {
					sock.write('\n', (err?: Error) => {
						if (err) {
							logger.warn(`[XMPP] Whitespace keepalive write failed: ${err.message}`);
						}
					});
				} else {
					// No raw socket write exposed — fall back to a no-op presence
					// probe to the server we are bound to. Prosody ignores a bare
					// self-presence beyond refreshing session liveness.
					this.xmpp?.send(xml('presence', {})).catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						logger.warn(`[XMPP] Whitespace-fallback presence failed: ${msg}`);
					});
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn(`[XMPP] Whitespace keepalive error: ${msg}`);
			}
		}, 3_000);

		this.pingInterval = setInterval(async () => {
			if (!this.xmpp || !this.connected) return;
			try {
				// Ping the server we are actually connected to (authDomain), not
				// the muc/app domain. Pinging meet.jitsi from an auth.meet.jitsi
				// connection got no reply, so the connection was declared dead
				// every ~5 min (connection-timeout), forcing a reconnect and a
				// fresh brewery presence.
				const pingIq = xml(
					'iq',
					{ type: 'get', to: this.config.authDomain, id: `ping-${Date.now()}` },
					xml('ping', { xmlns: 'urn:xmpp:ping' }),
				);
				await this.xmpp.send(pingIq);
				logger.debug('[XMPP] Ping sent');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn(`[XMPP] Ping failed: ${msg}`);
			}
		}, 30_000);
	}

	private stopPingInterval(): void {
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
		if (this.whitespaceTimer) {
			clearInterval(this.whitespaceTimer);
			this.whitespaceTimer = null;
		}
	}

	/**
	 * Route incoming stanzas to the appropriate handler.
	 */
	private handleStanza(stanza: Element): void {
		const stanzaName = stanza.name;

		if (stanzaName === 'iq') {
			this.handleIq(stanza);
		} else if (stanzaName === 'presence') {
			logger.debug(`[XMPP] Presence from ${stanza.attrs.from}: type=${stanza.attrs.type || 'available'}`);
		} else if (stanzaName === 'message') {
			logger.debug(`[XMPP] Message from ${stanza.attrs.from}`);
		}
	}

	/**
	 * Handle IQ stanzas — routes Rayo namespace IQs to the rayo handler.
	 */
	private handleIq(stanza: Element): void {
		const iqType = stanza.attrs.type;
		const from = stanza.attrs.from;
		const id = stanza.attrs.id;

		// Handle ping responses (result to our pings)
		if (iqType === 'result' && id?.startsWith('ping-')) {
			logger.debug('[XMPP] Ping response received');
			return;
		}

		// Handle ping requests from server (XEP-0199)
		const pingChild = stanza.getChild('ping', 'urn:xmpp:ping');
		if (iqType === 'get' && pingChild) {
			// Reply with empty result
			const pong = xml('iq', { type: 'result', to: from, id });
			this.xmpp?.send(pong).catch(() => {});
			return;
		}

		// Handle Rayo dial (Jicofo asking us to join a conference for transcription)
		// Jicofo uses 'urn:xmpp:rayo:1' namespace for the dial IQ.
		const dialChild = stanza.getChild('dial', 'urn:xmpp:rayo:1');
		if (iqType === 'set' && dialChild) {
			logger.info(`[XMPP] Rayo dial from ${from}`);
			const session = handleRayoDial(stanza, this.xmpp!, this.config);
			if (session) {
				this.sessions.set(session.callId, session);
				session.on('closed', () => {
					this.sessions.delete(session.callId);
					// Update brewery status back to idle when session closes
					if (this.sessions.size === 0) {
						this.updateBreweryStatus('idle').catch(() => {});
					}
				});
				// Update brewery status to busy
				this.updateBreweryStatus('busy').catch(() => {});
				this.emit('rayo:session', session);
			}
			return;
		}

		// Handle Rayo hangup
		const hangupChild = stanza.getChild('hangup', 'urn:xmpp:rayo:1');
		if (iqType === 'set' && hangupChild) {
			logger.info(`[XMPP] Rayo hangup from ${from}`);
			handleRayoHangup(stanza, this.sessions, this.xmpp!);
			return;
		}

		// Unknown IQ — respond with feature-not-implemented if it's a get/set
		if (iqType === 'get' || iqType === 'set') {
			logger.warn(`[XMPP] Unknown IQ ${iqType} from ${from}: ${stanza.toString().slice(0, 200)}`);
			const errorReply = xml(
				'iq',
				{ type: 'error', to: from, id },
				xml('error', { type: 'cancel' }, xml('feature-not-implemented', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' })),
			);
			this.xmpp?.send(errorReply).catch(() => {});
		}
	}

	/**
	 * Schedule a reconnection attempt after a delay.
	 */
	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.stopping) return;
		logger.info('[XMPP] Scheduling reconnect in 5s...');
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (!this.stopping) {
				await this.start();
			}
		}, 5000);
	}

	/**
	 * Gracefully stop the XMPP client.
	 */
	async stop(): Promise<void> {
		this.stopping = true;
		this.stopPingInterval();

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		// Close all active rayo sessions
		for (const [, session] of this.sessions) {
			session.close();
		}
		this.sessions.clear();

		await this.leaveBrewery();

		if (this.xmpp) {
			try {
				await this.xmpp.stop();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.warn(`[XMPP] Error during stop: ${msg}`);
			}
			this.xmpp = null;
		}

		this.connected = false;
		this.fullJid = null;
		logger.info('[XMPP] Client stopped');
	}
}
