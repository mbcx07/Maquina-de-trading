from __future__ import annotations

import json
from pathlib import Path
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

import r32_ml_research as core

SYMBOLS = ["XAUUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"]
CONFIGS = [(tp, sl, h) for tp, sl in [(.40,.25),(.50,.20),(.60,.15),(.80,.10)] for h in [30,60,120]]


def trades_for(candidate_rows, probs, returns, exits, idx, start, end, threshold):
    selected=[]; next_bar=start
    for k in candidate_rows:
        entry=idx[k]+1
        if probs[k]<threshold or entry<start or entry>=end or entry<next_bar: continue
        selected.append(float(returns[k])); next_bar=int(exits[k])+1
    return selected


def stats(values, days):
    a=np.asarray(values,float); wins=a[a>0]; losses=-a[a<=0]
    eq=100.; peak=100.; dd=0.
    for value in a:
        eq*=1+(value*core.EXPOSURE)/100; peak=max(peak,eq); dd=max(dd,(peak-eq)/peak*100)
    return {"trades":int(len(a)),"winRate":float((a>0).mean()*100) if len(a) else 0,
            "pf":float(wins.sum()/losses.sum()) if losses.sum() else (99 if wins.sum() else 0),
            "returnPct":eq-100,"ddPct":dd,"tradesPerDay":len(a)/days}


def run_symbol(symbol):
    core.SYMBOL=symbol
    core.CACHE=core.ARTIFACTS/f"r33-{symbol}-1m-{core.DAYS}d.pkl"
    bars=core.load_bars(); b,X,idx,sides,names=core.features_and_candidates(bars)
    t1=len(b)//2; t2=len(b)*3//4
    train=np.flatnonzero(idx<t1); val=np.flatnonzero((idx>=t1)&(idx<t2)); test=np.flatnonzero(idx>=t2)
    rows=[]
    for tp,sl,horizon in CONFIGS:
        returns,exits=core.outcomes(b,idx,sides,tp,sl,horizon); y=(returns>0).astype(np.int8)
        pos=max(1,y[train].sum()); weights=np.where(y[train]>0,len(train)/(2*pos),len(train)/(2*max(1,len(train)-pos)))
        model=HistGradientBoostingClassifier(max_iter=60,max_leaf_nodes=10,learning_rate=.06,l2_regularization=4,random_state=31).fit(X[train],y[train],sample_weight=weights)
        probs=model.predict_proba(X)[:,1]
        best=None
        for th in np.unique(np.quantile(probs[val],np.linspace(.55,.995,60))):
            vt=trades_for(val,probs,returns,exits,idx,t1,t2,float(th)); tt=trades_for(train,probs,returns,exits,idx,0,t1,float(th))
            sv=stats(vt,core.DAYS*.25); st=stats(tt,core.DAYS*.5)
            if min(sv['tradesPerDay'],st['tradesPerDay'])<1.7: continue
            score=sv['returnPct']*8+sv['pf']*10+sv['winRate']*.2-sv['ddPct']*3
            if best is None or score>best[0]: best=(score,float(th),st,sv,probs,returns,exits)
        if best: rows.append((best[0],tp,sl,horizon,*best[1:]))
    rows.sort(reverse=True,key=lambda x:x[0]); z=rows[0]
    test_values=trades_for(test,z[7],z[8],z[9],idx,t2,len(b),z[4])
    result={"symbol":symbol,"tp":z[1],"sl":z[2],"horizon":z[3],"threshold":z[4],
            "train":z[5],"validation":z[6],"test":stats(test_values,core.DAYS*.25)}
    return result,test_values


def main():
    all_values=[]; per=[]
    for symbol in SYMBOLS:
        result,values=run_symbol(symbol); per.append(result); all_values.extend(values)
        print("R33_SYMBOL",json.dumps(result),flush=True)
    portfolio=stats(all_values,core.DAYS*.25)
    survived=portfolio['winRate']>=65 and portfolio['tradesPerDay']>=10 and portfolio['pf']>=1.2 and portfolio['returnPct']>0
    result={"symbols":SYMBOLS,"costPct":core.COST,"selection":"TRAIN_VALIDATION_ONLY_TEST_BLIND","perSymbol":per,"portfolioTest":portfolio,"survived":survived}
    (core.ARTIFACTS/"r33-multi-market.json").write_text(json.dumps(result,indent=2))
    print("R33_RESULT",json.dumps(result),flush=True)


if __name__=="__main__": main()
