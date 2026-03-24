from middleware import get_remaining_slots as _canonical

def get_remaining_slots(tier_limits, limit_type, current_count):
    """Thin wrapper that delegates to the canonical middleware implementation."""
    return _canonical(tier_limits, limit_type, current_count)

def check_permission(user, action):
    """Unrelated function — no alias involvement."""
    pass
