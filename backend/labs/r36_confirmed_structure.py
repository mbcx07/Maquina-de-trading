from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

import r35_30s_causal as r35


STRUCTURE_FRAMES = ["1min", "3min", "5min", "15min"]
TREND_FRAMES = os.getenv("R36_TRENDS", "5min,15min").split(",")
MIN_REWARDS = [float(value) for value in os.getenv("R36_REWARDS", ".25,.35,.45").split(",")]
MAX_RISKS = [float(value) for value in os.getenv("R36_RISKS", ".15,.25,.4").split(",")]
BUFFERS = [float(value) for value in os.getenv("R36_BUFFERS", "0,.1").split(",")]
MIN_NET_RRS = [float(value) for value in os.getenv("R36_RRS", ".65,1").split(",")]
HORIZON = 120  # 60 minutes in 30-second bars


def atr28(bars: pd.DataFrame) -> np.ndarray:
    previous = bars.close.shift(1)
    true_range = pd.concat(
        [
            bars.high - bars.low,
            (bars.high - previous).abs(),
            (bars.low - previous).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return true_range.rolling(28).mean().to_numpy()


def confirmed_levels(bars: pd.DataFrame, depth: int = 6):
    events = []
    for frame in STRUCTURE_FRAMES:
        higher = bars.resample(frame, label="left", closed="left").agg(
            {"high": "max", "low": "min"}
        ).dropna()
        high = higher.high.to_numpy()
        low = higher.low.to_numpy()
        # pandas 3 preserves the millisecond resolution produced by the raw
        # trade feed. Timedelta.value is nanoseconds, so normalize explicitly
        # before comparing pivot confirmation times.
        timestamps = pd.DatetimeIndex(higher.index).as_unit("ns").asi8
        frame_ns = pd.Timedelta(frame).value
        for i in range(2, len(higher) - 2):
            known_at = int(timestamps[i + 2] + frame_ns)
            if high[i] > max(high[i - 2:i].max(), high[i + 1:i + 3].max()):
                events.append((known_at, float(high[i])))
            if low[i] < min(low[i - 2:i].min(), low[i + 1:i + 3].min()):
                events.append((known_at, float(low[i])))
    events.sort()
    below = np.full((len(bars), depth), np.nan, dtype=np.float64)
    above = np.full((len(bars), depth), np.nan, dtype=np.float64)
    active = []
    cursor = 0
    close_ns = (
        pd.DatetimeIndex(bars.index).as_unit("ns").asi8
        + pd.Timedelta("30s").value
    )
    prices = bars.close.to_numpy()
    for i, (known, price) in enumerate(zip(close_ns, prices)):
        while cursor < len(events) and events[cursor][0] <= known:
            active.append(events[cursor][1])
            cursor += 1
        if len(active) > 500:
            active = active[-500:]
        if not active:
            continue
        levels = np.asarray(active)
        supports = np.unique(levels[levels < price])
        resistances = np.unique(levels[levels > price])
        if len(supports):
            selected = supports[-depth:][::-1]
            below[i, :len(selected)] = selected
        if len(resistances):
            selected = resistances[:depth]
            above[i, :len(selected)] = selected
    return below, above


def structural_outcomes(
    prepared: r35.Prepared,
    below: np.ndarray,
    above: np.ndarray,
    atr: np.ndarray,
    trend_frame: str,
    min_reward_pct: float,
    max_risk_pct: float,
    buffer_atr: float,
    min_net_rr: float,
):
    bars = prepared.bars
    op, high, low, close = (
        bars[column].to_numpy(float) for column in ["open", "high", "low", "close"]
    )
    trend = prepared.trends[trend_frame]
    count = len(prepared.idx)
    returns = np.full(count, np.nan, dtype=np.float32)
    exits = np.full(count, -1, dtype=np.int32)
    reasons = np.full(count, -1, dtype=np.int8)
    stops = np.full(count, np.nan)
    targets = np.full(count, np.nan)
    level_support = np.full(count, np.nan)
    level_resistance = np.full(count, np.nan)
    for k, (signal, side) in enumerate(zip(prepared.idx, prepared.sides)):
        entry_bar = signal + 1
        entry = op[entry_bar]
        volatility_buffer = atr[signal] * buffer_atr
        if not np.isfinite(volatility_buffer):
            continue
        if side > 0:
            support_options = below[signal]
            resistance_options = above[signal]
            support_options = support_options[np.isfinite(support_options)]
            resistance_options = resistance_options[np.isfinite(resistance_options)]
            if not len(support_options) or not len(resistance_options):
                continue
            support = support_options[0]
            target_options = resistance_options[
                (resistance_options / entry - 1) * 100 >= min_reward_pct
            ]
            if not len(target_options):
                continue
            resistance = target_options[0]
            stop = support - volatility_buffer
            target = resistance - volatility_buffer
        else:
            support_options = below[signal]
            resistance_options = above[signal]
            support_options = support_options[np.isfinite(support_options)]
            resistance_options = resistance_options[np.isfinite(resistance_options)]
            if not len(support_options) or not len(resistance_options):
                continue
            resistance = resistance_options[0]
            target_options = support_options[
                (entry / support_options - 1) * 100 >= min_reward_pct
            ]
            if not len(target_options):
                continue
            support = target_options[0]
            stop = resistance + volatility_buffer
            target = support + volatility_buffer
        risk_pct = abs(stop / entry - 1) * 100
        reward_pct = abs(target / entry - 1) * 100
        net_rr = (reward_pct - r35.COST) / (risk_pct + r35.COST)
        if (
            risk_pct <= 0
            or risk_pct > max_risk_pct
            or reward_pct <= r35.COST
            or net_rr < min_net_rr
        ):
            continue
        last = min(len(bars) - 1, entry_bar + HORIZON)
        exit_price, exit_bar, reason = close[last], last, 4
        for j in range(entry_bar, last + 1):
            if prepared.macd_cross[j] == -side:
                exit_price, exit_bar, reason = op[j], j, 1
                break
            if trend[j] == -side:
                exit_price, exit_bar, reason = op[j], j, 2
                break
            hit_stop = low[j] <= stop if side > 0 else high[j] >= stop
            hit_target = high[j] >= target if side > 0 else low[j] <= target
            if hit_stop:
                exit_price, exit_bar, reason = stop, j, 3
                break
            if hit_target:
                exit_price, exit_bar, reason = target, j, 0
                break
        returns[k] = side * (exit_price / entry - 1) * 100 - r35.COST
        exits[k] = exit_bar
        reasons[k] = reason
        stops[k] = stop
        targets[k] = target
        level_support[k] = support
        level_resistance[k] = resistance
    valid = np.isfinite(returns)
    return (
        returns,
        exits,
        reasons,
        stops,
        targets,
        level_support,
        level_resistance,
        valid,
    )


def select_records(prepared, allowed, probabilities, outcome, start, end, threshold):
    returns, exits, reasons = outcome[:3]
    rows = allowed[
        (prepared.idx[allowed] >= start)
        & (prepared.idx[allowed] + 1 < end)
    ]
    records = []
    next_bar = start
    for k in rows:
        entry = int(prepared.idx[k]) + 1
        if entry < next_bar or probabilities[k] < threshold or exits[k] >= end:
            continue
        records.append((prepared.bars.index[entry].value, float(returns[k]), int(k), int(exits[k]), int(reasons[k])))
        next_bar = int(exits[k]) + 1
    return records


def segment(prepared, name, allowed, probabilities, outcome, threshold):
    if name == "train":
        start, end = 0, prepared.train_end
    elif name == "validationA":
        start, end = prepared.train_end, prepared.validation_mid
    else:
        start, end = prepared.validation_mid, prepared.validation_end
    records = select_records(prepared, allowed, probabilities, outcome, start, end, threshold)
    return r35.stats(records, (end - start) / r35.BARS_PER_DAY), records


def base_allowed(prepared, outcome, trend_frame, volume_min, macd_aligned):
    valid = outcome[-1]
    idx, side = prepared.idx, prepared.sides
    ema150 = prepared.x[:, prepared.names.index("ema150DistanceAtr")] > 0
    allowed = (
        valid
        & ema150
        & (prepared.trends[trend_frame][idx] == side)
        & (prepared.volume_ratio[idx] >= volume_min)
    )
    if macd_aligned:
        allowed &= prepared.macd_direction[idx] == side
    return np.flatnonzero(allowed)


def clean(row):
    return {key: value for key, value in row.items() if key not in {"records", "outcome"}}


def audit(prepared, row):
    outcome = row["outcome"]
    reasons = ["TP", "MACD_5M_REVERSE", "HIGHER_TF_REVERSE", "SL", "HORIZON"]
    items = []
    for _, net, k, exit_bar, reason in row["records"]:
        signal = int(prepared.idx[k])
        entry_bar = signal + 1
        items.append(
            {
                "signalTime": prepared.bars.index[signal].isoformat(),
                "entryTime": prepared.bars.index[entry_bar].isoformat(),
                "exitTime": prepared.bars.index[exit_bar].isoformat(),
                "side": "BUY" if prepared.sides[k] > 0 else "SELL",
                "entry": float(prepared.bars.open.iloc[entry_bar]),
                "support": float(outcome[5][k]),
                "resistance": float(outcome[6][k]),
                "sl": float(outcome[3][k]),
                "tp": float(outcome[4][k]),
                "exitReason": reasons[reason],
                "netPct": net,
            }
        )
    return items


def main():
    prepared = r35.prepare()
    atr = atr28(prepared.bars)
    below, above = confirmed_levels(prepared.bars)
    print("R36_LEVELS_READY", np.isfinite(below[:, 0]).sum(), np.isfinite(above[:, 0]).sum(), flush=True)
    results = []
    tested = 0
    raw_best = None
    for trend_frame in TREND_FRAMES:
        for min_reward in MIN_REWARDS:
            for max_risk in MAX_RISKS:
                for buffer_atr in BUFFERS:
                    for min_net_rr in MIN_NET_RRS:
                        outcome = structural_outcomes(
                            prepared,
                            below,
                            above,
                            atr,
                            trend_frame,
                            min_reward,
                            max_risk,
                            buffer_atr,
                            min_net_rr,
                        )
                        valid_train = np.flatnonzero(
                            outcome[-1]
                            & (prepared.idx + HORIZON + 1 < prepared.train_end)
                        )
                        if len(valid_train) < 100:
                            continue
                        y = (outcome[0][valid_train] > 0).astype(np.int8)
                        positives = max(1, int(y.sum()))
                        negatives = max(1, int((y == 0).sum()))
                        weights = np.where(
                            y > 0,
                            len(y) / (2 * positives),
                            len(y) / (2 * negatives),
                        )
                        model = HistGradientBoostingClassifier(
                            max_iter=70,
                            max_leaf_nodes=10,
                            min_samples_leaf=40,
                            learning_rate=0.05,
                            l2_regularization=12,
                            random_state=36,
                        ).fit(prepared.x[valid_train], y, sample_weight=weights)
                        probabilities = model.predict_proba(prepared.x)[:, 1]
                        for volume_min in (0.7, 1.0):
                            for macd_aligned in (False, True):
                                tested += 1
                                allowed = base_allowed(
                                    prepared,
                                    outcome,
                                    trend_frame,
                                    volume_min,
                                    macd_aligned,
                                )
                                raw_train, _ = segment(prepared, "train", allowed, probabilities, outcome, -1.0)
                                raw_val_a, _ = segment(prepared, "validationA", allowed, probabilities, outcome, -1.0)
                                raw_val_b, _ = segment(prepared, "validationB", allowed, probabilities, outcome, -1.0)
                                raw_candidate = {
                                    "trendFrame": trend_frame,
                                    "minRewardPct": min_reward,
                                    "maxRiskPct": max_risk,
                                    "bufferAtr": buffer_atr,
                                    "minNetRr": min_net_rr,
                                    "volumeMin": volume_min,
                                    "macdEntryAligned": macd_aligned,
                                    "minimumTradesPerDay": min(
                                        raw_train["tradesPerDay"],
                                        raw_val_a["tradesPerDay"],
                                        raw_val_b["tradesPerDay"],
                                    ),
                                    "train": raw_train,
                                    "validationA": raw_val_a,
                                    "validationB": raw_val_b,
                                }
                                if raw_best is None or raw_candidate["minimumTradesPerDay"] > raw_best["minimumTradesPerDay"]:
                                    raw_best = raw_candidate
                                validation = allowed[
                                    (prepared.idx[allowed] >= prepared.train_end)
                                    & (prepared.idx[allowed] + HORIZON + 1 < prepared.validation_end)
                                ]
                                if len(validation) < 30:
                                    continue
                                best = None
                                thresholds = np.unique(
                                    np.quantile(probabilities[validation], np.linspace(.1, .995, 20))
                                )
                                for threshold in thresholds:
                                    train, _ = segment(prepared, "train", allowed, probabilities, outcome, float(threshold))
                                    val_a, _ = segment(prepared, "validationA", allowed, probabilities, outcome, float(threshold))
                                    val_b, records = segment(prepared, "validationB", allowed, probabilities, outcome, float(threshold))
                                    if min(train["tradesPerDay"], val_a["tradesPerDay"], val_b["tradesPerDay"]) < r35.MIN_TRADES_PER_DAY:
                                        continue
                                    candidate = {
                                        "trendFrame": trend_frame,
                                        "minRewardPct": min_reward,
                                        "maxRiskPct": max_risk,
                                        "bufferAtr": buffer_atr,
                                        "minNetRr": min_net_rr,
                                        "volumeMin": volume_min,
                                        "macdEntryAligned": macd_aligned,
                                        "threshold": float(threshold),
                                        "train": train,
                                        "validationA": val_a,
                                        "validationB": val_b,
                                        "qualified": all(r35.qualifies(value) for value in [train, val_a, val_b]),
                                        "score": r35.score(train, val_a, val_b),
                                        "records": records,
                                        "outcome": outcome,
                                    }
                                    if best is None or candidate["score"] > best["score"]:
                                        best = candidate
                                if best is not None:
                                    results.append(best)
                        print("R36_CONFIG", trend_frame, min_reward, max_risk, buffer_atr, min_net_rr, flush=True)
    results.sort(key=lambda row: row["score"], reverse=True)
    best = results[0] if results else None
    output = {
        "mode": "DEVELOPMENT_ONLY_BLIND_LOCKED",
        "symbol": "XAUUSDT",
        "entryTimeframe": "30s",
        "entryExecution": "MARKET_NEXT_30S_OPEN",
        "structureTimeframes": STRUCTURE_FRAMES,
        "levelConfirmation": "two fully closed candles; no lookahead",
        "tpPlacement": "before next confirmed resistance/support",
        "slPlacement": "beyond nearest confirmed support/resistance",
        "positionExits": ["MACD_5M_REVERSE", "HIGHER_TIMEFRAME_REVERSE", "TP", "SL"],
        "costPct": r35.COST,
        "requirements": {
            "winRateMin": 65,
            "tradesPerDayMin": 10,
            "pfMin": 1.2,
            "positiveReturn": True,
        },
        "testedConfigurations": tested,
        "frequencyEligibleConfigurations": len(results),
        "maximumUnfilteredFrequency": raw_best,
        "qualifiedConfigurations": sum(row["qualified"] for row in results),
        "best": clean(best) if best else None,
        "top20": [clean(row) for row in results[:20]],
        "blindOpened": False,
        "survived": False,
    }
    artifact_dir = os.path.join(os.path.dirname(__file__), "..", "artifacts")
    with open(os.path.join(artifact_dir, "r36-confirmed-structure.json"), "w") as file:
        json.dump(output, file, indent=2)
    with open(os.path.join(artifact_dir, "r36-trades.json"), "w") as file:
        json.dump(
            {
                "config": clean(best) if best else None,
                "trades": audit(prepared, best) if best else [],
            },
            file,
            indent=2,
        )
    print("R36_RESULT", json.dumps({key: value for key, value in output.items() if key != "top20"}), flush=True)


if __name__ == "__main__":
    main()
