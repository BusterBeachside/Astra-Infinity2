import { LeaderboardEntry, ReplayData, UserProgress, GameSettings } from '../types';
import { scoreVerifier } from './scoreVerifier';
import { compressReplay, decompressReplay } from './replayCompression';

export const isWebsim = () => {
    return typeof window !== 'undefined' && !!(window as any).websim;
};

function getFallbackWebsimUser() {
    let localId = localStorage.getItem('astra_websim_guest_id');
    if (!localId) {
        localId = 'pilot_' + Math.random().toString(36).substring(2, 11);
        localStorage.setItem('astra_websim_guest_id', localId);
    }
    return {
        id: localId,
        username: 'PILOT_' + localId.slice(-4).toUpperCase(),
        avatar_url: ''
    };
}

export async function getWebsimUser() {
    if (!isWebsim()) return null;
    try {
        const user = await (window as any).websim.getUser();
        if (user && user.id) return user;
    } catch (e) {
        console.error("Error getting websim user:", e);
    }
    return getFallbackWebsimUser();
}

let sqlApiDisabled = false;

function localSqlEngine(sql: string): any {
    const cleanSql = sql.trim();

    if (/^CREATE TABLE/i.test(cleanSql)) {
        return { rows: [], success: true };
    }

    if (/^INSERT OR REPLACE INTO websim_user_data/i.test(cleanSql) || /^INSERT INTO websim_user_data/i.test(cleanSql)) {
        const match = cleanSql.match(/VALUES\s*\('([^']+)',\s*([\d.]+),\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)'/i);
        if (match) {
            const uid = match[1];
            try {
                const stats = JSON.parse(match[3].replace(/''/g, "'"));
                const settings = JSON.parse(match[4].replace(/''/g, "'"));
                saveLocalUserData(uid, { progress: stats, settings, updated_at: new Date().toISOString() });
            } catch (e) {
                // ignore parse error
            }
        }
        return { rows: [], changes: 1 };
    }

    if (/^SELECT .* FROM websim_user_data/i.test(cleanSql)) {
        const match = cleanSql.match(/user_id\s*=\s*'([^']+)'/i);
        const userId = match ? match[1] : '';
        const data = getLocalUserData(userId);
        if (data) {
            return {
                rows: [{
                    user_id: userId,
                    currency: data.progress?.coins || 0,
                    stats: JSON.stringify(data.progress || {}),
                    settings: JSON.stringify(data.settings || {}),
                    updated_at: data.updated_at || new Date().toISOString()
                }]
            };
        }
        return { rows: [] };
    }

    if (/^SELECT .* FROM websim_scores/i.test(cleanSql)) {
        let scores = getLocalScores();

        const modeMatch = cleanSql.match(/mode\s*=\s*'([^']+)'/i);
        if (modeMatch) {
            scores = scores.filter(s => s.mode === modeMatch[1]);
        }

        const idMatch = cleanSql.match(/id\s*=\s*'([^']+)'/i);
        if (idMatch) {
            scores = scores.filter(s => s.id === idMatch[1]);
        }

        const userMatch = cleanSql.match(/user_id\s*=\s*'([^']+)'/i);
        const usernameMatch = cleanSql.match(/username\s*=\s*'([^']+)'/i);
        if (userMatch || usernameMatch) {
            const uid = userMatch ? userMatch[1] : '';
            const uname = usernameMatch ? usernameMatch[1] : '';
            scores = scores.filter(s => s.user_id === uid || (s.username && s.username.toLowerCase() === uname.toLowerCase()));
        }

        scores.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

        const limitMatch = cleanSql.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) {
            scores = scores.slice(0, parseInt(limitMatch[1], 10));
        }

        return { rows: scores };
    }

    if (/^UPDATE websim_scores/i.test(cleanSql)) {
        const idMatch = cleanSql.match(/id\s*=\s*'([^']+)'/i);
        if (idMatch) {
            const targetId = idMatch[1];
            const scoreMatch = cleanSql.match(/score\s*=\s*([\d.]+)/i);
            const metaMatch = cleanSql.match(/metadata\s*=\s*'((?:[^']|'')+)'/i);
            const replayMatch = cleanSql.match(/replay_data\s*=\s*'((?:[^']|'')+)'/i);

            const scores = getLocalScores();
            const entry = scores.find(s => s.id === targetId);
            if (entry) {
                if (scoreMatch) entry.score = parseFloat(scoreMatch[1]);
                if (metaMatch) {
                    try { entry.metadata = JSON.parse(metaMatch[1].replace(/''/g, "'")); } catch (e) {}
                }
                if (replayMatch) entry.replay_data = replayMatch[1].replace(/''/g, "'");
                entry.created_at = new Date().toISOString();
                localStorage.setItem(LOCAL_SCORES_KEY, JSON.stringify(scores));
            }
        }
        return { rows: [], changes: 1 };
    }

    if (/^DELETE FROM websim_scores/i.test(cleanSql)) {
        const notIdMatch = cleanSql.match(/id\s*!=\s*'([^']+)'/i);
        if (notIdMatch) {
            const keepId = notIdMatch[1];
            const scores = getLocalScores().filter(s => s.id === keepId);
            localStorage.setItem(LOCAL_SCORES_KEY, JSON.stringify(scores));
        }
        return { rows: [], changes: 1 };
    }

    if (/^INSERT INTO websim_scores/i.test(cleanSql)) {
        return { rows: [], changes: 1 };
    }

    return { rows: [] };
}

async function runSql(sql: string) {
    if (sqlApiDisabled) {
        return localSqlEngine(sql);
    }

    // 1. Direct window.websim SQL methods if exposed by the host
    const w = typeof window !== 'undefined' ? (window as any).websim : null;
    if (w && typeof w.sql === 'function') {
        try {
            const res = await w.sql(sql);
            if (res !== null && res !== undefined) return res;
        } catch (e) {
            console.warn('[Websim DB] window.websim.sql failed:', e);
        }
    }
    if (w && typeof w.query === 'function') {
        try {
            const res = await w.query(sql);
            if (res !== null && res !== undefined) return res;
        } catch (e) {
            console.warn('[Websim DB] window.websim.query failed:', e);
        }
    }

    // 2. HTTP endpoints (POST first)
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ sql, query: sql });

    try {
        const res = await fetch('/api/v1/sql', { method: 'POST', headers, body });
        if (res.status === 403 || res.status === 404) {
            sqlApiDisabled = true;
            return localSqlEngine(sql);
        }
        if (res.ok) return await res.json();
    } catch (e) {
        // Fall through to local engine
    }

    sqlApiDisabled = true;
    return localSqlEngine(sql);
}

let dbInitialized = false;
async function ensureDb() {
    if (dbInitialized || !isWebsim()) return;
    await runSql(`CREATE TABLE IF NOT EXISTS websim_scores (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT,
        avatar_url TEXT,
        score REAL,
        mode TEXT,
        metadata TEXT,
        replay_data TEXT,
        created_at TEXT
    );`);
    await runSql(`CREATE TABLE IF NOT EXISTS websim_user_data (
        user_id TEXT PRIMARY KEY,
        currency REAL,
        stats TEXT,
        settings TEXT,
        updated_at TEXT
    );`);
    dbInitialized = true;
}

const LOCAL_SCORES_KEY = 'astra_websim_local_scores_v2';
const LOCAL_USER_DATA_KEY_PREFIX = 'astra_websim_user_data_v2_';

function getLocalScores(): any[] {
    try {
        const raw = localStorage.getItem(LOCAL_SCORES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveLocalScore(entry: any) {
    try {
        const scores = getLocalScores();
        const playerKey = (entry.user_id && entry.user_id.trim() !== '') ? entry.user_id : (entry.username || '').toLowerCase().trim();

        // Deduplicate locally: only store the player's personal best time per mode
        const existingIdx = scores.findIndex(s => {
            const sKey = (s.user_id && s.user_id.trim() !== '') ? s.user_id : (s.username || '').toLowerCase().trim();
            return sKey === playerKey && s.mode === entry.mode;
        });

        if (existingIdx >= 0) {
            if (entry.score > (Number(scores[existingIdx].score) || 0)) {
                scores[existingIdx] = entry;
            }
        } else {
            scores.unshift(entry);
        }

        scores.sort((a, b) => Number(b.score) - Number(a.score));
        localStorage.setItem(LOCAL_SCORES_KEY, JSON.stringify(scores.slice(0, 100)));
    } catch (e) {
        console.error("Failed to save local score:", e);
    }
}

function getLocalUserData(userId: string) {
    try {
        const raw = localStorage.getItem(LOCAL_USER_DATA_KEY_PREFIX + userId);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function saveLocalUserData(userId: string, data: any) {
    try {
        localStorage.setItem(LOCAL_USER_DATA_KEY_PREFIX + userId, JSON.stringify(data));
    } catch (e) {
        console.error("Failed to save local user data:", e);
    }
}

function extractRows(res: any): any[] {
    if (!res) return [];

    let rawRows: any[] = [];
    let cols: string[] | null = null;

    if (Array.isArray(res)) {
        rawRows = res;
    } else if (res.rows && Array.isArray(res.rows)) {
        rawRows = res.rows;
        if (res.columns && Array.isArray(res.columns)) cols = res.columns;
    } else if (res.data && Array.isArray(res.data)) {
        rawRows = res.data;
        if (res.columns && Array.isArray(res.columns)) cols = res.columns;
    } else if (res.result && Array.isArray(res.result)) {
        rawRows = res.result;
    }

    if (cols && cols.length > 0 && rawRows.length > 0 && Array.isArray(rawRows[0])) {
        return rawRows.map((r: any[]) => {
            const obj: any = {};
            cols!.forEach((col, idx) => {
                obj[col] = r[idx];
            });
            return obj;
        });
    }

    return rawRows;
}

export const websimService = {
    async getCurrentUser() {
        const user = await getWebsimUser();
        if (!user) return null;
        return {
            id: user.id,
            email: `${user.username}@websim.user`,
            user_metadata: { username: user.username, avatar_url: user.avatar_url }
        };
    },

    async getProfile(userId: string) {
        const user = await getWebsimUser();
        if (!user) return null;
        return {
            id: user.id,
            username: user.username,
            avatar_url: user.avatar_url,
            created_at: new Date().toISOString()
        };
    },

    async updateProfile(profile: any) {
        return { error: null };
    },

    async syncUserData(progress: UserProgress, settings: GameSettings) {
        const user = await getWebsimUser();
        if (!user) return;

        if (progress.upgrades) {
            progress.upgrades.maxShields = Math.max(0, progress.upgrades.maxShields || 0);
            progress.upgrades.durationSlow = Math.max(0, progress.upgrades.durationSlow || 0);
            progress.upgrades.durationShrink = Math.max(0, progress.upgrades.durationShrink || 0);
            progress.upgrades.grazeBonus = Math.max(0, progress.upgrades.grazeBonus || 0);
        }

        const payload = { progress, settings, updated_at: new Date().toISOString() };
        saveLocalUserData(user.id, payload);

        await ensureDb();
        const statsStr = JSON.stringify(progress).replace(/'/g, "''");
        const settingsStr = JSON.stringify(settings).replace(/'/g, "''");
        const sql = `INSERT OR REPLACE INTO websim_user_data (user_id, currency, stats, settings, updated_at) VALUES ('${user.id}', ${progress.coins}, '${statsStr}', '${settingsStr}', '${new Date().toISOString()}');`;
        await runSql(sql);
    },

    async fetchUserData() {
        const user = await getWebsimUser();
        if (!user) return null;

        await ensureDb();
        const res = await runSql(`SELECT * FROM websim_user_data WHERE user_id = '${user.id}'`);
        const rows = extractRows(res);
        if (rows.length > 0) {
            const row = rows[0];
            try {
                const progress = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats;
                const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
                return { progress, settings };
            } catch (e) {
                // Ignore parse error and fall back
            }
        }

        const localData = getLocalUserData(user.id);
        if (localData && localData.progress) {
            return { progress: localData.progress, settings: localData.settings };
        }

        return null;
    },

    async getLeaderboard(mode: string): Promise<LeaderboardEntry[]> {
        const mapEntry = (row: any): LeaderboardEntry => ({
            id: row.id || ('entry_' + Math.random().toString(36).substring(2, 9)),
            user_id: row.user_id || '',
            username: row.username || 'PILOT',
            avatar_url: row.avatar_url || '',
            name: row.username || 'PILOT',
            score: Number(row.score) || 0,
            date: row.created_at || new Date().toISOString(),
            metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null,
            replay_path: (row.replay_data && row.replay_data !== 'yes' && row.replay_data.length > 5) ? row.id : null,
            created_at: row.created_at || new Date().toISOString()
        });

        const allEntries: LeaderboardEntry[] = [];

        await ensureDb();
        const res = await runSql(`SELECT * FROM websim_scores WHERE mode = '${mode}' ORDER BY score DESC LIMIT 100`);
        const rows = extractRows(res);
        if (rows && rows.length > 0) {
            allEntries.push(...rows.map(mapEntry));
        }

        if (allEntries.length === 0) {
            const localScores = getLocalScores().filter(s => s.mode === mode).map(mapEntry);
            allEntries.push(...localScores);
        }

        // Deduplicate: The Hall of Fame strictly shows ONLY ONE best score per player
        const playerBestMap = new Map<string, LeaderboardEntry>();
        for (const entry of allEntries) {
            const playerKey = (entry.user_id && entry.user_id.trim() !== '')
                ? entry.user_id
                : (entry.username || 'PILOT').trim().toLowerCase();

            const existing = playerBestMap.get(playerKey);
            if (!existing || entry.score > existing.score) {
                playerBestMap.set(playerKey, entry);
            }
        }

        const uniqueEntries = Array.from(playerBestMap.values());
        uniqueEntries.sort((a, b) => b.score - a.score);

        return uniqueEntries.filter(scoreVerifier.sanitizeLeaderboardEntry).slice(0, 50);
    },

    async downloadReplay(id: string): Promise<ReplayData | null> {
        await ensureDb();
        const res = await runSql(`SELECT replay_data FROM websim_scores WHERE id = '${id}'`);
        const rows = extractRows(res);
        if (rows.length > 0) {
            const rawData = rows[0].replay_data;
            if (rawData && rawData !== 'yes' && rawData !== '') {
                try {
                    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
                    return decompressReplay(parsed);
                } catch (e) {
                    console.error("[Websim] Error parsing replay SQL data:", e);
                }
            }
        }

        const localScores = getLocalScores();
        const found = localScores.find(s => s.id === id);
        if (found && found.replay_data) {
            try {
                const parsed = typeof found.replay_data === 'string' ? JSON.parse(found.replay_data) : found.replay_data;
                return decompressReplay(parsed);
            } catch (e) {
                console.error("[Websim] Error parsing replay local data:", e);
            }
        }

        return null;
    },

    async submitScore(score: number, mode: string, metadata: any, replay: ReplayData | null) {
        const user = await getWebsimUser();
        if (!user) return { success: false, reason: 'NOT_AUTHENTICATED' };

        const userData = await this.fetchUserData();

        const verification = scoreVerifier.verifySubmission(score, mode, metadata, replay, userData);
        if (!verification.valid) {
            console.warn(`[AstraNet Security Engine] High score submission blocked: ${verification.reason}`);
            return { success: false, reason: verification.reason };
        }

        const createdAt = new Date().toISOString();
        const safeUsername = (user.username || 'PILOT').replace(/'/g, "''");
        const safeAvatar = (user.avatar_url || '').replace(/'/g, "''");

        const enrichedMetadata = {
            ...metadata,
            verified: true,
            proofToken: verification.proofToken || metadata?.proofToken
        };

        let replayStr = '';
        if (replay) {
            try {
                const compressed = compressReplay(replay);
                replayStr = JSON.stringify(compressed);
            } catch (e) {
                console.error("[Websim] Error compressing replay:", e);
                replayStr = '';
            }
        }

        await ensureDb();

        // Check if player already has an existing score recorded in this mode
        const checkSql = `SELECT id, score FROM websim_scores WHERE (user_id = '${user.id}' OR username = '${safeUsername}') AND mode = '${mode}' ORDER BY score DESC LIMIT 1;`;
        const existingRes = await runSql(checkSql);
        const existingRows = extractRows(existingRes);
        const existingEntry = existingRows.length > 0 ? existingRows[0] : null;

        // If player already has a higher or equal score recorded, retain their existing personal best
        if (existingEntry && Number(existingEntry.score) >= score) {
            console.log(`[Websim Hall of Fame] Score ${score}s is not higher than existing best (${existingEntry.score}s). Preserving personal record.`);
            saveLocalScore({
                id: existingEntry.id,
                user_id: user.id,
                username: user.username,
                avatar_url: user.avatar_url || '',
                score: Number(existingEntry.score),
                mode,
                metadata: enrichedMetadata,
                replay_data: replayStr,
                created_at: createdAt
            });
            return { success: true, proofToken: verification.proofToken };
        }

        const targetId = existingEntry ? existingEntry.id : ('score_' + Math.random().toString(36).substring(2, 11));

        const scoreEntry = {
            id: targetId,
            user_id: user.id,
            username: user.username,
            avatar_url: user.avatar_url || '',
            score,
            mode,
            metadata: enrichedMetadata,
            replay_data: replayStr,
            created_at: createdAt
        };

        // Always save to local storage (deduplicated best time per player)
        saveLocalScore(scoreEntry);

        const metaSqlStr = JSON.stringify(enrichedMetadata).replace(/'/g, "''");
        const replaySqlStr = replayStr.replace(/'/g, "''");

        let writeSuccess = false;
        if (existingEntry) {
            // Update existing record
            let updateSql = `UPDATE websim_scores SET score = ${score}, metadata = '${metaSqlStr}', replay_data = '${replaySqlStr}', created_at = '${createdAt}' WHERE id = '${targetId}';`;
            let res = await runSql(updateSql);
            if (!res && replaySqlStr.length > 2000) {
                // If update failed and replay was large, retry without bulky replay data so score is never lost
                updateSql = `UPDATE websim_scores SET score = ${score}, metadata = '${metaSqlStr}', replay_data = '', created_at = '${createdAt}' WHERE id = '${targetId}';`;
                res = await runSql(updateSql);
            }
            writeSuccess = !!res;

            // Clean up any other duplicates for this user/mode to ensure strictly one score per player
            await runSql(`DELETE FROM websim_scores WHERE (user_id = '${user.id}' OR username = '${safeUsername}') AND mode = '${mode}' AND id != '${targetId}';`);
        } else {
            // Insert new record
            let insertSql = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${targetId}', '${user.id}', '${safeUsername}', '${safeAvatar}', ${score}, '${mode}', '${metaSqlStr}', '${replaySqlStr}', '${createdAt}');`;
            let res = await runSql(insertSql);
            if (!res && replaySqlStr.length > 2000) {
                // Retry without bulky replay
                insertSql = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${targetId}', '${user.id}', '${safeUsername}', '${safeAvatar}', ${score}, '${mode}', '${metaSqlStr}', '', '${createdAt}');`;
                res = await runSql(insertSql);
            }
            writeSuccess = !!res;
        }

        console.log(`[Websim Hall of Fame] Score saved for ${user.username} (${mode}: ${score}s) - Database status: ${writeSuccess ? 'SUCCESS' : 'LOCAL_ONLY'}`);
        return { success: true, proofToken: verification.proofToken };
    }
};


