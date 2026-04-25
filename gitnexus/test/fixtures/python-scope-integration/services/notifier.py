"""Wildcard import — exercises `from X import *`."""
from utils.logger import *


def emit_all():
    log_info("hello")
    log_error("oops", 2)
