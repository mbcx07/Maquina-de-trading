from __future__ import annotations
import json, os
from itertools import product
import numpy as np
import pandas as pd
import r38_monster_replication as base
import r43_confirmed_harami as hcore

SYMBOLS=("XAUUSDT","CLUSDT"); FRAMES=("1min","3min","5min","15min"); ENGINES=("harami","engulfing","hammer","meeting","combined"); COST=.145

def prepare(b30,frame,engine,vol_min,trend_mode,room_min):
    b=b30.resample(frame,label="left",closed="left").agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum","buy_volume":"sum","sell_volume":"sum"}).dropna()
    o,c,h,l=b.open,b.close,b.high,b.low
    mbear=c.shift(3)<o.shift(3); mbull=c.shift(3)>o.shift(3)
    inside_bull=(c.shift(2)>o.shift(2))&(o.shift(2)>c.shift(3))&(c.shift(2)<o.shift(3)); inside_bear=(c.shift(2)<o.shift(2))&(o.shift(2)<c.shift(3))&(c.shift(2)>o.shift(3))
    har_b=mbear&inside_bull&(c.shift(1)>o.shift(3)); har_s=mbull&inside_bear&(c.shift(1)<o.shift(3))
    eng_b=(c.shift(2)<o.shift(2))&(c.shift(1)>o.shift(1))&(o.shift(1)<c.shift(2))&(c.shift(1)>o.shift(2))
    eng_s=(c.shift(2)>o.shift(2))&(c.shift(1)<o.shift(1))&(o.shift(1)>c.shift(2))&(c.shift(1)<o.shift(2))
    body=(c-o).abs(); lw=np.minimum(o.shift(1),c.shift(1))-l.shift(1); uw=h.shift(1)-np.maximum(o.shift(1),c.shift(1))
    ham_b=(lw>body.shift(1)*2)&(uw<body.shift(1)*.35)&(c>h.shift(1)); ham_s=(uw>body.shift(1)*2)&(lw<body.shift(1)*.35)&(c<l.shift(1))
    meet=(c.shift(1)-c.shift(2)).abs()<=(h.shift(2)-l.shift(2))*.1
    meet_b=(c.shift(2)<o.shift(2))&(c.shift(1)>o.shift(1))&meet&(c>h.shift(1)); meet_s=(c.shift(2)>o.shift(2))&(c.shift(1)<o.shift(1))&meet&(c<l.shift(1))
    # Harami has an extra confirmation candle; require that the current candle
    # does not immediately invalidate that confirmed direction.
    har_b=har_b&(c>o); har_s=har_s&(c<o)
    pairs={"harami":(har_b,har_s),"engulfing":(eng_b&(c>h.shift(1)),eng_s&(c<l.shift(1))),"hammer":(ham_b,ham_s),"meeting":(meet_b,meet_s)}
    if engine=="combined": bull=np.logical_or.reduce([x[0] for x in pairs.values()]); bear=np.logical_or.reduce([x[1] for x in pairs.values()])
    else: bull,bear=pairs[engine]
    side=np.where(bull,1,np.where(bear,-1,0)).astype(np.int8)
    prev=c.shift(1); atr=pd.concat([h-l,(h-prev).abs(),(l-prev).abs()],axis=1).max(axis=1).rolling(14).mean(); vr=b.volume/b.volume.shift(1).rolling(30).mean(); e200=base.ema(c,200); bias=np.sign(c-e200).fillna(0).to_numpy(np.int8)
    h5=c.resample("5min",label="left",closed="left").last().dropna(); t5=np.sign(base.ema(h5,8)-base.ema(h5,21)).shift(1).reindex(b.index,method="ffill").fillna(0).to_numpy(np.int8)
    support=l.shift(1).rolling(20).min(); resistance=h.shift(1).rolling(20).max(); room=np.where(side>0,(resistance/c-1)*100,(c/support-1)*100)
    allowed=(vr.to_numpy()>=vol_min)&(room>=room_min)
    if trend_mode=="ema200": allowed&=bias==side
    else: allowed&=t5==side
    side=np.where(allowed,side,0).astype(np.int8)
    return b,side,atr.to_numpy(),support.to_numpy(),resistance.to_numpy()

def qualify(x): return x["tradesPerDay"]>=10 and x["winRate"]>=65 and x["pf"]>=1.2 and x["netPointsPct"]>0

def main():
    raw={s:base.load(s) for s in SYMBOLS}; rows=[]; signal_cfg=list(product(FRAMES,ENGINES,(.5,.7,1.),("trend5","ema200"),(0,.1)))
    for n,(frame,engine,vol,trend,room) in enumerate(signal_cfg,1):
        prepared={s:prepare(raw[s],frame,engine,vol,trend,room) for s in SYMBOLS}
        for tp,stop,be in product((.4,.5,.6),(.3,.4,"structure"),(False,True)):
            pool={"train":[],"validationA":[],"validationB":[]}; per={}
            for symbol,p in prepared.items():
                b=p[0]; rec=hcore.simulate(p,tp,stop,be); N=len(b); a=N*2//3; m=a+(N-a)//2; per[symbol]={}
                for name,start,end in (("train",0,a),("validationA",a,m),("validationB",m,N)):
                    rr=base.segment(rec,start,end); per[symbol][name]=base.stats(rr,(end-start)/base.BPD[frame]); pool[name]+=rr
            days=np.mean([len(raw[s]) for s in SYMBOLS])/2880; total={name:base.stats(pool[name],days*(2/3 if name=="train" else 1/6)) for name in pool}
            floor=min(total[x]["tradesPerDay"] for x in total); wr=min(total[x]["winRate"] for x in total); pf=min(total[x]["pf"] for x in total); ret=min(total[x]["netPointsPct"] for x in total)
            cfg={"timeframe":frame,"engine":engine,"volumeMin":vol,"trend":trend,"roomMinPct":room,"tpPct":tp,"stop":stop,"breakEven":be}
            rows.append({"config":cfg,"combined":total,"perSymbol":per,"qualified":all(qualify(total[x]) for x in total),"score":wr+25*min(pf,3)+3*min(floor,10)+min(ret,2)-50*max(0,10-floor)})
        if n%20==0: print("R44_SIGNAL",n,"/",len(signal_cfg),flush=True)
    rows.sort(key=lambda r:r["score"],reverse=True); eligible=[r for r in rows if min(r["combined"][x]["tradesPerDay"] for x in r["combined"])>=10]; high=[r for r in rows if min(r["combined"][x]["winRate"] for x in r["combined"])>=65]; profitable=[r for r in rows if all(r["combined"][x]["pf"]>=1.2 and r["combined"][x]["netPointsPct"]>0 for x in r["combined"])]
    by_engine={e:(max((r for r in rows if r["config"]["engine"]==e),key=lambda r:r["score"],default=None)) for e in ENGINES}
    output={"mode":"DEVELOPMENT_ONLY_BLIND_LOCKED","symbols":list(SYMBOLS),"costPct":COST,"testedConfigurations":len(rows),"frequencyEligible":len(eligible),"stableWinRate65":len(high),"profitablePf12AllWindows":len(profitable),"qualified":sum(r["qualified"] for r in rows),"bestByEngine":by_engine,"bestFrequencyEligible":eligible[0] if eligible else None,"bestHighWinRate":high[0] if high else None,"bestOverall":rows[0],"blindOpened":False,"survived":False}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r44-confirmed-patterns.json")
    with open(path,"w") as f: json.dump(output,f,indent=2)
    print("R44_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
