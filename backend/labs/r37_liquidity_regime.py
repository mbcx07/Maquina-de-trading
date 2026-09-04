from __future__ import annotations

import importlib, json, os
from itertools import product
import numpy as np
import pandas as pd

SYMBOLS=os.getenv("R37_SYMBOLS","XAUUSDT,CLUSDT").split(",")
COST=0.145; BARS_PER_DAY=2880; MIN_TPD=10.0

def ema(s,n): return s.ewm(span=n,adjust=False).mean()

def load_symbol(symbol):
    os.environ["R35_SYMBOL"]=symbol
    import r35_30s_causal as feed
    return importlib.reload(feed).load_bars().sort_index()

def make_signals(b):
    close,high,low=b.close,b.high,b.low; prev=close.shift(1)
    tr=pd.concat([high-low,(high-prev).abs(),(low-prev).abs()],axis=1).max(axis=1)
    vol=b.volume/b.volume.shift(1).rolling(40).mean()
    flow=(b.buy_volume-b.sell_volume)/(b.buy_volume+b.sell_volume).replace(0,np.nan)
    e150=ema(close,150); m5=close.resample("5min",label="left",closed="left").last().dropna()
    line=ema(m5,12)-ema(m5,26); macd=(line-ema(line,9)).shift(1).reindex(b.index,method="ffill")
    md=np.sign(macd).fillna(0).to_numpy(np.int8)
    mc=np.r_[0,np.where(md[1:]!=md[:-1],md[1:],0)].astype(np.int8)
    trends={}; efficiency={}
    for tf in ("5min","15min"):
        h=close.resample(tf,label="left",closed="left").last().dropna()
        trends[tf]=np.sign(ema(h,8)-ema(h,21)).shift(1).reindex(b.index,method="ffill").fillna(0).to_numpy(np.int8)
        er=(h-h.shift(12)).abs()/h.diff().abs().rolling(12).sum().replace(0,np.nan)
        efficiency[tf]=er.shift(1).reindex(b.index,method="ffill").fillna(0).to_numpy()
    result={"atr":tr.rolling(28).mean().to_numpy(),"vol":vol.fillna(0).to_numpy(),"flow":flow.fillna(0).to_numpy(),"macdCross":mc,"emaBias":np.sign(close-e150).fillna(0).to_numpy(np.int8),"trends":trends,"efficiency":efficiency}
    for lookback in (20,40,80):
        ph=high.shift(1).rolling(lookback).max(); pl=low.shift(1).rolling(lookback).min()
        ls=(low<pl)&(close>pl)&(close>b.open); ss=(high>ph)&(close<ph)&(close<b.open)
        bu=(close>ph).shift(1).rolling(10).max().fillna(0).astype(bool)
        bd=(close<pl).shift(1).rolling(10).max().fillna(0).astype(bool)
        lr=bu&(low<=ph)&(close>ph); sr=bd&(high>=pl)&(close<pl)
        result[lookback]={"sweep":np.where(ls,1,np.where(ss,-1,0)).astype(np.int8),"retest":np.where(lr,1,np.where(sr,-1,0)).astype(np.int8),"support":pl.to_numpy(),"resistance":ph.to_numpy()}
    return result

def simulate(b,f,cfg):
    engine,lookback,tf,regime,vol_min,flow_min,reward,risk=cfg
    side=f[lookback][engine]; idx=np.flatnonzero(side)
    ok=(f["vol"][idx]>=vol_min)&(f["flow"][idx]*side[idx]>=flow_min)&(f["trends"][tf][idx]==side[idx])
    if regime=="trend": ok&=(f["efficiency"][tf][idx]>=.28)&(f["emaBias"][idx]==side[idx])
    else: ok&=f["efficiency"][tf][idx]<.35
    idx=idx[ok]; op,hi,lo,cl=(b[x].to_numpy(float) for x in ("open","high","low","close")); out=[]
    for signal in idx:
        eb=signal+1
        if eb>=len(b): continue
        s=int(side[signal]); entry=op[eb]; support=f[lookback]["support"][signal]; resistance=f[lookback]["resistance"][signal]
        sr=(entry-support)/entry*100 if s>0 else (resistance-entry)/entry*100
        ar=min(risk,max(.15,sr)); stop=entry*(1-s*ar/100); target=entry*(1+s*reward/100)
        last=min(len(b)-1,eb+120); xp=cl[last]; xb=last; reason="TIME"
        for j in range(eb,last+1):
            if f["macdCross"][j]==-s and f["trends"][tf][j]==-s: xp=op[j]; xb=j; reason="MACD_STRUCTURE"; break
            hs=lo[j]<=stop if s>0 else hi[j]>=stop; ht=hi[j]>=target if s>0 else lo[j]<=target
            if hs: xp=stop; xb=j; reason="SL"; break
            if ht: xp=target; xb=j; reason="TP"; break
        out.append((signal,eb,xb,s*(xp/entry-1)*100-COST,reason,s,entry,stop,target))
    return out

def nonoverlap(records,start,end):
    chosen=[]; next_bar=start
    for r in records:
        if r[0]>=start and r[1]>=next_bar and r[2]<end: chosen.append(r); next_bar=r[2]+1
    return chosen

def stats(records,days):
    v=np.asarray([r[3] for r in records]); w=v[v>0]; loss=-v[v<=0]
    return {"trades":len(v),"tradesPerDay":len(v)/days,"winRate":float((v>0).mean()*100) if len(v) else 0,"pf":float(w.sum()/loss.sum()) if loss.sum() else (99.0 if w.sum() else 0),"returnPct":float(v.sum()) if len(v) else 0}

def qualifies(x): return x["tradesPerDay"]>=MIN_TPD and x["winRate"]>=65 and x["pf"]>=1.2 and x["returnPct"]>0

def main():
    data={s:load_symbol(s) for s in SYMBOLS}; feat={s:make_signals(b) for s,b in data.items()}
    configs=list(product(("sweep","retest"),(20,40,80),("5min","15min"),("trend","range"),(.7,1.0),(0,.1),(.6,.8,1.0),(.25,.4)))
    rows=[]
    for n,cfg in enumerate(configs,1):
        pool={"train":[],"validationA":[],"validationB":[]}; per={}
        for symbol,b in data.items():
            rec=simulate(b,feat[symbol],cfg); N=len(b); a=N*2//3; m=a+(N-a)//2; per[symbol]={}
            for name,start,end in (("train",0,a),("validationA",a,m),("validationB",m,N)):
                selected=nonoverlap(rec,start,end); per[symbol][name]=stats(selected,(end-start)/BARS_PER_DAY)
                pool[name].extend([(b.index[r[1]],r) for r in selected])
        combined={}
        for name in pool:
            rr=[x[1] for x in sorted(pool[name],key=lambda x:x[0])]
            days=np.mean([len(b) for b in data.values()])/BARS_PER_DAY*(2/3 if name=="train" else 1/6)
            combined[name]=stats(rr,days)
        va,vb=combined["validationA"],combined["validationB"]
        score=min(va["winRate"],vb["winRate"])+20*min(va["pf"],vb["pf"])+min(va["tradesPerDay"],vb["tradesPerDay"])
        conf={"engine":cfg[0],"lookback":cfg[1],"trendFrame":cfg[2],"regime":cfg[3],"volumeMin":cfg[4],"flowMin":cfg[5],"tpPct":cfg[6],"maxSlPct":cfg[7]}
        rows.append({"config":conf,"combined":combined,"perSymbol":per,"qualified":all(qualifies(combined[x]) for x in combined),"score":score})
        if n%100==0: print("R37_CONFIG",n,"/",len(configs),flush=True)
    rows.sort(key=lambda x:x["score"],reverse=True); best=rows[0]
    output={"mode":"DEVELOPMENT_ONLY_BLIND_LOCKED","symbols":SYMBOLS,"costPct":COST,"testedConfigurations":len(rows),"qualifiedConfigurations":sum(r["qualified"] for r in rows),"best":best,"blindOpened":False,"survived":False,"requirements":{"winRateMin":65,"tradesPerDayMin":10,"pfMin":1.2,"positiveReturn":True}}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r37-liquidity-regime.json")
    with open(path,"w") as fh: json.dump(output,fh,indent=2)
    print("R37_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
