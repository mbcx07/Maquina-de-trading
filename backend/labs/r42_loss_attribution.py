from __future__ import annotations

import json, os
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import permutation_importance
import r38_monster_replication as base
import r39_monster_optimized as opt
import r40_loss_avoidance as loss

SYMBOLS=("XAUUSDT","CLUSDT"); FRAME="15min"
PATTERNS=("threeSoldiers","engulfing","harami","meetingLines","darkCloudPiercing","hammer","morningEveningStar")

def rsi(close,n=14):
    d=close.diff(); g=d.clip(lower=0).rolling(n).mean(); l=(-d.clip(upper=0)).rolling(n).mean()
    return 100-100/(1+g/l.replace(0,np.nan))

def build():
    rows=[]
    for symbol in SYMBOLS:
        b30=base.load(symbol); p=opt.prepare(b30,FRAME,1,.8,.25,"all",symbol); b=p[0]
        rec,_=loss.simulate(p,(.70,0,0,0,False),False); pb,ps=base.patterns(b,False)
        close=b.close; e200=base.ema(close,200); atr=pd.Series(p[2],index=b.index); vr=b.volume/b.volume.shift(1).rolling(30).mean(); rs=rsi(close)
        N=len(b); a=N*2//3; m=a+(N-a)//2
        for trade in rec:
            signal=trade[0]; side=int(p[1][signal]); segment="train" if signal<a else ("validationA" if signal<m else "validationB")
            patt=pb[signal] if side>0 else ps[signal]; hour=b.index[signal].hour; entry=float(b.close.iloc[signal])
            values={"symbolCL":int(symbol=="CLUSDT"),"side":side,"hourSin":np.sin(2*np.pi*hour/24),"hourCos":np.cos(2*np.pi*hour/24),"atrPct":float(atr.iloc[signal]/entry*100),"volumeRatio":float(vr.iloc[signal]),"bodyAtr":float(abs(b.close.iloc[signal]-b.open.iloc[signal])/atr.iloc[signal]),"rsiDirectional":float((rs.iloc[signal]-50)/50*side),"ema200DistanceAtr":float((close.iloc[signal]-e200.iloc[signal])/atr.iloc[signal]*side),"trend5":float(p[3]["5min"][signal]*side),"trend15":float(p[3]["15min"][signal]*side),"macd5":float(p[3]["macd5"][signal]*side),"roomPct":float(((p[5][signal]/entry-1)*100) if side>0 else ((entry/p[4][signal]-1)*100))}
            for i,name in enumerate(PATTERNS): values["pattern_"+name]=int(patt[i])
            rows.append({"symbol":symbol,"time":b.index[signal].isoformat(),"segment":segment,"net":trade[3],"win":int(trade[3]>0),"exitReason":trade[4],"features":values})
    return rows

def metrics(rows):
    v=np.asarray([x["net"] for x in rows]); w=v[v>0]; l=-v[v<=0]
    return {"trades":len(v),"winRate":float((v>0).mean()*100) if len(v) else 0,"pf":float(w.sum()/l.sum()) if l.sum() else (99. if w.sum() else 0),"netPctPoints":float(v.sum()) if len(v) else 0,"averageLoss":float(l.mean()) if len(l) else 0}

def groups(rows,key):
    values={}
    for r in rows:
        if key=="symbol": value=r["symbol"]
        elif key=="hourBlock": value=f'{int(r["time"][11:13])//4*4:02d}-{int(r["time"][11:13])//4*4+3:02d}'
        else:
            active=[n for n in PATTERNS if r["features"]["pattern_"+n]]; value=active[0] if active else "other"
        values.setdefault(value,[]).append(r)
    return {k:metrics(v) for k,v in values.items()}

def main():
    rows=build(); train=[r for r in rows if r["segment"]=="train"]; va=[r for r in rows if r["segment"]=="validationA"]; vb=[r for r in rows if r["segment"]=="validationB"]
    names=list(train[0]["features"]); X=lambda rr:np.nan_to_num(np.asarray([[r["features"][n] for n in names] for r in rr],dtype=float),nan=0.,posinf=10.,neginf=-10.); y=lambda rr:np.asarray([r["win"] for r in rr])
    model=RandomForestClassifier(n_estimators=500,max_depth=3,min_samples_leaf=8,class_weight="balanced",random_state=42).fit(X(train),y(train))
    pa=model.predict_proba(X(va))[:,1]; pb=model.predict_proba(X(vb))[:,1]
    candidates=[]
    for threshold in np.linspace(.2,.8,25):
        fa=[r for r,p in zip(va,pa) if p>=threshold]; ft=[r for r,p in zip(train,model.predict_proba(X(train))[:,1]) if p>=threshold]
        if len(fa)<max(8,len(va)//3) or len(ft)<len(train)//3: continue
        candidates.append((metrics(fa)["pf"]+metrics(fa)["winRate"]/100+metrics(ft)["pf"],float(threshold),ft,fa))
    candidates.sort(reverse=True,key=lambda x:x[0]); chosen=candidates[0] if candidates else (0,.5,train,va); threshold=chosen[1]
    fb=[r for r,p in zip(vb,pb) if p>=threshold]
    perm=permutation_importance(model,X(va),y(va),n_repeats=30,random_state=42,scoring="neg_log_loss")
    importance=sorted([{"feature":n,"importance":float(v)} for n,v in zip(names,perm.importances_mean)],key=lambda x:x["importance"],reverse=True)
    output={"mode":"LOSS_ATTRIBUTION_DEVELOPMENT_ONLY","symbols":list(SYMBOLS),"configuration":{"timeframe":FRAME,"tpPct":.30,"sl":"ATR4 capped .70","breakEven":True},"samples":{"train":len(train),"validationA":len(va),"validationB":len(vb)},"baseline":{"train":metrics(train),"validationA":metrics(va),"validationB":metrics(vb)},"attribution":{"bySymbol":{"train":groups(train,"symbol"),"validationA":groups(va,"symbol"),"validationB":groups(vb,"symbol")},"byHour":{"train":groups(train,"hourBlock"),"validationA":groups(va,"hourBlock"),"validationB":groups(vb,"hourBlock")},"byPattern":{"train":groups(train,"pattern"),"validationA":groups(va,"pattern"),"validationB":groups(vb,"pattern")},"featureImportanceValidationA":importance},"entryDecision":{"probabilityThreshold":threshold,"train":metrics(chosen[2]),"validationA":metrics(chosen[3]),"validationB":metrics(fb),"validationBRetained":len(fb)/len(vb) if vb else 0},"lookaheadFree":True,"blindOpened":False}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r42-loss-attribution.json")
    with open(path,"w") as f: json.dump(output,f,indent=2)
    print("R42_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
