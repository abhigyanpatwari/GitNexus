class Formatter:
    def format(self, value: str) -> str:
        return value.upper()

    def format_with_prefix(self, value: str, prefix: str) -> str:
        return prefix + value.upper()

def format_text(text: str) -> str:
    return text.strip()

def format_text_with_width(text: str, width: int) -> str:
    return text.strip().ljust(width)
