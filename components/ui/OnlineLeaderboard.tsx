import React, { useState, useEffect } from 'react';
import { supabaseService } from '../../services/supabaseService';
import { isWebsim } from '../../services/websimService';
import { LeaderboardEntry } from '../../types';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Clock, User, Play, Download, RefreshCw, ChevronLeft, ChevronRight, Filter, ShieldCheck, AlertTriangle, Copy, Check } from 'lucide-react';
import { format } from 'date-fns';
import { AvatarIcon } from './AvatarIcon';
import { ReplayTooltip } from './ReplayTooltip';

interface OnlineLeaderboardProps {
    initialMode?: 'normal' | 'hardcore' | 'chaos';
    onModeChange?: (mode: 'normal' | 'hardcore' | 'chaos') => void;
    onClose: () => void;
    onWatchReplay: (replayPath: string) => void;
}

const OnlineLeaderboard: React.FC<OnlineLeaderboardProps> = ({ initialMode, onModeChange, onClose, onWatchReplay }) => {
    const [mode, setMode] = useState<'normal' | 'hardcore' | 'chaos'>(initialMode || 'normal');
    const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [diagnostics, setDiagnostics] = useState<string | null>(null);
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [copied, setCopied] = useState(false);
    const [hoveredEntry, setHoveredEntry] = useState<LeaderboardEntry | null>(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    const handleCopyDiagnostics = () => {
        const textToCopy = diagnostics || error || '';
        if (!textToCopy) return;

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy)
                .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                })
                .catch(() => fallbackCopy(textToCopy));
        } else {
            fallbackCopy(textToCopy);
        }
    };

    const fallbackCopy = (text: string) => {
        try {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-9999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
        } catch (err) {
            console.error("Clipboard copy failed:", err);
        }
    };

    const handleModeChange = (m: 'normal' | 'hardcore' | 'chaos') => {
        setMode(m);
        if (onModeChange) onModeChange(m);
    };

    useEffect(() => {
        fetchLeaderboard();
    }, [mode]);

    const handleMouseMove = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMousePos({ 
            x: e.clientX - rect.left, 
            y: e.clientY - rect.top 
        });
    };

    const fetchLeaderboard = async () => {
        setIsLoading(true);
        setError(null);
        setDiagnostics(null);
        try {
            const data = await supabaseService.getLeaderboard(mode);
            setEntries(data);
        } catch (err: any) {
            console.error("[OnlineLeaderboard] Failed to load scores:", err);
            setError(err?.message || 'Failed to load scores from the Websim database.');
            if (err?.diagnostics) {
                setDiagnostics(err.diagnostics);
            }
            setEntries([]);
        } finally {
            setIsLoading(false);
        }
    };

    const displayedEntries = entries.filter(e => {
        const itemMode = (e.metadata?.mode || (e as any).mode || (e as any).gameMode || 'normal').toLowerCase().trim();
        return itemMode === mode.toLowerCase().trim();
    });

    return (
        <div 
            className="absolute inset-0 z-[150] flex flex-col items-center justify-center bg-black/95 backdrop-blur-md p-6"
            onMouseMove={handleMouseMove}
        >
            <div className="w-full max-w-4xl border-b-2 border-yellow-500 pb-2 mb-6 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <Trophy className="w-8 h-8 text-yellow-500" />
                    <h2 className="text-yellow-500 text-3xl font-black tracking-tighter italic uppercase">Global Hall of Fame</h2>
                </div>
                <div className="text-xs font-mono text-yellow-500/50 uppercase tracking-widest">{isWebsim() ? 'Websim // Top_Pilots' : 'Underdog_ID // Top_Pilots'}</div>
            </div>

            {/* Mode Selector */}
            <div className="flex gap-2 mb-6">
                {(['normal', 'hardcore', 'chaos'] as const).map(m => (
                    <button
                        key={m}
                        onClick={() => handleModeChange(m)}
                        className={`px-6 py-2 font-mono text-xs font-bold uppercase tracking-widest border transition-all ${
                            mode === m 
                            ? 'bg-yellow-500 text-black border-yellow-500 shadow-[0_0_15px_rgba(241,196,15,0.3)]' 
                            : 'bg-black text-yellow-500/50 border-yellow-500/20 hover:border-yellow-500/50'
                        }`}
                    >
                        {m}
                    </button>
                ))}
            </div>

            {/* Table Header */}
            <div className="w-full max-w-4xl grid grid-cols-12 gap-4 px-4 py-2 bg-yellow-500/10 border-y border-yellow-500/20 text-[10px] font-mono text-yellow-500 uppercase tracking-widest mb-2">
                <div className="col-span-1">Rank</div>
                <div className="col-span-8">Pilot & Performance</div>
                <div className="col-span-2 hidden sm:block">Date</div>
                <div className="col-span-1 text-right">Replay</div>
            </div>

            {/* Entries */}
            <div className="w-full max-w-4xl flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-1">
                <AnimatePresence mode="wait">
                    {isLoading ? (
                        <motion.div 
                            key="loading"
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="flex flex-col items-center justify-center py-20 gap-4"
                        >
                            <RefreshCw className="w-8 h-8 text-yellow-500 animate-spin" />
                            <div className="text-yellow-500 font-mono text-xs animate-pulse">QUERYING GLOBAL DATABASE...</div>
                        </motion.div>
                    ) : error ? (
                        <motion.div
                            key="error"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="flex flex-col items-center justify-center py-10 px-6 my-4 bg-red-950/40 border border-red-500/50 rounded text-center max-w-2xl mx-auto"
                        >
                            <div className="flex items-center gap-3 text-red-400 mb-2 font-mono font-bold text-sm tracking-wider uppercase">
                                <AlertTriangle className="w-5 h-5 text-red-400 animate-pulse shrink-0" />
                                <span>WEBSIM DATABASE CONNECTION FAILED</span>
                            </div>
                            <div className="text-gray-200 font-mono text-xs mb-3 max-w-lg leading-relaxed">
                                {error}
                            </div>
                            <div className="text-[10px] font-mono text-yellow-500/90 bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 rounded mb-4">
                                ⚠️ Local score fallback is disabled. Showing live Websim database status only.
                            </div>

                            {diagnostics && (
                                <div className="w-full text-left mb-4">
                                    <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                                        <button
                                            type="button"
                                            onClick={() => setShowDiagnostics(!showDiagnostics)}
                                            className="text-[11px] font-mono text-gray-400 hover:text-white underline cursor-pointer"
                                        >
                                            {showDiagnostics ? '▼ Hide Diagnostic Details' : '▶ Show Diagnostic Audit Details'}
                                        </button>

                                        <button
                                            type="button"
                                            onClick={handleCopyDiagnostics}
                                            className={`flex items-center gap-1.5 px-3 py-1 font-mono text-[11px] font-bold uppercase rounded border transition-all cursor-pointer ${
                                                copied 
                                                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50 shadow-[0_0_10px_rgba(16,185,129,0.3)]' 
                                                : 'bg-cyan-950/60 text-cyan-400 border-cyan-500/40 hover:bg-cyan-900/80 hover:text-white'
                                            }`}
                                        >
                                            {copied ? (
                                                <>
                                                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                                                    <span>COPIED TO CLIPBOARD!</span>
                                                </>
                                            ) : (
                                                <>
                                                    <Copy className="w-3.5 h-3.5" />
                                                    <span>COPY DIAGNOSTIC DETAILS</span>
                                                </>
                                            )}
                                        </button>
                                    </div>

                                    {showDiagnostics && (
                                        <div className="relative mt-2">
                                            <pre className="p-3 bg-black/90 border border-white/10 rounded text-[9px] font-mono text-emerald-400 overflow-x-auto max-h-48 custom-scrollbar select-all">
                                                {diagnostics}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={fetchLeaderboard}
                                className="flex items-center gap-2 px-6 py-2 bg-red-600 hover:bg-red-500 text-white font-mono text-xs font-bold uppercase tracking-wider rounded transition-all shadow-[0_0_15px_rgba(239,68,68,0.3)] cursor-pointer"
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                RETRY DATABASE QUERY
                            </button>
                        </motion.div>
                    ) : displayedEntries.length === 0 ? (
                        <motion.div 
                            key="empty"
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="flex flex-col items-center justify-center py-20 text-gray-600 font-mono italic"
                        >
                            NO RECORDS FOUND FOR THIS SECTOR IN THE DATABASE.
                        </motion.div>
                    ) : (
                        <motion.div 
                            key="list"
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                            className="space-y-1"
                        >
                            {displayedEntries.map((entry, idx) => (
                                <motion.div 
                                    key={entry.id}
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ delay: idx * 0.03 }}
                                    className={`grid grid-cols-12 gap-4 px-4 py-3 items-center border border-white/5 hover:border-yellow-500/30 hover:bg-yellow-500/5 transition-all group relative ${
                                        idx === 0 ? 'bg-yellow-500/5 border-yellow-500/20' : 'bg-black/40'
                                    }`}
                                    onMouseEnter={() => {
                                        console.log("[Underdog_ID] Hovered entry:", entry.username, "Metadata:", entry.metadata);
                                        setHoveredEntry(entry);
                                    }}
                                    onMouseLeave={() => setHoveredEntry(null)}
                                >
                                    <div className={`col-span-1 font-mono text-sm font-bold ${
                                        idx === 0 ? 'text-yellow-500' : idx === 1 ? 'text-gray-300' : idx === 2 ? 'text-orange-400' : 'text-gray-600'
                                    }`}>
                                        #{idx + 1}
                                    </div>
                                    <div className="col-span-8 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-6">
                                        <div className="flex items-center gap-3">
                                            <AvatarIcon 
                                                avatarId={entry.avatar_id || ''} 
                                                avatarUrl={entry.avatar_url}
                                                size={32} 
                                                className="ring-2 ring-yellow-500/20 shadow-[0_0_10px_rgba(241,196,15,0.2)]"
                                            />
                                            <div className="flex items-center gap-1.5">
                                                <div className="font-bold text-white tracking-tight break-all sm:break-normal line-clamp-1 sm:line-clamp-none">{entry.username}</div>
                                                {(entry.metadata?.verified || entry.metadata?.proofToken) && (
                                                    <span title="AstraNet Verified Record">
                                                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="font-mono text-yellow-500 font-bold text-xs sm:text-sm whitespace-nowrap">
                                            {Math.floor(entry.score / 60)}m {Math.floor(entry.score % 60)}s
                                        </div>
                                    </div>
                                    <div className="col-span-2 text-[10px] font-mono text-gray-500 hidden sm:block">
                                        {format(new Date(entry.created_at), 'MMM dd, yyyy')}
                                    </div>
                                    <div className="col-span-1 sm:col-span-1 text-right flex justify-end">
                                        {entry.replay_path && (
                                            <button 
                                                onClick={() => onWatchReplay(entry.replay_path!)}
                                                className="p-2 text-yellow-500/50 hover:text-yellow-500 hover:bg-yellow-500/20 rounded transition-all"
                                                title="Watch Replay"
                                            >
                                                <Play className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </motion.div>
                            ))}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <button 
                onClick={onClose}
                className="mt-8 px-12 py-3 bg-yellow-500/10 border border-yellow-500 text-yellow-500 font-mono font-bold hover:bg-yellow-500 hover:text-black transition-all uppercase tracking-widest"
            >
                EXIT HALL OF FAME
            </button>

            <AnimatePresence>
                {hoveredEntry && (
                    <ReplayTooltip entry={hoveredEntry} mousePos={mousePos} />
                )}
            </AnimatePresence>
        </div>
    );
};

export default OnlineLeaderboard;
