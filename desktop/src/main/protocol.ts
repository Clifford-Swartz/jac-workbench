/** WebSocket protocol types — mirrors server/protocol.py */

// ── Client → Server ──────────────────────────────────────────────────────────

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export type ClientMessage =
    | { type: 'auth'; token: string; client_id?: string }
    | { type: 'query'; prompt: string; images?: Array<{data: string; mediaType: string}>; cwd?: string; session_id?: string }
    | { type: 'new_conversation'; session_id?: string }
    | { type: 'abort_query'; session_id?: string }
    | { type: 'ping' }
    | { type: 'permission_response'; request_id: string; allow: boolean; session_id?: string }
    | { type: 'set_permission_mode'; mode: PermissionMode; session_id?: string }
    | { type: 'set_model'; model: string; session_id?: string }
    | { type: 'tool_result_response'; tool_id: string; content: string; is_error: boolean; session_id?: string };

// ── Server → Client ──────────────────────────────────────────────────────────

export type ServerMessage =
    | { type: 'auth_ok' }
    | { type: 'assistant_text_delta'; text: string; session_id?: string }
    | { type: 'assistant_text'; text: string; model: string; session_id?: string }
    | { type: 'tool_use'; tool_name: string; tool_use_id: string; args: Record<string, unknown>; session_id?: string }
    | { type: 'tool_result'; tool_use_id: string; content: string | null; is_error: boolean; session_id?: string }
    | { type: 'thinking'; text: string; session_id?: string }
    | { type: 'result'; session_id: string; duration_ms: number; total_cost_usd: number | null; num_turns: number; is_error: boolean; usage?: { input_tokens?: number; output_tokens?: number } }
    | { type: 'system'; subtype: string; session_id?: string }
    | { type: 'done'; session_id?: string }
    | { type: 'error'; message: string; session_id?: string }
    | { type: 'conversation_reset'; session_id?: string }
    | { type: 'pong' }
    | { type: 'permission_request'; request_id: string; tool_name: string; tool_input: Record<string, unknown>; session_id?: string }
    | { type: 'permission_mode_changed'; mode: PermissionMode; session_id?: string }
    | { type: 'models_list'; models: Array<{id: string; label: string}>; current_model: string }
    | { type: 'tool_execute'; tool_id: string; tool_name: string; tool_input: Record<string, unknown>; session_id?: string };

// Injected by extension host, not from server
export type ConnectionStatus = { type: 'connection_status'; status: 'connecting' | 'connected' | 'disconnected' | 'error' };

export type WebviewMessage = ServerMessage | ConnectionStatus;
