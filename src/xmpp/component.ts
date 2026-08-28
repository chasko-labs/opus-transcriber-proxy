/**
 * XMPP external component (XEP-0114) that registers as `jitsi_meet_transcribe`
 * on the local prosody instance. Handles Rayo dial/hangup IQ stanzas to bridge
 * Jitsi's native transcription path into the existing WebSocket pipeline.
 */
import { component, xml } from '@xmpp/component';
import { EventEmitter } from 'node:events';
import logger from '../logger';
import { handleRayoStanza, type RayoSession } from './rayo';

export interface XmppComponentConfig {
	host: string;
	port: number;
	domain: string;
	secret: string;
}

export class XmppComponent extends EventEmitter {
	private xmpp: ReturnType<typeof component> | null = null;
	private config: XmppComponentConfig;
	private connected = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private stopping = false;

	/** Active Rayo sessions keyed by call-id */
	readonly sessions = new Map<string, RayoSession>();

	constructor(config: XmppComponentConfig) {
		super();
		this.config = config;
	}

	/**
	 * Attempt to connect to prosody's component port. Non-blocking — if prosody
	 * is not ready, logs a warning and schedules reconnection.
	 */
	async start(): Promise<void> {
		if (!this.config.secret) {
			logger.warn('[XMPP] XMPP_COMPONENT_SECRET not set — XMPP component disabled');
			return;
		}

		logger.info(`[XMPP] Connecting to ${this.config.host}:${this.config.port} as ${this.config.domain}`);

		this.xmpp = component({
			service: `xmpp://${this.config.host}:${this.config.port}`,
			domain: this.config.domain,
			password: this.config.secret,
		});

		this.xmpp.on('online', (address) => {
			this.connected = true;
			logger.info(`[XMPP] Component online as ${address.toString()}`);
			this.emit('online');
		});

		this.xmpp.on('offline', () => {
			this.connected = false;
			logger.info('[XMPP] Component offline');
			this.emit('offline');
			this.scheduleReconnect();
		});

		this.xmpp.on('error', (err: Error) => {
			logger.error(`[XMPP] Component error: ${err.message}`);
			// Connection errors are non-fatal — we retry
			if (!this.connected) {
				this.scheduleReconnect();
			}
		});

		this.xmpp.on('stanza', (stanza) => {
			this.handleStanza(stanza);
		});

		try {
			await this.xmpp.start();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn(`[XMPP] Failed to connect (prosody may not be ready): ${msg}`);
			this.scheduleReconnect();
		}
	}

	/**
	 * Gracefully shut down the XMPP connection and all active Rayo sessions.
	 */
	async stop(): Promise<void> {
		this.stopping = true;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		// Hang up all active sessions
		for (const [callId, session] of this.sessions) {
			logger.info(`[XMPP] Closing Rayo session ${callId} on shutdown`);
			session.close();
			this.sessions.delete(callId);
		}

		if (this.xmpp) {
			try {
				await this.xmpp.stop();
			} catch {
				// Ignore errors during shutdown
			}
			this.xmpp = null;
		}

		this.connected = false;
	}

	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Send a stanza via the XMPP connection.
	 */
	async send(stanza: ReturnType<typeof xml>): Promise<void> {
		if (!this.xmpp || !this.connected) {
			throw new Error('XMPP component not connected');
		}
		await this.xmpp.send(stanza);
	}

	private handleStanza(stanza: any): void {
		// Only handle IQ stanzas (Rayo uses IQ set for dial/hangup)
		if (stanza.is('iq')) {
			handleRayoStanza(this, stanza);
			return;
		}

		// Log unexpected stanzas at debug level
		logger.debug(`[XMPP] Received ${stanza.name} stanza: ${stanza.toString()}`);
	}

	private scheduleReconnect(): void {
		if (this.stopping) return;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}

		const delay = 5000; // 5 seconds between reconnection attempts
		logger.info(`[XMPP] Will retry connection in ${delay / 1000}s`);

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (!this.stopping) {
				try {
					await this.start();
				} catch {
					// start() handles its own errors
				}
			}
		}, delay);
	}
}
