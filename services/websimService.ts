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

async function runSql(sql: string) {
    try {
        let response = await fetch('/api/v1/sql/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql })
        });
        if (!response.ok) {
            response = await fetch('/api/v1/sql/?' + new URLSearchParams({ sql }));
        }
        if (!response.ok) throw new Error('SQL execution failed');
        return await response.json();
    } catch (err) {
        return null;
    }
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
        const filtered = scores.filter(s => s.id !== entry.id);
        filtered.unshift(entry);
        localStorage.setItem(LOCAL_SCORES_KEY, JSON.stringify(filtered.slice(0, 200)));
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
    if (Array.isArray(res)) return res;
    if (res.rows && Array.isArray(res.rows)) return res.rows;
    if (res.data && Array.isArray(res.data)) return res.data;
    if (res.result && Array.isArray(res.result)) return res.result;
    return [];
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
            id: row.id,
            user_id: row.user_id,
            username: row.username,
            avatar_url: row.avatar_url,
            name: row.username || 'PILOT',
            score: Number(row.score),
            date: row.created_at || new Date().toISOString(),
            metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null,
            replay_path: (row.replay_data && row.replay_data !== 'yes' && row.replay_data.length > 5) ? row.id : null,
            created_at: row.created_at
        });

        let entries: LeaderboardEntry[] = [];

        await ensureDb();
        const res = await runSql(`SELECT * FROM websim_scores WHERE mode = '${mode}' ORDER BY score DESC LIMIT 100`);
        const rows = extractRows(res);
        if (rows.length > 0) {
            entries = rows.map(mapEntry);
        }

        const localScores = getLocalScores().filter(s => s.mode === mode).map(mapEntry);
        const existingIds = new Set(entries.map(e => e.id));
        for (const localEntry of localScores) {
            if (!existingIds.has(localEntry.id)) {
                entries.push(localEntry);
                existingIds.add(localEntry.id);
            }
        }

        entries.sort((a, b) => b.score - a.score);

        return entries.filter(scoreVerifier.sanitizeLeaderboardEntry).slice(0, 50);
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

        const id = 'score_' + Math.random().toString(36).substring(2, 11);
        const createdAt = new Date().toISOString();

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

        const scoreEntry = {
            id,
            user_id: user.id,
            username: user.username,
            avatar_url: user.avatar_url || '',
            score,
            mode,
            metadata: enrichedMetadata,
            replay_data: replayStr,
            created_at: createdAt
        };

        saveLocalScore(scoreEntry);

        await ensureDb();
        const metaSqlStr = JSON.stringify(enrichedMetadata).replace(/'/g, "''");
        const replaySqlStr = replayStr.replace(/'/g, "''");
        const sql = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${id}', '${user.id}', '${user.username.replace(/'/g, "''")}', '${user.avatar_url || ''}', ${score}, '${mode}', '${metaSqlStr}', '${replaySqlStr}', '${createdAt}');`;
        await runSql(sql);

        return { success: true, proofToken: verification.proofToken };
    }
};


