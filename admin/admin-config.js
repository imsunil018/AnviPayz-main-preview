const localAdminApiBase = (() => {
    const host = window.location.hostname || "";
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    const isFilePreview = window.location.protocol === "file:";

    if (isFilePreview || isLocalHost) {
        return "http://127.0.0.1:5050/api/admin";
    }

    return "/api/admin";
})();

export const ADMIN_API_BASE = (window.ANVI_ADMIN_API_BASE || localStorage.getItem("anvi-admin-api-base") || localAdminApiBase).replace(/\/$/, "");
const ADMIN_TOKEN_KEY = "anvi-admin-token";

export function getAdminToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

export function setAdminToken(token) {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export async function requestFirst(variants, { auth = true } = {}) {
    let lastError = null;

    for (const variant of variants) {
        try {
            return await apiRequest(variant.path, {
                method: variant.method || "GET",
                body: variant.body,
                auth
            });
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Admin API request failed.");
}

export async function apiRequest(path, { method = "GET", body, auth = true } = {}) {
    const headers = {
        Accept: "application/json"
    };

    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    if (auth) {
        const token = getAdminToken();
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
    }

    const response = await fetch(`${ADMIN_API_BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => "");

    if (!response.ok) {
        const message = typeof payload === "object" && payload?.message
            ? payload.message
            : `Request failed with status ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    return payload;
}

export function formatDateTime(value) {
    const ms = toTimestamp(value);
    if (!ms) {
        return "-";
    }

    return new Date(ms).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

export function formatRelativeTime(value) {
    const ms = toTimestamp(value);
    if (!ms) {
        return "-";
    }

    const diff = Date.now() - ms;
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function normalizeUserRecord(user) {
    return {
        id: user.id || user._id || "",
        fullName: user.fullName || user.name || "User",
        email: user.email || "No email",
        phone: user.phone || user.mobile || user.phoneNumber || "-",
        balance: toNumber(user.balance, user.points, 0),
        tokens: toNumber(user.tokens, user.totalTokens, 0),
        tokensConverted: toNumber(user.tokensConverted, user.totalTokensConverted, user.convertedTokens, 0),
        totalReferrals: toNumber(user.totalReferrals, user.referrals, 0),
        joinedAt: user.joinedAt || user.createdAt || user.registeredAt || 0,
        lastActive: user.lastActive || user.updatedAt || user.lastLoginAt || 0,
        joinType: user.joinType || (user.referredBy ? "referral" : "direct"),
        referredByName: user.referredByName || user.referredBy || ""
    };
}

export function normalizeTaskRecord(task) {
    return {
        id: task.id || task._id || "",
        title: task.title || "Untitled Task",
        taskType: task.taskType || task.type || "general",
        rewardPoints: toNumber(task.rewardPoints, task.points, task.reward, 0),
        status: task.status || "active",
        createdAt: task.createdAt || task.updatedAt || task.date || 0,
        link: task.link || task.url || "",
        description: task.description || ""
    };
}

export function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

export function chunkArray(list, size) {
    const chunks = [];
    for (let index = 0; index < list.length; index += size) {
        chunks.push(list.slice(index, index + size));
    }
    return chunks;
}

export function toNumber(...values) {
    for (const value of values) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return numeric;
        }
    }

    return 0;
}

export function capitalize(value) {
    const raw = String(value || "");
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
}

function toTimestamp(value) {
    if (!value) return 0;
    if (typeof value === "number") return value > 100_000_000_000 ? value : value * 1000;
    if (typeof value === "string") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric > 100_000_000_000 ? numeric : numeric * 1000;
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") return value.seconds * 1000;
    return 0;
}
