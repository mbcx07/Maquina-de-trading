from __future__ import annotations

import os
from typing import Literal, Optional

import MetaTrader5 as mt5
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

load_dotenv()

HOST = os.getenv("MT5_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("MT5_BRIDGE_PORT", "8790"))
TOKEN = os.getenv("MT5_BRIDGE_TOKEN", "")
LOGIN = os.getenv("MT5_LOGIN", "").strip()
PASSWORD = os.getenv("MT5_PASSWORD", "").strip()
SERVER = os.getenv("MT5_SERVER", "").strip()
TERMINAL_PATH = os.getenv("MT5_TERMINAL_PATH", "").strip()

app = FastAPI(title="Maquina Trading V34 MT5 Bridge", version="0.1.0")


class OrderRequest(BaseModel):
    symbol: str = Field(min_length=1)
    side: Literal["BUY", "SELL"]
    volume: float = Field(gt=0)
    sl: float = Field(gt=0)
    tp: float = Field(gt=0)
    magic: int = 340034
    deviation: int = Field(default=20, ge=0, le=1000)
    comment: str = Field(default="V34", max_length=31)


class CloseRequest(BaseModel):
    ticket: int
    deviation: int = Field(default=20, ge=0, le=1000)


def authorize(x_bridge_token: Optional[str] = Header(default=None)) -> None:
    if TOKEN and x_bridge_token != TOKEN:
        raise HTTPException(status_code=401, detail="Invalid bridge token")


def ensure_mt5() -> None:
    if mt5.terminal_info() is not None:
        return

    kwargs = {}
    if TERMINAL_PATH:
        kwargs["path"] = TERMINAL_PATH

    if not mt5.initialize(**kwargs):
        raise HTTPException(status_code=503, detail={"error": "MT5_INITIALIZE_FAILED", "last_error": mt5.last_error()})

    if LOGIN:
        login_kwargs = {"login": int(LOGIN)}
        if PASSWORD:
            login_kwargs["password"] = PASSWORD
        if SERVER:
            login_kwargs["server"] = SERVER
        if not mt5.login(**login_kwargs):
            raise HTTPException(status_code=503, detail={"error": "MT5_LOGIN_FAILED", "last_error": mt5.last_error()})


def account_snapshot() -> dict:
    ensure_mt5()
    info = mt5.account_info()
    if info is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_ACCOUNT_INFO_FAILED", "last_error": mt5.last_error()})

    data = info._asdict()
    hedging_constant = getattr(mt5, "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING", 2)
    return {
        "login": data.get("login"),
        "server": data.get("server"),
        "currency": data.get("currency"),
        "tradeMode": data.get("trade_mode"),
        "tradeAllowed": bool(data.get("trade_allowed")),
        "tradeExpert": bool(data.get("trade_expert")),
        "leverage": data.get("leverage"),
        "marginMode": data.get("margin_mode"),
        "hedging": data.get("margin_mode") == hedging_constant,
        "balance": float(data.get("balance", 0.0)),
        "equity": float(data.get("equity", 0.0)),
        "profit": float(data.get("profit", 0.0)),
        "margin": float(data.get("margin", 0.0)),
        "marginFree": float(data.get("margin_free", 0.0)),
        "marginLevel": float(data.get("margin_level", 0.0)),
    }


def serialize_position(position) -> dict:
    data = position._asdict()
    return {
        "ticket": int(data.get("ticket", 0)),
        "symbol": data.get("symbol"),
        "side": "BUY" if int(data.get("type", 0)) == mt5.POSITION_TYPE_BUY else "SELL",
        "volume": float(data.get("volume", 0.0)),
        "priceOpen": float(data.get("price_open", 0.0)),
        "sl": float(data.get("sl", 0.0)),
        "tp": float(data.get("tp", 0.0)),
        "priceCurrent": float(data.get("price_current", 0.0)),
        "swap": float(data.get("swap", 0.0)),
        "profit": float(data.get("profit", 0.0)),
        "magic": int(data.get("magic", 0)),
        "comment": data.get("comment", ""),
        "time": int(data.get("time", 0)),
        "timeMsc": int(data.get("time_msc", 0)),
    }


def choose_filling_modes():
    modes = []
    for name in ("ORDER_FILLING_IOC", "ORDER_FILLING_FOK", "ORDER_FILLING_RETURN"):
        value = getattr(mt5, name, None)
        if value is not None and value not in modes:
            modes.append(value)
    return modes


@app.get("/health", dependencies=[Depends(authorize)])
def health():
    account = account_snapshot()
    return {"ok": True, "account": account, "lastError": mt5.last_error()}


@app.get("/account", dependencies=[Depends(authorize)])
def account():
    return account_snapshot()


@app.get("/positions", dependencies=[Depends(authorize)])
def positions(symbol: Optional[str] = None):
    ensure_mt5()
    rows = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    if rows is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_POSITIONS_GET_FAILED", "last_error": mt5.last_error()})
    return [serialize_position(row) for row in rows]


@app.post("/order", dependencies=[Depends(authorize)])
def open_order(order: OrderRequest):
    ensure_mt5()
    account = account_snapshot()
    symbol = order.symbol.strip().upper()

    info = mt5.symbol_info(symbol)
    if info is None:
        raise HTTPException(status_code=400, detail=f"Unknown MT5 symbol: {symbol}")
    if not info.visible and not mt5.symbol_select(symbol, True):
        raise HTTPException(status_code=400, detail={"error": "MT5_SYMBOL_SELECT_FAILED", "last_error": mt5.last_error()})

    existing = mt5.positions_get(symbol=symbol) or ()
    if existing and not account["hedging"]:
        raise HTTPException(
            status_code=409,
            detail="MT5 account is NETTING. Multiple independent positions on the same symbol require HEDGING mode.",
        )

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_TICK_FAILED", "last_error": mt5.last_error()})

    is_buy = order.side == "BUY"
    price = float(tick.ask if is_buy else tick.bid)
    order_type = mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL

    base_request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(order.volume),
        "type": order_type,
        "price": price,
        "sl": float(order.sl),
        "tp": float(order.tp),
        "deviation": int(order.deviation),
        "magic": int(order.magic),
        "comment": order.comment,
        "type_time": mt5.ORDER_TIME_GTC,
    }

    last_check = None
    last_result = None

    for filling in choose_filling_modes():
        request = {**base_request, "type_filling": filling}
        check = mt5.order_check(request)
        last_check = check
        if check is None:
            continue

        check_dict = check._asdict()
        # 0 means request validation accepted by the terminal/server.
        if int(check_dict.get("retcode", -1)) != 0:
            continue

        result = mt5.order_send(request)
        last_result = result
        if result is None:
            continue

        result_dict = result._asdict()
        if int(result_dict.get("retcode", -1)) in {
            getattr(mt5, "TRADE_RETCODE_DONE", 10009),
            getattr(mt5, "TRADE_RETCODE_PLACED", 10008),
            getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010),
        }:
            ticket = int(result_dict.get("order") or result_dict.get("deal") or 0)
            positions_now = mt5.positions_get(symbol=symbol) or ()
            candidates = [p for p in positions_now if int(p.magic) == order.magic]
            newest = max(candidates, key=lambda p: int(p.time_msc), default=None)
            return {
                "ok": True,
                "ticket": int(newest.ticket) if newest is not None else ticket,
                "order": int(result_dict.get("order", 0)),
                "deal": int(result_dict.get("deal", 0)),
                "price": float(result_dict.get("price", price)),
                "volume": float(result_dict.get("volume", order.volume)),
                "retcode": int(result_dict.get("retcode", 0)),
                "comment": result_dict.get("comment", ""),
                "hedging": account["hedging"],
            }

    raise HTTPException(
        status_code=502,
        detail={
            "error": "MT5_ORDER_FAILED",
            "last_error": mt5.last_error(),
            "order_check": last_check._asdict() if last_check is not None else None,
            "order_send": last_result._asdict() if last_result is not None else None,
        },
    )


@app.post("/close", dependencies=[Depends(authorize)])
def close_position(req: CloseRequest):
    ensure_mt5()
    rows = mt5.positions_get(ticket=req.ticket)
    if not rows:
        raise HTTPException(status_code=404, detail=f"MT5 position ticket {req.ticket} not found")

    position = rows[0]
    symbol = position.symbol
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(status_code=503, detail={"error": "MT5_TICK_FAILED", "last_error": mt5.last_error()})

    is_buy = int(position.type) == mt5.POSITION_TYPE_BUY
    close_type = mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY
    close_price = float(tick.bid if is_buy else tick.ask)

    base_request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "position": int(position.ticket),
        "symbol": symbol,
        "volume": float(position.volume),
        "type": close_type,
        "price": close_price,
        "deviation": int(req.deviation),
        "magic": int(position.magic),
        "comment": "V34_CLOSE",
        "type_time": mt5.ORDER_TIME_GTC,
    }

    for filling in choose_filling_modes():
        result = mt5.order_send({**base_request, "type_filling": filling})
        if result is None:
            continue
        data = result._asdict()
        if int(data.get("retcode", -1)) in {
            getattr(mt5, "TRADE_RETCODE_DONE", 10009),
            getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010),
        }:
            return {
                "ok": True,
                "ticket": req.ticket,
                "deal": int(data.get("deal", 0)),
                "price": float(data.get("price", close_price)),
                "retcode": int(data.get("retcode", 0)),
            }

    raise HTTPException(status_code=502, detail={"error": "MT5_CLOSE_FAILED", "last_error": mt5.last_error()})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
