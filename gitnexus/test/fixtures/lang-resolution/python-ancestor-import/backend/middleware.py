def get_remaining_slots(tier_limits, limit_type, current_count):
    """Canonical implementation in the backend root."""
    limit = tier_limits.get(limit_type, -1)
    if limit == -1:
        return float("inf")
    return max(0, limit - current_count)

def enforce_rate_limit(org_id):
    """Another function in middleware."""
    pass
