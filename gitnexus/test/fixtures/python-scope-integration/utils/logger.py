"""Logging helpers."""


def log_info(message: str) -> None:
    print(f"[info] {message}")


def log_error(message: str, code: int = 1) -> None:
    print(f"[error:{code}] {message}")


def log_with_extras(message: str, *args, **kwargs) -> None:
    print(message, args, kwargs)
