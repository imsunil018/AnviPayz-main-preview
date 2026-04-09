import {
    requestFirst,
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
    refreshTimer: null
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
    overviewSyncStatus: document.getElementById("overviewSyncStatus")
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

    try {
        await refreshAdminData();
        showApp();
        state.refreshTimer = window.setInterval(refreshAdminData, 30000);
    } catch (error) {
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

    try {
        const data = await requestFirst([
            { path: "/login", method: "POST", body: { email, password } },
            { path: "/auth/login", method: "POST", body: { email, password } }
        ], { auth: false });

        if (!data?.token) {
            throw new Error("Admin token missing in response.");
        }

        setAdminToken(data.token);
        await refreshAdminData();
        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
        }
        state.refreshTimer = window.setInterval(refreshAdminData, 30000);
        showApp();
        showToast("Admin console ready.", "success");
        playNotificationSound();
    } catch (error) {
        showToast(error.message || "Invalid admin credentials.", "error");
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
    setLiveStatus(true);
}

function renderOverview() {
    const overview = state.overview;
    const computedPoints = state.users.reduce((sum, user) => sum + user.balance, 0);
    const computedTokens = state.users.reduce((sum, user) => sum + toNumber(user.tokens, 0), 0);
    const computedTokensConverted = state.users.reduce((sum, user) => sum + toNumber(user.tokensConverted, 0), 0);
    const computedUsersConverted = state.users.filter((user) => toNumber(user.tokensConverted, 0) > 0).length;
    const activeTasks = state.tasks.filter((task) => task.status === "active").length;
    const recentJoins = state.users.filter((user) => Date.now() - toMillis(user.joinedAt) < 30 * 86_400_000).length;
    const recentReferralJoins = state.users.filter((user) => user.joinType === "referral" && Date.now() - toMillis(user.joinedAt) < 30 * 86_400_000).length;
    const visits24 = state.users.filter((user) => Date.now() - toMillis(user.lastActive) < 86_400_000).length;

    setStat("statUsers", toNumber(overview.totalUsers, state.users.length));
    setStat("statBalance", toNumber(overview.totalPoints, computedPoints));
    setTokenStat("statTokens", toNumber(overview.totalTokens, computedTokens));
    setTokenStat("statTokensConverted", toNumber(overview.totalTokensConverted, computedTokensConverted));
    setStat("statUsersConverted", toNumber(overview.usersConverted, computedUsersConverted));
    setStat("statTasks", toNumber(overview.activeTasks, activeTasks));
    setStat("statVisits24", toNumber(overview.visits24h, visits24));
    setStat("statJoins30", toNumber(overview.joins30d, recentJoins));
    setStat("statReferralJoins30", toNumber(overview.referralJoins30d, recentReferralJoins));

    const topPointsUser = [...state.users].sort((a, b) => b.balance - a.balance)[0];
    const topReferralUser = [...state.users].sort((a, b) => b.totalReferrals - a.totalReferrals)[0];
    if (refs.topPointsUser) refs.topPointsUser.textContent = topPointsUser ? `${topPointsUser.fullName} - ${topPointsUser.balance}` : "-";
    if (refs.topReferralUser) refs.topReferralUser.textContent = topReferralUser ? `${topReferralUser.fullName} - ${topReferralUser.totalReferrals}` : "-";
    if (refs.overviewTopUser) refs.overviewTopUser.textContent = topPointsUser ? topPointsUser.fullName : "-";
    if (refs.overviewTopReferrer) refs.overviewTopReferrer.textContent = topReferralUser ? topReferralUser.fullName : "-";
    if (refs.overviewSyncStatus) refs.overviewSyncStatus.textContent = state.activity.length ? "Live data ready" : "Waiting for activity";
}

function renderUsers() {
    if (!refs.userTableBody) return;

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
    const items = state.activity.length ? state.activity : [{ message: "No admin activity yet.", time: Date.now() }];
    const markup = items.map(renderFeedItem).join("");
    if (refs.miniFeed) refs.miniFeed.innerHTML = markup;
    if (refs.fullFeed) refs.fullFeed.innerHTML = markup;
}

function renderJoinAlerts() {
    if (!refs.joinAlerts) return;
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
    setLiveStatus(false);
}

function showApp() {
    refs.authScreen?.classList.add("hidden");
    refs.appInterface?.classList.remove("hidden");
    switchTab("overview");
    setLiveStatus(true);
}

function logout() {
    if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
    }
    clearAdminToken();
    showAuthScreen();
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

function setLiveStatus(isLive) {
    if (!refs.liveChip) return;
    refs.liveChip.innerHTML = isLive ? `<i class="ri-radar-line"></i> Synced` : `<i class="ri-close-circle-line"></i> Signed out`;
    if (refs.overviewSyncStatus) {
        refs.overviewSyncStatus.textContent = isLive ? "Live data ready" : "Signed out";
    }
}

function setStat(id, value) {
    document.getElementById(id).textContent = formatNumber(value);
}

function setTokenStat(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = formatToken(value);
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
