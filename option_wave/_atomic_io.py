"""Small cross-platform helpers for durable local state replacement."""

from __future__ import annotations

import errno
import os
from os import PathLike
from time import sleep

REPLACE_ATTEMPTS = 8
REPLACE_BASE_DELAY_SECONDS = 0.01
REPLACE_MAX_DELAY_SECONDS = 0.25
RETRYABLE_REPLACE_ERRNOS = frozenset({errno.EPERM, errno.EACCES, errno.EBUSY})


def replace_with_retry(source: str | PathLike[str], target: str | PathLike[str]) -> None:
    """Atomically replace a file, tolerating short antivirus/indexer locks."""

    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(source, target)
            return
        except OSError as error:
            final_attempt = attempt + 1 >= REPLACE_ATTEMPTS
            if error.errno not in RETRYABLE_REPLACE_ERRNOS or final_attempt:
                raise
            sleep(min(REPLACE_MAX_DELAY_SECONDS, REPLACE_BASE_DELAY_SECONDS * (2 ** attempt)))


__all__ = ["replace_with_retry"]
