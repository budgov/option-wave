from __future__ import annotations

import numpy as np
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


def plot_field_surface(
    field: np.ndarray,
    distances: np.ndarray,
    expiries: np.ndarray,
    title: str,
    path: str,
) -> str:
    """Render the v0.9 expiry x distance field as a 3D surface."""

    x, y = np.meshgrid(distances, expiries)
    figure = plt.figure(figsize=(10, 7))
    axis = figure.add_subplot(111, projection="3d")
    surface = axis.plot_surface(x, y, field, cmap="coolwarm", linewidth=0, antialiased=True)
    axis.set_title(title)
    axis.set_xlabel("Relative distance (+ Call / - Put)")
    axis.set_ylabel("Expiry (days)")
    axis.set_zlabel("ELO / PDE signal")
    figure.colorbar(surface, shrink=0.65, pad=0.12)
    figure.tight_layout()
    figure.savefig(path, dpi=180, bbox_inches="tight")
    plt.close(figure)
    return path
