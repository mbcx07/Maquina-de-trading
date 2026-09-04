from __future__ import annotations
import json, os
from itertools import product
import numpy as np
import pandas as pd
import r38_monster_replication as base

SYMBOLS=("XAUUSDT","CLUSDT"); FRAMES=("1min","3min","5min","15min"); COST=.145

def prepare(b30,frame,break_type,vol_min,trend_mode,room_min):
    b=b30.resample(frame,label="left",closed="left").agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum","buy_volume":"sum","sell_volume":"sum"}).dropna()
    o,c,h,l=b.open,b.close,b.high,b.low
    mother_bear=c.shift(2)<o.shift(2); mother_bull=c.shift(2)>o.shift(2)
    inside_bull=(c.shift(1)>o.shift(1))&(o.shift(1)>c.shift(2))&(c.shift(1)<o.shift(2))
    inside_bear=(c.shift(1)<o.shift(1))&(o.shift(1)<c.shift(2))&(c.shift(1)>o.shift(2))
    bull_level=h.shift(2) if break_type=="wick" else o.shift(2); bear_level=l.shift(2) if break_type=="wick" else o.shift(2)
    bull=mother_bear&inside_bull&(c>bull_level)&(c>o); bear=mother_bull&inside_bear&(c<bear_level)&(c<o)
    side=np.where(bull,1,np.where(bear,-1,0)).astype(np.int8)
    prev=c.shift(1); atr=pd.concat([h-l,(h-prev).abs(),(l-prev).abs()],axis=1).max(axis=1).rolling(14).mean()
    vr=b.volume/b.volume.shift(1).rolling(30).mean(); e200=base.ema(c,200); bias=np.sign(c-e200).fillna(0).to_numpy(np.int8)
    h5=c.resample("5min",label="left",closed="left").last().dropna(); trend5=np.sign(base.ema(h5,8)-base.ema(h5,21)).shift(1).reindex(b.index,method="ffill").fillna(0).to_numpy(np.int8)
    support=l.shift(1).rolling(20).min(); resistance=h.shift(1).rolling(20).max(); entry=c
    room=np.where(side>0,(resistance/entry-1)*100,(entry/support-1)*100)
    allowed=(vr.to_numpy()>=vol_min)&(room>=room_min)
    if trend_mode=="ema200": allowed&=bias==side
    elif trend_mode=="trend5": allowed&=trend5==side
    side=np.where(allowed,side,0).astype(np.int8)
    return b,side,atr.to_numpy(),support.to_numpy(),resistance.to_numpy()

def simulate(p,tp,stop_mode,be):
    b,side,atr,support,resistance=p; o,h,l,c=(b[x].to_numpy(float) for x in ("open","high","low","close")); out=[]; next_bar=1
    for signal in np.flatnonzero(side):
        eb=signal+1
        if eb<next_bar or eb>=len(b) or not np.isfinite(atr[signal]): continue
        s=int(side[signal]); entry=o[eb]; target=entry*(1+s*tp/100)
        if stop_mode=="structure":
            level=support[signal] if s>0 else resistance[signal]
            if not np.isfinite(level): continue
            risk=min(.70,max(.20,abs(entry-level)/entry*100+.03))
        else: risk=float(stop_mode)
        stop=entry*(1-s*risk/100); last=min(len(b)-1,eb+120); xp=c[last]; xb=last; reason="TIME"; moved=False
        for j in range(eb,last+1):
            hs=l[j]<=stop if s>0 else h[j]>=stop; ht=h[j]>=target if s>0 else l[j]<=target
            if hs: xp=stop; xb=j; reason="SL"; break
            if ht: xp=target; xb=j; reason="TP"; break
            fav=(h[j]/entry-1)*100 if s>0 else (entry/l[j]-1)*100
            if be and not moved and fav>=.25: stop=entry*(1+s*(COST+.015)/100); moved=True
        out.append((signal,eb,xb,s*(xp/entry-1)*100-COST,reason)); next_bar=xb+1
    return out

def qualify(x): return x["tradesPerDay"]>=10 and x["winRate"]>=65 and x["pf"]>=1.2 and x["netPointsPct"]>0

def main():
    raw={s:base.load(s) for s in SYMBOLS}; rows=[]; signal_configs=list(product(FRAMES,("body","wick"),(.5,.7,1.),("none","ema200","trend5"),(0,.1,.2)))
    for n,(frame,break_type,vol,trend,room) in enumerate(signal_configs,1):
        prepared={s:prepare(raw[s],frame,break_type,vol,trend,room) for s in SYMBOLS}
        for tp,stop,be in product((.3,.5,.7,1.),(.2,.3,.4,"structure"),(False,True)):
            pool={"train":[],"validationA":[],"validationB":[]}; per={}
            for symbol,p in prepared.items():
                b=p[0]; rec=simulate(p,tp,stop,be); N=len(b); a=N*2//3; m=a+(N-a)//2; per[symbol]={}
                for name,start,end in (("train",0,a),("validationA",a,m),("validationB",m,N)):
                    rr=base.segment(rec,start,end); per[symbol][name]=base.stats(rr,(end-start)/base.BPD[frame]); pool[name]+=rr
            days=np.mean([len(raw[s]) for s in SYMBOLS])/2880; total={name:base.stats(pool[name],days*(2/3 if name=="train" else 1/6)) for name in pool}
            floor=min(total[x]["tradesPerDay"] for x in total); wr=min(total[x]["winRate"] for x in total); pf=min(total[x]["pf"] for x in total); ret=min(total[x]["netPointsPct"] for x in total)
            cfg={"timeframe":frame,"confirmation":break_type,"volumeMin":vol,"trend":trend,"roomMinPct":room,"tpPct":tp,"stop":stop,"breakEven":be}
            rows.append({"config":cfg,"combined":total,"perSymbol":per,"qualified":all(qualify(total[x]) for x in total),"score":wr+25*min(pf,3)+3*min(floor,10)+min(ret,2)-50*max(0,10-floor)})
        print("R43_SIGNAL",n,"/",len(signal_configs),flush=True)
    rows.sort(key=lambda r:r["score"],reverse=True); eligible=[r for r in rows if min(r["combined"][x]["tradesPerDay"] for x in r["combined"])>=10]; high=[r for r in rows if min(r["combined"][x]["winRate"] for x in r["combined"])>=65]
    output={"mode":"DEVELOPMENT_ONLY_BLIND_LOCKED","symbols":list(SYMBOLS),"costPct":COST,"testedConfigurations":len(rows),"frequencyEligible":len(eligible),"stableWinRate65":len(high),"qualified":sum(r["qualified"] for r in rows),"bestFrequencyEligible":eligible[0] if eligible else None,"bestHighWinRate":high[0] if high else None,"bestOverall":rows[0],"blindOpened":False,"survived":False}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r43-confirmed-harami.json")
    with open(path,"w") as f: json.dump(output,f,indent=2)
    print("R43_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
