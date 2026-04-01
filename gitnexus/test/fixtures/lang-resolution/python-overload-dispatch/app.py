from service import Formatter, format_text, format_text_with_width

def run():
    f = Formatter()
    result1 = f.format("hello")
    result2 = f.format_with_prefix("hello", ">>")
    plain = format_text("  hi  ")
    padded = format_text_with_width("hi", 20)
