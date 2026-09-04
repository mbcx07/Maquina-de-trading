from __future__ import annotations

import json, os
from itertools import product
import numpy as np
import pandas as pd
import r38_monster_replication as base

SYMBOLS=("XAUUSDT","CLUSDT"); FRAMES=("1min","3min","5min","15min")
TPS=(.30,.50,.70,1.0); STOPS=("atr1.5","atr2.5","atr4","structure")
EXITS=("none","trend5","trend15","confirmed"); COST=.145

def prepare(b30,frame,min_osc,volume_min,impulse_min,session,symbol):
    b=b30.resample(frame,label="left",closed="left").agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum","buy_volume":"sum","sell_volume":"sum"}).dropna()
    side,atr,smart=base.signals(b,"corrected",min_osc)
    volume_ratio=b.volume/b.volume.shift(1).rolling(30).mean()
    body=(b.close-b.open).abs()/pd.Series(atr,index=b.index).replace(0,np.nan)
    side=np.where((volume_ratio.to_numpy()>=volume_min)&(body.to_numpy()>=impulse_min),side,0).astype(np.int8)
    if session=="core":
        hour=b.index.hour
        allowed=(hour>=7)&(hour<20) if symbol=="XAUUSDT" else (hour>=12)&(hour<21)
        side=np.where(allowed,side,0).astype(np.int8)
    support=b.low.shift(1).rolling(20).min().to_numpy(); resistance=b.high.shift(1).rolling(20).max().to_numpy()
    fast=np.sign(base.ema(b.close,8)-base.ema(b.close,14)).shift(1).fillna(0).to_numpy(np.int8)
    return b,side,atr,smart,support,resistance,fast

def simulate(p,tp_pct,stop_mode,exit_mode,breakeven):
    b,side,atr,smart,support,resistance,fast=p
    o,h,l,c=(b[x].to_numpy(float) for x in ("open","high","low","close")); out=[]; next_bar=1
    for signal in np.flatnonzero(side):
        eb=signal+1
        if eb<next_bar or eb>=len(b) or not np.isfinite(atr[signal]): continue
        s=int(side[signal]); entry=o[eb]; target=entry*(1+s*tp_pct/100)
        if stop_mode=="structure":
            level=support[signal] if s>0 else resistance[signal]
            if not np.isfinite(level): continue
            raw=abs(entry-level)/entry*100
            risk_pct=min(.70,max(.20,raw+.05))
        else: risk_pct=min(.70,max(.20,atr[signal]*float(stop_mode[3:])/entry*100))
        stop=entry*(1-s*risk_pct/100); last=min(len(b)-1,eb+240); xp=c[last]; xb=last; reason="TIME"; be_done=False
        for j in range(eb,last+1):
            hs=l[j]<=stop if s>0 else h[j]>=stop; ht=h[j]>=target if s>0 else l[j]<=target
            if hs: xp=stop; xb=j; reason="SL"; break
            if ht: xp=target; xb=j; reason="TP"; break
            favorable=(h[j]/entry-1)*100 if s>0 else (entry/l[j]-1)*100
            if breakeven and not be_done and favorable>=.25:
                stop=entry*(1+s*(COST+.015)/100); be_done=True
            reverse=False
            if exit_mode=="trend5": reverse=smart["5min"][j]==-s
            elif exit_mode=="trend15": reverse=smart["15min"][j]==-s
            elif exit_mode=="confirmed":
                lost=(c[j]<support[j] if s>0 else c[j]>resistance[j]) if np.isfinite(support[j]) and np.isfinite(resistance[j]) else False
                reverse=smart["5min"][j]==-s and smart["macd5"][j]==-s and (fast[j]==-s or lost)
            if reverse: xp=c[j]; xb=j; reason="TREND"; break
        out.append((signal,eb,xb,s*(xp/entry-1)*100-COST,reason)); next_bar=xb+1
    return out

def stats(rec,days): return base.stats(rec,days)
def qualify(x): return x["tradesPerDay"]>=10 and x["winRate"]>=65 and x["pf"]>=1.2 and x["netPointsPct"]>0

def main():
    raw={s:base.load(s) for s in SYMBOLS}; rows=[]; tested=0
    signal_cfg=list(product(FRAMES,(1,2),(.8,1.2),(0,.25),("all","core")))
    trade_cfg=list(product(TPS,STOPS,EXITS,(False,True)))
    for frame,min_osc,vol,impulse,session in signal_cfg:
        prepared={s:prepare(raw[s],frame,min_osc,vol,impulse,session,s) for s in SYMBOLS}
        for tp,stop,exit_mode,be in trade_cfg:
            tested+=1; pool={"train":[],"validationA":[],"validationB":[]}; per={}
            for symbol,p in prepared.items():
                b=p[0]; rec=simulate(p,tp,stop,exit_mode,be); N=len(b); a=N*2//3; m=a+(N-a)//2; per[symbol]={}
                for name,start,end in (("train",0,a),("validationA",a,m),("validationB",m,N)):
                    r=base.segment(rec,start,end); st=stats(r,(end-start)/base.BPD[frame]); per[symbol][name]=st; pool[name].extend(r)
            days=np.mean([len(raw[s]) for s in SYMBOLS])/2880
            total={name:stats(pool[name],days*(2/3 if name=="train" else 1/6)) for name in pool}
            floor=min(total[x]["tradesPerDay"] for x in total); wr=min(total[x]["winRate"] for x in total); pf=min(total[x]["pf"] for x in total); ret=min(total[x]["netPointsPct"] for x in total)
            cfg={"timeframe":frame,"minOscillators":min_osc,"volumeRatio":vol,"impulseAtr":impulse,"session":session,"tpPct":tp,"stop":stop,"trendExit":exit_mode,"breakEven":be}
            score=wr+25*min(pf,3)+3*min(floor,10)+2*min(ret,2)-50*max(0,10-floor)
            rows.append({"config":cfg,"combined":total,"perSymbol":per,"qualified":all(qualify(total[x]) for x in total),"score":score})
        print("R39_SIGNAL_SET",signal_cfg.index((frame,min_osc,vol,impulse,session))+1,"/",len(signal_cfg),flush=True)
    rows.sort(key=lambda r:r["score"],reverse=True); eligible=[r for r in rows if min(r["combined"][x]["tradesPerDay"] for x in r["combined"])>=10]; high=[r for r in rows if min(r["combined"][x]["winRate"] for x in r["combined"])>=65]
    output={"mode":"DEVELOPMENT_ONLY_BLIND_LOCKED","symbols":list(SYMBOLS),"costPct":COST,"testedConfigurations":tested,"frequencyEligible":len(eligible),"stableWinRate65":len(high),"qualified":sum(r["qualified"] for r in rows),"bestFrequencyEligible":eligible[0] if eligible else None,"bestHighWinRate":high[0] if high else None,"bestOverall":rows[0],"blindOpened":False,"survived":False}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r39-monster-optimized.json")
    with open(path,"w") as f: json.dump(output,f,indent=2)
    print("R39_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
