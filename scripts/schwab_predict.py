"""Run one read-only Schwab/Ocean Wave prediction and print compact JSON."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from option_wave.realtime import RealtimePredictor, validate_horizons


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--signal-published-at", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--horizons", default="5,15,30,60")
    parser.add_argument("--strike-count", type=int, default=40)
    parser.add_argument("--expiry")
    parser.add_argument("--strike", type=float)
    parser.add_argument("--option-type", choices=("call", "put"))
    parser.add_argument("--quote-only", action="store_true")
    args = parser.parse_args()

    with RealtimePredictor(Path(args.state_dir), async_checkpoints=False) as predictor:
        if args.quote_only:
            output = predictor.quote(
                symbol=args.symbol,
                signal_published_at=args.signal_published_at,
                access_token=os.getenv("SCHWAB_ACCESS_TOKEN", ""),
            )
        else:
            horizons = validate_horizons(tuple(float(value) for value in args.horizons.split(",") if value.strip()))
            output = predictor.predict(
                symbol=args.symbol,
                signal_published_at=args.signal_published_at,
                access_token=os.getenv("SCHWAB_ACCESS_TOKEN", ""),
                horizons=horizons,
                strike_count=args.strike_count,
                expiry=args.expiry,
                strike=args.strike,
                option_type=args.option_type,
                checkpoint_async=False,
            )
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
