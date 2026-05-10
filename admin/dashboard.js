import {
    requestFirst,
    fetchBackendHealth,
    setAdminToken,
    clearAdminToken,
    getAdminToken,
    formatDateTime,
    formatRelativeTime,
    normalizeUserRecord,
    normalizeTaskRecord,
    escapeHtml,
    toNumber,
    capitalize
} from "./admin-config.js";

const state = {
    users: [],
    tasks: [],
    activity: [],
    overview: {},
    leaderboardMode: "refer",
    userSort: "newest",
    userSearch: "",
    refreshTimer: null,
    connectionStatus: "signed_out",
    retryTimer: null,
    lastSyncAt: 0
};

const refs = {
    authScreen: document.getElementById("authScreen"),
    appInterface: document.getElementById("appInterface"),
    toastBox: document.getElementById("toast-box"),
    notifSound: document.getElementById("notifSound"),
    pageTitle: document.getElementById("pageTitle"),
    headerTime: document.getElementById("headerTime"),
    liveChip: document.getElementById("liveChip"),
    themeToggle: document.getElementById("themeToggle"),
    sidebar: document.getElementById("sidebar"),
    sidebarOverlay: document.getElementById("sidebarOverlay"),
    leaderboardTopCards: document.getElementById("leaderboardTopCards"),
    leaderboardTableBody: document.getElementById("leaderboardTableBody"),
    leaderboardValueHeader: document.getElementById("leaderboardValueHeader"),
    userTableBody: document.getElementById("userTableBody"),
    taskTableBody: document.getElementById("taskTableBody"),
    miniFeed: document.getElementById("miniFeed"),
    fullFeed: document.getElementById("fullFeed"),
    joinAlerts: document.getElementById("joinAlerts"),
    topPointsUser: document.getElementById("topPointsUser"),
    topReferralUser: document.getElementById("topReferralUser"),
    overviewTopUser: document.getElementById("overviewTopUser"),
    overviewTopReferrer: document.getElementById("overviewTopReferrer"),
    overviewSyncStatus: document.getElementById("overviewSyncStatus"),
    systemBanner: document.getElementById("systemBanner"),
    systemBannerTitle: document.getElementById("systemBannerTitle"),
    systemBannerMessage: document.getElementById("systemBannerMessage"),
    systemBannerRetryBtn: document.getElementById("systemBannerRetryBtn")
};

initTheme();
bindStaticEvents();
void bootstrap();

async function bootstrap() {
    updateClock();
    window.setInterval(updateClock, 1000);

    if (!getAdminToken()) {
        showAuthScreen();
        return;
    }

    const dbOnline = await ensureDatabaseOnline();
    if (!dbOnline) {
        showApp({ status: "offline" });
        startRetryLoop();
        return;
    }

    try {
        await refreshAdminData();
        showApp({ status: "live" });
        state.refreshTimer = window.setInterval(() => {
            refreshAdminData().catch(handleBackgroundRefreshError);
        }, 30000);
    } catch (error) {
        if (error?.code === "DB_OFFLINE" || error?.status === 503) {
            state.users = [];
            state.tasks = [];
            state.activity = [];
            state.overview = {};
            renderOverview();
            renderUsers();
            renderTasks();
            renderLeaderboards();
            renderActivity();
            renderJoinAlerts();
            showToast(error.message || "Database is offline. Start MongoDB and reload to sync.", "warning");
            showApp({ status: "offline" });
            startRetryLoop();
            return;
        }

        clearAdminToken();
        showToast(error.message || "Session expired. Please sign in again.", "error");
        showAuthScreen();
    }
}

function bindStaticEvents() {
    document.getElementById("loginForm")?.addEventListener("submit", handleLogin);
    document.getElementById("logoutBtn")?.addEventListener("click", logout);
    document.getElementById("themeToggle")?.addEventListener("click", toggleTheme);
    document.getElementById("mobileToggle")?.addEventListener("click", toggleSidebar);
    refs.sidebarOverlay?.addEventListener("click", closeSidebar);
    refs.systemBannerRetryBtn?.addEventListener("click", () => void retrySync());
    document.getElementById("userSearch")?.addEventListener("input", (event) => {
        state.userSearch = event.target.value || "";
        renderUsers();
    });

    document.querySelectorAll(".nav-item[data-tab]").forEach((button) => {
        button.addEventListener("click", () => switchTab(button.dataset.tab || "overview"));
    });

    document.querySelectorAll("[data-tab-jump]").forEach((button) => {
        button.addEventListener("click", () => switchTab(button.dataset.tabJump || "overview"));
    });

    document.querySelectorAll("#leaderboardMode .segmented-btn").forEach((button) => {
        button.addEventListener("click", () => {
            state.leaderboardMode = button.dataset.mode || "refer";
            document.querySelectorAll("#leaderboardMode .segmented-btn").forEach((item) => item.classList.remove("active"));
            button.classList.add("active");
            renderLeaderboards();
        });
    });

    document.querySelectorAll("#userSortMode .segmented-btn").forEach((button) => {
        button.addEventListener("click", () => {
            state.userSort = button.dataset.sort || "newest";
            document.querySelectorAll("#userSortMode .segmented-btn").forEach((item) => item.classList.remove("active"));
            button.classList.add("active");
            renderUsers();
        });
    });

    document.getElementById("openTaskModalBtn")?.addEventListener("click", () => openModal("taskModal"));
    document.getElementById("openGiftAllBtn")?.addEventListener("click", () => openModal("giftAllModal"));
    document.getElementById("overviewCreateTaskBtn")?.addEventListener("click", () => openModal("taskModal"));
    document.getElementById("overviewGiftAllBtn")?.addEventListener("click", () => openModal("giftAllModal"));
    document.querySelectorAll("[data-close-modal]").forEach((button) => {
        button.addEventListener("click", () => closeModal(button.dataset.closeModal || ""));
    });

    document.getElementById("taskForm")?.addEventListener("submit", handleTaskCreate);
    document.getElementById("giftForm")?.addEventListener("submit", handleGiftUser);
    document.getElementById("giftAllForm")?.addEventListener("submit", handleGiftAll);
    refs.userTableBody?.addEventListener("click", handleUserTableActions);
    refs.taskTableBody?.addEventListener("click", handleTaskTableActions);
}

async function handleLogin(event) {
    event.preventDefault();
    const email = document.getElementById("loginEmail")?.value.trim();
    const password = document.getElementById("loginPassword")?.value;
    const submitBtn = document.querySelector("#loginForm button[type=\"submit\"]");

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Signing in...";
        }

        const data = await requestFirst([
            { path: "/login", method: "POST", body: { email, password } },
            { path: "/auth/login", method: "POST", body: { email, password } }
        ], { auth: false });

        if (!data?.token) {
            throw new Error("Admin token missing in response.");
        }

        setAdminToken(data.token);

        try {
            const dbOnline = await ensureDatabaseOnline();
            if (!dbOnline) {
                state.users = [];
                state.tasks = [];
                state.activity = [];
                state.overview = {};
                renderOverview();
                renderUsers();
                renderTasks();
                renderLeaderboards();
                renderActivity();
                renderJoinAlerts();
                showApp({ status: "offline" });
                showToast("Logged in, but database is offline.", "warning");
                startRetryLoop();
                return;
            }

            await refreshAdminData();
            if (state.refreshTimer) {
                clearInterval(state.refreshTimer);
            }
            state.refreshTimer = window.setInterval(() => {
                refreshAdminData().catch(handleBackgroundRefreshError);
            }, 30000);
            showApp({ status: "live" });
            showToast("Admin console ready.", "success");
            playNotificationSound();
        } catch (refreshError) {
            if (refreshError?.code === "DB_OFFLINE" || refreshError?.status === 503) {
                // Let the admin UI load even when MongoDB is offline, so the user can see the console.
                state.users = [];
                state.tasks = [];
                state.activity = [];
                state.overview = {};
                renderOverview();
                renderUsers();
                renderTasks();
                renderLeaderboards();
                renderActivity();
                renderJoinAlerts();
                showApp({ status: "offline" });
                showToast(refreshError.message || "Logged in, but database is offline.", "warning");
                startRetryLoop();
                return;
            }

            throw refreshError;
        }
    } catch (error) {
        if (error?.code === "DB_OFFLINE" || error?.status === 503) {
            showToast(error.message || "Database is offline. Start MongoDB and retry.", "warning");
            return;
        }

        showToast(error.message || "Invalid admin credentials.", "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Login";
        }
    }
}

async function refreshAdminData() {
    const [overviewPayload, usersPayload, tasksPayload, activityPayload] = await Promise.allSettled([
        requestFirst([
            { path: "/overview", method: "GET" },
            { path: "/stats", method: "GET" }
        ]),
        requestFirst([
            { path: "/users", method: "GET" }
        ]),
        requestFirst([
            { path: "/tasks", method: "GET" }
        ]),
        requestFirst([
            { path: "/activity", method: "GET" }
        ])
    ]);

    const failures = [overviewPayload, usersPayload, tasksPayload, activityPayload]
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);

    const authFailure = failures.find((error) => error?.status === 401 || error?.status === 403);
    if (authFailure) {
        throw authFailure;
    }

    if (failures.length === 4) {
        throw failures[0] || new Error("Admin data could not be loaded.");
    }

    state.overview = overviewPayload.status === "fulfilled" ? overviewPayload.value?.overview || overviewPayload.value || {} : {};
    state.users = usersPayload.status === "fulfilled"
        ? (usersPayload.value?.users || usersPayload.value || []).map(normalizeUserRecord)
        : [];
    state.tasks = tasksPayload.status === "fulfilled"
        ? (tasksPayload.value?.tasks || tasksPayload.value || []).map(normalizeTaskRecord)
        : [];
    state.activity = activityPayload.status === "fulfilled"
        ? normalizeActivityFeed(activityPayload.value?.activity || activityPayload.value || [])
        : [];

    renderOverview();
    renderUsers();
    renderTasks();
    renderLeaderboards();
    renderActivity();
    renderJoinAlerts();
    state.lastSyncAt = Date.now();
    stopRetryLoop();
    setConnectionStatus("live");
    setLiveStatus("live");

    if (!state.refreshTimer) {
        state.refreshTimer = window.setInterval(() => {
            refreshAdminData().catch(handleBackgroundRefreshError);
        }, 30000);
    }
}

function renderOverview() {
    const overview = state.overview;
    const live = state.connectionStatus === "live";
    const computedPoints = state.users.reduce((sum, user) => sum + user.balance, 0);
    const computedTokens = state.users.reduce((sum, user) => sum + toNumber(user.tokens, 0), 0);
    const computedTokensConverted = state.users.reduce((sum, user) => sum + toNumber(user.tokensConverted, 0), 0);
    const computedUsersConverted = state.users.filter((user) => toNumber(user.tokensConverted, 0) > 0).length;
    const activeTasks = state.tasks.filter((task) => task.status === "active").length;
    const recentJoins = state.users.filter((user) => Date.now() - toMillis(user.joinedAt) < 30 * 86_400_000).length;
    const recentReferralJoins = state.users.filter((user) => user.joinType === "referral" && Date.now() - toMillis(user.joinedAt) < 30 * 86_400_000).length;
    const visits24 = state.users.filter((user) => Date.now() - toMillis(user.lastActive) < 86_400_000).length;

    if (live) {
        setStat("statUsers", toNumber(overview.totalUsers, state.users.length));
        setStat("statBalance", toNumber(overview.totalPoints, computedPoints));
        setTokenStat("statTokens", toNumber(overview.totalTokens, computedTokens));
        setTokenStat("statTokensConverted", toNumber(overview.totalTokensConverted, computedTokensConverted));
        setStat("statUsersConverted", toNumber(overview.usersConverted, computedUsersConverted));
        setStat("statTasks", toNumber(overview.activeTasks, activeTasks));
        setStat("statVisits24", toNumber(overview.visits24h, visits24));
        setStat("statJoins30", toNumber(overview.joins30d, recentJoins));
        setStat("statReferralJoins30", toNumber(overview.referralJoins30d, recentReferralJoins));
    } else {
        setStat("statUsers", "—");
        setStat("statBalance", "—");
        setTokenStat("statTokens", "—");
        setTokenStat("statTokensConverted", "—");
        setStat("statUsersConverted", "—");
        setStat("statTasks", "—");
        setStat("statVisits24", "—");
        setStat("statJoins30", "—");
        setStat("statReferralJoins30", "—");
    }

    const topPointsUser = [...state.users].sort((a, b) => b.balance - a.balance)[0];
    const topReferralUser = [...state.users].sort((a, b) => b.totalReferrals - a.totalReferrals)[0];
    if (refs.topPointsUser) refs.topPointsUser.textContent = topPointsUser ? `${topPointsUser.fullName} - ${topPointsUser.balance}` : "-";
    if (refs.topReferralUser) refs.topReferralUser.textContent = topReferralUser ? `${topReferralUser.fullName} - ${topReferralUser.totalReferrals}` : "-";
    if (refs.overviewTopUser) refs.overviewTopUser.textContent = topPointsUser ? topPointsUser.fullName : "-";
    if (refs.overviewTopReferrer) refs.overviewTopReferrer.textContent = topReferralUser ? topReferralUser.fullName : "-";
    if (live && refs.overviewSyncStatus) {
        refs.overviewSyncStatus.textContent = state.activity.length ? "Live data ready" : "Waiting for activity";
    }
}

function renderUsers() {
    if (!refs.userTableBody) return;

    if (state.connectionStatus !== "live") {
        refs.userTableBody.innerHTML = `<tr><td class="table-empty" colspan="10">Database offline. Click Retry to sync once MongoDB is running.</td></tr>`;
        return;
    }

    let users = [...state.users];
    const keyword = state.userSearch.trim().toLowerCase();

    if (keyword) {
        users = users.filter((user) =>
            user.fullName.toLowerCase().includes(keyword) ||
            user.email.toLowerCase().includes(keyword) ||
            user.phone.toLowerCase().includes(keyword)
        );
    }

    users.sort((a, b) => state.userSort === "points"
        ? b.balance - a.balance
        : toMillis(b.joinedAt) - toMillis(a.joinedAt));

    refs.userTableBody.innerHTML = users.length ? users.map((user) => `
        <tr>
            <td data-label="User"><div class="user-title">${escapeHtml(user.fullName)}</div><div class="user-sub">${escapeHtml(user.email)}</div></td>
            <td data-label="Mobile">${escapeHtml(user.phone)}</td>
            <td data-label="Points">${formatNumber(user.balance)}</td>
            <td data-label="Tokens">${formatToken(user.tokens)}</td>
            <td data-label="Tokens Converted">${formatToken(user.tokensConverted)}</td>
            <td data-label="Referrals">${formatNumber(user.totalReferrals)}</td>
            <td data-label="Join Type">${escapeHtml(capitalize(user.joinType))}</td>
            <td data-label="Last Active">${escapeHtml(formatRelativeTime(user.lastActive))}</td>
            <td data-label="Joined">${escapeHtml(formatDateTime(user.joinedAt))}</td>
            <td data-label="Action">
                <div class="actions">
                    <button class="icon-btn" data-user-gift="${user.id}" title="Send Gift"><i class="ri-gift-line"></i></button>
                    <button class="icon-btn delete" data-user-delete="${user.id}" title="Delete User"><i class="ri-delete-bin-line"></i></button>
                </div>
            </td>
        </tr>
    `).join("") : `<tr><td class="table-empty" colspan="10">No users found.</td></tr>`;
}

function renderTasks() {
    if (!refs.taskTableBody) return;

    if (state.connectionStatus !== "live") {
        refs.taskTableBody.innerHTML = `<tr><td class="table-empty" colspan="6">Database offline. Click Retry to sync tasks.</td></tr>`;
        return;
    }

    refs.taskTableBody.innerHTML = state.tasks.length ? state.tasks.map((task) => `
        <tr>
            <td data-label="Title">${escapeHtml(task.title)}</td>
            <td data-label="Type">${escapeHtml(capitalize(task.taskType))}</td>
            <td data-label="Reward">${formatNumber(task.rewardPoints)}</td>
            <td data-label="Status">${escapeHtml(capitalize(task.status))}</td>
            <td data-label="Created">${escapeHtml(formatDateTime(task.createdAt))}</td>
            <td data-label="Action">
                <button class="icon-btn delete" data-task-delete="${task.id}" title="Delete Task"><i class="ri-delete-bin-line"></i></button>
            </td>
        </tr>
    `).join("") : `<tr><td class="table-empty" colspan="6">No tasks available.</td></tr>`;
}

function renderLeaderboards() {
    if (state.connectionStatus !== "live") {
        if (refs.leaderboardTopCards) {
            refs.leaderboardTopCards.innerHTML = `
                <article class="stat-card">
                    <div class="stat-top"><span>Leaderboard</span><i class="ri-cloud-off-line"></i></div>
                    <div class="stat-val">Database offline</div>
                    <p class="user-sub">Retry sync to load rankings.</p>
                </article>
            `;
        }
        if (refs.leaderboardTableBody) {
            refs.leaderboardTableBody.innerHTML = `<tr><td class="table-empty" colspan="4">Database offline. Retry sync.</td></tr>`;
        }
        return;
    }

    const users = [...state.users].sort((a, b) => state.leaderboardMode === "refer"
        ? b.totalReferrals - a.totalReferrals
        : b.balance - a.balance);

    if (refs.leaderboardValueHeader) {
        refs.leaderboardValueHeader.textContent = state.leaderboardMode === "refer" ? "Referrals" : "Points";
    }

    if (refs.leaderboardTopCards) {
        refs.leaderboardTopCards.innerHTML = users.slice(0, 3).map((user, index) => `
            <article class="stat-card">
                <div class="stat-top"><span>#${index + 1}</span><i class="ri-award-line"></i></div>
                <div class="stat-val">${escapeHtml(user.fullName)}</div>
                <p class="user-sub">${state.leaderboardMode === "refer" ? formatNumber(user.totalReferrals) : formatNumber(user.balance)}</p>
            </article>
        `).join("");
    }

    if (refs.leaderboardTableBody) {
        refs.leaderboardTableBody.innerHTML = users.length ? users.map((user, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${escapeHtml(user.fullName)}</td>
                <td>${escapeHtml(user.email)}</td>
                <td>${state.leaderboardMode === "refer" ? formatNumber(user.totalReferrals) : formatNumber(user.balance)}</td>
            </tr>
        `).join("") : `<tr><td class="table-empty" colspan="4">Leaderboard is empty.</td></tr>`;
    }
}

function renderActivity() {
    const items = state.connectionStatus !== "live"
        ? [{ message: "Database offline. Activity will appear once sync is restored.", time: Date.now() }]
        : (state.activity.length ? state.activity : [{ message: "No admin activity yet.", time: Date.now() }]);
    const markup = items.map(renderFeedItem).join("");
    if (refs.miniFeed) refs.miniFeed.innerHTML = markup;
    if (refs.fullFeed) refs.fullFeed.innerHTML = markup;
}

function renderJoinAlerts() {
    if (!refs.joinAlerts) return;
    if (state.connectionStatus !== "live") {
        refs.joinAlerts.innerHTML = `<div class="feed-item"><div class="feed-title">Database offline. Join alerts paused.</div></div>`;
        return;
    }
    const items = [...state.users]
        .sort((a, b) => toMillis(b.joinedAt) - toMillis(a.joinedAt))
        .slice(0, 10)
        .map((user) => ({
            message: `${user.fullName} joined via ${user.joinType === "referral" ? "referral" : "direct signup"}`,
            time: user.joinedAt
        }));

    refs.joinAlerts.innerHTML = items.length ? items.map(renderFeedItem).join("") : `<div class="feed-item"><div class="feed-title">No recent joins.</div></div>`;
}

async function handleTaskCreate(event) {
    event.preventDefault();
    const body = {
        title: document.getElementById("tTitle")?.value.trim(),
        link: document.getElementById("tLink")?.value.trim(),
        description: document.getElementById("tDesc")?.value.trim(),
        rewardPoints: toNumber(document.getElementById("tPoints")?.value, 0),
        taskType: document.getElementById("tType")?.value || "daily",
        notifyUsers: Boolean(document.getElementById("tNotifyUsers")?.checked)
    };

    try {
        await requestFirst([{ path: "/tasks", method: "POST", body }]);
        closeModal("taskModal");
        event.target.reset();
        await refreshAdminData();
        showToast("Task created.", "success");
    } catch (error) {
        showToast(error.message || "Task creation failed.", "error");
    }
}

async function handleGiftUser(event) {
    event.preventDefault();
    const userId = document.getElementById("giftUserId")?.value;
    const title = document.getElementById("giftTitle")?.value.trim();
    const points = toNumber(document.getElementById("giftPoints")?.value, 0);

    try {
        await requestFirst([
            { path: `/users/${userId}/gift`, method: "POST", body: { title, points } },
            { path: "/gift", method: "POST", body: { userId, title, points } }
        ]);
        closeModal("giftModal");
        event.target.reset();
        await refreshAdminData();
        showToast("Gift sent.", "success");
    } catch (error) {
        showToast(error.message || "Gift failed.", "error");
    }
}

async function handleGiftAll(event) {
    event.preventDefault();
    const body = {
        title: document.getElementById("giftAllTitle")?.value.trim(),
        message: document.getElementById("giftAllMsg")?.value.trim(),
        points: toNumber(document.getElementById("giftAllPoints")?.value, 0)
    };

    try {
        await requestFirst([
            { path: "/users/gift-all", method: "POST", body },
            { path: "/gift-all", method: "POST", body }
        ]);
        closeModal("giftAllModal");
        event.target.reset();
        await refreshAdminData();
        showToast("Gift sent to all users.", "success");
    } catch (error) {
        showToast(error.message || "Bulk gift failed.", "error");
    }
}

async function handleUserTableActions(event) {
    const giftButton = event.target.closest("[data-user-gift]");
    const deleteButton = event.target.closest("[data-user-delete]");

    if (giftButton) {
        document.getElementById("giftUserId").value = giftButton.dataset.userGift;
        openModal("giftModal");
        return;
    }

    if (!deleteButton) return;
    if (!window.confirm("Delete this user?")) return;

    try {
        await requestFirst([{ path: `/users/${deleteButton.dataset.userDelete}`, method: "DELETE" }]);
        await refreshAdminData();
        showToast("User deleted.", "warning");
    } catch (error) {
        showToast(error.message || "User delete failed.", "error");
    }
}

async function handleTaskTableActions(event) {
    const deleteButton = event.target.closest("[data-task-delete]");
    if (!deleteButton) return;
    if (!window.confirm("Delete this task?")) return;

    try {
        await requestFirst([{ path: `/tasks/${deleteButton.dataset.taskDelete}`, method: "DELETE" }]);
        await refreshAdminData();
        showToast("Task deleted.", "warning");
    } catch (error) {
        showToast(error.message || "Task delete failed.", "error");
    }
}

function showAuthScreen() {
    refs.authScreen?.classList.remove("hidden");
    refs.appInterface?.classList.add("hidden");
    setLiveStatus("signed_out");
    setConnectionStatus("signed_out");
    stopRetryLoop();
}

function showApp({ status = "live" } = {}) {
    refs.authScreen?.classList.add("hidden");
    refs.appInterface?.classList.remove("hidden");
    switchTab("overview");
    setLiveStatus(status);
    setConnectionStatus(status);
}

function logout() {
    if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
    }
    clearAdminToken();
    showAuthScreen();
}

function setConnectionStatus(status) {
    state.connectionStatus = status === "offline" || status === "signed_out" ? status : "live";
    updateSystemBanner();
    toggleDataActions(state.connectionStatus === "live");
}

async function ensureDatabaseOnline() {
    const health = await fetchBackendHealth({ timeoutMs: 6500 });
    const dbOk = health.ok && String(health.database || "").toLowerCase() === "connected";

    if (!dbOk) {
        setConnectionStatus("offline");
        renderOverview();
        renderUsers();
        renderTasks();
        renderLeaderboards();
        renderActivity();
        renderJoinAlerts();
        return false;
    }

    setConnectionStatus("live");
    return true;
}

function updateSystemBanner() {
    const banner = refs.systemBanner;
    if (!banner) return;

    banner.classList.remove("is-live", "is-signedout");

    if (state.connectionStatus === "live") {
        banner.classList.add("hidden");
        return;
    }

    banner.classList.remove("hidden");

    if (state.connectionStatus === "signed_out") {
        banner.classList.add("is-signedout");
        if (refs.systemBannerTitle) refs.systemBannerTitle.textContent = "Signed out";
        if (refs.systemBannerMessage) refs.systemBannerMessage.textContent = "Please sign in again to access admin tools.";
        if (refs.systemBannerRetryBtn) refs.systemBannerRetryBtn.textContent = "Login";
        return;
    }

    if (refs.systemBannerTitle) refs.systemBannerTitle.textContent = "Database offline";
    if (refs.systemBannerMessage) refs.systemBannerMessage.textContent = "MongoDB is not connected. Start MongoDB / check MONGO_URI. If using Atlas, whitelist your IP in Network Access, then Retry.";
    if (refs.systemBannerRetryBtn) refs.systemBannerRetryBtn.textContent = "Retry";
}

function toggleDataActions(enabled) {
    const selectors = [
        "#openTaskModalBtn",
        "#openGiftAllBtn",
        "#overviewCreateTaskBtn",
        "#overviewGiftAllBtn",
        "#taskForm button[type=\"submit\"]",
        "#giftForm button[type=\"submit\"]",
        "#giftAllForm button[type=\"submit\"]"
    ];

    selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
            if (el instanceof HTMLButtonElement) {
                el.disabled = !enabled;
            }
        });
    });
}

async function retrySync() {
    if (state.connectionStatus === "signed_out") {
        showAuthScreen();
        return;
    }

    try {
        const dbOnline = await ensureDatabaseOnline();
        if (!dbOnline) {
            showToast("Database is still offline.", "warning");
            startRetryLoop();
            return;
        }

        await refreshAdminData();
        showToast("Synced successfully.", "success");
    } catch (error) {
        if (error?.code === "DB_OFFLINE" || error?.status === 503) {
            setConnectionStatus("offline");
            showToast(error.message || "Database is still offline.", "warning");
            startRetryLoop();
            return;
        }

        showToast(error.message || "Sync failed.", "error");
    }
}

function startRetryLoop() {
    if (state.retryTimer) {
        return;
    }

    state.retryTimer = window.setInterval(async () => {
        if (state.connectionStatus !== "offline") {
            stopRetryLoop();
            return;
        }

        try {
            const dbOnline = await ensureDatabaseOnline();
            if (!dbOnline) {
                return;
            }

            await refreshAdminData();
            showToast("Database connected. Synced.", "success");
        } catch (error) {
            // Keep waiting until DB comes back.
        }
    }, 8000);
}

function stopRetryLoop() {
    if (state.retryTimer) {
        clearInterval(state.retryTimer);
        state.retryTimer = null;
    }
}

function handleBackgroundRefreshError(error) {
    if (error?.status === 401 || error?.status === 403) {
        showToast(error.message || "Session expired. Please sign in again.", "error");
        logout();
        return;
    }

    if (error?.code === "DB_OFFLINE" || error?.status === 503) {
        const wasLive = state.connectionStatus === "live";
        setConnectionStatus("offline");

        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
            state.refreshTimer = null;
        }

        if (wasLive) {
            showToast(error.message || "Database went offline. Retrying...", "warning");
        }

        startRetryLoop();
    }
}

function switchTab(tabId) {
    document.querySelectorAll(".section").forEach((section) => {
        section.classList.toggle("active", section.id === tabId);
        section.classList.toggle("hidden", section.id !== tabId);
    });

    document.querySelectorAll(".nav-item[data-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tabId);
    });

    document.querySelectorAll("[data-tab-jump]").forEach((button) => {
        button.classList.toggle("active", button.dataset.tabJump === tabId);
    });

    if (refs.pageTitle) refs.pageTitle.textContent = capitalize(tabId);
    closeSidebar();
}

function openModal(id) {
    document.getElementById(id)?.classList.add("active");
}

function closeModal(id) {
    document.getElementById(id)?.classList.remove("active");
}

function toggleSidebar() {
    refs.sidebar?.classList.toggle("open");
    refs.sidebarOverlay?.classList.toggle("active");
}

function closeSidebar() {
    refs.sidebar?.classList.remove("open");
    refs.sidebarOverlay?.classList.remove("active");
}

function updateClock() {
    if (refs.headerTime) {
        refs.headerTime.textContent = new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
    }
}

function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    refs.toastBox?.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3400);
}

function playNotificationSound() {
    refs.notifSound?.play().catch(() => {});
}

function setLiveStatus(status) {
    if (!refs.liveChip) return;

    refs.liveChip.classList.remove("is-offline", "is-signedout");

    const normalized = typeof status === "string"
        ? status
        : (status ? "live" : "signed_out");

    if (normalized === "offline") {
        refs.liveChip.classList.add("is-offline");
        refs.liveChip.innerHTML = `<i class="ri-cloud-off-line"></i> DB Offline`;
        if (refs.overviewSyncStatus) {
            refs.overviewSyncStatus.textContent = "Database offline";
        }
        return;
    }

    if (normalized === "signed_out") {
        refs.liveChip.classList.add("is-signedout");
        refs.liveChip.innerHTML = `<i class="ri-logout-circle-line"></i> Signed out`;
        if (refs.overviewSyncStatus) {
            refs.overviewSyncStatus.textContent = "Signed out";
        }
        return;
    }

    refs.liveChip.innerHTML = `<i class="ri-radar-line"></i> Synced`;
    if (refs.overviewSyncStatus) {
        refs.overviewSyncStatus.textContent = "Live data ready";
    }
}

function setStat(id, value) {
    const element = document.getElementById(id);
    if (!element) {
        return;
    }

    if (typeof value === "string") {
        element.textContent = value;
        return;
    }

    element.textContent = formatNumber(value);
}

function setTokenStat(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = typeof value === "string" ? value : formatToken(value);
    }
}

function formatNumber(value) {
    return Math.round(toNumber(value, 0)).toLocaleString("en-IN");
}

function formatToken(value) {
    const numeric = toNumber(value, 0);
    return numeric.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function normalizeActivityFeed(items) {
    return (Array.isArray(items) ? items : []).map((item) => ({
        message: item.message || item.title || "Admin activity",
        time: item.time || item.createdAt || item.timestamp || Date.now()
    }));
}

function renderFeedItem(item) {
    return `
        <div class="feed-item">
            <div class="feed-title">${escapeHtml(item.message)}</div>
            <div class="feed-meta">${escapeHtml(formatDateTime(item.time))}</div>
        </div>
    `;
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value === "number") return value > 100_000_000_000 ? value : value * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function initTheme() {
    const saved = localStorage.getItem("anvi_admin_theme") || "dark";
    setTheme(saved);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    setTheme(current === "dark" ? "light" : "dark");
}

function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("anvi_admin_theme", theme);
    if (refs.themeToggle) {
        refs.themeToggle.innerHTML = theme === "dark" ? '<i class="ri-sun-line"></i>' : '<i class="ri-moon-line"></i>';
    }
}
