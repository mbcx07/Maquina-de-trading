from __future__ import annotations

import io
import json
import os
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier

SYMBOL = "XAUUSDT"
COST = 0.145
EXPOSURE = 0.10
DAYS = int(os.getenv("R32_DAYS", "56"))
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
CACHE = ARTIFACTS / f"r32-klines-1m-{DAYS}d.pkl"


def download_day(day: str) -> pd.DataFrame:
    url = f"https://data.binance.vision/data/futures/um/daily/klines/{SYMBOL}/1m/{SYMBOL}-1m-{day}.zip"
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "r32-lab"})
            with urllib.request.urlopen(req, timeout=90) as response:
                raw = response.read()
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                if not archive.namelist():
                    raise ValueError("empty Binance Vision ZIP")
                member = archive.namelist()[0]
                frame = pd.read_csv(
                    archive.open(member), header=None, usecols=[0,1,2,3,4,5,9],
                    names=["time","open","high","low","close","volume","buy_volume"],
                )
            for column in ["time","open","high","low","close","volume","buy_volume"]:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
            frame = frame.dropna(subset=["time","open","high","low","close","volume","buy_volume"])
            timestamp = frame["time"].astype("int64")
            timestamp = np.where(timestamp > 10**17, timestamp // 10**6,
                        np.where(timestamp > 10**14, timestamp // 10**3, timestamp))
            frame["time"] = pd.to_datetime(timestamp, unit="ms", utc=True)
            frame["bucket"] = frame["time"].dt.floor("1min")
            frame["sell_volume"] = (frame["volume"]-frame["buy_volume"]).clip(lower=0)
            out = frame.groupby("bucket", sort=True).agg(
                open=("open", "first"), high=("high", "max"),
                low=("low", "min"), close=("close", "last"),
                volume=("volume", "sum"), buy_volume=("buy_volume", "sum"),
                sell_volume=("sell_volume", "sum"),
            )
            print("DAY", day, len(out), flush=True)
            return out
        except Exception as exc:
            last = exc
            print("DAY_RETRY", day, attempt + 1, repr(exc), flush=True)
    raise RuntimeError(f"download failed {day}: {last}")


def load_bars() -> pd.DataFrame:
    if CACHE.exists():
        return pd.read_pickle(CACHE)
    fixed_end = os.getenv("R32_END_DATE")
    end = date.fromisoformat(fixed_end) if fixed_end else datetime.now(timezone.utc).date() - timedelta(days=2)
    dates = [(end - timedelta(days=DAYS - i)).isoformat() for i in range(DAYS)]
    frames = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(download_day, day): day for day in dates}
        for future in as_completed(futures):
            frames.append(future.result())
    bars = pd.concat(frames).sort_index()
    bars = bars[~bars.index.duplicated(keep="last")]
    bars.to_pickle(CACHE)
    return bars


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def features_and_candidates(b30: pd.DataFrame):
    b = b30.resample("1min", label="left", closed="left").agg({
        "open": "first", "high": "max", "low": "min", "close": "last",
        "volume": "sum", "buy_volume": "sum", "sell_volume": "sum",
    }).dropna()
    e8, e14, e150 = ema(b.close, 8), ema(b.close, 14), ema(b.close, 150)
    h15 = b.resample("15min", label="left", closed="left").agg({"close": "last"}).dropna()
    trend15 = np.sign(ema(h15.close, 8) - ema(h15.close, 14)).shift(1).reindex(b.index, method="ffill")
    h60 = b.resample("60min", label="left", closed="left").agg({"close": "last"}).dropna()
    trend60 = np.sign(ema(h60.close, 8) - ema(h60.close, 14)).shift(1).reindex(b.index, method="ffill")
    prev = b.close.shift(1)
    tr = pd.concat([(b.high-b.low), (b.high-prev).abs(), (b.low-prev).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    vol_avg = b.volume.shift(1).rolling(20).mean()
    rng = (b.high-b.low).replace(0, np.nan)
    hi20 = b.high.shift(1).rolling(20).max()
    lo20 = b.low.shift(1).rolling(20).min()
    hi60 = b.high.shift(1).rolling(60).max()
    lo60 = b.low.shift(1).rolling(60).min()
    delta = b.close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rsi = 100 - 100/(1 + gain/loss.replace(0, np.nan))
    mean20 = b.close.rolling(20).mean()
    std20 = b.close.rolling(20).std()
    z20 = (b.close-mean20)/std20.replace(0, np.nan)
    direction = np.sign(e8-e14)
    aligned = (direction == trend15) & (((direction > 0) & (b.close > e150)) | ((direction < 0) & (b.close < e150)))
    cross = ((direction != np.sign((e8-e14).shift(1))) & (direction != 0)).astype(float)
    bounce = (((direction>0)&(b.low<=e8)&(b.close>e8)) | ((direction<0)&(b.high>=e8)&(b.close<e8))).astype(float)
    pull150 = (((direction>0)&(b.low<=e150)&(b.close>e150)) | ((direction<0)&(b.high>=e150)&(b.close<e150))).astype(float)
    retest = (((direction>0)&(b.high>hi20)&(b.low<=hi20)) | ((direction<0)&(b.low<lo20)&(b.high>=lo20))).astype(float)
    x = pd.DataFrame(index=b.index)
    x["side"] = direction
    x["cross"] = cross
    x["bounce"] = bounce
    x["pull150"] = pull150
    x["retest"] = retest
    x["ema_sep_atr"] = (e8-e14).abs()/atr
    x["ema150_slope_atr"] = (e150-e150.shift(5))*direction/atr
    x["dist150_atr"] = (b.close-e150)*direction/atr
    x["volume_ratio"] = b.volume/vol_avg
    x["flow"] = (b.buy_volume-b.sell_volume)/(b.buy_volume+b.sell_volume).replace(0,np.nan)*direction
    x["body"] = (b.close-b.open)/rng*direction
    x["close_location"] = ((b.close-b.low)/rng-.5)*direction
    x["atr_pct"] = atr/b.close*100
    x["roc3"] = b.close.pct_change(3)*100*direction
    x["roc10"] = b.close.pct_change(10)*100*direction
    x["space_atr"] = np.where(direction>0,(hi60-b.close)/atr,(b.close-lo60)/atr)
    x["trend60"] = trend60*direction
    x["rsi_direction"] = (rsi-50)/50*direction
    x["z20_direction"] = z20*direction
    x["range_position"] = ((b.close-lo20)/(hi20-lo20).replace(0,np.nan)-.5)*direction
    hours = b.index.hour + b.index.minute/60
    x["hour_sin"] = np.sin(2*np.pi*hours/24)
    x["hour_cos"] = np.cos(2*np.pi*hours/24)
    extra_event = (rsi.lt(30)|rsi.gt(70)|z20.abs().gt(1.5)|x.flow.abs().gt(.35)|x.volume_ratio.gt(1.5)|x.body.abs().gt(.6))
    candidate = (direction != 0) & (((cross+bounce+pull150+retest)>0)|extra_event) & (x.volume_ratio >= .7)
    valid = candidate & x.replace([np.inf,-np.inf],np.nan).notna().all(axis=1)
    valid.iloc[-1] = False
    idx = np.flatnonzero(valid.to_numpy())
    names = list(x.columns)
    direct = x.iloc[idx].to_numpy(dtype=np.float32)
    reverse = direct.copy()
    for name in ["side", "ema150_slope_atr", "dist150_atr", "flow", "body", "close_location", "roc3", "roc10", "trend60", "rsi_direction", "z20_direction", "range_position"]:
        reverse[:, names.index(name)] *= -1
    both_x = np.vstack([direct, reverse])
    both_idx = np.concatenate([idx, idx])
    both_sides = np.concatenate([
        direction.iloc[idx].to_numpy(dtype=np.int8),
        -direction.iloc[idx].to_numpy(dtype=np.int8),
    ])
    order = np.argsort(both_idx, kind="stable")
    return b, both_x[order], both_idx[order], both_sides[order], names


def outcomes(b, idx, sides, tp_pct, sl_pct, horizon):
    op, hi, lo, cl = (b[c].to_numpy(float) for c in ["open","high","low","close"])
    n=len(idx); ret=np.empty(n); exits=np.empty(n,dtype=np.int32)
    for k,(i,side) in enumerate(zip(idx,sides)):
        e=op[i+1]; tp=e*(1+side*tp_pct/100); sl=e*(1-side*sl_pct/100); last=min(len(b)-1,i+1+horizon); px=cl[last]; xi=last
        for j in range(i+1,last+1):
            stop=lo[j]<=sl if side>0 else hi[j]>=sl; target=hi[j]>=tp if side>0 else lo[j]<=tp
            if stop: px=sl;xi=j;break
            if target: px=tp;xi=j;break
        ret[k]=side*(px/e-1)*100-COST; exits[k]=xi
    return ret,exits


def select_stats(indices, probs, returns, exits, start, end, threshold):
    eq=100.;peak=100.;dd=gp=gl=0.;wins=n=0;next_i=start
    for k in indices:
        if k<0 or probs[k]<threshold: continue
        entry=GLOBAL_IDX[k]+1
        if entry<start or entry>=end or entry<next_i: continue
        r=returns[k]; eq*=1+(r*EXPOSURE)/100;peak=max(peak,eq);dd=max(dd,(peak-eq)/peak*100);n+=1
        if r>0:wins+=1;gp+=r*EXPOSURE
        else:gl+=abs(r*EXPOSURE)
        next_i=exits[k]+1
    days=max(1,(end-start)/1440)
    return {"trades":n,"winRate":wins/n*100 if n else 0,"pf":gp/gl if gl else (99 if gp else 0),"returnPct":eq-100,"ddPct":dd,"tradesPerDay":n/days}


def main():
    global GLOBAL_IDX
    bars30=load_bars(); b,X,GLOBAL_IDX,sides,names=features_and_candidates(bars30)
    t1=len(b)//2;t2=len(b)*3//4
    train=np.flatnonzero(GLOBAL_IDX<t1); val=np.flatnonzero((GLOBAL_IDX>=t1)&(GLOBAL_IDX<t2)); test=np.flatnonzero(GLOBAL_IDX>=t2)
    configs=[]
    for tp in [.30,.40,.50,.60,.80]:
      for sl in [.10,.15,.20,.25,.30]:
       for horizon in [15,30,60,120]: configs.append((tp,sl,horizon))
    for tp in [.15,.20]:
      for sl in [.40,.60,.80,1.0]:
       for horizon in [60,120]: configs.append((tp,sl,horizon))
    rows=[]
    for z,(tp,sl,horizon) in enumerate(configs):
        returns,exits=outcomes(b,GLOBAL_IDX,sides,tp,sl,horizon); y=(returns>0).astype(np.int8)
        pos=max(1,y[train].sum()); weights=np.where(y[train]>0,len(train)/(2*pos),len(train)/(2*max(1,len(train)-pos)))
        model=HistGradientBoostingClassifier(
            max_iter=80, max_leaf_nodes=15, learning_rate=.07,
            l2_regularization=2, random_state=17,
        ).fit(X[train],y[train],sample_weight=weights)
        probs=model.predict_proba(X)[:,1]
        thresholds=np.unique(np.quantile(probs[val],np.linspace(.35,.98,45)))
        best=None
        for th in thresholds:
            sv=select_stats(val,probs,returns,exits,t1,t2,float(th)); st=select_stats(train,probs,returns,exits,0,t1,float(th))
            if sv['tradesPerDay']<10 or st['tradesPerDay']<10: continue
            score=sv['returnPct']*5+sv['pf']*8+sv['winRate']*.2-sv['ddPct']*2
            if best is None or score>best[0]:best=(score,float(th),st,sv)
        if best:
            rows.append({"tp":tp,"sl":sl,"horizon":horizon,"threshold":best[1],"train":best[2],"validation":best[3],"score":best[0],"returns":returns,"exits":exits,"probs":probs})
        print("CONFIG",z+1,"/",len(configs),tp,sl,horizon,flush=True)
    rows.sort(key=lambda r:r['score'],reverse=True); best=rows[0]
    test_stats=select_stats(test,best['probs'],best['returns'],best['exits'],t2,len(b),best['threshold'])
    clean=[{k:v for k,v in r.items() if k not in ('returns','exits','probs')} for r in rows[:20]]
    result={"symbol":SYMBOL,"days":DAYS,"costPct":COST,"candidates":len(GLOBAL_IDX),"features":names,"testedConfigurations":len(configs),"selection":"TRAIN_AND_VALIDATION_ONLY","best":clean[0],"test":test_stats,"top20":clean,"survived":bool(test_stats['winRate']>=65 and test_stats['tradesPerDay']>=10 and test_stats['pf']>=1.2 and test_stats['returnPct']>0)}
    (ARTIFACTS/"r32-ml-research.json").write_text(json.dumps(result,indent=2))
    print("R32_RESULT",json.dumps({k:v for k,v in result.items() if k!='top20'}),flush=True)

if __name__ == "__main__": main()
