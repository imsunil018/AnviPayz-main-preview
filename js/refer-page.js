(function () {
    "use strict";

    function $(id) {
        return document.getElementById(id);
    }

    function toNumber(value, fallback = 0) {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    function formatNumber(value) {
        try {
            return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(toNumber(value, 0));
        } catch (error) {
            return String(Math.floor(toNumber(value, 0)));
        }
    }

    function escapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function maskEmail(email) {
        const raw = String(email || "").trim();
        if (!raw || !raw.includes("@")) {
            return "";
        }

        const [local, domain] = raw.split("@");
        if (!local || !domain) {
            return "";
        }

        const head = local.slice(0, Math.min(6, local.length));
        return `${head}****@${domain}`;
    }

    function resolveApiBase() {
        try {
            if (typeof API_BASE_URL === "string" && API_BASE_URL.trim()) {
                return API_BASE_URL.trim().replace(/\/+$/, "");
            }
        } catch (error) {
            // ignore
        }

        const isLocal = window.location.protocol === "file:" ||
            window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1";

        return (isLocal ? "http://localhost:5000" : "https://anvipayz-main-preview-production.up.railway.app");
    }

    function getToken() {
        return String(localStorage.getItem("anvi-token") || "").trim();
    }

    function buildShareUrl(referralCode) {
        const code = String(referralCode || "").trim().toUpperCase();
        const base = `${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, "/")}`;
        if (!code) {
            return `${base}index.html?view=register`;
        }
        return `${base}index.html?view=register&ref=${encodeURIComponent(code)}`;
    }

    function normalizeLeaderboardEntries(entries) {
        return (Array.isArray(entries) ? entries : []).map((item) => {
            const referrals = toNumber(item.referrals ?? item.referralCount ?? 0, 0);
            const points = toNumber(item.points ?? item.reward ?? 0, 0);
            const name = String(item.username || item.name || "Member");
            const emailMasked = String(item.emailMasked || "").trim() || maskEmail(item.email);
            return {
                id: String(item.id || item._id || ""),
                name,
                emailMasked,
                referrals,
                points,
                isMe: Boolean(item.isMe)
            };
        })
            .filter((entry) => entry.referrals > 0)
            .sort((a, b) => (b.referrals - a.referrals) || (b.points - a.points));
    }

    function renderLeaderboard(listEl, entries, rankCard) {
        if (!listEl) {
            return;
        }

        const sorted = normalizeLeaderboardEntries(entries);

        if (!sorted.length) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <i class="ri-trophy-line"></i>
                    <p>No leaderboard data yet.</p>
                </div>
            `;
            if (rankCard) {
                rankCard.hidden = true;
            }
            return;
        }

        const top = sorted.slice(0, 10);
        listEl.innerHTML = top.map((person, index) => `
            <div class="lb-row ${person.isMe ? "lb-row--me" : ""}">
                <div class="lb-rank">#${index + 1}</div>
                <div class="lb-user">
                    <div class="lb-name">${escapeHtml(person.name)}</div>
                    <div class="lb-email">${escapeHtml(person.emailMasked || "-")}</div>
                </div>
                <div class="lb-metric">
                    ${formatNumber(person.referrals)}
                    <div class="lb-metric-sub">Referrals</div>
                </div>
                <div class="lb-metric">
                    ${formatNumber(person.points)}
                    <div class="lb-metric-sub">Points</div>
                </div>
            </div>
        `).join("");

        if (rankCard) {
            const meIndex = top.findIndex((entry) => entry.isMe);
            if (meIndex >= 0) {
                const me = top[meIndex];
                rankCard.hidden = false;
                rankCard.innerHTML = `
                    <div class="section-title">Your leaderboard</div>
                    <div class="summary-value summary-value--primary">#${meIndex + 1}</div>
                    <div class="summary-meta">${escapeHtml(me.name)} - ${escapeHtml(me.emailMasked)}</div>
                    <div style="display:flex; gap:0.75rem; margin-top:0.85rem; flex-wrap:wrap;">
                        <div class="status-pill success">${formatNumber(me.referrals)} Referrals</div>
                        <div class="status-pill success">${formatNumber(me.points)} Points</div>
                    </div>
                `;
            } else {
                rankCard.hidden = true;
            }
        }
    }

    function renderBonusProgress(payload) {
        const titleEl = $("bonus-progress-title");
        const currentEl = $("progress-current");
        const goalEl = $("progress-goal");
        const fillEl = $("progress-fill");
        const statusEl = $("bonus-status");

        if (!currentEl || !goalEl || !fillEl) {
            return;
        }

        const totalReferrals = toNumber(payload?.totalReferrals, 0);
        const milestone = Math.max(toNumber(payload?.bonusMilestone, 15), 1);
        const cycleProgress = totalReferrals % milestone;
        const displayProgress = cycleProgress === 0 && totalReferrals > 0 ? milestone : cycleProgress;
        const remaining = cycleProgress === 0 ? milestone : (milestone - cycleProgress);
        const ratio = Math.min(displayProgress / milestone, 1);
        const milestoneBonusPoints = toNumber(payload?.milestoneBonusPoints, 1000);

        if (titleEl) {
            titleEl.textContent = `Bonus Progress (every ${milestone} referrals)`;
        }

        currentEl.textContent = formatNumber(displayProgress);
        goalEl.textContent = formatNumber(milestone);
        fillEl.style.width = `${Math.round(ratio * 100)}%`;

        if (statusEl) {
            if (totalReferrals > 0 && totalReferrals % milestone === 0) {
                statusEl.textContent = `Milestone unlocked! +${formatNumber(milestoneBonusPoints)} points credited.`;
                statusEl.classList.add("unlocked");
            } else {
                statusEl.textContent = `Invite ${formatNumber(remaining)} more friends to unlock +${formatNumber(milestoneBonusPoints)} bonus points.`;
                statusEl.classList.remove("unlocked");
            }
        }
    }

    function formatLongDate(value) {
        const timestamp = Date.parse(String(value || ""));
        const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
        try {
            return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
        } catch (error) {
            return date.toISOString();
        }
    }

    function renderNetwork(container, network) {
        if (!container) {
            return;
        }

        const list = (Array.isArray(network) ? network : []).map((person) => ({
            name: String(person?.name || "New referral"),
            emailMasked: String(person?.emailMasked || "").trim() || maskEmail(person?.email),
            reward: toNumber(person?.reward ?? person?.points ?? 0, 0),
            time: person?.time || person?.createdAt || ""
        }));

        if (!list.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="ri-user-follow-line"></i>
                    <p>Your verified referrals will appear here after they join.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = list.map((person) => `
            <div class="network-item">
                <div class="list-info">
                    <div class="task-title">${escapeHtml(person.name)}</div>
                    <div class="task-body">${escapeHtml(person.emailMasked || "-")}</div>
                </div>
                <div style="text-align:right;">
                    <div class="status-pill success">${formatNumber(person.reward)} Points</div>
                    <div class="network-time" style="margin-top:6px;">${escapeHtml(formatLongDate(person.time))}</div>
                </div>
            </div>
        `).join("");
    }

    async function fetchReferralPayload() {
        const token = getToken();
        if (!token) {
            return null;
        }

        const apiBase = resolveApiBase();
        const response = await fetch(`${apiBase}/api/referrals`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`
            }
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    }

    async function init() {
        const container = document.querySelector(".ref-container");
        if (!container) {
            return;
        }

        const listEl = $("leaderboard-list");
        const toggleAll = $("toggle-all");
        const toggleWeekly = $("toggle-weekly");
        const rankCard = $("your-rank-card");
        const networkEl = $("referral-list");

        const payload = await fetchReferralPayload();
        if (!payload) {
            return;
        }

        renderBonusProgress(payload);

        const renderCurrent = () => {
            const mode = toggleWeekly?.classList.contains("active") ? "weekly" : "all";
            const entries = mode === "weekly" ? payload.weeklyLeaderboard : payload.leaderboard;
            renderLeaderboard(listEl, entries, rankCard);
        };

        // Render once now, then keep in sync when toggles are clicked.
        renderCurrent();
        setTimeout(renderCurrent, 600);

        toggleAll?.addEventListener("click", () => {
            setTimeout(renderCurrent, 0);
        });
        toggleWeekly?.addEventListener("click", () => {
            setTimeout(renderCurrent, 0);
        });

        const rerenderNetwork = () => renderNetwork(networkEl, payload.network);
        rerenderNetwork();
        setTimeout(rerenderNetwork, 600);

        const whatsappBtn = $("whatsapp-btn");
        if (whatsappBtn && !whatsappBtn.dataset.bound) {
            whatsappBtn.dataset.bound = "1";
            whatsappBtn.addEventListener("click", () => {
                const referralCode = $("my-refer-code")?.textContent || "";
                const shareUrl = buildShareUrl(referralCode);
                const text = `Join AnviPayz using my referral code ${String(referralCode || "").trim().toUpperCase()} and earn bonus points! ${shareUrl}`;
                const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
                window.open(waUrl, "_blank", "noopener,noreferrer");
            });
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        // Let auth.js paint first; then enhance.
        setTimeout(() => {
            init().catch(() => { });
        }, 50);
    });
})();
