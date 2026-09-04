from __future__ import annotations

import json, os
from itertools import product
import numpy as np
import r38_monster_replication as base
import r39_monster_optimized as opt

SYMBOLS=("XAUUSDT","CLUSDT"); FRAME="15min"; COST=.145

def simulate(p,rule,diagnose=False):
    b,side,atr,smart,support,resistance,fast=p
    cap,patience,min_progress,adverse_close,structure=rule
    o,h,l,c=(b[x].to_numpy(float) for x in ("open","high","low","close")); out=[]; diag=[]; next_bar=1
    for signal in np.flatnonzero(side):
        eb=signal+1
        if eb<next_bar or eb>=len(b) or not np.isfinite(atr[signal]): continue
        s=int(side[signal]); entry=o[eb]; target=entry*(1+s*.30/100)
        initial=min(.70,max(.20,atr[signal]*4/entry*100)); risk=min(initial,cap)
        stop=entry*(1-s*risk/100); last=min(len(b)-1,eb+240); xp=c[last]; xb=last; reason="TIME"; mfe=0.; mae=0.; be=False
        for j in range(eb,last+1):
            fav=(h[j]/entry-1)*100 if s>0 else (entry/l[j]-1)*100
            adv=(entry/l[j]-1)*100 if s>0 else (h[j]/entry-1)*100
            mfe=max(mfe,fav); mae=max(mae,adv)
            hs=l[j]<=stop if s>0 else h[j]>=stop; ht=h[j]>=target if s>0 else l[j]<=target
            if hs: xp=stop; xb=j; reason="SL"; break
            if ht: xp=target; xb=j; reason="TP"; break
            if not be and mfe>=.25: stop=entry*(1+s*(COST+.015)/100); be=True
            current=s*(c[j]/entry-1)*100
            failed_time=patience>0 and j-eb>=patience and mfe<min_progress and current<=-adverse_close
            failed_structure=structure and ((c[j]<support[signal]*(1-.0005)) if s>0 else (c[j]>resistance[signal]*(1+.0005)))
            if failed_time or failed_structure:
                xp=c[j]; xb=j; reason="NO_PROGRESS" if failed_time else "STRUCTURE"; break
        net=s*(xp/entry-1)*100-COST; out.append((signal,eb,xb,net,reason)); next_bar=xb+1
        if diagnose: diag.append({"net":net,"mfe":mfe,"mae":mae,"bars":xb-eb+1,"reason":reason,"symbolSide":s})
    return out,diag

def q(values,p): return float(np.quantile(values,p)) if values else 0.
def diagnostics(items):
    wins=[x for x in items if x["net"]>0]; losses=[x for x in items if x["net"]<=0]
    return {"trades":len(items),"wins":len(wins),"losses":len(losses),"winnerMae":{"median":q([x["mae"] for x in wins],.5),"p75":q([x["mae"] for x in wins],.75),"p90":q([x["mae"] for x in wins],.9)},"loserMfe":{"median":q([x["mfe"] for x in losses],.5),"p75":q([x["mfe"] for x in losses],.75),"p90":q([x["mfe"] for x in losses],.9)},"winnerBars":{"median":q([x["bars"] for x in wins],.5),"p90":q([x["bars"] for x in wins],.9)},"loserBars":{"median":q([x["bars"] for x in losses],.5),"p90":q([x["bars"] for x in losses],.9)}}

def evaluate(prepared,rule):
    pool={"train":[],"validationA":[],"validationB":[]}; per={}; all_diag=[]
    for symbol,p in prepared.items():
        b=p[0]; rec,diag=simulate(p,rule,True); all_diag+=diag; N=len(b); a=N*2//3; m=a+(N-a)//2; per[symbol]={}
        for name,start,end in (("train",0,a),("validationA",a,m),("validationB",m,N)):
            rr=base.segment(rec,start,end); per[symbol][name]=base.stats(rr,(end-start)/base.BPD[FRAME]); pool[name]+=rr
    days=np.mean([len(p[0]) for p in prepared.values()])/base.BPD[FRAME]
    total={name:base.stats(pool[name],days*(2/3 if name=="train" else 1/6)) for name in pool}
    return total,per,diagnostics(all_diag)

def main():
    raw={s:base.load(s) for s in SYMBOLS}
    prepared={s:opt.prepare(raw[s],FRAME,1,.8,.25,"all",s) for s in SYMBOLS}
    baseline_rule=(.70,0,0,0,False); baseline,baseline_per,diag=evaluate(prepared,baseline_rule)
    rules=list(product((.20,.30,.40,.50,.60,.70),(0,2,4,8,16),(0,.05,.10,.15),(0,.05,.10,.15),(False,True)))
    rows=[]
    for i,rule in enumerate(rules,1):
        if rule[1]==0 and (rule[2]!=0 or rule[3]!=0): continue
        total,per,_=evaluate(prepared,rule)
        preserve_train=total["train"]["winRate"]>=baseline["train"]["winRate"]-.5
        preserve_a=total["validationA"]["winRate"]>=baseline["validationA"]["winRate"]-.5
        improve_loss=total["train"]["averageLoss"]<baseline["train"]["averageLoss"] and total["validationA"]["averageLoss"]<baseline["validationA"]["averageLoss"]
        score=total["validationA"]["pf"]*40+total["validationA"]["winRate"]+min(total["validationA"]["tradesPerDay"],10)*2+total["validationA"]["netPointsPct"]
        rows.append({"rule":{"maxLossPct":rule[0],"patienceBars":rule[1],"minimumProgressPct":rule[2],"adverseClosePct":rule[3],"structureFailure":rule[4]},"combined":total,"perSymbol":per,"trainAndValidationAEligible":preserve_train and preserve_a and improve_loss,"score":score})
        if i%250==0: print("R40_RULE",i,"/",len(rules),flush=True)
    eligible=[r for r in rows if r["trainAndValidationAEligible"]]; eligible.sort(key=lambda r:r["score"],reverse=True)
    best=eligible[0] if eligible else max(rows,key=lambda r:r["score"])
    b=best["combined"]; confirmed=(b["validationB"]["winRate"]>=baseline["validationB"]["winRate"]-.5 and b["validationB"]["averageLoss"]<baseline["validationB"]["averageLoss"] and b["validationB"]["pf"]>baseline["validationB"]["pf"])
    output={"mode":"DEVELOPMENT_ONLY_BLIND_LOCKED","symbols":list(SYMBOLS),"entryConfiguration":{"timeframe":FRAME,"tpPct":.30,"sl":"ATR4 capped .70%","breakEven":True},"baseline":{"combined":baseline,"perSymbol":baseline_per},"lossPathDiagnostics":diag,"testedExitRules":len(rows),"trainValidationEligible":len(eligible),"bestExit":best,"confirmedOnValidationB":confirmed,"blindOpened":False,"survived":False}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r40-loss-avoidance.json")
    with open(path,"w") as f: json.dump(output,f,indent=2)
    print("R40_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
