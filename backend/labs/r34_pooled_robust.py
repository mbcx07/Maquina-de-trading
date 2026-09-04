from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

import r32_ml_research as core


SYMBOLS = os.getenv(
    "R34_SYMBOLS", "XAUUSDT,BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT"
).split(",")
MODE = os.getenv("R34_MODE", "develop")
HORIZONS = [
    int(item) for item in os.getenv("R34_HORIZONS", "15,30,60,120").split(",")
]
RISK_PAIRS = [
    (0.30, 0.10),
    (0.35, 0.10),
    (0.35, 0.15),
    (0.40, 0.15),
    (0.40, 0.20),
    (0.40, 0.25),
    (0.45, 0.20),
    (0.50, 0.20),
    (0.60, 0.20),
]
RISK_PAIRS = RISK_PAIRS[: int(os.getenv("R34_RISK_LIMIT", str(len(RISK_PAIRS))))]
FILTERS = ["all", "score2", "trend"]
MIN_TRADES_PER_DAY = 10.0


@dataclass
class Market:
    symbol: str
    bars: pd.DataFrame
    x: np.ndarray
    idx: np.ndarray
    sides: np.ndarray
    names: list[str]
    train_end: int
    validation_mid: int
    validation_end: int


def load_market(symbol: str) -> Market:
    if MODE != "develop":
        raise RuntimeError("R34 blind data stays locked until development qualifies")
    path = core.ARTIFACTS / f"r33-{symbol}-1m-56d.pkl"
    if not path.exists():
        raise FileNotFoundError(path)
    raw = pd.read_pickle(path)
    bars, x, idx, sides, names = core.features_and_candidates(raw)
    # The old R33 blind segment has already been observed. R34 therefore uses
    # all 56 days only as development data and never reports it as a blind test.
    train_end = len(bars) * 2 // 3
    validation_mid = train_end + (len(bars) - train_end) // 2
    validation_end = len(bars)
    symbol_columns = np.zeros((len(x), len(SYMBOLS)), dtype=np.float32)
    symbol_columns[:, SYMBOLS.index(symbol)] = 1.0
    x = np.hstack([x, symbol_columns])
    names = names + [f"symbol_{item}" for item in SYMBOLS]
    return Market(
        symbol, bars, x, idx, sides, names,
        train_end, validation_mid, validation_end,
    )


def filter_mask(market: Market, kind: str) -> np.ndarray:
    col = {name: market.x[:, i] for i, name in enumerate(market.names)}
    if kind == "all":
        return np.ones(len(market.idx), dtype=bool)
    aligned_150 = col["dist150_atr"] > 0
    aligned_hour = col["trend60"] > 0
    volume = col["volume_ratio"] >= 0.9
    flow = col["flow"] > 0
    if kind == "trend":
        return aligned_150 & aligned_hour & volume
    return (
        aligned_150.astype(np.int8)
        + aligned_hour.astype(np.int8)
        + volume.astype(np.int8)
        + flow.astype(np.int8)
    ) >= 2


def split_rows(market: Market, start: int, end: int, horizon: int) -> np.ndarray:
    # Purging ensures every label is fully resolved inside its own split.
    return np.flatnonzero(
        (market.idx >= start)
        & (market.idx + 1 + horizon < end)
    )


def select_trades(
    market: Market,
    probs: np.ndarray,
    returns: np.ndarray,
    exits: np.ndarray,
    chosen_rows: np.ndarray,
    start: int,
    end: int,
    threshold: float,
):
    records = []
    next_bar = start
    rows = chosen_rows[
        (market.idx[chosen_rows] >= start)
        & (market.idx[chosen_rows] + 1 < end)
    ]
    for winner in rows:
        signal_bar = int(market.idx[winner])
        entry = signal_bar + 1
        if entry >= next_bar and probs[winner] >= threshold and exits[winner] < end:
            records.append(
                (
                    market.bars.index[entry].value,
                    market.symbol,
                    float(returns[winner]),
                    int(market.sides[winner]),
                    entry,
                    int(exits[winner]),
                    float(probs[winner]),
                )
            )
            next_bar = int(exits[winner]) + 1
    return records


def highest_probability_rows(
    market: Market, probs: np.ndarray, allowed: np.ndarray
) -> np.ndarray:
    """Keep exactly one direction per signal bar, chosen without future outcomes."""
    rows = np.flatnonzero(allowed)
    chosen = []
    cursor = 0
    while cursor < len(rows):
        signal_bar = int(market.idx[rows[cursor]])
        stop = cursor + 1
        while stop < len(rows) and market.idx[rows[stop]] == signal_bar:
            stop += 1
        same_bar = rows[cursor:stop]
        chosen.append(int(same_bar[np.argmax(probs[same_bar])]))
        cursor = stop
    return np.asarray(chosen, dtype=np.int32)


def stats(records, days: float):
    ordered = sorted(records, key=lambda row: row[0])
    values = np.asarray([row[2] for row in ordered], dtype=float)
    wins = values[values > 0]
    losses = -values[values <= 0]
    equity = peak = 100.0
    drawdown = 0.0
    for value in values:
        equity *= 1 + value * core.EXPOSURE / 100
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak * 100)
    gross_loss = float(losses.sum())
    gross_profit = float(wins.sum())
    return {
        "trades": int(len(values)),
        "winRate": float((values > 0).mean() * 100) if len(values) else 0.0,
        "pf": gross_profit / gross_loss if gross_loss else (99.0 if gross_profit else 0.0),
        "returnPct": equity - 100,
        "ddPct": drawdown,
        "tradesPerDay": len(values) / days,
    }


def aggregate(
    markets: list[Market],
    probabilities: list[np.ndarray],
    outcomes: list[tuple[np.ndarray, np.ndarray]],
    choices: list[np.ndarray],
    segment: str,
    threshold: float,
):
    records = []
    if segment == "train":
        days = 56 * 2 / 3
    else:
        days = 56 / 6
    for market, probs, (returns, exits), chosen_rows in zip(
        markets, probabilities, outcomes, choices
    ):
        if segment == "train":
            start, end = 0, market.train_end
        elif segment == "validationA":
            start, end = market.train_end, market.validation_mid
        else:
            start, end = market.validation_mid, market.validation_end
        records.extend(
            select_trades(
                market, probs, returns, exits, chosen_rows, start, end, threshold
            )
        )
    return stats(records, days), records


def qualifies(item: dict) -> bool:
    return (
        item["tradesPerDay"] >= MIN_TRADES_PER_DAY
        and item["winRate"] >= 65.0
        and item["pf"] >= 1.2
        and item["returnPct"] > 0
    )


def robustness_score(train: dict, val_a: dict, val_b: dict) -> float:
    validations = [val_a, val_b]
    qualified = all(qualifies(item) for item in validations)
    worst_pf = min(item["pf"] for item in validations)
    worst_wr = min(item["winRate"] for item in validations)
    worst_return = min(item["returnPct"] for item in validations)
    frequency_shortfall = sum(
        max(0.0, MIN_TRADES_PER_DAY - item["tradesPerDay"])
        for item in validations
    )
    return (
        (10000.0 if qualified else 0.0)
        + worst_pf * 35
        + worst_wr
        + worst_return * 20
        - frequency_shortfall * 15
        - abs(val_a["winRate"] - val_b["winRate"]) * 0.5
        - max(0.0, train["winRate"] - min(val_a["winRate"], val_b["winRate"]))
    )


def clean_row(row: dict) -> dict:
    return {
        key: value
        for key, value in row.items()
        if key not in {"probabilities", "outcomes", "choices", "records"}
    }


def main():
    markets = [load_market(symbol) for symbol in SYMBOLS]
    all_x = np.vstack([market.x for market in markets])
    offsets = np.cumsum([0] + [len(market.x) for market in markets])
    rows = []
    for horizon_index, horizon in enumerate(HORIZONS, start=1):
            # One causal direction model per horizon. Risk parameters are then
            # evaluated against the same probabilities, reducing data mining and runtime.
            label_outcomes = [
                core.outcomes(market.bars, market.idx, market.sides, 0.40, 0.20, horizon)
                for market in markets
            ]
            train_global = []
            labels = []
            for market_index, (market, (returns, _)) in enumerate(zip(markets, label_outcomes)):
                local = split_rows(market, 0, market.train_end, horizon)
                train_global.append(local + offsets[market_index])
                labels.append((returns[local] > 0).astype(np.int8))
            train_global_array = np.concatenate(train_global)
            y = np.concatenate(labels)
            positives = max(1, int(y.sum()))
            negatives = max(1, len(y) - positives)
            weights = np.where(
                y > 0,
                len(y) / (2 * positives),
                len(y) / (2 * negatives),
            )
            model = HistGradientBoostingClassifier(
                max_iter=90,
                max_leaf_nodes=15,
                min_samples_leaf=100,
                learning_rate=0.055,
                l2_regularization=10,
                random_state=34,
            ).fit(all_x[train_global_array], y, sample_weight=weights)
            pooled_probabilities = model.predict_proba(all_x)[:, 1]
            probabilities = [
                pooled_probabilities[offsets[i]:offsets[i + 1]]
                for i in range(len(markets))
            ]
            for risk_index, (tp, sl) in enumerate(RISK_PAIRS, start=1):
              outcomes = [
                  core.outcomes(market.bars, market.idx, market.sides, tp, sl, horizon)
                  for market in markets
              ]
              for filter_kind in FILTERS:
                masks = [filter_mask(market, filter_kind) for market in markets]
                choices = [
                    highest_probability_rows(market, probabilities[i], masks[i])
                    for i, market in enumerate(markets)
                ]
                validation_probs = np.concatenate([
                    probabilities[i][choices[i][
                        (market.idx[choices[i]] >= market.train_end)
                        & (market.idx[choices[i]] + 1 + horizon < market.validation_end)
                    ]]
                    for i, market in enumerate(markets)
                ])
                best = None
                thresholds = np.unique(
                    np.quantile(validation_probs, np.linspace(0.40, 0.997, 24))
                )
                for threshold in thresholds:
                    train, _ = aggregate(
                        markets, probabilities, outcomes, choices, "train", float(threshold)
                    )
                    val_a, _ = aggregate(
                        markets, probabilities, outcomes, choices, "validationA", float(threshold)
                    )
                    val_b, records = aggregate(
                        markets, probabilities, outcomes, choices, "validationB", float(threshold)
                    )
                    if min(
                        train["tradesPerDay"],
                        val_a["tradesPerDay"],
                        val_b["tradesPerDay"],
                    ) < MIN_TRADES_PER_DAY:
                        continue
                    score = robustness_score(train, val_a, val_b)
                    candidate = {
                        "tp": tp,
                        "sl": sl,
                        "horizon": horizon,
                        "filter": filter_kind,
                        "threshold": float(threshold),
                        "train": train,
                        "validationA": val_a,
                        "validationB": val_b,
                        "qualified": all(qualifies(item) for item in [train, val_a, val_b]),
                        "score": score,
                        "probabilities": probabilities,
                        "outcomes": outcomes,
                        "choices": choices,
                        "records": records,
                    }
                    if best is None or candidate["score"] > best["score"]:
                        best = candidate
                if best is not None:
                    rows.append(best)
              print(
                  "R34_CONFIG",
                  horizon_index,
                  "/",
                  len(HORIZONS),
                  risk_index,
                  "/",
                  len(RISK_PAIRS),
                  tp,
                  sl,
                  horizon,
                  flush=True,
              )
    rows.sort(key=lambda row: row["score"], reverse=True)
    best = rows[0]
    qualified_count = sum(row["qualified"] for row in rows)
    result = {
        "mode": MODE,
        "symbols": SYMBOLS,
        "costPct": core.COST,
        "exposurePct": core.EXPOSURE,
        "selection": "POOLED_TRAIN_TWO_STABLE_VALIDATION_WINDOWS_BLIND_STILL_LOCKED",
        "sameBarDirectionFix": "highest_probability_side",
        "purgedBoundaries": True,
        "requirements": {
            "winRateMin": 65,
            "tradesPerDayMin": MIN_TRADES_PER_DAY,
            "pfMin": 1.2,
            "positiveReturn": True,
        },
        "testedConfigurations": len(rows),
        "qualifiedConfigurations": qualified_count,
        "best": clean_row(best),
        "top20": [clean_row(row) for row in rows[:20]],
        "blindOpened": False,
        "survived": False,
    }
    output = core.ARTIFACTS / "r34-pooled-development.json"
    output.write_text(json.dumps(result, indent=2))
    print("R34_RESULT", json.dumps({key: value for key, value in result.items() if key != "top20"}), flush=True)


if __name__ == "__main__":
    main()
