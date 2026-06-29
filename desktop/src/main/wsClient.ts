import WebSocket from 'ws';
import { ServerMessage, ClientMessage } from './protocol.js';

function generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 12; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}

export class WSClient {
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalClose = false;
    private messageListeners: Set<(msg: any) => void> = new Set();

    /** Stable identifier for this VS Code extension instance */
    readonly clientId: string;
    /** Current conversation session — set by webviewProvider */
    sessionId: string;

    constructor(
        private serverUrl: string,
        private authToken: string,
        private callbacks: {
            onMessage: (msg: ServerMessage) => void;
            onStatusChange: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;
        },
    ) {
        this.clientId = generateId();
        this.sessionId = generateId();
    }

    connect(): void {
        this.intentionalClose = false;
        this.callbacks.onStatusChange('connecting');

        try {
            this.ws = new WebSocket(this.serverUrl, { maxPayload: 20 * 1024 * 1024 });
        } catch {
            this.callbacks.onStatusChange('error');
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            this.ws!.send(JSON.stringify({ type: 'auth', token: this.authToken, role: 'client', client_id: this.clientId }));
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const msg: ServerMessage = JSON.parse(data.toString());
                if (msg.type === 'auth_ok') {
                    this.callbacks.onStatusChange('connected');
                } else {
                    this.callbacks.onMessage(msg);
                    for (const listener of this.messageListeners) {
                        listener(msg);
                    }
                }
            } catch {
                // Ignore unparseable messages
            }
        });

        this.ws.on('close', () => {
            this.callbacks.onStatusChange('disconnected');
            if (!this.intentionalClose) {
                this.scheduleReconnect();
            }
        });

        this.ws.on('error', () => {
            this.callbacks.onStatusChange('error');
        });
    }

    send(msg: ClientMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            // Auto-inject session_id on messages that support it
            const enriched = msg.type !== 'auth' && msg.type !== 'ping'
                ? { ...msg, session_id: this.sessionId }
                : msg;
            this.ws.send(JSON.stringify(enriched));
        }
    }

    /** Subscribe to messages — returns a Disposable to unsubscribe. */
    onMessage(handler: (msg: any) => void): { dispose(): void } {
        this.messageListeners.add(handler);
        return { dispose: () => this.messageListeners.delete(handler) };
    }

    /** Send an arbitrary JSON message (for non-standard message types like greeting requests). */
    sendRaw(msg: Record<string, unknown>): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            const enriched = { ...msg, session_id: this.sessionId };
            this.ws.send(JSON.stringify(enriched));
        }
    }

    disconnect(): void {
        this.intentionalClose = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
    }

    updateConfig(serverUrl: string, authToken: string): void {
        this.serverUrl = serverUrl;
        this.authToken = authToken;
    }

    private scheduleReconnect(): void {
        if (this.intentionalClose) { return; }
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    }
}
