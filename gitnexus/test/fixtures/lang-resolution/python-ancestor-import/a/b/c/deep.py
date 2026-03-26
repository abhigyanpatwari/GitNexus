from utils import format_currency

def render_price(amount):
    """Depth-2 ancestor import: a/b/c/deep.py imports utils from a/utils.py."""
    return format_currency(amount)
