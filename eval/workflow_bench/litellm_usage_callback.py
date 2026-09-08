"""Append each upstream request's usage exactly as the provider reported it.

This runs INSIDE the LiteLLM proxy, on the far side of the translation that
turns an OpenAI response into the Anthropic shape Claude Code expects. That is
the only point that still knows which provider served the request, what model
actually answered, and what the native usage object said before its fields were
renamed into someone else's semantics.

Deliberately self-contained: the proxy loads this file by path from the config
directory, so it cannot assume ``workflow_bench`` is importable. Normalization
lives in workflow_bench.provider_usage and runs offline over what this writes -
the native object is the evidence, and deriving from it here would mean the
derivation could not be revisited without re-running a paid sweep.

Never raises. A cell that fails still spent money upstream, and losing the
accounting because the log write failed would be the worse outcome.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

# Literals, not imports. LiteLLM loads this file BY PATH from the config
# directory via spec_from_file_location, so it has no parent package and the
# directory is not on sys.path - a relative or sibling import raises
# ImportError and the proxy refuses to start. workflow_bench.provider_usage
# holds the canonical copies and a test asserts these agree with them, which
# catches drift without coupling at import time.
USAGE_LOG_ENV_VAR = "GITNEXUS_BENCH_PROVIDER_USAGE"
SWEEP_ID_ENV_VAR = "GITNEXUS_BENCH_SWEEP_ID"


def canonical_provider(label, call_type):  # noqa: ANN001, ANN201
    """Adapter key for the usage shape, or None when it cannot be resolved.

    Mirrors workflow_bench.provider_usage.canonical_provider; see the note
    above for why this is a copy rather than an import.
    """

    if label == "openai" and call_type and "responses" in call_type:
        return "openai-responses"
    if label == "anthropic":
        return "anthropic"
    return None

SCHEMA_VERSION = 1
_LOCK = threading.Lock()


def _plain(value: Any) -> Any:
    """Provider usage arrives as pydantic models; keep the shape, drop the class."""

    for attr in ("model_dump", "dict"):
        method = getattr(value, attr, None)
        if callable(method):
            try:
                return method()
            except Exception:
                pass
    if isinstance(value, dict):
        return value
    return None


class ProviderUsageLogger(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:  # noqa: ANN001
        self._append("success", kwargs, response_obj, start_time, end_time)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time) -> None:  # noqa: ANN001
        # Failed requests are billed too, and a sweep that only accounts for
        # successes understates what it spent.
        self._append("failure", kwargs, response_obj, start_time, end_time)

    def log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:  # noqa: ANN001
        self._append("success", kwargs, response_obj, start_time, end_time)

    def log_failure_event(self, kwargs, response_obj, start_time, end_time) -> None:  # noqa: ANN001
        # The synchronous counterpart. Overriding only the success hook here
        # recorded successes and let failures fall through to the base class,
        # which accounts for nothing - and a failed request is still billed, so
        # a sweep missing them understates what it spent.
        self._append("failure", kwargs, response_obj, start_time, end_time)

    def _append(self, status, kwargs, response_obj, start_time, end_time) -> None:  # noqa: ANN001
        path = os.environ.get(USAGE_LOG_ENV_VAR)
        if not path:
            return
        try:
            params = kwargs.get("litellm_params") or {}
            call_type = kwargs.get("call_type")
            provider_label = kwargs.get("custom_llm_provider") or params.get("custom_llm_provider")
            metadata = params.get("metadata") or {}
            event = {
                "schema_version": SCHEMA_VERSION,
                "status": status,
                # Identity. The REQUESTED model is the caller's role name and the
                # ACTUAL model is what answered; pricing must follow the second,
                # because several roles map onto one upstream model here.
                "requested_model": kwargs.get("model"),
                "actual_model": getattr(response_obj, "model", None),
                # Two fields, because they answer different questions. The raw
                # label is what LiteLLM said; "provider" is the adapter key,
                # which needs the call type too - LiteLLM reports "openai" for
                # both Chat Completions and Responses and those report usage
                # differently. Unresolvable stays None so normalize_usage
                # refuses rather than guessing token semantics.
                "provider_label": provider_label,
                "provider": canonical_provider(provider_label, call_type),
                "response_id": getattr(response_obj, "id", None),
                "call_type": call_type,
                "sweep_id": os.environ.get(SWEEP_ID_ENV_VAR),
                # The per-request half of identity, and the only thing that can
                # attribute a request to a cell: one proxy serves the whole
                # sweep, so anything read from the environment is the same for
                # every event. Recorded even when absent, because knowing the
                # attribution is unavailable is itself a fact about the run.
                "session_id": metadata.get("litellm_session_id") or metadata.get("session_id"),
                "started_at": str(start_time),
                "completed_at": str(end_time),
                # Verbatim. Not flattened, not renamed, not summed.
                "native_usage": _plain(getattr(response_obj, "usage", None)),
            }
            line = json.dumps(event, default=str) + "\n"
            with _LOCK, open(path, "a", encoding="utf-8") as handle:
                handle.write(line)
        except Exception:
            # Accounting is evidence, not control flow: never take the sweep down.
            return


handler = ProviderUsageLogger()
