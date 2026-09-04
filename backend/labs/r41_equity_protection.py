from __future__ import annotations

import json, os
from itertools import product
import numpy as np
import r38_monster_replication as base
import r39_monster_optimized as opt
import r40_loss_avoidance as loss

SYMBOLS=("XAUUSDT","CLUSDT"); FRAME="15min"; COST=.145

def trade_streams():
    raw={s:base.load(s) for s in SYMBOLS}; streams={"train":[],"validationA":[],"validationB":[]}; baseline={}
    for symbol,b30 in raw.items():
        p=opt.prepare(b30,FRAME,1,.8,.25,"all",symbol); b=p[0]
        rec,_=loss.simulate(p,(.70,0,0,0,False),False); N=len(b); a=N*2//3; m=a+(N-a)//2
        for name,start,end in (("train",0,a),("validationA",a,m),("validationB",m,N)):
            rr=base.segment(rec,start,end)
            for r in rr:
                signal=r[0]; entry=float(b.open.iloc[r[1]])
                initial=min(.70,max(.20,p[2][signal]*4/entry*100))
                streams[name].append({"time":b.index[r[1]],"netPct":r[3],"riskPct":initial+COST,"symbol":symbol})
    for name in streams: streams[name].sort(key=lambda x:x["time"])
    return streams

def simulate(trades,cfg):
    risk,daily_cap,weekly_cap,max_streak,total_dd=cfg
    equity=peak=100.; max_drawdown=0.; streak=0; stopped=False; executed=[]
    day=None; week=None; day_start=week_start=100.; day_paused=week_paused=False
    for t in trades:
        d=t["time"].date(); w=(t["time"].isocalendar().year,t["time"].isocalendar().week)
        if d!=day: day=d; day_start=equity; day_paused=False; streak=0
        if w!=week: week=w; week_start=equity; week_paused=False
        if stopped or day_paused or week_paused: continue
        multiple=t["netPct"]/t["riskPct"]; pnl=equity*risk/100*multiple; equity+=pnl; executed.append(t["netPct"])
        streak=0 if t["netPct"]>0 else streak+1; peak=max(peak,equity); dd=(peak-equity)/peak*100; max_drawdown=max(max_drawdown,dd)
        if (day_start-equity)/day_start*100>=daily_cap or streak>=max_streak: day_paused=True
        if (week_start-equity)/week_start*100>=weekly_cap: week_paused=True
        if dd>=total_dd: stopped=True
    v=np.asarray(executed); wins=v[v>0]; losses=-v[v<=0]
    return {"signals":len(trades),"executed":len(v),"winRate":float((v>0).mean()*100) if len(v) else 0,"pf":float(wins.sum()/losses.sum()) if losses.sum() else (99. if wins.sum() else 0),"returnPct":equity-100,"maxDrawdownPct":max_drawdown,"protectionTriggered":stopped,"endingEquity":equity}

def main():
    streams=trade_streams(); configs=list(product((.10,.25,.50,1.0),(.5,1.,2.),(2.,3.,5.),(2,3,4),(3.,5.,10.)))
    rows=[]
    baseline_wr={name:float(np.mean([x["netPct"]>0 for x in trades])*100) for name,trades in streams.items()}
    for cfg in configs:
        result={name:simulate(trades,cfg) for name,trades in streams.items()}
        preserves=all(result[n]["winRate"]>=baseline_wr[n]-.5 for n in result)
        survives=all(result[n]["maxDrawdownPct"]<=cfg[4]*1.1 for n in result)
        positive=all(result[n]["returnPct"]>0 for n in result)
        score=min(result[n]["returnPct"] for n in result)-max(result[n]["maxDrawdownPct"] for n in result)+10*(preserves and survives)
        rows.append({"config":{"riskPerTradePct":cfg[0],"dailyLossPct":cfg[1],"weeklyLossPct":cfg[2],"maxConsecutiveLosses":cfg[3],"totalDrawdownStopPct":cfg[4]},"segments":result,"preservesWinRate":preserves,"survives":survives,"positiveAllSegments":positive,"score":score})
    rows.sort(key=lambda r:r["score"],reverse=True); protective=[r for r in rows if r["preservesWinRate"] and r["survives"]]
    output={"mode":"RISK_RESEARCH_NO_LIVE_ACTIVATION","symbols":list(SYMBOLS),"accountNormalized":100,"baselineWinRate":baseline_wr,"testedConfigurations":len(rows),"winRatePreservingAndSurviving":len(protective),"positiveAllSegments":sum(r["positiveAllSegments"] for r in rows),"bestProtection":protective[0] if protective else rows[0],"bestOverall":rows[0],"conclusion":"Risk controls can bound drawdown but cannot repair negative trade expectancy."}
    path=os.path.join(os.path.dirname(__file__),"..","artifacts","r41-equity-protection.json")
    with open(path,"w") as f: json.dump(output,f,indent=2)
    print("R41_RESULT",json.dumps(output),flush=True)

if __name__=="__main__": main()
