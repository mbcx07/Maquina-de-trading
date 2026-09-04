from __future__ import annotations

import importlib, json, os
from itertools import product
import numpy as np
import pandas as pd

SYMBOLS=("XAUUSDT","CLUSDT"); FRAMES=("1min","3min","5min","15min")
COST=.145; BPD={"1min":1440,"3min":480,"5min":288,"15min":96}

def ema(s,n): return s.ewm(span=n,adjust=False).mean()
def load(symbol):
    os.environ["R35_SYMBOL"]=symbol
    import r35_30s_causal as feed
    return importlib.reload(feed).load_bars().sort_index()

def indicators(b):
    tp=(b.high+b.low+b.close)/3; ma=tp.rolling(14).mean(); dev=(tp-ma).abs().rolling(14).mean(); cci=(tp-ma)/(.015*dev.replace(0,np.nan))
    delta=b.close.diff(); gain=delta.clip(lower=0).rolling(14).mean(); loss=(-delta.clip(upper=0)).rolling(14).mean(); rsi=100-100/(1+gain/loss.replace(0,np.nan))
    raw=b.close.diff(); pos=np.where(raw>0,tp*b.volume,0); neg=np.where(raw<0,tp*b.volume,0)
    ps=pd.Series(pos,index=b.index).rolling(14).sum(); ns=pd.Series(neg,index=b.index).rolling(14).sum(); mfi=100-100/(1+ps/ns.replace(0,np.nan))
    lo=b.low.rolling(5).min(); hi=b.high.rolling(5).max(); k=100*(b.close-lo)/(hi-lo).replace(0,np.nan); stoch=k.rolling(3).mean().rolling(3).mean()
    buy=(cci<-100).astype(int)+(mfi<20).astype(int)+(rsi<30).astype(int)+(stoch<20).astype(int)
    sell=(cci>100).astype(int)+(mfi>80).astype(int)+(rsi>70).astype(int)+(stoch>80).astype(int)
    return buy.fillna(0).to_numpy(),sell.fillna(0).to_numpy()

def patterns(b,literal):
    o,c,h,l=b.open,b.close,b.high,b.low; body=(c-o).abs(); rng=h-l
    bull3=(c.shift(3)>o.shift(3))&(c.shift(2)>o.shift(2))&(c.shift(1)>o.shift(1))&(c.shift(2)>c.shift(3))&(c.shift(1)>c.shift(2))
    bear3=(c.shift(3)<o.shift(3))&(c.shift(2)<o.shift(2))&(c.shift(1)<o.shift(1))&(c.shift(2)<c.shift(3))&(c.shift(1)<c.shift(2))
    bull_eng=(c.shift(2)<o.shift(2))&(c.shift(1)>o.shift(1))&(o.shift(1)<c.shift(2))&(c.shift(1)>o.shift(2))
    bear_eng=(c.shift(2)>o.shift(2))&(c.shift(1)<o.shift(1))&(o.shift(1)>c.shift(2))&(c.shift(1)<o.shift(2))
    if literal:
        bull_har=(c.shift(2)<o.shift(2))&(c.shift(1)>o.shift(1))&(c.shift(1)<c.shift(2))&(o.shift(1)>o.shift(2))
        bear_har=(c.shift(2)>o.shift(2))&(c.shift(1)<o.shift(1))&(c.shift(1)>c.shift(2))&(o.shift(1)<o.shift(2))
    else:
        bull_har=(c.shift(2)<o.shift(2))&(c.shift(1)>o.shift(1))&(o.shift(1)<o.shift(2))&(c.shift(1)>c.shift(2))
        bear_har=(c.shift(2)>o.shift(2))&(c.shift(1)<o.shift(1))&(o.shift(1)>o.shift(2))&(c.shift(1)<c.shift(2))
    meet=(c.shift(1)-c.shift(2)).abs()<=rng.shift(2)*.1
    bull_meet=(c.shift(2)<o.shift(2))&(c.shift(1)>o.shift(1))&meet; bear_meet=(c.shift(2)>o.shift(2))&(c.shift(1)<o.shift(1))&meet
    bull_dcp=(c.shift(2)<o.shift(2))&(c.shift(1)>o.shift(1))&(o.shift(1)<l.shift(2))&(c.shift(1)>(o.shift(2)+c.shift(2))/2)
    bear_dcp=(c.shift(2)>o.shift(2))&(c.shift(1)<o.shift(1))&(o.shift(1)>h.shift(2))&(c.shift(1)<(o.shift(2)+c.shift(2))/2)
    lw=np.minimum(o.shift(1),c.shift(1))-l.shift(1); uw=h.shift(1)-np.maximum(o.shift(1),c.shift(1)); hammer=(lw>body.shift(1)*2)&(uw<body.shift(1)*.3)&(body.shift(1)>0)
    star=body.shift(2)<=rng.shift(2)*.1
    bull_star=(c.shift(3)<o.shift(3))&star&(c.shift(1)>o.shift(1))&(c.shift(1)>(o.shift(3)+c.shift(3))/2)
    bear_star=(c.shift(3)>o.shift(3))&star&(c.shift(1)<o.shift(1))&(c.shift(1)<(o.shift(3)+c.shift(3))/2)
    buys=[bull3,bull_eng,bull_har,bull_meet,bull_dcp,hammer,bull_star]; sells=[bear3,bear_eng,bear_har,bear_meet,bear_dcp,hammer,bear_star]
    return np.column_stack([x.fillna(False) for x in buys]),np.column_stack([x.fillna(False) for x in sells])

def context(b):
    e200=ema(b.close,200).shift(1); bias=np.sign(b.close.shift(1)-e200).fillna(0).to_numpy(np.int8)
    prev=b.close.shift(1); atr=pd.concat([b.high-b.low,(b.high-prev).abs(),(b.low-prev).abs()],axis=1).max(axis=1).rolling(14).mean().shift(1).to_numpy()
    smart={}
    for tf in ("5min","15min"):
        x=b.close.resample(tf,label="left",closed="left").last().dropna(); d=np.sign(ema(x,8)-ema(x,21)).shift(2)
        smart[tf]=d.reindex(b.index,method="ffill").fillna(0).to_numpy(np.int8)
    x=b.close.resample("5min",label="left",closed="left").last().dropna(); line=ema(x,12)-ema(x,26); md=np.sign(line-ema(line,9)).shift(2)
    smart["macd5"]=md.reindex(b.index,method="ffill").fillna(0).to_numpy(np.int8)
    return bias,atr,smart

def signals(b,variant,min_osc):
    literal=variant=="literal"; pb,ps=patterns(b,literal); ib,isell=indicators(b); bias,atr,smart=context(b)
    if literal:
        buy=(pb.sum(axis=1)*ib>=2)&(bias>0); sell=(ps.sum(axis=1)*isell>=2)&(bias<0)
    else:
        buy=(pb.sum(axis=1)>0)&(ib>=min_osc)&(bias>0); sell=(ps.sum(axis=1)>0)&(isell>=min_osc)&(bias<0)
    side=np.where(buy,1,np.where(sell,-1,0)).astype(np.int8)
    return side,atr,smart

def simulate(b,side,atr,smart,mode,tp_abs=2.0):
    o,h,l,c=(b[x].to_numpy(float) for x in ("open","high","low","close")); records=[]; next_bar=1
    for signal in np.flatnonzero(side):
        eb=signal+1
        if eb<next_bar or eb>=len(b) or not np.isfinite(atr[signal]): continue
        s=int(side[signal]); entry=o[eb]; stop=entry-s*atr[signal]*8; target=entry+s*tp_abs; trail=stop; last=min(len(b)-1,eb+500); xp=c[last]; xb=last; reason="TIME"
        for j in range(eb,last+1):
            hs=l[j]<=trail if s>0 else h[j]>=trail; ht=h[j]>=target if s>0 else l[j]<=target
            if hs: xp=trail; xb=j; reason="SL"; break
            if ht: xp=target; xb=j; reason="TP"; break
            if mode!="none":
                reverse=smart[mode][j]==-s if mode in ("5min","15min") else smart["5min"][j]==-s and smart["macd5"][j]==-s
                if reverse: xp=c[j]; xb=j; reason="TREND"; break
            candidate=c[j]-s*atr[signal]*4
            if s>0: trail=max(trail,candidate)
            else: trail=min(trail,candidate)
        net=s*(xp/entry-1)*100-COST; records.append((signal,eb,xb,net,reason)); next_bar=xb+1
    return records

def segment(rec,start,end): return [r for r in rec if r[0]>=start and r[2]<end]
def stats(rec,days):
    v=np.asarray([r[3] for r in rec]); w=v[v>0]; loss=-v[v<=0]
    return {"trades":len(v),"tradesPerDay":len(v)/days,"winRate":float((v>0).mean()*100) if len(v) else 0,"pf":float(w.sum()/loss.sum()) if loss.sum() else (99. if w.sum() else 0),"netPointsPct":float(v.sum()) if len(v) else 0,"averageWin":float(w.mean()) if len(w) else 0,"averageLoss":float(loss.mean()) if len(loss) else 0}
def pass_goal(x): return x["winRate"]>=65 and x["pf"]>=1.2 and x["tradesPerDay"]>=10 and x["netPointsPct"]>0

def main():
    raw={s:load(s) for s in SYMBOLS}; rows=[]
    for frame,variant,min_osc,mode in product(FRAMES,("literal","corrected"),(1,2),("none","5min","15min","macd5")):
        if variant=="literal" and min_osc==1: continue
        combined={"train":[],"validationA":[],"validationB":[]}; per={}
        for symbol,b30 in raw.items():
            b=b30.resample(frame,label="left",closed="left").agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum","buy_volume":"sum","sell_volume":"sum"}).dropna()
            side,atr,smart=signals(b,variant,min_osc); rec=simulate(b,side,atr,smart,mode); N=len(b); a=N*2//3; m=a+(N-a)//2; per[symbol]={}
            for name,start,end in (("train",0,a),("validationA",a,m),("validationB",m,N)):
                r=segment(rec,start,end); st=stats(r,(end-start)/BPD[frame]); per[symbol][name]=st; combined[name].extend(r)
        total={name:stats(combined[name],np.mean([len(raw[s]) for s in SYMBOLS])/2880*(2/3 if name=="train" else 1/6)) for name in combined}
        floor=min(total[x]["tradesPerDay"] for x in total); wr=min(total[x]["winRate"] for x in total); pf=min(total[x]["pf"] for x in total)
        rows.append({"config":{"timeframe":frame,"variant":variant,"minOscillators":min_osc,"trendExit":mode,"tpAbsolute":2.0,"slAtr":8,"trailingAtr":4},"combined":total,"perSymbol":per,"qualified":all(pass_goal(total[x]) for x in total),"score":wr+20*pf+min(floor,10)*3-50*max(0,10-floor)})
    rows.sort(key=lambda x:x["score"],reverse=True); eligible=[r for r in rows if min(r["combined"][x]["tradesPerDay"] for x in r["combined"])>=10]
    high_wr=[r for r in rows if min(r["combined"][x]["winRate"] for x in r["combined"])>=65]
    output={"mode":"DEVELOPMENT_ONLY_BLIND_LOCKED","symbols":list(SYMBOLS),"costPct":COST,"testedConfigurations":len(rows),"frequencyEligible":len(eligible),"stableWinRate65":len(high_wr),"qualified":sum(r["qualified"] for r in rows),"bestFrequencyEligible":eligible[0] if eligible else None,"bestHighWinRate":high_wr[0] if high_wr else None,"bestOverall":rows[0],"blindOpened":False,"survived":False}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r38-monster-replication.json")
    with open(path,"w") as f: json.dump(output,f,indent=2)
    print("R38_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
