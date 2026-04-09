// js/app.js
(() => {
    const isReferPage = /refer\.html$/i.test(window.location.pathname);
    if (!isReferPage) return;

    const state = {
        view: "all",
        datasets: {
            all: [],
            weekly: []
        },
        prevRanks: {
            all: new Map(),
            weekly: new Map()
        },
        currentUser: {
            username: "sunil",
            referrals: 0,
            points: 0
        }
    };

    const elements = {};

    document.addEventListener("DOMContentLoaded", () => {
        cacheElements();
        initUser();
        buildDatasets();
        bindControls();
        renderAll();
        startLiveUpdates();
    });

    function cacheElements() {
        elements.copyBtn = document.getElementById("copy-btn");
        elements.shareBtn = document.getElementById("share-btn");
        elements.inviteBtn = document.getElementById("invite-now-btn");
        elements.code = document.getElementById("my-refer-code");
        elements.refCount = document.getElementById("total-ref-count");
        elements.points = document.getElementById("total-ref-earnings");
        elements.rank = document.getElementById("pending-ref-rewards");
        elements.dailyLimit = document.getElementById("daily-limit-text");
        elements.progressFill = document.getElementById("progress-fill");
        elements.progressCurrent = document.getElementById("progress-current");
        elements.progressGoal = document.getElementById("progress-goal");
        elements.bonusStatus = document.getElementById("bonus-status");
        elements.leaderboardContainer = document.getElementById("leaderboard-container");
        elements.leaderboardList = document.getElementById("leaderboard-list");
        elements.yourRankCard = document.getElementById("your-rank-card");
        elements.activityList = document.getElementById("referral-list");
        elements.toggleAll = document.getElementById("toggle-all");
        elements.toggleWeekly = document.getElementById("toggle-weekly");
        elements.themeButtons = document.querySelectorAll("#theme-toggle, .mobile-theme-toggle");
    }

    function initUser() {
        const storedName = localStorage.getItem("anvi-username");
        const fallbackName = "sunil";
        const username = sanitizeName(storedName || fallbackName);
        state.currentUser.username = username;

        const code = getReferralCode(username);
        if (elements.code) {
            elements.code.textContent = code;
        }
    }

    function buildDatasets() {
        const names = [
            "sunil", "priya", "aarav", "anaya", "arjun", "isha", "rohan", "kavya",
            "vikram", "meera", "nisha", "rahul", "tanvi", "dev", "simran", "karan",
            "neha", "abhinav", "pallavi", "farhan"
        ];

        if (!names.includes(state.currentUser.username)) {
            names[0] = state.currentUser.username;
        }

        state.datasets.all = buildUsers(names, 6, 30, 500, 2800);
        state.datasets.weekly = buildUsers(names, 2, 14, 120, 900);

        const current = state.datasets.all.find(user => user.username === state.currentUser.username);
        if (current) {
            state.currentUser.referrals = current.referrals;
            state.currentUser.points = current.points;
        }
    }

    function buildUsers(names, minRef, maxRef, minPoints, maxPoints) {
        return names.map((name, idx) => {
            const referrals = randomBetween(minRef, maxRef);
            const points = Math.round(referrals * randomBetween(55, 110) + randomBetween(minPoints, maxPoints));
            return {
                id: idx + 1,
                username: sanitizeName(name),
                referrals,
                points
            };
        });
    }

    function bindControls() {
        bindThemeToggle();

        elements.copyBtn?.addEventListener("click", () => {
            handleCopy();
            pulseButton(elements.copyBtn, "Copied!");
        });

        elements.shareBtn?.addEventListener("click", () => {
            handleShare();
            pulseButton(elements.shareBtn, "Shared");
        });

        elements.inviteBtn?.addEventListener("click", () => {
            handleShare();
            pulseButton(elements.inviteBtn, "Link Ready");
        });

        elements.inviteBtn?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            copyReferralLink();
            pulseButton(elements.inviteBtn, "Invite Sent");
        }, true);
    }

    function bindThemeToggle() {
        if (document.documentElement.dataset.referThemeBound === "1") return;
        document.documentElement.dataset.referThemeBound = "1";
        elements.themeButtons.forEach((button) => {
            button.addEventListener("click", () => {
                const current = document.documentElement.getAttribute("data-theme") || "dark";
                const next = current === "dark" ? "light" : "dark";
                document.documentElement.setAttribute("data-theme", next);
                localStorage.setItem("anvi-theme", next);
            });
        });
    }

    function switchView(view) {
        if (state.view === view) return;
        state.view = view;
        elements.toggleAll?.classList.toggle("active", view === "all");
        elements.toggleWeekly?.classList.toggle("active", view === "weekly");
        renderLeaderboard();
    }

    function renderAll() {
        renderLeaderboard();
        updateStats();
        updateProgress();
        renderActivity();
    }

    function updateStats() {
        const user = getCurrentUser(state.view);
        if (!user) return;
        const rank = calculateRank(state.view, user.username);

        if (elements.refCount) elements.refCount.textContent = formatNumber(user.referrals);
        if (elements.points) elements.points.textContent = formatNumber(user.points);
        if (elements.rank) elements.rank.textContent = rank ? `#${rank}` : "#-";
        if (elements.dailyLimit) elements.dailyLimit.textContent = `${formatNumber(user.referrals)} / 10 Today`;
    }

    function updateProgress() {
        const user = getCurrentUser(state.view);
        const goal = 10;
        const current = user ? user.referrals : 0;
        const ratio = Math.min(current / goal, 1);

        if (elements.progressCurrent) elements.progressCurrent.textContent = formatNumber(current);
        if (elements.progressGoal) elements.progressGoal.textContent = formatNumber(goal);
        if (elements.progressFill) {
            elements.progressFill.style.width = "0%";
            requestAnimationFrame(() => {
                elements.progressFill.style.width = `${ratio * 100}%`;
            });
        }

        if (elements.bonusStatus) {
            if (current >= goal) {
                elements.bonusStatus.textContent = "Bonus unlocked! Keep pushing the leaderboard.";
                elements.bonusStatus.classList.add("unlocked");
            } else {
                elements.bonusStatus.textContent = `Invite ${goal - current} more friends to unlock reward.`;
                elements.bonusStatus.classList.remove("unlocked");
            }
        }
    }

    function renderLeaderboard() {
        const list = getSortedUsers(state.view);
        const topTen = list.slice(0, 10);
        const prevRanks = state.prevRanks[state.view];
        const newRanks = new Map();

        topTen.forEach((user, index) => {
            newRanks.set(user.username, index + 1);
        });

        const listEl = ensureLeaderboardList();
        if (!listEl) return;

        const oldPositions = new Map();
        Array.from(listEl.children).forEach(el => {
            oldPositions.set(el.dataset.username, el.getBoundingClientRect());
        });

        const fragment = document.createDocumentFragment();
        topTen.forEach((user, index) => {
            const rank = index + 1;
            const previousRank = prevRanks.get(user.username);
            const delta = previousRank ? previousRank - rank : 0;
            fragment.appendChild(buildLeaderboardRow(user, rank, delta));
        });

        listEl.innerHTML = "";
        listEl.appendChild(fragment);

        animateLeaderboard(listEl, oldPositions);

        state.prevRanks[state.view] = newRanks;

        const currentRank = calculateRank(state.view, state.currentUser.username);
        renderYourRank(currentRank, list);
        updateStats();
    }

    function ensureLeaderboardList() {
        if (!elements.leaderboardContainer) return null;
        let listEl = elements.leaderboardContainer.querySelector(".leaderboard-list");
        if (!listEl) {
            listEl = document.createElement("div");
            listEl.className = "leaderboard-list";
            elements.leaderboardContainer.innerHTML = "";
            elements.leaderboardContainer.appendChild(listEl);
        }
        return listEl;
    }

    function buildLeaderboardRow(user, rank, delta) {
        const row = document.createElement("div");
        row.className = "leader-row";
        row.dataset.username = user.username;

        if (rank === 1) row.classList.add("leader-top-1");
        if (rank === 2) row.classList.add("leader-top-2");
        if (rank === 3) row.classList.add("leader-top-3");
        if (user.username === state.currentUser.username) row.classList.add("leader-current");

        const changeClass = delta > 0 ? "up" : delta < 0 ? "down" : "";
        const changeText = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : "";

        row.innerHTML = `
            <div class="leader-rank">${rank}</div>
            <div class="leader-info">
                <div class="leader-name">${user.username === state.currentUser.username ? "You" : capitalize(user.username)}</div>
                <div class="leader-meta">${formatNumber(user.referrals)} referrals</div>
            </div>
            <div class="leader-points">${formatNumber(user.points)} pts</div>
            ${changeText ? `<div class="leader-change ${changeClass}">${changeText}</div>` : ""}
        `;

        return row;
    }

    function animateLeaderboard(listEl, oldPositions) {
        const newPositions = new Map();
        Array.from(listEl.children).forEach(el => {
            newPositions.set(el.dataset.username, el.getBoundingClientRect());
        });

        Array.from(listEl.children).forEach(el => {
            const old = oldPositions.get(el.dataset.username);
            const current = newPositions.get(el.dataset.username);
            if (!old || !current) return;
            const deltaY = old.top - current.top;
            if (Math.abs(deltaY) < 1) return;
            el.style.transition = "transform 0s";
            el.style.transform = `translateY(${deltaY}px)`;
            requestAnimationFrame(() => {
                el.style.transition = "transform 280ms ease";
                el.style.transform = "translateY(0)";
            });
        });
    }

    function renderYourRank(rank, list) {
        if (!elements.yourRankCard) return;
        if (!rank || rank <= 10) {
            elements.yourRankCard.hidden = true;
            return;
        }

        const user = list.find(item => item.username === state.currentUser.username);
        if (!user) return;

        elements.yourRankCard.hidden = false;
        elements.yourRankCard.innerHTML = `
            <div class="section-title">Your Rank</div>
            <div class="leader-name">#${rank} - ${capitalize(user.username)}</div>
            <div class="leader-meta">${formatNumber(user.points)} pts · ${formatNumber(user.referrals)} referrals</div>
        `;
    }

    function renderActivity() {
        if (!elements.activityList) return;
        const list = getSortedUsers(state.view).slice(0, 6);
        elements.activityList.innerHTML = list.map((user, idx) => {
            const status = idx % 2 === 0 ? "Verified" : "Pending";
            return `
                <div class="activity-row">
                    <div class="activity-user">
                        <strong>${capitalize(user.username)}</strong>
                        <span>${status}</span>
                    </div>
                    <div class="activity-points">+${formatNumber(Math.round(user.points / 10))} pts</div>
                </div>
            `;
        }).join("");
    }

    function startLiveUpdates() {
        setInterval(() => {
            const list = state.datasets[state.view];
            const updateCount = Math.min(3, list.length);
            for (let i = 0; i < updateCount; i += 1) {
                const index = randomBetween(0, list.length - 1);
                const user = list[index];
                user.points += randomBetween(20, 80);
                if (Math.random() > 0.6) {
                    user.referrals += 1;
                }
            }
            renderLeaderboard();
            updateProgress();
        }, 4200);
    }

    function getSortedUsers(view) {
        return [...state.datasets[view]].sort((a, b) => b.points - a.points);
    }

    function calculateRank(view, username) {
        const list = getSortedUsers(view);
        const index = list.findIndex(item => item.username === username);
        return index === -1 ? null : index + 1;
    }

    function getCurrentUser(view) {
        return state.datasets[view].find(item => item.username === state.currentUser.username);
    }

    async function copyReferralLink() {
        const code = elements.code?.textContent?.trim() || getReferralCode(state.currentUser.username);
        const link = `${window.location.origin}${window.location.pathname.replace(/\/?[^/]*$/, "/")}index.html?view=register&ref=${encodeURIComponent(code)}`;
        try {
            await navigator.clipboard.writeText(link);
        } catch (error) {
            // ignore
        }
    }

    function pulseButton(button, label) {
        if (!button) return;
        const labelEl = button.querySelector(".btn-label") || button;
        const original = labelEl.textContent;
        labelEl.textContent = label;
        button.classList.add("is-pulsed");
        setTimeout(() => {
            labelEl.textContent = original;
            button.classList.remove("is-pulsed");
        }, 1400);
    }

    function getReferralCode(username) {
        const key = `anvi-ref-code-${username}`;
        let code = localStorage.getItem(key);
        if (!code) {
            const suffix = randomBetween(1000, 9999);
            code = `${username.slice(0, 4).toUpperCase()}${suffix}`;
            localStorage.setItem(key, code);
        }
        return code;
    }

    function sanitizeName(name) {
        return String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase() || "sunil";
    }

    function capitalize(text) {
        if (!text) return "";
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    function formatNumber(value) {
        return Number(value || 0).toLocaleString("en-IN");
    }

    function randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
})();
