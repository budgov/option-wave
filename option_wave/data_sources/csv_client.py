from __future__ import annotations

from io import BytesIO, StringIO

import pandas as pd

from .normalize import normalize_option_chain


def load_csv_chain(file_bytes: bytes, filename: str | None = None) -> pd.DataFrame:
    if not file_bytes:
        raise ValueError("Uploaded file is empty.")

    if filename and filename.lower().endswith(".csv"):
        raw = pd.read_csv(StringIO(file_bytes.decode("utf-8")))
    else:
        raw = pd.read_csv(BytesIO(file_bytes))

    return normalize_option_chain(raw)
