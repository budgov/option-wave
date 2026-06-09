from __future__ import annotations

import matplotlib.pyplot as plt
import pandas as pd


def plot_contributions(contributions: dict[str, float], title: str, path: str) -> str:
    df = pd.DataFrame({"factor": list(contributions.keys()), "contribution": list(contributions.values())})
    plt.figure(figsize=(9, 6))
    plt.barh(df["factor"], df["contribution"])
    plt.axvline(0, linewidth=1)
    plt.title(title)
    plt.xlabel("Contribution")
    plt.tight_layout()
    plt.savefig(path, dpi=180, bbox_inches="tight")
    plt.close()
    return path


def plot_forecast_path(rows: list[dict], title: str, path: str) -> str:
    df = pd.DataFrame(rows)
    x = df.iloc[:, 0]
    plt.figure(figsize=(9, 5.5))
    for col in df.columns[1:]:
        plt.plot(x, df[col], marker="o", label=col)
    plt.title(title)
    plt.ylabel("Price")
    plt.legend()
    plt.tight_layout()
    plt.savefig(path, dpi=180, bbox_inches="tight")
    plt.close()
    return path
