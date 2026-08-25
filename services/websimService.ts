import { LeaderboardEntry, ReplayData, UserProgress, GameSettings } from '../types';
import { scoreVerifier } from './scoreVerifier';
import { compressReplay, decompressReplay } from './replayCompression';

export const isWebsim = () => {
    return typeof window !== 'undefined' && !!(window as any).websim;
};

export async function getWebsimUser() {
    if (!isWebsim()) return null;
    try {
        return await (window as any).websim.getUser();
    } catch (e) {
        console.error("Error getting websim user:", e);
        return null;
    }
}

async function runSql(sql: string) {
    try {
        const response = await fetch('/api/v1/sql/?' + new URLSearchParams({ sql }));
        if (!response.ok) throw new Error('SQL execution failed');
        return await response.json();
    } catch (err) {
        console.error("Websim SQL Error:", err);
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
        await ensureDb();
        const user = await getWebsimUser();
        if (!user) return;

        // Sanity check progress stats before saving
        if (progress.upgrades) {
            progress.upgrades.maxShields = Math.min(5, Math.max(0, progress.upgrades.maxShields || 0));
            progress.upgrades.durationSlow = Math.min(5, Math.max(0, progress.upgrades.durationSlow || 0));
            progress.upgrades.durationShrink = Math.min(5, Math.max(0, progress.upgrades.durationShrink || 0));
        }

        const statsStr = JSON.stringify(progress).replace(/'/g, "''");
        const settingsStr = JSON.stringify(settings).replace(/'/g, "''");
        const sql = `INSERT OR REPLACE INTO websim_user_data (user_id, currency, stats, settings, updated_at) VALUES ('${user.id}', ${progress.coins}, '${statsStr}', '${settingsStr}', '${new Date().toISOString()}');`;
        await runSql(sql);
    },

    async fetchUserData() {
        await ensureDb();
        const user = await getWebsimUser();
        if (!user) return null;
        const res = await runSql(`SELECT * FROM websim_user_data WHERE user_id = '${user.id}'`);
        if (!res || !res.rows || res.rows.length === 0) return null;
        const row = res.rows[0];
        try {
            const progress = JSON.parse(row.stats);
            const settings = JSON.parse(row.settings);
            return { progress, settings };
        } catch (e) {
            return null;
        }
    },

    async getLeaderboard(mode: string): Promise<LeaderboardEntry[]> {
        await ensureDb();
        const res = await runSql(`SELECT * FROM websim_scores WHERE mode = '${mode}' ORDER BY score DESC LIMIT 100`);
        if (!res || !res.rows) return [];

        const entries: LeaderboardEntry[] = res.rows.map((row: any) => ({
            id: row.id,
            user_id: row.user_id,
            username: row.username,
            avatar_url: row.avatar_url,
            score: row.score,
            mode: row.mode,
            metadata: row.metadata ? JSON.parse(row.metadata) : null,
            replay_path: row.replay_data ? row.id : null,
            created_at: row.created_at
        }));

        // Filter out any entries that fail anti-cheat security checks
        return entries.filter(scoreVerifier.sanitizeLeaderboardEntry).slice(0, 50);
    },

    async submitScore(score: number, mode: string, metadata: any, replay: ReplayData | null) {
        await ensureDb();
        const user = await getWebsimUser();
        if (!user) return { success: false, reason: 'NOT_AUTHENTICATED' };

        // Fetch stored user data to verify progression
        const userData = await this.fetchUserData();

        // Perform multi-stage anti-cheat verification
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

        const metaStr = JSON.stringify(enrichedMetadata);
        let replayStr = '';
        if (replay) {
            try {
                const compressed = compressReplay(replay);
                replayStr = JSON.stringify(compressed).replace(/'/g, "''");
            } catch (e) {
                replayStr = 'yes';
            }
        }

        const sql = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${id}', '${user.id}', '${user.username.replace(/'/g, "''")}', '${user.avatar_url || ''}', ${score}, '${mode}', '${metaStr.replace(/'/g, "''")}', '${replayStr ? 'yes' : ''}', '${createdAt}');`;
        await runSql(sql);
        return { success: true, proofToken: verification.proofToken };
    }
};

