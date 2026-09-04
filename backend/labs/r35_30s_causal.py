from __future__ import annotations

import json
import io
import os
import tempfile
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier


COST = 0.145
EXPOSURE = 0.10
BARS_PER_DAY = 2880
TREND_FRAMES = os.getenv("R35_TRENDS", "3min,5min,15min,60min").split(",")
HORIZON_MINUTES = [
    int(item) for item in os.getenv("R35_HORIZONS", "30,60,120").split(",")
]
RISK_PAIRS = [(.30, .10), (.35, .15), (.40, .20), (.40, .25), (.50, .20)]
RISK_PAIRS = RISK_PAIRS[: int(os.getenv("R35_RISK_LIMIT", str(len(RISK_PAIRS))))]
MIN_TRADES_PER_DAY = 10.0
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
DATA_END = date.fromisoformat(os.getenv("R35_END_DATE", "2026-09-01"))
DATA_DAYS = int(os.getenv("R35_DAYS", "56"))
SYMBOL = os.getenv("R35_SYMBOL", "XAUUSDT")
CACHE = ARTIFACTS / f"r35-{SYMBOL}-30s-{DATA_END.isoformat()}-{DATA_DAYS}d.pkl"
LEGACY_CACHE = ARTIFACTS / "r32-bars-56d.pkl"


@dataclass
class Prepared:
    bars: pd.DataFrame
    x: np.ndarray
    idx: np.ndarray
    sides: np.ndarray
    names: list[str]
    trends: dict[str, np.ndarray]
    macd_direction: np.ndarray
    macd_cross: np.ndarray
    volume_ratio: np.ndarray
    support: np.ndarray
    resistance: np.ndarray
    train_end: int
    validation_mid: int
    validation_end: int


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def closed_trend(bars: pd.DataFrame, timeframe: str) -> pd.Series:
    higher = bars.close.resample(timeframe, label="left", closed="left").last().dropna()
    direction = np.sign(ema(higher, 8) - ema(higher, 14)).shift(1)
    return direction.reindex(bars.index, method="ffill").fillna(0)


def event_edge(raw: pd.Series) -> pd.Series:
    return raw.fillna(False) & ~raw.shift(fill_value=False)


def download_day(day: str) -> pd.DataFrame:
    daily_dir = ARTIFACTS / "r35-daily"
    daily_dir.mkdir(exist_ok=True)
    daily_path = daily_dir / f"{SYMBOL}-30s-{day}.pkl"
    if daily_path.exists():
        try:
            cached = pd.read_pickle(daily_path)
            if not cached.empty and set(
                ["open", "high", "low", "close", "volume", "buy_volume", "sell_volume"]
            ).issubset(cached.columns):
                return cached
        except Exception:
            daily_path.unlink(missing_ok=True)
    url = (
        "https://data.binance.vision/data/futures/um/daily/aggTrades/"
        f"{SYMBOL}/{SYMBOL}-aggTrades-{day}.zip"
    )
    last_error = None
    for attempt in range(6):
        try:
            request = urllib.request.Request(
                f"{url}?r35={attempt}", headers={"User-Agent": "r35-30s-lab"}
            )
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = response.read()
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                if not archive.namelist():
                    raise ValueError("empty Binance Vision ZIP")
                # Binance added a header to newer aggTrades archives. Reading
                # positional usecols together with four replacement names is
                # rejected by pandas 3, so parse the schema first and then
                # select the four fields needed by this laboratory.
                raw = pd.read_csv(archive.open(archive.namelist()[0]))
                normalized = {str(column).strip().lower(): column for column in raw.columns}
                named = {
                    "price": normalized.get("price"),
                    "qty": normalized.get("quantity", normalized.get("qty")),
                    "time": normalized.get("transact_time", normalized.get("time")),
                    "maker": normalized.get("is_buyer_maker", normalized.get("maker")),
                }
                if all(column is not None for column in named.values()):
                    frame = raw[[named[key] for key in ("price", "qty", "time", "maker")]].copy()
                    frame.columns = ["price", "qty", "time", "maker"]
                else:
                    raw = pd.read_csv(archive.open(archive.namelist()[0]), header=None)
                    if raw.shape[1] < 7:
                        raise ValueError(f"unexpected aggTrades schema: {raw.shape[1]} columns")
                    frame = raw.iloc[:, [1, 2, 5, 6]].copy()
                    frame.columns = ["price", "qty", "time", "maker"]
            for column in ["price", "qty", "time"]:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
            frame = frame.dropna(subset=["price", "qty", "time"])
            timestamp = frame.time.astype("int64")
            timestamp = np.where(
                timestamp > 10**17,
                timestamp // 10**6,
                np.where(timestamp > 10**14, timestamp // 10**3, timestamp),
            )
            frame["time"] = pd.to_datetime(timestamp, unit="ms", utc=True)
            frame["bucket"] = frame.time.dt.floor("30s")
            maker = frame.maker.astype(str).str.lower().eq("true")
            frame["buy_volume"] = np.where(~maker, frame.qty, 0.0)
            frame["sell_volume"] = np.where(maker, frame.qty, 0.0)
            result = frame.groupby("bucket", sort=True).agg(
                open=("price", "first"),
                high=("price", "max"),
                low=("price", "min"),
                close=("price", "last"),
                volume=("qty", "sum"),
                buy_volume=("buy_volume", "sum"),
                sell_volume=("sell_volume", "sum"),
            )
            if len(result) < 100:
                raise ValueError(f"incomplete 30-second day: only {len(result)} bars")
            with tempfile.NamedTemporaryFile(dir=daily_dir, suffix=".pkl", delete=False) as temp:
                temp_path = Path(temp.name)
            try:
                result.to_pickle(temp_path)
                temp_path.replace(daily_path)
            finally:
                temp_path.unlink(missing_ok=True)
            print("R35_DAY", day, len(result), flush=True)
            return result
        except Exception as error:
            last_error = error
            print("R35_DAY_RETRY", day, attempt + 1, repr(error), flush=True)
    raise RuntimeError(f"30-second download failed for {day}: {last_error}")


def load_bars() -> pd.DataFrame:
    if CACHE.exists():
        return pd.read_pickle(CACHE)
    if (
        LEGACY_CACHE.exists()
        and DATA_END == date(2026, 9, 1)
        and DATA_DAYS == 56
        and SYMBOL == "XAUUSDT"
    ):
        bars = pd.read_pickle(LEGACY_CACHE)
        bars.to_pickle(CACHE)
        return bars
    dates = [
        (DATA_END - timedelta(days=DATA_DAYS - offset)).isoformat()
        for offset in range(DATA_DAYS)
    ]
    frames = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(download_day, day): day for day in dates}
        for future in as_completed(futures):
            frames.append(future.result())
    bars = pd.concat(frames).sort_index()
    bars = bars[~bars.index.duplicated(keep="last")]
    bars.to_pickle(CACHE)
    return bars


def prepare() -> Prepared:
    bars = load_bars().sort_index()
    e8, e14, e150 = ema(bars.close, 8), ema(bars.close, 14), ema(bars.close, 150)
    direction = np.sign(e8 - e14).fillna(0)
    cross = direction.ne(direction.shift()) & direction.ne(0)
    age = np.full(len(bars), 10_000, dtype=np.int16)
    last = -10_000
    for i, value in enumerate(cross.to_numpy()):
        if value:
            last = i
        age[i] = min(10_000, i - last)

    previous = bars.close.shift(1)
    true_range = pd.concat(
        [
            bars.high - bars.low,
            (bars.high - previous).abs(),
            (bars.low - previous).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr = true_range.rolling(28).mean()
    candle_range = (bars.high - bars.low).replace(0, np.nan)
    volume_average = bars.volume.shift(1).rolling(40).mean()
    volume_ratio = bars.volume / volume_average
    flow = (bars.buy_volume - bars.sell_volume) / (
        bars.buy_volume + bars.sell_volume
    ).replace(0, np.nan)

    high40 = bars.high.shift(1).rolling(40).max()
    low40 = bars.low.shift(1).rolling(40).min()
    high120 = bars.high.shift(1).rolling(120).max()
    low120 = bars.low.shift(1).rolling(120).min()
    swing = (high40 - low40).replace(0, np.nan)
    tolerance = atr * 0.15
    fib_events = pd.Series(False, index=bars.index)
    fib_distance = pd.Series(np.inf, index=bars.index)
    for ratio in (0.382, 0.5, 0.618):
        long_level = high40 - swing * ratio
        short_level = low40 + swing * ratio
        long_touch = (
            direction.gt(0)
            & bars.low.le(long_level + tolerance)
            & bars.close.gt(long_level)
            & bars.close.gt(bars.open)
        )
        short_touch = (
            direction.lt(0)
            & bars.high.ge(short_level - tolerance)
            & bars.close.lt(short_level)
            & bars.close.lt(bars.open)
        )
        fib_events |= long_touch | short_touch
        selected_level = pd.Series(
            np.where(direction.gt(0), long_level, short_level), index=bars.index
        )
        fib_distance = pd.concat(
            [fib_distance, (bars.close - selected_level).abs() / atr], axis=1
        ).min(axis=1)

    ema_bounce = (
        (direction.gt(0) & bars.low.le(e8) & bars.close.gt(e8))
        | (direction.lt(0) & bars.high.ge(e8) & bars.close.lt(e8))
    )
    structure_retest = (
        (direction.gt(0) & bars.high.gt(high40) & bars.low.le(high40))
        | (direction.lt(0) & bars.low.lt(low40) & bars.high.ge(low40))
    )
    fib_edge = event_edge(fib_events)
    ema_edge = event_edge(ema_bounce)
    structure_edge = event_edge(structure_retest)
    event = (cross | fib_edge | ema_edge | structure_edge) & (age <= 40)

    trends = {frame: closed_trend(bars, frame).to_numpy(np.int8) for frame in TREND_FRAMES}
    higher5 = bars.close.resample("5min", label="left", closed="left").last().dropna()
    macd_line = ema(higher5, 12) - ema(higher5, 26)
    macd_signal = ema(macd_line, 9)
    macd_histogram = macd_line - macd_signal
    closed_macd = macd_histogram.shift(1).reindex(bars.index, method="ffill")
    macd_direction = np.sign(closed_macd).fillna(0).to_numpy(np.int8)
    macd_cross = np.r_[
        0,
        np.where(
            macd_direction[1:] != macd_direction[:-1], macd_direction[1:], 0
        ),
    ].astype(np.int8)
    macd_age = np.zeros(len(bars), dtype=np.float32)
    last_macd = 0
    for i, value in enumerate(macd_cross):
        if value:
            last_macd = i
        macd_age[i] = min(600, i - last_macd)

    delta = bars.close.diff()
    gain = delta.clip(lower=0).rolling(28).mean()
    loss = (-delta.clip(upper=0)).rolling(28).mean()
    rsi = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    mean40 = bars.close.rolling(40).mean()
    deviation40 = bars.close.rolling(40).std()
    z40 = (bars.close - mean40) / deviation40.replace(0, np.nan)
    side = direction
    features = pd.DataFrame(index=bars.index)
    features["side"] = side
    features["cross"] = cross.astype(float)
    features["fibBounce"] = fib_edge.astype(float)
    features["emaBounce"] = ema_edge.astype(float)
    features["structureRetest"] = structure_edge.astype(float)
    features["barsSinceCross"] = age / 40
    features["emaSeparationAtr"] = (e8 - e14).abs() / atr
    features["ema150DistanceAtr"] = (bars.close - e150) * side / atr
    features["ema150SlopeAtr"] = (e150 - e150.shift(10)) * side / atr
    for frame, values in trends.items():
        features[f"trend_{frame}"] = values * side.to_numpy()
    features["macdDirection"] = macd_direction * side.to_numpy()
    features["macdHistogramAtr"] = closed_macd * side / atr
    features["macdSlopeAtr"] = (closed_macd - closed_macd.shift(10)) * side / atr
    features["barsSinceMacdCross"] = macd_age / 600
    features["volumeRatio"] = volume_ratio
    features["flow"] = flow * side
    features["flow5"] = flow.rolling(5).mean() * side
    features["body"] = (bars.close - bars.open) / candle_range * side
    features["closeLocation"] = ((bars.close - bars.low) / candle_range - 0.5) * side
    features["atrPct"] = atr / bars.close * 100
    features["rangeExpansion"] = true_range / atr
    features["roc1"] = bars.close.pct_change() * 100 * side
    features["roc6"] = bars.close.pct_change(6) * 100 * side
    features["roc20"] = bars.close.pct_change(20) * 100 * side
    features["rsiDirectional"] = (rsi - 50) / 50 * side
    features["z40Directional"] = z40 * side
    features["fibDistanceAtr"] = fib_distance
    features["roomAtr"] = np.where(
        side.gt(0), (high120 - bars.close) / atr, (bars.close - low120) / atr
    )
    features["supportRiskAtr"] = np.where(
        side.gt(0), (bars.close - low40) / atr, (high40 - bars.close) / atr
    )
    hour = bars.index.hour + bars.index.minute / 60 + bars.index.second / 3600
    features["hourSin"] = np.sin(2 * np.pi * hour / 24)
    features["hourCos"] = np.cos(2 * np.pi * hour / 24)

    valid = event & features.replace([np.inf, -np.inf], np.nan).notna().all(axis=1)
    valid.iloc[-1] = False
    idx = np.flatnonzero(valid.to_numpy())
    x = features.iloc[idx].to_numpy(np.float32)
    sides = direction.iloc[idx].to_numpy(np.int8)
    train_end = len(bars) * 2 // 3
    validation_mid = train_end + (len(bars) - train_end) // 2
    return Prepared(
        bars=bars,
        x=x,
        idx=idx,
        sides=sides,
        names=list(features.columns),
        trends=trends,
        macd_direction=macd_direction,
        macd_cross=macd_cross,
        volume_ratio=volume_ratio.fillna(0).to_numpy(),
        support=low40.fillna(bars.close).to_numpy(),
        resistance=high40.fillna(bars.close).to_numpy(),
        train_end=train_end,
        validation_mid=validation_mid,
        validation_end=len(bars),
    )


def outcomes(prepared: Prepared, tp_pct: float, sl_pct: float, horizon: int, trend_frame: str):
    bars = prepared.bars
    op, high, low, close = (
        bars[column].to_numpy(float) for column in ["open", "high", "low", "close"]
    )
    trend = prepared.trends[trend_frame]
    returns = np.empty(len(prepared.idx), dtype=np.float32)
    exits = np.empty(len(prepared.idx), dtype=np.int32)
    reasons = np.empty(len(prepared.idx), dtype=np.int8)
    for k, (signal, side) in enumerate(zip(prepared.idx, prepared.sides)):
        entry_bar = signal + 1
        entry = op[entry_bar]
        target = entry * (1 + side * tp_pct / 100)
        stop = entry * (1 - side * sl_pct / 100)
        last = min(len(bars) - 1, entry_bar + horizon)
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
        returns[k] = side * (exit_price / entry - 1) * 100 - COST
        exits[k] = exit_bar
        reasons[k] = reason
    return returns, exits, reasons


def allowed_rows(
    prepared: Prepared,
    trend_frame: str,
    volume_min: float,
    macd_aligned: bool,
    structural: bool,
    tp_pct: float,
    sl_pct: float,
) -> np.ndarray:
    idx, side = prepared.idx, prepared.sides
    close = prepared.bars.close.to_numpy()[idx]
    e150_distance = prepared.x[:, prepared.names.index("ema150DistanceAtr")]
    allowed = (
        (prepared.trends[trend_frame][idx] == side)
        & (e150_distance > 0)
        & (prepared.volume_ratio[idx] >= volume_min)
    )
    if macd_aligned:
        allowed &= prepared.macd_direction[idx] == side
    if structural:
        room_pct = np.where(
            side > 0,
            (prepared.resistance[idx] / close - 1) * 100,
            (close / prepared.support[idx] - 1) * 100,
        )
        support_pct = np.where(
            side > 0,
            (close / prepared.support[idx] - 1) * 100,
            (prepared.resistance[idx] / close - 1) * 100,
        )
        allowed &= (room_pct >= tp_pct) & (support_pct <= sl_pct)
    return np.flatnonzero(allowed)


def select_records(
    prepared: Prepared,
    rows: np.ndarray,
    probabilities: np.ndarray,
    returns: np.ndarray,
    exits: np.ndarray,
    reasons: np.ndarray,
    start: int,
    end: int,
    threshold: float,
):
    in_segment = rows[
        (prepared.idx[rows] >= start)
        & (prepared.idx[rows] + 1 < end)
    ]
    records = []
    next_bar = start
    for k in in_segment:
        signal = int(prepared.idx[k])
        entry = signal + 1
        if entry < next_bar or probabilities[k] < threshold or exits[k] >= end:
            continue
        records.append(
            (
                prepared.bars.index[entry].value,
                float(returns[k]),
                int(k),
                int(exits[k]),
                int(reasons[k]),
            )
        )
        next_bar = int(exits[k]) + 1
    return records


def stats(records, days: float):
    values = np.asarray([record[1] for record in records], dtype=float)
    wins = values[values > 0]
    losses = -values[values <= 0]
    equity = peak = 100.0
    drawdown = 0.0
    for value in values:
        equity *= 1 + value * EXPOSURE / 100
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak * 100)
    return {
        "trades": int(len(values)),
        "winRate": float((values > 0).mean() * 100) if len(values) else 0.0,
        "pf": float(wins.sum() / losses.sum()) if losses.sum() else (99.0 if wins.sum() else 0.0),
        "returnPct": equity - 100,
        "ddPct": drawdown,
        "tradesPerDay": len(values) / days,
    }


def segment(
    prepared: Prepared,
    name: str,
    rows: np.ndarray,
    probabilities: np.ndarray,
    outcome,
    threshold: float,
):
    if name == "train":
        start, end = 0, prepared.train_end
    elif name == "validationA":
        start, end = prepared.train_end, prepared.validation_mid
    else:
        start, end = prepared.validation_mid, prepared.validation_end
    records = select_records(
        prepared, rows, probabilities, *outcome, start, end, threshold
    )
    return stats(records, (end - start) / BARS_PER_DAY), records


def qualifies(value: dict) -> bool:
    return (
        value["tradesPerDay"] >= MIN_TRADES_PER_DAY
        and value["winRate"] >= 65
        and value["pf"] >= 1.2
        and value["returnPct"] > 0
    )


def score(train: dict, val_a: dict, val_b: dict) -> float:
    windows = [train, val_a, val_b]
    passed = all(qualifies(value) for value in windows)
    return (
        (10_000 if passed else 0)
        + min(val_a["winRate"], val_b["winRate"])
        + min(val_a["pf"], val_b["pf"]) * 30
        + min(val_a["returnPct"], val_b["returnPct"]) * 20
        - abs(val_a["winRate"] - val_b["winRate"]) * 0.5
        - max(0, train["winRate"] - min(val_a["winRate"], val_b["winRate"]))
    )


def clean(row: dict) -> dict:
    return {key: value for key, value in row.items() if key not in {"records"}}


def audit(prepared: Prepared, row: dict):
    names = ["TP", "MACD_5M_REVERSE", "HIGHER_TF_REVERSE", "SL", "HORIZON"]
    bars = prepared.bars
    items = []
    for _, net, k, exit_bar, reason in row["records"]:
        signal = int(prepared.idx[k])
        entry_bar = signal + 1
        side = int(prepared.sides[k])
        entry = float(bars.open.iloc[entry_bar])
        items.append(
            {
                "signalTime": bars.index[signal].isoformat(),
                "entryTime": bars.index[entry_bar].isoformat(),
                "exitTime": bars.index[exit_bar].isoformat(),
                "side": "BUY" if side > 0 else "SELL",
                "entry": entry,
                "tp": entry * (1 + side * row["tp"] / 100),
                "sl": entry * (1 - side * row["sl"] / 100),
                "support": float(prepared.support[signal]),
                "resistance": float(prepared.resistance[signal]),
                "exitReason": names[reason],
                "netPct": net,
            }
        )
    return items


def main():
    prepared = prepare()
    print("R35_CANDIDATES", len(prepared.idx), flush=True)
    results = []
    for frame_index, trend_frame in enumerate(TREND_FRAMES, start=1):
        for risk_index, (tp_pct, sl_pct) in enumerate(RISK_PAIRS, start=1):
            for horizon_minutes in HORIZON_MINUTES:
                horizon = horizon_minutes * 2
                outcome = outcomes(prepared, tp_pct, sl_pct, horizon, trend_frame)
                purge_end = prepared.train_end - horizon - 1
                train_rows = np.flatnonzero(prepared.idx < purge_end)
                y = (outcome[0][train_rows] > 0).astype(np.int8)
                positives, negatives = max(1, int(y.sum())), max(1, int((y == 0).sum()))
                weights = np.where(
                    y > 0,
                    len(y) / (2 * positives),
                    len(y) / (2 * negatives),
                )
                model = HistGradientBoostingClassifier(
                    max_iter=80,
                    max_leaf_nodes=10,
                    min_samples_leaf=50,
                    learning_rate=0.05,
                    l2_regularization=12,
                    random_state=35,
                ).fit(prepared.x[train_rows], y, sample_weight=weights)
                probabilities = model.predict_proba(prepared.x)[:, 1]
                for volume_min in (0.7, 1.0):
                    for macd_aligned in (False, True):
                        for structural in (False, True):
                            allowed = allowed_rows(
                                prepared,
                                trend_frame,
                                volume_min,
                                macd_aligned,
                                structural,
                                tp_pct,
                                sl_pct,
                            )
                            validation_rows = allowed[
                                (prepared.idx[allowed] >= prepared.train_end)
                                & (prepared.idx[allowed] + horizon + 1 < prepared.validation_end)
                            ]
                            if len(validation_rows) < 20:
                                continue
                            best = None
                            thresholds = np.unique(
                                np.quantile(
                                    probabilities[validation_rows],
                                    np.linspace(0.15, 0.995, 22),
                                )
                            )
                            for threshold in thresholds:
                                train, _ = segment(
                                    prepared, "train", allowed, probabilities, outcome, float(threshold)
                                )
                                val_a, _ = segment(
                                    prepared, "validationA", allowed, probabilities, outcome, float(threshold)
                                )
                                val_b, records = segment(
                                    prepared, "validationB", allowed, probabilities, outcome, float(threshold)
                                )
                                if min(
                                    train["tradesPerDay"],
                                    val_a["tradesPerDay"],
                                    val_b["tradesPerDay"],
                                ) < MIN_TRADES_PER_DAY:
                                    continue
                                candidate = {
                                    "tp": tp_pct,
                                    "sl": sl_pct,
                                    "horizonMinutes": horizon_minutes,
                                    "trendFrame": trend_frame,
                                    "volumeMin": volume_min,
                                    "macdEntryAligned": macd_aligned,
                                    "structureSpace": structural,
                                    "threshold": float(threshold),
                                    "train": train,
                                    "validationA": val_a,
                                    "validationB": val_b,
                                    "qualified": all(qualifies(value) for value in [train, val_a, val_b]),
                                    "score": score(train, val_a, val_b),
                                    "records": records,
                                }
                                if best is None or candidate["score"] > best["score"]:
                                    best = candidate
                            if best is not None:
                                results.append(best)
                print(
                    "R35_CONFIG",
                    frame_index,
                    "/",
                    len(TREND_FRAMES),
                    risk_index,
                    "/",
                    len(RISK_PAIRS),
                    horizon_minutes,
                    flush=True,
                )
    results.sort(key=lambda item: item["score"], reverse=True)
    best = results[0]
    output = {
        "mode": "DEVELOPMENT_ONLY_BLIND_LOCKED",
        "symbol": SYMBOL,
        "entryTimeframe": "30s",
        "entryExecution": "MARKET_NEXT_30S_OPEN",
        "entryEvents": ["EMA_8_14_CROSS", "EMA_REBOUND", "FIB_REBOUND", "STRUCTURE_RETEST"],
        "hardFilters": ["EMA150_30S", "HIGHER_TIMEFRAME_TREND", "VOLUME"],
        "positionExits": ["MACD_5M_REVERSE", "HIGHER_TIMEFRAME_REVERSE", "TP", "SL"],
        "costPct": COST,
        "lookaheadFree": True,
        "purgedBoundaries": True,
        "requirements": {
            "winRateMin": 65,
            "tradesPerDayMin": MIN_TRADES_PER_DAY,
            "pfMin": 1.2,
            "positiveReturn": True,
        },
        "candidates": len(prepared.idx),
        "testedConfigurations": len(results),
        "qualifiedConfigurations": sum(item["qualified"] for item in results),
        "best": clean(best),
        "top20": [clean(item) for item in results[:20]],
        "blindOpened": False,
        "survived": False,
    }
    artifact_dir = os.path.join(os.path.dirname(__file__), "..", "artifacts")
    with open(os.path.join(artifact_dir, "r35-30s-development.json"), "w") as file:
        json.dump(output, file, indent=2)
    with open(os.path.join(artifact_dir, "r35-30s-trades.json"), "w") as file:
        json.dump({"config": clean(best), "trades": audit(prepared, best)}, file, indent=2)
    print(
        "R35_RESULT",
        json.dumps({key: value for key, value in output.items() if key != "top20"}),
        flush=True,
    )


if __name__ == "__main__":
    main()
