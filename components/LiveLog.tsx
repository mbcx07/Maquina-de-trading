
import React from 'react';
import { LogEntry } from '../types';

interface Props {
  logs: LogEntry[];
}

const LiveLog: React.FC<Props> = ({ logs }) => {
  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'SUCCESS': return 'text-emerald-400';
      case 'WARNING': return 'text-amber-400';
      case 'ERROR': return 'text-rose-400';
      default: return 'text-cyan-400';
    }
  };

  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col h-[400px]">
      <h2 className="text-lg font-bold mb-4 flex items-center justify-between">
        <span>Log de Decisiones</span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></span>
          <span className="text-[10px] uppercase text-slate-500">Real-time</span>
        </span>
      </h2>
      <div className="flex-grow overflow-y-auto space-y-2 pr-2 scrollbar-thin">
        {logs.map((log, i) => (
          <div key={i} className="text-[11px] font-mono leading-tight py-1 border-b border-slate-800/50 last:border-0">
            <span className="text-slate-600 mr-2">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
            <span className={`${getLevelColor(log.level)} font-bold mr-2`}>{log.category}</span>
            <span className="text-slate-300">{log.message}</span>
          </div>
        ))}
        {logs.length === 0 && (
          <div className="h-full flex items-center justify-center text-slate-600 italic text-sm">
            Esperando eventos del motor...
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveLog;
