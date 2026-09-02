from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import MetaTrader5 as mt5
from dotenv import load_dotenv
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

load_dotenv()

TOKEN = os.getenv("MT5_BRIDGE_TOKEN", "")
TERMINAL_PATH = os.getenv("MT5_TERMINAL_PATH", "").strip()

router = APIRouter(prefix="/market", tags=["market-data"])

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
}


class ProfitRequest(BaseModel):
    symbol: str = Field(min_length=1)
    side: Literal["BUY", "SELL"]
    volume: float = Field(gt=0)
    entry: float = Field(gt=0)
    exit: float = Field(gt=0)


def authorize(x_bridge_token: Optional[str]) -> None:
    if TOKEN and x_bridge_token != TOKEN:
        raise HTTPException(status_code=401, detail="Invalid bridge token")


def ensure_mt5() -> None:
    if mt5.terminal_info() is not None:
        return
    kwargs = {"path": TERMINAL_PATH} if TERMINAL_PATH else {}
    if not mt5.initialize(**kwargs):
        raise HTTPException(status_code=503, detail={"error": "MT5_INITIALIZE_FAILED", "last_error": mt5.last_error()})


def ensure_symbol(symbol: str):
    normalized = symbol.strip()
    info = mt5.symbol_info(normalized)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Unknown MT5 symbol: {normalized}")
    if not info.visible and not mt5.symbol_select(normalized, True):
        raise HTTPException(status_code=400, detail={"error": "MT5_SYMBOL_SELECT_FAILED", "last_error": mt5.last_error()})
    return normalized


def serialize_rates(rows):
    return [
        {
            "time": int(row["time"]) * 1000,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["tick_volume"]),
            "spread": int(row["spread"]),
            "realVolume": float(row["real_volume"]),
        }
        for row in rows
    ]


@router.get("/snapshot/{symbol}")
def snapshot(symbol: str, x_bridge_token: Optional[str] = Header(default=None)):
    authorize(x_bridge_token)
    ensure_mt5()
    normalized = ensure_symbol(symbol)
    info = mt5.symbol_info(normalized)
    tick = mt5.symbol_info_tick(normalized)
    if info is None or tick is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_SNAPSHOT_FAILED", "last_error": mt5.last_error()})

    point = float(info.point or 0.0)
    bid = float(tick.bid or 0.0)
    ask = float(tick.ask or 0.0)
    spread_points = (ask - bid) / point if point > 0 and ask > 0 and bid > 0 else float(info.spread or 0)
    return {
        "symbol": normalized,
        "bid": bid,
        "ask": ask,
        "point": point,
        "digits": int(info.digits),
        "spreadPoints": float(spread_points),
        "spreadPrice": max(0.0, ask - bid),
        "timeMsc": int(getattr(tick, "time_msc", 0)),
    }


@router.get("/ticks/{symbol}")
def ticks(
    symbol: str,
    seconds: int = 300,
    limit: int = 5000,
    x_bridge_token: Optional[str] = Header(default=None),
):
    authorize(x_bridge_token)
    ensure_mt5()
    normalized = ensure_symbol(symbol)
    seconds = max(30, min(int(seconds), 1800))
    limit = max(50, min(int(limit), 20000))
    start = datetime.now(tz=timezone.utc) - timedelta(seconds=seconds)
    rows = mt5.copy_ticks_from(normalized, start, limit, mt5.COPY_TICKS_ALL)
    if rows is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_COPY_TICKS_FAILED", "last_error": mt5.last_error()})
    output = []
    buy_flag = int(getattr(mt5, "TICK_FLAG_BUY", 32))
    sell_flag = int(getattr(mt5, "TICK_FLAG_SELL", 64))
    for row in rows:
        bid = float(row["bid"])
        ask = float(row["ask"])
        last = float(row["last"])
        price = last if last > 0 else (bid + ask) / 2 if bid > 0 and ask > 0 else max(bid, ask)
        if price <= 0:
            continue
        flags = int(row["flags"])
        output.append({
            "timeMsc": int(row["time_msc"]),
            "bid": bid,
            "ask": ask,
            "last": last,
            "price": price,
            "volume": float(row["volume"]),
            "flags": flags,
            "buy": bool(flags & buy_flag),
            "sell": bool(flags & sell_flag),
        })
    return output


@router.post("/calc-profit")
def calc_profit(req: ProfitRequest, x_bridge_token: Optional[str] = Header(default=None)):
    authorize(x_bridge_token)
    ensure_mt5()
    symbol = ensure_symbol(req.symbol)
    order_type = mt5.ORDER_TYPE_BUY if req.side == "BUY" else mt5.ORDER_TYPE_SELL
    result = mt5.order_calc_profit(order_type, symbol, float(req.volume), float(req.entry), float(req.exit))
    if result is None:
        raise HTTPException(status_code=422, detail={"error": "MT5_ORDER_CALC_PROFIT_FAILED", "last_error": mt5.last_error()})
    return {"symbol": symbol, "side": req.side, "volume": req.volume, "entry": req.entry, "exit": req.exit, "profit": float(result)}


@router.get("/rates/{symbol}")
def rates(
    symbol: str,
    timeframe: str = "M1",
    count: int = 220,
    x_bridge_token: Optional[str] = Header(default=None),
):
    authorize(x_bridge_token)
    ensure_mt5()

    normalized = ensure_symbol(symbol)
    tf = TIMEFRAMES.get(timeframe.upper())
    if tf is None:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe}")
    count = max(50, min(int(count), 5000))

    rows = mt5.copy_rates_from_pos(normalized, tf, 0, count)
    if rows is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_COPY_RATES_FAILED", "last_error": mt5.last_error()})
    return serialize_rates(rows)


@router.get("/rates-range/{symbol}")
def rates_range(
    symbol: str,
    timeframe: str,
    start_ms: int,
    end_ms: int,
    x_bridge_token: Optional[str] = Header(default=None),
):
    authorize(x_bridge_token)
    ensure_mt5()

    if end_ms <= start_ms:
        raise HTTPException(status_code=400, detail="Invalid time range")
    if end_ms - start_ms > 40 * 24 * 60 * 60 * 1000:
        raise HTTPException(status_code=400, detail="Range too large; maximum is 40 days including warm-up")

    normalized = ensure_symbol(symbol)
    tf = TIMEFRAMES.get(timeframe.upper())
    if tf is None:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe}")

    start_dt = datetime.fromtimestamp(start_ms / 1000.0, tz=timezone.utc)
    end_dt = datetime.fromtimestamp(end_ms / 1000.0, tz=timezone.utc)
    rows = mt5.copy_rates_range(normalized, tf, start_dt, end_dt)
    if rows is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_COPY_RATES_RANGE_FAILED", "last_error": mt5.last_error()})
    return serialize_rates(rows)


@router.get("/symbols")
def symbols(x_bridge_token: Optional[str] = Header(default=None)):
    authorize(x_bridge_token)
    ensure_mt5()
    rows = mt5.symbols_get()
    if rows is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_SYMBOLS_GET_FAILED", "last_error": mt5.last_error()})

    return [
        {
            "name": row.name,
            "path": row.path,
            "visible": bool(row.visible),
            "tradeMode": int(row.trade_mode),
            "currencyBase": row.currency_base,
            "currencyProfit": row.currency_profit,
            "volumeMin": float(row.volume_min),
            "volumeMax": float(row.volume_max),
            "volumeStep": float(row.volume_step),
        }
        for row in rows
    ]
