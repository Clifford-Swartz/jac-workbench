"""Token-based authentication for WebSocket connections."""

import hmac


def validate_token(provided: str, expected: str) -> bool:
    """Constant-time comparison to prevent timing attacks."""
    if not expected:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())
