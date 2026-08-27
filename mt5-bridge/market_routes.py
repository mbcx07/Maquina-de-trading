from __future__ import annotations

import os
from typing import Optional

import MetaTrader5 as mt5
from dotenv import load_dotenv
from fastapi import APIRouter, Header, HTTPException

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


def authorize(x_bridge_token: Optional[str]) -> None:
    if TOKEN and x_bridge_token != TOKEN:
        raise HTTPException(status_code=401, detail="Invalid bridge token")


def ensure_mt5() -> None:
    if mt5.terminal_info() is not None:
        return
    kwargs = {"path": TERMINAL_PATH} if TERMINAL_PATH else {}
    if not mt5.initialize(**kwargs):
        raise HTTPException(status_code=503, detail={"error": "MT5_INITIALIZE_FAILED", "last_error": mt5.last_error()})


@router.get("/rates/{symbol}")
def rates(
    symbol: str,
    timeframe: str = "M1",
    count: int = 220,
    x_bridge_token: Optional[str] = Header(default=None),
):
    authorize(x_bridge_token)
    ensure_mt5()

    normalized = symbol.strip()
    tf = TIMEFRAMES.get(timeframe.upper())
    if tf is None:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe}")
    count = max(50, min(int(count), 1000))

    info = mt5.symbol_info(normalized)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Unknown MT5 symbol: {normalized}")
    if not info.visible and not mt5.symbol_select(normalized, True):
        raise HTTPException(status_code=400, detail={"error": "MT5_SYMBOL_SELECT_FAILED", "last_error": mt5.last_error()})

    rows = mt5.copy_rates_from_pos(normalized, tf, 0, count)
    if rows is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_COPY_RATES_FAILED", "last_error": mt5.last_error()})

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
