from __future__ import annotations

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from streamlit_autorefresh import st_autorefresh

from option_wave import OptionWaveV08
from option_wave.factors import MarketState
from option_wave.data_sources import MoomooClient, MoomooConfig, load_csv_chain

st.set_page_config(page_title="Option Wave", page_icon="📈", layout="wide")


@st.cache_data(show_spinner=False)
def _load_csv(file_bytes: bytes, filename: str) -> pd.DataFrame:
    return load_csv_chain(file_bytes, filename)


@st.cache_data(ttl=10, show_spinner=False)
def _load_moomoo_chain(host: str, port: int, code: str, max_expiries: int) -> tuple[pd.DataFrame, MarketState, dict]:
    client = MoomooClient(MoomooConfig(host=host, port=port, code=code, max_expiries=max_expiries))
    return client.fetch()


@st.cache_data(show_spinner=False)
def _load_sample() -> tuple[pd.DataFrame, MarketState, dict]:
    strikes = [717, 718, 719, 720, 721, 722, 723, 724, 725]
    rows = []
    for k in strikes:
        rows.append(
            {
                "strike": k,
                "expiry_date": pd.Timestamp.utcnow().strftime("%Y-%m-%d"),
                "expiry_days": 0,
                "call_bid": max(0.05, 721.5 - k) + 0.35,
                "call_ask": max(0.08, 721.5 - k) + 0.45,
                "call_last": max(0.06, 721.5 - k) + 0.40,
                "put_bid": max(0.05, k - 721.5) + 0.35,
                "put_ask": max(0.08, k - 721.5) + 0.45,
                "put_last": max(0.06, k - 721.5) + 0.40,
                "call_volume": 1000 + max(0, k - 720) * 300,
                "put_volume": 900 + max(0, 721 - k) * 350,
                "call_oi": 5000,
                "put_oi": 5000,
                "call_iv": 0.22,
                "put_iv": 0.24,
                "call_delta": max(0.05, min(0.95, 0.5 - (k - 721.5) * 0.08)),
                "put_delta": -max(0.05, min(0.95, 0.5 + (k - 721.5) * 0.08)),
                "call_gamma": 0.03,
                "put_gamma": 0.03,
                "call_vega": 0.12,
                "put_vega": 0.12,
            }
        )
    chain = pd.DataFrame(rows)
    state = MarketState(
        spot=721.5,
        high=725.0,
        low=717.18,
        vwap=721.8,
        rvol=1.2,
        stock_dollar_volume=721.5 * 10_000_000,
        minutes_from_open=180,
    )
    return chain, state, {"underlying": "SAMPLE", "expiries": [chain["expiry_date"].iloc[0]], "row_count": len(chain)}


def run_model(chain: pd.DataFrame, state: MarketState) -> tuple[OptionWaveV08, object, float | None]:
    model = OptionWaveV08()
    call_wall = chain.loc[chain["call_oi"].fillna(0).idxmax(), "strike"] if not chain.empty else None
    result = model.predict(chain, state, k_wall=call_wall, whale_impact=0.0, whale_confidence=0.0)
    return model, result, call_wall


def contribution_figure(contributions: dict[str, float]) -> go.Figure:
    df = pd.DataFrame({"factor": list(contributions.keys()), "contribution": list(contributions.values())})
    df = df.sort_values("contribution")
    fig = px.bar(df, x="contribution", y="factor", orientation="h", title="Factor Contributions")
    fig.add_vline(x=0, line_width=1)
    fig.update_layout(height=420, margin=dict(l=0, r=0, t=50, b=0))
    return fig


def premium_figure(chain: pd.DataFrame) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=chain["strike"], y=chain["call_mid"], mode="lines+markers", name="Call mid"))
    fig.add_trace(go.Scatter(x=chain["strike"], y=chain["put_mid"], mode="lines+markers", name="Put mid"))
    fig.update_layout(title="Option Mid Prices by Strike", xaxis_title="Strike", yaxis_title="Premium")
    return fig


def flow_figure(chain: pd.DataFrame) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Bar(x=chain["strike"], y=chain["call_volume"], name="Call volume"))
    fig.add_trace(go.Bar(x=chain["strike"], y=-chain["put_volume"], name="Put volume"))
    fig.update_layout(title="Volume Imbalance by Strike", barmode="relative", xaxis_title="Strike", yaxis_title="Contracts")
    return fig


def oi_figure(chain: pd.DataFrame) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Bar(x=chain["strike"], y=chain["call_oi"], name="Call OI"))
    fig.add_trace(go.Bar(x=chain["strike"], y=chain["put_oi"], name="Put OI"))
    fig.update_layout(title="Open Interest by Strike", barmode="group", xaxis_title="Strike", yaxis_title="Open interest")
    return fig


def elo_heatmap(chain: pd.DataFrame) -> go.Figure:
    if "elo_net" not in chain.columns:
        return go.Figure()
    heat = chain.pivot_table(index="expiry_days", columns="strike", values="elo_net", aggfunc="mean")
    fig = px.imshow(
        heat,
        labels=dict(x="Strike", y="Expiry days", color="ELO net"),
        aspect="auto",
        title="ELO Surface",
        color_continuous_scale="RdBu_r",
    )
    fig.update_layout(margin=dict(l=0, r=0, t=50, b=0))
    return fig


def main() -> None:
    st.title("Option Wave Forecast Dashboard")
    st.caption("Research-only option flow dashboard. No order execution or account actions are included.")

    with st.sidebar:
        source = st.radio("Data source", ["moomoo live", "CSV upload", "sample"], index=0)
        refresh_seconds = st.slider("Refresh seconds", min_value=5, max_value=60, value=15, step=5)
        if source == "moomoo live":
            st_autorefresh(interval=refresh_seconds * 1000, key="option-wave-refresh")
            host = st.text_input("OpenD host", value="127.0.0.1")
            port = st.number_input("OpenD port", min_value=1, max_value=65535, value=11111)
            code = st.text_input("Underlying code", value="US.AAPL")
            max_expiries = st.slider("Expiries", min_value=1, max_value=6, value=3)
        else:
            host = "127.0.0.1"
            port = 11111
            code = "CSV"
            max_expiries = 1

    chain: pd.DataFrame
    state: MarketState
    meta: dict

    try:
        if source == "moomoo live":
            chain, state, meta = _load_moomoo_chain(host, int(port), code, max_expiries)
        elif source == "CSV upload":
            uploaded = st.sidebar.file_uploader("Upload normalized or long-form option CSV", type=["csv"])
            if uploaded is None:
                st.info("Upload a CSV to run the dashboard. Expected columns can be normalized wide columns or long-form rows with option_type/code/bid/ask/last/volume/OI/IV/Greeks.")
                return
            chain = _load_csv(uploaded.getvalue(), uploaded.name)
            spot_guess = float(chain["strike"].median()) if not chain.empty else 0.0
            state = MarketState(
                spot=spot_guess,
                high=spot_guess,
                low=spot_guess,
                vwap=spot_guess,
                stock_dollar_volume=None,
                minutes_from_open=0,
            )
            meta = {"underlying": uploaded.name, "expiries": sorted(chain["expiry_date"].dropna().unique().tolist()), "row_count": len(chain)}
        else:
            chain, state, meta = _load_sample()
    except Exception as exc:
        st.error(str(exc))
        if source == "moomoo live":
            st.warning("Make sure moomoo OpenD is logged in locally and the Python SDK `moomoo-api` is installed.")
        return

    model, result, k_wall = run_model(chain, state)
    chain = result.elo_surface.copy()
    if "call_mid" not in chain.columns:
        chain["call_mid"] = (chain["call_bid"] + chain["call_ask"]) / 2.0
    if "put_mid" not in chain.columns:
        chain["put_mid"] = (chain["put_bid"] + chain["put_ask"]) / 2.0

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Trend score", f"{result.trend_score:+.3f}")
    col2.metric("Direction", result.direction)
    col3.metric("Confidence", f"{result.confidence:.2f}")
    col4.metric("Spot", f"{state.spot:.2f}")

    st.write(
        {
            "underlying": meta.get("underlying"),
            "expiries": meta.get("expiries"),
            "contracts": meta.get("row_count"),
            "call_wall_guess": k_wall,
        }
    )

    left, right = st.columns([1, 1])
    left.plotly_chart(contribution_figure(result.contributions), use_container_width=True)
    right.plotly_chart(elo_heatmap(chain), use_container_width=True)

    lower_left, lower_right = st.columns([1, 1])
    lower_left.plotly_chart(premium_figure(chain), use_container_width=True)
    lower_right.plotly_chart(flow_figure(chain), use_container_width=True)

    st.plotly_chart(oi_figure(chain), use_container_width=True)

    st.subheader("Normalized Option Chain")
    st.dataframe(chain, use_container_width=True, height=420)
    st.download_button(
        "Download normalized chain CSV",
        chain.to_csv(index=False).encode("utf-8"),
        file_name="option_wave_chain.csv",
        mime="text/csv",
    )


if __name__ == "__main__":
    main()
