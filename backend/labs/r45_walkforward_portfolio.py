from __future__ import annotations

import json
import os
from itertools import product

import numpy as np

import r38_monster_replication as base
import r43_confirmed_harami as hcore
import r44_confirmed_patterns as patterns


SYMBOLS = ("XAUUSDT", "CLUSDT")
FRAMES = ("1min", "3min", "5min", "15min")
ENGINES = ("harami", "engulfing", "hammer", "meeting")
WINDOWS = ("train", "validationA", "validationB")


def window_bounds(index):
    n = len(index)
    a = n * 2 // 3
    m = a + (n - a) // 2
    return {
        "train": (index[0], index[a]),
        "validationA": (index[a], index[m]),
        "validationB": (index[m], index[-1] + (index[-1] - index[-2])),
    }


def metric(records, days):
    return base.stats([(0, 0, 0, r[3], r[4]) for r in records], days)


def split(records, bounds):
    return {
        name: [r for r in records if r[1] >= lo and r[2] < hi]
        for name, (lo, hi) in bounds.items()
    }


def merge_portfolio(candidates, selected, bounds, days):
    pooled = []
    for rank, c in enumerate(selected):
        for symbol, records in c["records"].items():
            pooled.extend((r[1], rank, symbol, r) for r in records)
    pooled.sort(key=lambda x: (x[0], x[1]))
    accepted = []
    busy_until = {s: None for s in SYMBOLS}
    seen = set()
    for _, _, symbol, r in pooled:
        key = (symbol, r[1])
        if key in seen or (busy_until[symbol] is not None and r[1] <= busy_until[symbol]):
            continue
        seen.add(key)
        accepted.append(r)
        busy_until[symbol] = r[2]
    windows = split(accepted, bounds)
    stats = {name: metric(windows[name], days[name]) for name in WINDOWS}
    return accepted, stats


def passes(stats):
    return all(
        stats[w]["tradesPerDay"] >= 10
        and stats[w]["winRate"] >= 65
        and stats[w]["pf"] >= 1.2
        and stats[w]["netPointsPct"] > 0
        for w in WINDOWS
    )


def main():
    raw = {s: base.load(s) for s in SYMBOLS}
    bounds = window_bounds(raw[SYMBOLS[0]].index)
    days = {name: (hi - lo).total_seconds() / 86400 for name, (lo, hi) in bounds.items()}
    candidates = []
    signal_space = list(product(FRAMES, ENGINES, (.5, .7, 1.0), ("trend5", "ema200"), (0, .1)))
    exit_space = list(product((.4, .5, .6), (.3, .4, "structure"), (False, True)))
    for n, (frame, engine, volume, trend, room) in enumerate(signal_space, 1):
        prepared = {s: patterns.prepare(raw[s], frame, engine, volume, trend, room) for s in SYMBOLS}
        for tp, stop, be in exit_space:
            records = {}
            train_records = []
            for symbol, p in prepared.items():
                b = p[0]
                converted = []
                for sig, entry, close, pnl, reason in hcore.simulate(p, tp, stop, be):
                    converted.append((symbol, b.index[entry], b.index[close], pnl, reason))
                records[symbol] = converted
                train_records.extend(split(converted, bounds)["train"])
            train = metric(train_records, days["train"])
            candidates.append({
                "config": {"timeframe": frame, "engine": engine, "volumeMin": volume,
                           "trend": trend, "roomMinPct": room, "tpPct": tp,
                           "stop": stop, "breakEven": be},
                "train": train,
                "records": records,
            })
        if n % 20 == 0:
            print("R45_SIGNAL", n, "/", len(signal_space), flush=True)

    # Candidate selection and ranking use training data only. Validation windows
    # remain untouched until a complete portfolio has been specified.
    trials = []
    for wr_floor, pf_floor, min_trades, per_bucket, limit in product(
        (50, 55, 60, 65), (.6, .8, 1.0, 1.2), (5, 10, 20), (1, 2), (8, 16, 32)
    ):
        eligible = [c for c in candidates if c["train"]["trades"] >= min_trades
                    and c["train"]["winRate"] >= wr_floor
                    and c["train"]["pf"] >= pf_floor
                    and c["train"]["netPointsPct"] > 0]
        eligible.sort(key=lambda c: (
            c["train"]["pf"] * np.sqrt(c["train"]["trades"]),
            c["train"]["winRate"], c["train"]["netPointsPct"]), reverse=True)
        selected = []
        bucket_count = {}
        for c in eligible:
            bucket = (c["config"]["engine"], c["config"]["timeframe"])
            if bucket_count.get(bucket, 0) >= per_bucket:
                continue
            selected.append(c)
            bucket_count[bucket] = bucket_count.get(bucket, 0) + 1
            if len(selected) >= limit:
                break
        if not selected:
            continue
        accepted, stats = merge_portfolio(candidates, selected, bounds, days)
        floor_freq = min(stats[w]["tradesPerDay"] for w in WINDOWS)
        floor_wr = min(stats[w]["winRate"] for w in WINDOWS)
        floor_pf = min(stats[w]["pf"] for w in WINDOWS)
        floor_ret = min(stats[w]["netPointsPct"] for w in WINDOWS)
        trials.append({
            "selection": {"trainWinRateFloor": wr_floor, "trainPfFloor": pf_floor,
                          "minimumTrainTrades": min_trades, "perEngineFrame": per_bucket,
                          "candidateLimit": limit},
            "selectedCount": len(selected),
            "selectedConfigs": [c["config"] for c in selected],
            "stats": stats,
            "qualified": passes(stats),
            "score": floor_wr + 25 * min(floor_pf, 3) + 3 * min(floor_freq, 10)
                     + min(floor_ret, 2) - 50 * max(0, 10 - floor_freq),
        })

    trials.sort(key=lambda x: x["score"], reverse=True)
    frequency = [x for x in trials if min(x["stats"][w]["tradesPerDay"] for w in WINDOWS) >= 10]
    stable = [x for x in trials if min(x["stats"][w]["winRate"] for w in WINDOWS) >= 65]
    output = {
        "mode": "TRAIN_SELECTED_VALIDATION_A_B_BLIND_LOCKED",
        "symbols": list(SYMBOLS), "costPct": patterns.COST,
        "candidateConfigurations": len(candidates), "portfolioTrials": len(trials),
        "frequencyEligible": len(frequency), "stableWinRate65": len(stable),
        "qualified": sum(x["qualified"] for x in trials),
        "bestFrequencyEligible": frequency[0] if frequency else None,
        "bestStableWinRate": stable[0] if stable else None,
        "bestOverall": trials[0] if trials else None,
        "blindOpened": False,
    }
    path = os.path.join(os.path.dirname(__file__), "..", "artifacts", "r45-walkforward-portfolio.json")
    with open(path, "w") as f:
        json.dump(output, f, indent=2)
    print("R45_RESULT", json.dumps(output), flush=True)


if __name__ == "__main__":
    main()
