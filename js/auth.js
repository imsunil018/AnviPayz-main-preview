const APP_VERSION = "2026-03-30-production";

// API Base URL - configured via config.js (or local override in localStorage)
const storedApiBase = (localStorage.getItem("anvi-api-base") || "").trim();
const isLocalDev = window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.host.includes("localhost") ||
    window.location.host.includes("127.0.0.1");

function normalizeApiBase(value) {
    return String(value || "")
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/api$/, "");
}

const API_BASE = normalizeApiBase(window.API_BASE || storedApiBase || (isLocalDev ? "http://127.0.0.1:5050" : "https://anvipayz-main-preview-1.onrender.com"));
const API_PREFIX = "/api";

const INDIA_TIME_ZONE = "Asia/Kolkata";
const inflightRequests = new Map();
let appInitPromise = null;
let deleteAccountFlowResolver = null;
let deleteAccountFlowStep = 0;
let accountRestoreContext = null;

const STORAGE_KEYS = {
    token: "anvi-token",
    user: "anvi-user",
    notifications: "anvi-local-notifications",
    activity: "anvi-local-activity",
    tasks: "anvi-local-task-state",
    watchState: "anvi-local-watch-state",
    referralSeenCount: "anvi-referral-seen-count",
    activeUser: "anvi-active-user"
};

const PUBLIC_PAGES = new Set(["index.html", "login.html", "forgot.html", "reset-password.html", "legal.html"]);
const DEFAULT_ADMIN_TASKS = [];
const SPIN_REWARDS = [5, 10, 15, 20, 25, 40, 60, 100];
const SECURITY_ACTIVITY_KEY = "anvi-last-activity";
const INACTIVITY_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_ACCOUNT_FLOW_STEPS = [
    {
        badge: "Step 1 of 3",
        title: "Schedule account deletion?",
        message: "Your account will be signed out right away and marked for deletion on this device.",
        points: [
            "You will lose access to your current session.",
            "You can still restore the same account within the next 7 days."
        ],
        confirmLabel: "Continue"
    },
    {
        badge: "Step 2 of 3",
        title: "Recovery stays open for 7 days",
        message: "Your rewards and account data stay paused during the recovery window, then the account is removed permanently.",
        points: [
            "Login again within 7 days if you want to restore everything.",
            "After the deadline, coins, tokens, and history will be deleted permanently."
        ],
        confirmLabel: "I Understand"
    },
    {
        badge: "Final Step",
        title: "Final confirmation",
        message: "Please confirm one last time to schedule permanent deletion after the 7-day recovery period.",
        points: [
            "You can recover by logging in again before the deadline.",
            "If you do nothing for 7 days, deletion will happen permanently."
        ],
        confirmLabel: "Schedule Deletion",
        acknowledgement: "I understand permanent deletion will happen automatically after 7 days."
    }
];

const state = {
    page: currentPage(),
    user: null, // Always fetch from API, not localStorage
    token: localStorage.getItem(STORAGE_KEYS.token) || "",
    notifications: normalizeNotifications(readStore(STORAGE_KEYS.notifications, [])),
    activity: normalizeActivity(readStore(STORAGE_KEYS.activity, [])),
    spinning: false,
    wheelRotation: 0,
    watchTimer: null
};

const MOBILE_NAV_META = {
    "home.html": { href: "home.html", label: "Dashboard", icon: "ri-home-5-line" },
    "wallet.html": { href: "wallet.html", label: "Wallet", icon: "ri-wallet-line" },
    "tasks.html": { href: "tasks.html", label: "Tasks", icon: "ri-task-line" },
    "recharge.html": { href: "recharge.html", label: "Recharge", icon: "ri-flashlight-fill" },
    "refer.html": { href: "refer.html", label: "Refer", icon: "ri-share-forward-line" },
    "notifications.html": { href: "notifications.html", label: "Alerts", icon: "ri-notification-3-line" },
    "profile.html": { href: "profile.html", label: "Profile", icon: "ri-user-line" },
    "support.html": { href: "support.html", label: "Support", icon: "ri-customer-service-2-line" },
    "spin.html": { href: "spin.html", label: "Spin", icon: "ri-refresh-line" }
};

const defaultTasks = [
    {
        id: "daily-checkin",
        title: "Daily Check-in",
        description: "Open the app once a day to keep your streak active.",
        rewardPoints: 10,
        buttonLabel: "Claim",
        category: "daily",
        style: "success"
    },
    {
        id: "watch-tutorial",
        title: "Watch Tutorial",
        description: "Watch the guided tutorial for 10 seconds.",
        rewardPoints: 15,
        buttonLabel: "Start",
        category: "video",
        style: "warning"
    }
];

document.addEventListener("DOMContentLoaded", () => {
    // Debug: Show API config on load
    console.log("🔧 API_BASE:", API_BASE);
    console.log("🔧 Is Local Dev:", isLocalDev);
    console.log("🔧 Location:", window.location.host);

    if (!appInitPromise) {
        appInitPromise = initApp().finally(() => {
            appInitPromise = null;
        });
    }
});

window.logout = logout;

async function initApp() {
    console.info("[AnviPayz]", APP_VERSION, state.page);

    enforceAutoLogout();
    bindActivityListeners();
    ensureUiShell();
    syncActiveNav();
    bindNetworkIndicators();
    bindThemeToggles();

    if (state.page === "legal.html") {
        return;
    }

    if (!PUBLIC_PAGES.has(state.page) && !state.token) {
        redirectToLogin();
        return;
    }

    if (state.page === "index.html" || state.page === "login.html" || state.page === "forgot.html" || state.page === "reset-password.html") {
        if (state.token && (state.page === "index.html" || state.page === "login.html")) {
            window.location.replace("home.html");
            return;
        }

        initAuthPages();
        return;
    }

    initShellInteractions();
    await hydrateUser();
    renderCommonUserState();

    switch (state.page) {
        case "home.html":
            await initHomePage();
            break;
        case "tasks.html":
            await initTasksPage();
            break;
        case "wallet.html":
            await initWalletPage();
            break;
        case "refer.html":
            await initReferPage();
            break;
        case "recharge.html":
            await initRechargePage();
            break;
        case "notifications.html":
            await initNotificationsPage();
            break;
        case "spin.html":
            await initSpinPage();
            break;
        case "profile.html":
            await initProfilePage();
            break;
        case "support.html":
            initSupportPage();
            break;
        default:
            break;
    }
}

function currentPage() {
    const raw = window.location.pathname.split("/").pop() || "index.html";
    return raw.toLowerCase();
}

function ensureUiShell() {
    if (!document.querySelector(".app-toast-stack")) {
        const toastStack = document.createElement("div");
        toastStack.className = "app-toast-stack";
        document.body.appendChild(toastStack);
    }

    if (!document.querySelector(".page-loading-bar")) {
        const bar = document.createElement("div");
        bar.className = "page-loading-bar";
        document.body.appendChild(bar);
    }

    if (!document.querySelector(".network-status")) {
        const banner = document.createElement("div");
        banner.className = "network-status";
        banner.setAttribute("role", "status");
        banner.setAttribute("aria-live", "polite");
        banner.innerHTML = `
            <span class="network-status__dot"></span>
            <span class="network-status__text">Checking connection...</span>
        `;
        document.body.appendChild(banner);
    }

    if (!document.querySelector(".reward-modal")) {
        const modal = document.createElement("div");
        modal.className = "reward-modal";
        modal.hidden = true;
        modal.innerHTML = `
            <div class="reward-card">
                <div class="reward-icon" id="reward-icon">🎉</div>
                <h3 id="reward-title">Reward unlocked</h3>
                <p id="reward-message">Your action completed successfully.</p>
                <div class="reward-value" id="reward-value">0 Points</div>
                <div class="reward-actions">
                    <button type="button" class="btn-primary" id="reward-close-btn">Continue</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener("click", (event) => {
            if (event.target === modal) {
                hideRewardPopup();
            }
        });

        document.getElementById("reward-close-btn")?.addEventListener("click", hideRewardPopup);
    }

    if (!document.querySelector(".danger-confirm-modal")) {
        const modal = document.createElement("div");
        modal.className = "danger-confirm-modal";
        modal.hidden = true;
        modal.innerHTML = `
            <div class="danger-confirm-card" role="dialog" aria-modal="true" aria-labelledby="danger-confirm-title" aria-describedby="danger-confirm-message">
                <button type="button" class="danger-confirm-close" id="danger-confirm-close" aria-label="Close delete account confirmation">
                    <i class="ri-close-line"></i>
                </button>
                <div class="danger-confirm-badge" id="danger-confirm-badge">Step 1 of 3</div>
                <h3 id="danger-confirm-title">Delete your account?</h3>
                <p id="danger-confirm-message">This action needs multiple confirmations for your safety.</p>
                <div class="danger-confirm-points" id="danger-confirm-points"></div>
                <label class="danger-confirm-ack" id="danger-confirm-ack-wrap" hidden>
                    <input type="checkbox" id="danger-confirm-ack">
                    <span id="danger-confirm-ack-label">I understand this action cannot be undone.</span>
                </label>
                <div class="danger-confirm-progress" id="danger-confirm-progress" aria-hidden="true"></div>
                <div class="danger-confirm-actions">
                    <button type="button" class="danger-confirm-secondary" id="danger-confirm-cancel">Keep Account</button>
                    <button type="button" class="btn-danger danger-confirm-primary" id="danger-confirm-confirm">Continue</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener("click", (event) => {
            if (event.target === modal) {
                closeDeleteAccountFlow(false);
            }
        });

        document.getElementById("danger-confirm-close")?.addEventListener("click", () => {
            closeDeleteAccountFlow(false);
        });

        document.getElementById("danger-confirm-cancel")?.addEventListener("click", () => {
            closeDeleteAccountFlow(false);
        });

        document.getElementById("danger-confirm-confirm")?.addEventListener("click", () => {
            advanceDeleteAccountFlow();
        });

        document.getElementById("danger-confirm-ack")?.addEventListener("change", syncDeleteAccountConfirmButton);

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !document.querySelector(".danger-confirm-modal")?.hidden) {
                closeDeleteAccountFlow(false);
            }

            if (event.key === "Escape" && !document.querySelector(".account-recovery-modal")?.hidden) {
                hideAccountRecoveryModal();
            }
        });
    }

    if (!document.querySelector(".account-recovery-modal")) {
        const modal = document.createElement("div");
        modal.className = "account-recovery-modal";
        modal.hidden = true;
        modal.innerHTML = `
            <div class="account-recovery-card" role="dialog" aria-modal="true" aria-labelledby="account-recovery-title" aria-describedby="account-recovery-message">
                <button type="button" class="account-recovery-close" id="account-recovery-close" aria-label="Close account recovery dialog">
                    <i class="ri-close-line"></i>
                </button>
                <div class="account-recovery-badge">Recovery Available</div>
                <h3 id="account-recovery-title">Restore your account?</h3>
                <p id="account-recovery-message">This account is scheduled for permanent deletion, but you can still bring it back before the deadline.</p>
                <div class="account-recovery-summary">
                    <div class="account-recovery-row">
                        <span>Email</span>
                        <strong id="account-recovery-email">-</strong>
                    </div>
                    <div class="account-recovery-row">
                        <span>Permanent deletion on</span>
                        <strong id="account-recovery-deadline">-</strong>
                    </div>
                </div>
                <div class="account-recovery-note" id="account-recovery-note">Restore now to keep your rewards, balance, and activity history.</div>
                <div class="account-recovery-actions">
                    <button type="button" class="account-recovery-secondary" id="account-recovery-later">Not Now</button>
                    <button type="button" class="btn-primary account-recovery-primary" id="account-recovery-confirm">Restore Account</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener("click", (event) => {
            if (event.target === modal) {
                hideAccountRecoveryModal();
            }
        });

        document.getElementById("account-recovery-close")?.addEventListener("click", hideAccountRecoveryModal);
        document.getElementById("account-recovery-later")?.addEventListener("click", hideAccountRecoveryModal);
        document.getElementById("account-recovery-confirm")?.addEventListener("click", () => {
            void restoreScheduledAccount();
        });
    }

    ensureNavBadgeStyles();
    ensureSidebarUnreadBadge();
    updateSidebarUnreadBadge();
}

function ensureNavBadgeStyles() {
    if (document.getElementById("nav-badge-style")) {
        return;
    }
    const style = document.createElement("style");
    style.id = "nav-badge-style";
    style.textContent = `
        .nav-badge {
            margin-left: auto;
            padding: 0.2rem 0.55rem;
            border-radius: 999px;
            background: rgba(239, 68, 68, 0.16);
            color: var(--danger);
            font-size: 0.7rem;
            font-weight: 800;
            letter-spacing: 0.04em;
        }
    `;
    document.head.appendChild(style);
}

function ensureSidebarUnreadBadge() {
    const navLink = document.querySelector(".nav-links a[href='notifications.html']");
    if (!navLink) {
        return;
    }

    if (!navLink.querySelector(".nav-badge")) {
        const badge = document.createElement("span");
        badge.id = "sidebar-unread-badge";
        badge.className = "nav-badge";
        badge.hidden = true;
        badge.textContent = "0";
        navLink.appendChild(badge);
    }
}

function updateSidebarUnreadBadge(countOverride) {
    const badge = document.getElementById("sidebar-unread-badge") || document.querySelector(".nav-badge");
    if (!badge) {
        return;
    }

    const count = typeof countOverride === "number"
        ? countOverride
        : state.notifications.filter((item) => item.unread).length;

    if (count > 0) {
        badge.textContent = count > 99 ? "99+" : formatNumber(count);
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

function showHomeUnreadBannerOnce() {
    if (state.page !== "home.html") {
        return;
    }

    if (!window.matchMedia("(max-width: 900px)").matches) {
        return;
    }

    const banner = document.getElementById("mobile-home-unread-banner");
    const countEl = document.getElementById("mobile-home-unread-count");
    if (!banner || !countEl) {
        return;
    }

    const unread = state.notifications.filter((item) => item.unread).length;
    if (unread <= 0) {
        banner.hidden = true;
        return;
    }

    const seenKey = "anvi-home-unread-banner-seen";
    if (sessionStorage.getItem(seenKey) === "1") {
        return;
    }

    countEl.textContent = unread > 99 ? "99+" : formatNumber(unread);
    banner.hidden = false;
    sessionStorage.setItem(seenKey, "1");

    window.setTimeout(() => {
        banner.hidden = true;
    }, 1800);
}

function bindThemeToggles() {
    document.querySelectorAll("#theme-toggle, .mobile-theme-toggle, #themeBtn").forEach((button) => {
        button.addEventListener("click", toggleTheme);
    });
}

function initShellInteractions() {
    const overlay = document.querySelector(".overlay");
    const sidebar = document.querySelector(".sidebar");
    const menuButton = document.getElementById("menu-btn");

    menuButton?.addEventListener("click", () => {
        sidebar?.classList.toggle("open");
        overlay?.classList.toggle("active");
        document.body.classList.toggle("drawer-open", sidebar?.classList.contains("open"));
    });

    overlay?.addEventListener("click", () => {
        sidebar?.classList.remove("open");
        overlay.classList.remove("active");
        document.body.classList.remove("drawer-open");
    });

    document.querySelectorAll(".nav-footer a[href='index.html']").forEach((anchor) => {
        anchor.addEventListener("click", (event) => {
            event.preventDefault();
            logout();
        });
    });
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
    const nextTheme = currentTheme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", nextTheme);
    localStorage.setItem("anvi-theme", nextTheme);
}

function initAuthPages() {
    // OTP state tracking
    let otpState = {
        loginEmail: "",
        registerData: {}
    };

    // Get form and button elements
    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");
    const loginSendOtpBtn = document.getElementById("login-send-otp-btn");
    const loginVerifyOtpBtn = document.getElementById("login-verify-otp-btn");
    const loginResendLink = document.getElementById("login-resend-otp-link");
    const loginOtpSection = document.getElementById("login-otp-section");
    const loginOtpInput = document.getElementById("login-otp-input");
    const registerSendOtpBtn = document.getElementById("register-send-otp-btn");
    const registerVerifyOtpBtn = document.getElementById("register-verify-otp-btn");
    const registerResendLink = document.getElementById("register-resend-otp-link");
    const registerOtpSection = document.getElementById("register-otp-section");
    const registerOtpInput = document.getElementById("register-otp-input");

    const urlParams = new URLSearchParams(window.location.search);
    const referralParam = urlParams.get("ref");
    const viewParam = urlParams.get("view");

    if (referralParam && document.getElementById("register-refer")) {
        document.getElementById("register-refer").value = referralParam;
    }

    if (viewParam === "register" && typeof window.switchView === "function") {
        window.switchView("register");
    }

    const moveToLoginForRecovery = (email) => {
        if (typeof window.switchView === "function") {
            window.switchView("login");
        }

        const loginEmailInput = document.getElementById("login-email");
        if (loginEmailInput && email) {
            loginEmailInput.value = email;
        }

        if (email) {
            otpState.loginEmail = email;
        }
    };

    // ============ LOGIN OTP FLOW ============
    loginSendOtpBtn?.addEventListener("click", async () => {
        const email = document.getElementById("login-email")?.value.trim();
        if (!isValidEmail(email)) {
            showToast("Enter a valid email address.", "error");
            return;
        }

        otpState.loginEmail = email;

        await withButtonState(loginSendOtpBtn, "Sending OTP...", async () => {
            try {
                await requestJson("/send-otp", {
                    method: "POST",
                    body: { email },
                    auth: false
                });
                showToast("OTP sent to your email.", "success");
                loginOtpSection.style.display = "block";
                loginOtpInput.focus();
                startResendTimer(loginResendLink);
            } catch (error) {
                if (error.code === "ACCOUNT_PENDING_DELETION") {
                    moveToLoginForRecovery(email);
                }
                showToast(error.message || "Failed to send OTP.", "error");
            }
        });
    });

    loginVerifyOtpBtn?.addEventListener("click", async () => {
        const otp = loginOtpInput?.value.trim();
        const email = otpState.loginEmail;

        if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
            showToast("Enter a valid 6-digit OTP.", "error");
            return;
        }

        await withButtonState(loginVerifyOtpBtn, "Verifying...", async () => {
            try {
                const data = await requestJson("/verify-otp", {
                    method: "POST",
                    body: { email, otp },
                    auth: false
                });

                if (data?.restoreRequired) {
                    showAccountRecoveryModal(data);
                    loginOtpInput.value = "";
                    return;
                }

                if (data?.token) {
                    localStorage.setItem(STORAGE_KEYS.token, data.token);
                    state.token = data.token;
                }

                state.user = normalizeUser(data?.user || data);
                persistUser(state.user);

                showToast("Login successful!", "success");

                if (data.welcomeReward) {
                    playRewardSound();
                    showRewardPopup({
                        icon: "🎉",
                        title: "Login Reward!",
                        message: data.welcomeReward.message,
                        value: `${data.welcomeReward.points} Points`
                    });
                } else {
                    showToast("Welcome back!", "success");
                }

                setTimeout(() => {
                    window.location.replace("home.html");
                }, 900);
            } catch (error) {
                showToast(error.message || "OTP verification failed.", "error");
                loginOtpInput.value = "";
                loginOtpInput.focus();
            }
        });
    });

    loginResendLink?.addEventListener("click", async (e) => {
        e.preventDefault();
        const email = otpState.loginEmail;
        if (!email) {
            showToast("Please enter email first.", "error");
            return;
        }

        try {
            await requestJson("/send-otp", {
                method: "POST",
                body: { email },
                auth: false
            });
            showToast("OTP resent to your email.", "success");
            loginOtpInput.value = "";
            loginOtpInput.focus();
            startResendTimer(loginResendLink);
        } catch (error) {
            showToast(error.message || "Failed to resend OTP.", "error");
        }
    });

    // ============ REGISTER OTP FLOW ============
    // ============================================
    // SMART REFERRAL CODE HANDLER
    // ============================================
    function validateReferralCode(code) {
        if (!code) return { valid: true, code: null };

        // Remove spaces and convert to uppercase
        const normalized = String(code || '').trim().toUpperCase();

        // Check format: Should be 7-12 characters (e.g., BABUL1234)
        if (!/^[A-Z0-9]{7,12}$/.test(normalized)) {
            return {
                valid: false,
                error: "Invalid code format. Use format like: BABUL1234"
            };
        }

        return { valid: true, code: normalized };
    }

    function populateReferralCodeFromURL() {
        try {
            const params = new URLSearchParams(window.location.search);
            const refParam = params.get('ref');

            if (refParam && document.getElementById('register-refer')) {
                const validation = validateReferralCode(refParam);
                if (validation.valid) {
                    document.getElementById('register-refer').value = validation.code || '';
                    console.log('✅ Referral code pre-populated:', validation.code);
                } else {
                    console.warn('⚠️ Invalid referral code in URL:', refParam);
                }
            }
        } catch (error) {
            console.error('Error populating referral code:', error);
        }
    }

    // Call on page load
    document.addEventListener('DOMContentLoaded', populateReferralCodeFromURL);

    // ============================================
    // REGISTER FORM HANDLERS
    // ============================================
    registerSendOtpBtn?.addEventListener("click", async () => {
        const name = document.getElementById("register-name")?.value.trim();
        const email = document.getElementById("register-email")?.value.trim();
        const referCodeRaw = document.getElementById("register-refer")?.value.trim();
        const acceptedTerms = Boolean(document.getElementById("register-terms")?.checked);

        // Validate name and email
        if (!name || !isValidEmail(email)) {
            showToast("Enter your name and a valid email address.", "error");
            return;
        }

        if (!acceptedTerms) {
            showToast("Please accept the Terms & Conditions to continue.", "error");
            return;
        }

        // Validate and normalize referral code
        const referCodeValidation = validateReferralCode(referCodeRaw);
        if (!referCodeValidation.valid) {
            showToast(referCodeValidation.error || "Invalid referral code.", "error");
            return;
        }

        const referCode = referCodeValidation.code; // Normalized code or null

        // Store in state for verification phase
        otpState.registerData = {
            name,
            email,
            referCode: referCode || null,
            acceptedTerms
        };

        await withButtonState(registerSendOtpBtn, "Sending OTP...", async () => {
            try {
                // ✅ NOW SENDING referCode in send-otp request
                await requestJson("/register-send-otp", {
                    method: "POST",
                    body: {
                        email,
                        name,
                        acceptedTerms,
                        referCode: referCode || undefined  // Send if exists
                    },
                    auth: false
                });
                showToast("OTP sent to your email.", "success");
                registerOtpSection.style.display = "block";
                registerOtpInput.focus();
                startResendTimer(registerResendLink);
                console.log('✅ OTP sent with referCode:', referCode || '(none)');
            } catch (error) {
                showToast(error.message || "Failed to send OTP.", "error");
                console.error('❌ OTP send error:', error);
            }
        });
    });

    registerVerifyOtpBtn?.addEventListener("click", async () => {
        const otp = registerOtpInput?.value.trim();
        const { name, email, referCode, acceptedTerms } = otpState.registerData;

        if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
            showToast("Enter a valid 6-digit OTP.", "error");
            return;
        }

        await withButtonState(registerVerifyOtpBtn, "Creating account...", async () => {
            try {
                const response = await requestJson("/register-verify-otp", {
                    method: "POST",
                    body: {
                        email,
                        otp,
                        name,
                        referCode: referCode || undefined,
                        acceptedTerms
                    },
                    auth: false
                });

                const data = response;

                if (data?.token) {
                    localStorage.setItem(STORAGE_KEYS.token, data.token);
                    state.token = data.token;
                }

                state.user = normalizeUser(data?.user || data);
                persistUser(state.user);

                showToast("Account created successfully!", "success");
                playRewardSound();

                // Calculate total reward (welcome + referral bonus)
                const welcomeReward = numberFrom(data?.welcomeReward?.points, 0);
                const referralReward = numberFrom(data?.referralReward?.points, 0);
                const referrerName = String(data?.referralReward?.referrerName || "").trim();
                const totalSignupReward = welcomeReward + referralReward;

                // Build reward message
                let rewardMessage = "You've earned a welcome reward for joining AnviPayz!";
                if (referCode && referralReward > 0) {
                    rewardMessage = `You earned ${welcomeReward} welcome points + ${referralReward} referral bonus! Total: ${totalSignupReward} points`;
                    if (referrerName) {
                        rewardMessage = `${rewardMessage} Referred by ${referrerName}.`;
                    }
                }

                showRewardPopup({
                    icon: "🎉",
                    title: "Welcome to AnviPayz!",
                    message: rewardMessage,
                    value: `${formatNumber(totalSignupReward || state.user?.points || 0)} Points`
                });

                console.log('✅ Account created successfully');
                console.log('   Welcome reward:', welcomeReward);
                console.log('   Referral reward:', referralReward);
                console.log('   Referral code used:', referCode || 'none');

                setTimeout(() => {
                    window.location.replace("home.html");
                }, 900);
            } catch (error) {
                if (error.code === "ACCOUNT_PENDING_DELETION") {
                    moveToLoginForRecovery(email);
                }
                showToast(error.message || "OTP verification failed.", "error");
                console.error('❌ Verification error:', error);
                registerOtpInput.value = "";
                registerOtpInput.focus();
            }
        });
    });

    registerResendLink?.addEventListener("click", async (e) => {
        e.preventDefault();
        const { email, name, acceptedTerms } = otpState.registerData;
        if (!email) {
            showToast("Please enter email first.", "error");
            return;
        }

        try {
            await requestJson("/register-send-otp", {
                method: "POST",
                body: { email, name, acceptedTerms },
                auth: false
            });
            showToast("OTP resent to your email.", "success");
            registerOtpInput.value = "";
            registerOtpInput.focus();
            startResendTimer(registerResendLink);
        } catch (error) {
            if (error.code === "ACCOUNT_PENDING_DELETION") {
                moveToLoginForRecovery(email);
            }
            showToast(error.message || "Failed to resend OTP.", "error");
        }
    });

    loginForm?.addEventListener("submit", (event) => event.preventDefault());
    registerForm?.addEventListener("submit", (event) => event.preventDefault());
}

function startResendTimer(linkElement) {
    if (!linkElement) return;

    let seconds = 30;
    const originalText = "Resend OTP";
    linkElement.style.pointerEvents = "none";
    linkElement.style.opacity = "0.5";
    linkElement.classList.add('timer-active');

    const interval = setInterval(() => {
        seconds--;
        linkElement.textContent = `Resend in ${seconds}s`;

        if (seconds <= 0) {
            clearInterval(interval);
            linkElement.style.pointerEvents = "auto";
            linkElement.style.opacity = "1";
            linkElement.textContent = originalText;
            linkElement.classList.remove('timer-active');
        }
    }, 1000);
}

async function verifyEmailToken(token) {
    try {
        showToast("Verifying your email link...", "warning");
        const data = await requestJson("/verify", {
            method: "POST",
            body: { token },
            auth: false
        });

        if (data?.token) {
            localStorage.setItem(STORAGE_KEYS.token, data.token);
            state.token = data.token;
        }

        state.user = normalizeUser(data?.user || data);
        persistUser(state.user);
        showRewardPopup({
            icon: "🎉",
            title: "Welcome to AnviPayz",
            message: "Your email is verified and your rewards account is ready.",
            value: `${formatNumber(state.user.points)} Points`
        });

        setTimeout(() => {
            window.location.replace("home.html");
        }, 900);
    } catch (error) {
        showToast(error.message || "This sign-in link is invalid or expired.", "error");
    }
}

async function hydrateUser() {
    try {
        const data = await requestJson("/me", { auth: true });

        state.user = normalizeUser(data?.user || data);
        persistUser(state.user);
    } catch (error) {
        try {
            const fallback = await requestFirst([
                { path: "/dashboard", method: "GET" },
                { path: "/user/dashboard", method: "GET" }
            ], { auth: true });

            if (fallback?.user) {
                state.user = normalizeUser(fallback.user);
                persistUser(state.user);
                return;
            }
        } catch (fallbackError) {
            // Ignore and continue with the original error handling.
        }

        if (error.status === 401) {
            logout();
            return;
        }

        if (error.status === 423 || error.code === "ACCOUNT_PENDING_DELETION") {
            logout();
            return;
        }

        if (!state.user) {
            showToast("We could not load your session right now.", "error");
            redirectToLogin();
        }
    }
}

function renderCommonUserState() {
    if (!state.user) {
        return;
    }

    setAllText("header-token-count", formatDecimal(state.user.tokens));
    setAllText("mobile-token-count", formatDecimal(state.user.tokens));
    setAllText("wallet-token-count", formatDecimal(state.user.tokens));
    setText("home-hero-token-count", formatDecimal(state.user.tokens));
    setText("home-hero-token-inline", formatDecimal(state.user.tokens));
    setText("user-name", firstName(state.user.name));
    setText("wallet-balance", formatNumber(state.user.points));
    setText("user-balance", formatNumber(state.user.points));
    setText("profile-title", state.user.name || "AnviPayz Member");
    setText("profile-subtitle", state.user.email || "Rewards account");
    setText("profile-name", state.user.name || "-");
    setText("profile-email", state.user.email || "-");
    setText("profile-phone", state.user.phone || "Not added yet");
    setText("profile-joined", formatLongDate(state.user.joinedAt));
    setText("profile-referral-code", state.user.referralCode || "-");
    setText("profile-points", formatNumber(state.user.points));
    setText("profile-tokens", formatDecimal(state.user.tokens));
    setText("profile-summary-email", state.user.email || "-");
    setText("profile-summary-joined", formatLongDate(state.user.joinedAt));
    setText("profile-referral-inline-secondary", state.user.referralCode || "-");

    const avatar = document.getElementById("profile-avatar");
    if (avatar) {
        avatar.textContent = initialsFromName(state.user.name || "A");
        avatar.style.background = "linear-gradient(135deg, #6366f1, #22c55e)";
    }

    document.querySelectorAll("#token-available-pill").forEach((pill) => {
        pill.textContent = `${formatDecimal(state.user.tokens)} Tokens`;
    });
}

async function initHomePage() {
    showHomeUnreadBannerOnce();
    const dashboard = await fetchDashboardPayload();
    const stats = dashboard.stats;

    setText("refer-income", formatNumber(stats.referralEarnings || 0));
    setText("task-income", formatNumber(stats.taskRewards || 0));
    setText("survey-income", formatNumber(stats.surveyEarnings || 0));
    setText("user-balance", formatNumber(stats.points));

    const latestHistory = (dashboard.history || []).slice(0, 7);
    renderHistoryList(
        document.getElementById("recent-history"),
        latestHistory,
        "No recent wallet activity yet."
    );

    const [tasksResult, referralResult] = await Promise.allSettled([
        fetchTasksPayload(),
        fetchReferralPayload()
    ]);

    const tasks = tasksResult.status === "fulfilled" ? tasksResult.value : [];
    const referral = referralResult.status === "fulfilled" ? referralResult.value : null;
    updateHomeSmartCard({ tasks, referral });
}

function syncActiveNav() {
    const page = currentPage();
    ensureMobileNavCurrent(page);
    document.querySelectorAll(".mobile-nav-item, .nav-item").forEach((link) => {
        const href = link.getAttribute("href") || "";
        if (!href) {
            return;
        }
        const target = href.split("#")[0].split("/").pop()?.toLowerCase();
        if (!target) {
            return;
        }
        link.classList.toggle("active", target === page);
    });
}

function navPageFromHref(href) {
    if (!href) {
        return "";
    }
    const clean = href.split("#")[0].split("?")[0];
    return clean.split("/").pop()?.toLowerCase() || "";
}

function ensureMobileNavCurrent(page) {
    const nav = document.querySelector(".mobile-nav");
    if (!nav) {
        return;
    }

    const items = Array.from(nav.querySelectorAll(".mobile-nav-item"));
    if (!items.length) {
        return;
    }

    const exists = items.some((item) => navPageFromHref(item.getAttribute("href")) === page);
    if (exists) {
        return;
    }

    const meta = MOBILE_NAV_META[page];
    if (!meta) {
        return;
    }

    const replacement = pickMobileNavReplacement(items);
    const newLink = document.createElement("a");
    newLink.className = "mobile-nav-item";
    newLink.href = meta.href;
    newLink.innerHTML = `<i class="${meta.icon}"></i><span>${meta.label}</span>`;

    if (replacement) {
        nav.replaceChild(newLink, replacement);
    } else {
        nav.appendChild(newLink);
    }
}

function pickMobileNavReplacement(items) {
    const keep = new Set(["home.html", "wallet.html", "tasks.html"]);
    for (let i = items.length - 1; i >= 0; i -= 1) {
        const target = navPageFromHref(items[i].getAttribute("href"));
        if (!keep.has(target)) {
            return items[i];
        }
    }
    return items[items.length - 1] || null;
}

function bindNetworkIndicators() {
    const bar = document.querySelector(".page-loading-bar");
    const banner = document.querySelector(".network-status");
    const bannerText = banner?.querySelector(".network-status__text");

    if (bar) {
        bar.classList.add("active");
        window.addEventListener("load", () => {
            window.setTimeout(() => bar.classList.remove("active"), 400);
        });
    }

    const setBanner = (message, show = true) => {
        if (!banner || !bannerText) {
            return;
        }
        bannerText.textContent = message;
        banner.classList.toggle("active", show);
    };

    const updateNetworkState = () => {
        if (!navigator.onLine) {
            setBanner("No internet connection. Reconnecting...");
            return;
        }

        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (connection && (connection.saveData || /2g/.test(connection.effectiveType || ""))) {
            setBanner("Slow network detected. Loading optimized view...");
            return;
        }

        setBanner("Connection restored.", true);
        window.setTimeout(() => setBanner("", false), 1200);
    };

    window.addEventListener("offline", updateNetworkState);
    window.addEventListener("online", updateNetworkState);
    updateNetworkState();
}

function updateHomeSmartCard({ tasks = [], referral = null } = {}) {
    const card = document.getElementById("home-smart-card");
    if (!card) {
        return;
    }

    const title = document.getElementById("home-smart-title");
    const sub = document.getElementById("home-smart-sub");
    const icon = document.getElementById("home-smart-icon");

    const pendingTasks = getPendingTaskCount(tasks);
    const referralDelta = getHomeReferralDelta(referral);

    let tone = "tasks";
    let iconClass = "ri-flashlight-line";
    let titleText = "New tasks are live";
    let subText = pendingTasks > 0
        ? `${formatNumber(pendingTasks)} tasks ready. Tap to start earning.`
        : "Tap to view your available tasks.";
    let href = "tasks.html";

    if (referralDelta.newCount > 0) {
        tone = "referral";
        iconClass = "ri-user-add-line";
        titleText = "New referral joined";
        subText = referralDelta.newCount > 1
            ? `${formatNumber(referralDelta.newCount)} friends joined using your code.`
            : `${referralDelta.latestName} joined using your code.`;
        href = "refer.html";
    } else if (pendingTasks === 0) {
        tone = "neutral";
        iconClass = "ri-notification-2-line";
        titleText = "No new updates right now";
        subText = "Check tasks or invite friends to earn more.";
        href = "tasks.html";
    }

    card.dataset.tone = tone;
    card.setAttribute("href", href);
    if (title) {
        title.textContent = titleText;
    }
    if (sub) {
        sub.textContent = subText;
    }
    if (icon) {
        icon.innerHTML = `<i class="${iconClass}"></i>`;
    }
}

function getPendingTaskCount(tasks) {
    if (!Array.isArray(tasks)) {
        return 0;
    }

    return tasks.filter((task) => !(task.completed || isTaskCompleted(task.id))).length;
}

function getHomeReferralDelta(referralData) {
    if (!referralData) {
        return { newCount: 0, latestName: "A friend" };
    }

    const totalReferrals = numberFrom(referralData.totalReferrals, 0);
    const todayReferrals = numberFrom(referralData.todayReferrals, 0);
    const stored = localStorage.getItem(STORAGE_KEYS.referralSeenCount);
    const previous = stored !== null ? numberFrom(stored, 0) : null;

    let newCount = previous === null ? todayReferrals : totalReferrals - previous;
    if (newCount < 0) {
        newCount = 0;
    }

    localStorage.setItem(STORAGE_KEYS.referralSeenCount, String(totalReferrals));

    const latest = Array.isArray(referralData.network) ? referralData.network[0] : null;
    const latestName = latest?.name || "A friend";

    return { newCount, latestName };
}

async function initTasksPage() {
    const taskStats = buildTaskStats();
    setText("task-total-earned", formatNumber(taskStats.earnedPoints));
    setText("task-completed-count", formatNumber(taskStats.completedCount));

    bindStaticTaskButtons();
    const responseTasks = await fetchTasksPayload();
    renderTaskSections(responseTasks);
    renderTaskHistory();
}

function bindStaticTaskButtons() {
    const checkinBtn = document.getElementById("btn-daily-checkin");
    const tutorialBtn = document.getElementById("btn-watch-video");

    updateTaskButton(checkinBtn, "daily-checkin", "Claimed");
    updateTaskButton(tutorialBtn, "watch-tutorial", "Completed");

    checkinBtn?.addEventListener("click", async () => {
        if (isTaskCompleted("daily-checkin")) {
            showToast("Daily check-in already claimed today.", "warning");
            return;
        }

        await completeRewardFlow({
            taskId: "daily-checkin",
            title: "Daily check-in",
            message: "Daily streak reward credited.",
            points: 10,
            type: "task"
        });

        updateTaskButton(checkinBtn, "daily-checkin", "Claimed");
        renderTaskHistory();
    });

    tutorialBtn?.addEventListener("click", () => {
        if (isTaskCompleted("watch-tutorial")) {
            showToast("Tutorial reward already used today.", "warning");
            return;
        }

        if (state.watchTimer) {
            return;
        }

        let secondsLeft = 10;
        tutorialBtn.disabled = true;
        tutorialBtn.textContent = `Watching ${secondsLeft}s`;

        state.watchTimer = window.setInterval(async () => {
            secondsLeft -= 1;

            if (secondsLeft <= 0) {
                window.clearInterval(state.watchTimer);
                state.watchTimer = null;

                await completeRewardFlow({
                    taskId: "watch-tutorial",
                    title: "Watch tutorial",
                    message: "Tutorial task completed.",
                    points: 15,
                    type: "task"
                });

                updateTaskButton(tutorialBtn, "watch-tutorial", "Completed");
                renderTaskHistory();
                return;
            }

            tutorialBtn.textContent = `Watching ${secondsLeft}s`;
        }, 1000);
    });

    // Bind Survey Task Buttons
    bindSurveyButtons();
}

// Survey Data - Questions for each survey
const SURVEY_DATA = {
    survey_001: {
        title: "Product Feedback Survey",
        reward: 50,
        questions: [
            { id: "q1", text: "How satisfied are you with AnviPayz?", type: "radio", options: ["Very Satisfied", "Satisfied", "Neutral", "Dissatisfied"] },
            { id: "q2", text: "Which feature do you use the most?", type: "radio", options: ["Daily Check-in", "Spin & Win", "Refer & Earn", "Tasks"] },
            { id: "q3", text: "Would you recommend AnviPayz to friends?", type: "radio", options: ["Definitely Yes", "Probably Yes", "Not Sure", "No"] }
        ]
    },
    survey_002: {
        title: "User Experience Survey",
        reward: 75,
        questions: [
            { id: "q1", text: "How easy is it to navigate the app?", type: "radio", options: ["Very Easy", "Easy", "Average", "Difficult"] },
            { id: "q2", text: "Do you find the interface user-friendly?", type: "radio", options: ["Yes, very", "Somewhat", "Not really", "No"] },
            { id: "q3", text: "What would you like to improve?", type: "text", placeholder: "Your suggestions..." }
        ]
    },
    survey_003: {
        title: "Market Research Survey",
        reward: 100,
        questions: [
            { id: "q1", text: "How did you hear about AnviPayz?", type: "radio", options: ["Friend/Referral", "Social Media", "Google Search", "Other"] },
            { id: "q2", text: "What is your primary goal on AnviPayz?", type: "radio", options: ["Earn Money", "Entertainment", "Learn & Grow", "Other"] },
            { id: "q3", text: "How often do you use the app?", type: "radio", options: ["Daily", "Few times a week", "Weekly", "Rarely"] },
            { id: "q4", text: "Any additional feedback?", type: "text", placeholder: "Share your thoughts..." }
        ]
    }
};

let currentSurveyId = null;
let currentSurveyAnswers = {};

function bindSurveyButtons() {
    const surveyButtons = document.querySelectorAll('.btn-start-survey');

    surveyButtons.forEach(btn => {
        const card = btn.closest('.survey-task-card');
        const surveyId = card?.dataset.surveyId;

        if (surveyId && isTaskCompleted(surveyId)) {
            btn.disabled = true;
            btn.textContent = 'Completed';
            btn.style.opacity = '0.6';
        }

        btn.addEventListener('click', () => {
            if (surveyId) {
                openSurveyModal(surveyId);
            }
        });
    });

    // Modal close handlers
    document.getElementById('close-survey')?.addEventListener('click', closeSurveyModal);
    document.getElementById('survey-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'survey-modal') closeSurveyModal();
    });

    // Submit handler
    document.getElementById('btn-submit-survey')?.addEventListener('click', submitSurvey);
}

function openSurveyModal(surveyId) {
    const survey = SURVEY_DATA[surveyId];
    if (!survey) return;

    currentSurveyId = surveyId;
    currentSurveyAnswers = {};

    document.getElementById('survey-title').textContent = survey.title;
    document.getElementById('survey-progress').textContent = `1 of ${survey.questions.length} questions`;

    const content = document.getElementById('survey-content');
    content.innerHTML = survey.questions.map((q, idx) => renderQuestion(q, idx)).join('');

    document.getElementById('survey-modal').style.display = 'flex';

    // Add change listeners to inputs
    content.querySelectorAll('input, textarea').forEach(input => {
        input.addEventListener('change', updateSurveyProgress);
    });
}

function renderQuestion(question, index) {
    const number = index + 1;

    if (question.type === 'radio') {
        return `
            <div class="survey-question" data-qid="${question.id}" style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border);">
                <p style="font-weight: 600; margin-bottom: 12px;">${number}. ${question.text}</p>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${question.options.map(opt => `
                        <label style="display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 8px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
                            <input type="radio" name="${question.id}" value="${opt}" style="width: 18px; height: 18px; accent-color: #8b5cf6;">
                            <span>${opt}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    } else if (question.type === 'text') {
        return `
            <div class="survey-question" data-qid="${question.id}" style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border);">
                <p style="font-weight: 600; margin-bottom: 12px;">${number}. ${question.text}</p>
                <textarea name="${question.id}" placeholder="${question.placeholder || 'Type your answer...'}" 
                    style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text); min-height: 80px; resize: vertical; font-family: inherit;"></textarea>
            </div>
        `;
    }
}

function updateSurveyProgress() {
    const survey = SURVEY_DATA[currentSurveyId];
    if (!survey) return;

    let answered = 0;
    survey.questions.forEach(q => {
        if (q.type === 'radio') {
            const selected = document.querySelector(`input[name="${q.id}"]:checked`);
            if (selected) answered++;
        } else if (q.type === 'text') {
            const textarea = document.querySelector(`textarea[name="${q.id}"]`);
            if (textarea && textarea.value.trim()) answered++;
        }
    });

    document.getElementById('survey-progress').textContent = `${answered} of ${survey.questions.length} answered`;
}

function closeSurveyModal() {
    document.getElementById('survey-modal').style.display = 'none';
    currentSurveyId = null;
    currentSurveyAnswers = {};
}

async function submitSurvey() {
    const survey = SURVEY_DATA[currentSurveyId];
    if (!survey) return;

    // Collect answers
    const answers = {};
    let allAnswered = true;

    survey.questions.forEach(q => {
        if (q.type === 'radio') {
            const selected = document.querySelector(`input[name="${q.id}"]:checked`);
            if (selected) {
                answers[q.id] = selected.value;
            } else {
                allAnswered = false;
            }
        } else if (q.type === 'text') {
            const textarea = document.querySelector(`textarea[name="${q.id}"]`);
            if (textarea && textarea.value.trim()) {
                answers[q.id] = textarea.value.trim();
            }
        }
    });

    if (!allAnswered) {
        showToast("Please answer all questions before submitting.", "warning");
        return;
    }

    // Submit to API (placeholder - API endpoint to be provided)
    const btn = document.getElementById('btn-submit-survey');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
        // Attempt API reward flow first (if backend supports surveys)
        await completeRewardFlow({
            taskId: currentSurveyId,
            title: survey.title,
            message: `Survey completed! +${survey.reward} coins added.`,
            points: survey.reward,
            type: "survey",
            requestVariants: [
                {
                    path: "/surveys/submit",
                    method: "POST",
                    body: { surveyId: currentSurveyId, answers }
                },
                {
                    path: "/add-points",
                    method: "POST",
                    body: { source: "survey", taskId: currentSurveyId, points: survey.reward, title: survey.title }
                }
            ]
        });

        // Update UI
        const card = document.querySelector(`[data-survey-id="${currentSurveyId}"]`);
        const startBtn = card?.querySelector('.btn-start-survey');
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.textContent = 'Completed';
            startBtn.style.opacity = '0.6';
        }

        renderTaskHistory();
        closeSurveyModal();
        showToast(`Survey completed! +${survey.reward} coins credited.`, "success");

    } catch (error) {
        console.error('Survey submission error:', error);
        // Fallback: local reward (offline-safe for surveys)
        if (!isTaskCompleted(currentSurveyId)) {
            markTaskCompleted(currentSurveyId);
            if (state.user) {
                state.user.points = numberFrom(state.user.points, 0) + numberFrom(survey.reward, 0);
                persistUser(state.user);
            }

            createWalletEntry({
                title: survey.title,
                message: `Survey completed! +${survey.reward} coins added.`,
                amount: survey.reward,
                type: "survey",
                direction: "credit",
                status: "completed",
                taskId: currentSurveyId
            });

            pushNotification({
                title: "Survey reward",
                message: `${survey.title}: ${survey.reward} points credited.`,
                type: "survey"
            });

            renderCommonUserState();
            playRewardSound();
            showRewardPopup({
                icon: "Reward",
                title: "Survey reward",
                message: `Survey completed! +${survey.reward} coins added.`,
                value: `${formatNumber(survey.reward)} Points`
            });
        }

        // Update UI locally
        const card = document.querySelector(`[data-survey-id="${currentSurveyId}"]`);
        const startBtn = card?.querySelector('.btn-start-survey');
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.textContent = 'Completed';
            startBtn.style.opacity = '0.6';
        }

        renderTaskHistory();
        closeSurveyModal();
        showToast(`Survey completed! +${survey.reward} coins credited.`, "success");
    } finally {
        btn.disabled = false;
        btn.textContent = 'Submit';
    }
}

async function fetchTasksPayload() {
    try {
        const data = await requestFirst([
            { path: "/tasks", method: "GET" },
            { path: "/user/tasks", method: "GET" }
        ], { auth: true });

        return normalizeTaskList(data?.tasks || data || []);
    } catch (error) {
        return DEFAULT_ADMIN_TASKS;
    }
}

function renderTaskSections(tasks) {
    const dailyContainer = document.getElementById("daily-task-container");
    const adminContainer = document.getElementById("admin-task-container");

    if (dailyContainer) {
        dailyContainer.innerHTML = renderProfileCompletionTask();
    }

    if (!adminContainer) {
        return;
    }

    if (!tasks.length) {
        adminContainer.innerHTML = emptyStateMarkup("ri-inbox-archive-line", "No API-powered tasks are live right now.");
        return;
    }

    adminContainer.innerHTML = tasks.map((task) => {
        const done = Boolean(task.completed) || isTaskCompleted(task.id);
        const badgeClass = done ? "success" : "warning";
        const actionLabel = done ? "Completed" : "Complete";

        return `
            <div class="task-card" data-task-card="${escapeHtml(task.id)}">
                <div class="task-card-head">
                    <div class="list-icon"><i class="ri-flashlight-line"></i></div>
                    <div class="list-info">
                        <div class="task-title">${escapeHtml(task.title)}</div>
                        <div class="task-body">${escapeHtml(task.description || "Open the task and finish the required action.")}</div>
                    </div>
                </div>
                <div class="task-card-bottom">
                    <div class="task-card-badges">
                        <span class="task-pill reward"><i class="ri-coin-line"></i>${formatNumber(task.rewardPoints)} Points</span>
                        <span class="status-pill ${badgeClass}">${done ? "Done today" : capitalize(task.taskType || "task")}</span>
                    </div>
                    <button type="button" class="btn-primary task-card-action" data-api-task="${escapeHtml(task.id)}">
                        ${actionLabel}
                    </button>
                </div>
            </div>
        `;
    }).join("");

    adminContainer.querySelectorAll("[data-api-task]").forEach((button) => {
        button.addEventListener("click", async () => {
            const taskId = button.getAttribute("data-api-task") || "";
            const task = tasks.find((item) => item.id === taskId);
            if (!task || isTaskCompleted(task.id) || task.completed) {
                showToast("This task is already completed.", "warning");
                return;
            }

            await withButtonState(button, "Completing...", async () => {
                if (task.link) {
                    window.open(task.link, "_blank", "noopener,noreferrer");
                }

                await completeRewardFlow({
                    taskId: task.id,
                    title: task.title,
                    message: `${task.title} completed successfully.`,
                    points: task.rewardPoints,
                    type: "task",
                    requestVariants: [
                        {
                            path: "/tasks/complete",
                            method: "POST",
                            body: { taskId: task.id, rewardPoints: task.rewardPoints }
                        },
                        {
                            path: "/add-points",
                            method: "POST",
                            body: { source: "task", taskId: task.id, points: task.rewardPoints, title: task.title }
                        }
                    ]
                });

                button.dataset.locked = "true";
                button.dataset.lockedLabel = "Completed";
                button.textContent = "Completed";
                button.disabled = true;
                renderTaskHistory();
            });
        });
    });
}

function renderProfileCompletionTask() {
    return "";
}

function renderTaskHistory() {
    const container = document.getElementById("task-history-list");
    if (!container) {
        return;
    }

    const records = state.activity
        .filter((entry) => entry.type === "task" || entry.type === "spin");

    renderHistoryList(container, records, "Your completed tasks will appear here.", {
        emptyIcon: "ri-time-line"
    });
    const stats = buildTaskStats();
    setText("task-total-earned", formatNumber(stats.earnedPoints));
    setText("task-completed-count", formatNumber(stats.completedCount));
}

async function initWalletPage() {
    const walletPayload = await fetchWalletPayload();
    renderWallet(walletPayload);
    bindWalletConversion();
}

async function fetchWalletPayload() {
    try {
        const data = await requestFirst([
            { path: "/wallet", method: "GET" },
            { path: "/user/wallet", method: "GET" }
        ], { auth: true });

        if (data?.user) {
            state.user = normalizeUser(data.user);
            persistUser(state.user);
        }

        const transactions = syncActivityState(data?.transactions || data?.history || [], { replace: true });

        return {
            transactions,
            user: state.user,
            stats: {
                referralEarnings: numberFrom(data?.stats?.referralEarnings, state.user?.referralEarnings, 0),
                taskRewards: Math.max(numberFrom(data?.stats?.taskRewards, state.user?.taskEarnings, 0), buildTaskStats().earnedPoints),
                surveyEarnings: Math.max(numberFrom(data?.stats?.surveyEarnings, state.user?.surveyEarnings, 0), buildSurveyStats().earnedPoints)
            }
        };
    } catch (error) {
        return {
            transactions: [...state.activity],
            user: state.user,
            stats: {
                referralEarnings: numberFrom(state.user?.referralEarnings, 0),
                taskRewards: buildTaskStats().earnedPoints,
                surveyEarnings: buildSurveyStats().earnedPoints
            }
        };
    }
}

function renderWallet(payload) {
    renderCommonUserState();
    const stats = payload?.stats || {};
    setText("wallet-refer-income", formatNumber(numberFrom(stats.referralEarnings, state.user?.referralEarnings, 0)));
    setText("wallet-task-income", formatNumber(numberFrom(stats.taskRewards, state.user?.taskEarnings, buildTaskStats().earnedPoints)));
    setText("wallet-survey-income", formatNumber(numberFrom(stats.surveyEarnings, state.user?.surveyEarnings, buildSurveyStats().earnedPoints)));

    const list = uniqueByKey(payload.transactions, (item) => `${item.id}:${item.time}`);
    const container = document.getElementById("transaction-list");
    if (!container) {
        return;
    }
    renderHistoryList(container, list, "Your wallet movements will show here.");
}

function bindWalletConversion() {
    const input = document.getElementById("points-input");
    const output = document.getElementById("token-output");
    const button = document.getElementById("convert-btn");
    const warning = document.getElementById("min-warning");

    if (!input || !output || !button) {
        return;
    }

    const updatePreview = () => {
        const points = Math.floor(Number(input.value || 0));
        const tokens = points / 1000;
        const balance = Math.floor(state.user?.points || 0);
        const valid = points > 0 && points <= balance;

        output.textContent = formatDecimal(tokens);
        button.disabled = !valid;
        button.textContent = valid ? "Convert Points" : "Enter Valid Points";

        if (warning) {
            warning.style.display = !points || valid ? "none" : "block";
            warning.textContent = points <= 0
                ? "Enter at least 1 point to continue."
                : "Entered points exceed your current balance.";
        }
    };

    input.addEventListener("input", updatePreview);
    updatePreview();

    button.addEventListener("click", async () => {
        const points = Math.floor(Number(input.value || 0));
        if (points <= 0) {
            showToast("Enter points to convert.", "error");
            return;
        }

        if (points > (state.user?.points || 0)) {
            showToast("Entered points exceed your current balance.", "error");
            return;
        }

        const tokens = roundTo(points / 1000, 2);

        await withButtonState(button, "Converting...", async () => {
            const requestData = await requestFirst([
                { path: "/wallet/convert", method: "POST", body: { points } },
                { path: "/convert-points", method: "POST", body: { points } }
            ], { auth: true });

            if (requestData?.user) {
                state.user = normalizeUser(requestData.user);
                persistUser(state.user);
                if (requestData?.transactions?.length || requestData?.activityEntry) {
                    syncActivityState(requestData.transactions || [requestData.activityEntry], { replace: true });
                }
            } else {
                throw new Error("Wallet conversion failed. Please try again.");
            }

            pushNotification({
                title: "Wallet updated",
                message: `${formatDecimal(tokens)} tokens added to your wallet.`,
                type: "wallet"
            });

            renderWallet({
                transactions: state.activity,
                user: state.user,
                stats: requestData?.stats
            });
            input.value = "";
            updatePreview();
            showRewardPopup({
                icon: "💳",
                title: "Conversion complete",
                message: "Your wallet is updated and ready to use on recharge.",
                value: `${formatDecimal(tokens)} Tokens`
            });
        });
    });
}

async function initReferPage() {
    const data = await fetchReferralPayload();
    const referralCode = data.referralCode || state.user?.referralCode || "ANVI0000";
    const shareUrl = `${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, "/")}index.html?view=register&ref=${encodeURIComponent(referralCode)}`;

    setText("my-refer-code", referralCode);
    setText("total-ref-count", formatNumber(data.totalReferrals));
    setText("total-ref-earnings", formatNumber(data.totalEarnings));
    setText("daily-limit-text", `${formatNumber(data.todayReferrals)} / ${formatNumber(data.dailyLimit)} Today`);
    setText("pending-ref-rewards", formatNumber(data.todayReferrals));
    updateReferralProgress(data);
    bindInviteNow(shareUrl);
    bindReferralLeaderboard({
        leaderboard: data.leaderboard || [],
        weeklyLeaderboard: data.weeklyLeaderboard || [],
        network: data.network || []
    });

    document.getElementById("copy-btn")?.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            showToast("Referral link copied.", "success");
        } catch (error) {
            showToast("Copy failed on this device.", "error");
        }
    });

    document.getElementById("share-btn")?.addEventListener("click", async () => {
        if (navigator.share) {
            try {
                await navigator.share({
                    title: "Join AnviPayz",
                    text: `Use my invite code ${referralCode} to join AnviPayz.`,
                    url: shareUrl
                });
                showToast("Referral link shared.", "success");
                return;
            } catch (error) {
                // Silent fallback to copy.
            }
        }

        try {
            await navigator.clipboard.writeText(shareUrl);
            showToast("Referral link copied for sharing.", "success");
        } catch (error) {
            showToast("Share is not available right now.", "error");
        }
    });

    renderReferralNetwork(data.network);
    handleReferralAlerts(data);
}

function updateReferralProgress(data) {
    const current = numberFrom(data?.todayReferrals, 0);
    const goal = Math.max(numberFrom(data?.dailyLimit, 10), 1);
    const ratio = Math.min(current / goal, 1);

    setText("progress-current", formatNumber(current));
    setText("progress-goal", formatNumber(goal));

    const fill = document.getElementById("progress-fill");
    if (fill) {
        fill.style.width = `${Math.round(ratio * 100)}%`;
    }

    const bonusStatus = document.getElementById("bonus-status");
    if (bonusStatus) {
        if (current >= goal) {
            bonusStatus.textContent = "Bonus unlocked! Keep pushing the leaderboard.";
            bonusStatus.classList.add("unlocked");
        } else {
            bonusStatus.textContent = `Invite ${goal - current} more friends to unlock reward.`;
            bonusStatus.classList.remove("unlocked");
        }
    }
}

function bindInviteNow(shareUrl) {
    const inviteBtn = document.getElementById("invite-now-btn");
    if (!inviteBtn || inviteBtn.dataset.bound === "true") {
        return;
    }
    inviteBtn.dataset.bound = "true";
    inviteBtn.addEventListener("click", async () => {
        if (navigator.share) {
            try {
                await navigator.share({
                    title: "Join AnviPayz",
                    text: "Use my invite code to join AnviPayz.",
                    url: shareUrl
                });
                showToast("Referral link shared.", "success");
                return;
            } catch (error) {
                // fallback to copy
            }
        }

        try {
            await navigator.clipboard.writeText(shareUrl);
            showToast("Referral link copied for sharing.", "success");
        } catch (error) {
            showToast("Share is not available right now.", "error");
        }
    });
}

function bindReferralLeaderboard({ leaderboard = [], weeklyLeaderboard = [], network = [] } = {}) {
    const listEl = document.getElementById("leaderboard-list");
    const toggleAll = document.getElementById("toggle-all");
    const toggleWeekly = document.getElementById("toggle-weekly");
    const rankCard = document.getElementById("your-rank-card");

    if (!listEl || !toggleAll || !toggleWeekly) {
        return;
    }

    if (!document.documentElement.dataset.referLeaderboardBound) {
        document.documentElement.dataset.referLeaderboardBound = "1";
        toggleAll.addEventListener("click", () => {
            toggleAll.classList.add("active");
            toggleWeekly.classList.remove("active");
            renderReferralLeaderboard(listEl, normalizeLeaderboardEntries(leaderboard, { timeLabel: "All time" }), "all", rankCard);
        });

        toggleWeekly.addEventListener("click", () => {
            toggleWeekly.classList.add("active");
            toggleAll.classList.remove("active");
            renderReferralLeaderboard(listEl, normalizeLeaderboardEntries(weeklyLeaderboard, { timeLabel: "This week" }), "weekly", rankCard);
        });
    }

    const mode = toggleWeekly.classList.contains("active") ? "weekly" : "all";
    renderReferralLeaderboard(
        listEl,
        mode === "weekly"
            ? normalizeLeaderboardEntries(weeklyLeaderboard, { timeLabel: "This week" })
            : normalizeLeaderboardEntries(leaderboard, { timeLabel: "All time" }),
        mode,
        rankCard
    );
}

function normalizeLeaderboardEntries(entries, { timeLabel = "All time" } = {}) {
    return (Array.isArray(entries) ? entries : []).map((item) => {
        const referrals = numberFrom(item.referrals, item.referralCount, 0);
        return {
            name: item.username || item.name || "Member",
            email: "",
            reward: numberFrom(item.points, item.reward, 0),
            time: item.time || item.createdAt || "",
            subLabel: `Referrals: ${formatNumber(referrals)}`,
            timeLabel: timeLabel
        };
    });
}

function handleReferralAlerts(data) {
    const totalReferrals = numberFrom(data?.totalReferrals, 0);
    const stored = localStorage.getItem(STORAGE_KEYS.referralSeenCount);
    const previous = stored !== null ? numberFrom(stored, 0) : null;

    let newCount = 0;
    if (previous === null) {
        newCount = numberFrom(data?.todayReferrals, 0);
        if (newCount <= 0) {
            localStorage.setItem(STORAGE_KEYS.referralSeenCount, String(totalReferrals));
            return;
        }
    } else {
        newCount = totalReferrals - previous;
        if (newCount <= 0) {
            localStorage.setItem(STORAGE_KEYS.referralSeenCount, String(totalReferrals));
            return;
        }
    }

    localStorage.setItem(STORAGE_KEYS.referralSeenCount, String(totalReferrals));
    const latest = Array.isArray(data?.network) ? data.network[0] : null;
    const latestName = latest?.name || "A friend";
    const message = newCount > 1
        ? `${formatNumber(newCount)} new referrals joined using your code.`
        : `${latestName} joined using your referral code.`;

    pushNotification({
        title: "Referral joined",
        message,
        type: "referral"
    });

    showToast(newCount > 1 ? "New referrals joined!" : "New referral joined!", "success");

    const rewardPoints = numberFrom(latest?.reward, 0) * newCount;
    showRewardPopup({
        icon: "Reward",
        title: "Referral Bonus",
        message,
        value: rewardPoints > 0 ? `${formatNumber(rewardPoints)} Points` : "Rewards updated"
    });
}

function renderReferralLeaderboard(listEl, network, mode, rankCard) {
    const now = Date.now();
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const sourceList = (network || []);
    const hasTime = sourceList.some((person) => toTimestamp(person.time));
    const filtered = sourceList.filter((person) => {
        if (mode !== "weekly" || !hasTime) {
            return true;
        }
        const timestamp = toTimestamp(person.time);
        return timestamp && now - timestamp <= windowMs;
    });

    const sorted = [...filtered].sort((a, b) => numberFrom(b.reward, 0) - numberFrom(a.reward, 0));

    if (!sorted.length) {
        listEl.innerHTML = emptyStateMarkup("ri-trophy-line", "No leaderboard data yet.");
        if (rankCard) {
            rankCard.hidden = true;
        }
        return;
    }

    listEl.innerHTML = sorted.slice(0, 8).map((person, index) => {
        const emailLabel = person.subLabel || (person.email ? maskEmail(person.email) : "Joined via invite link");
        const timeLabel = person.timeLabel || (person.time ? formatRelative(person.time) : "All time");
        return `
            <div class="network-item">
                <div class="list-info">
                    <div class="task-title">#${index + 1} ${escapeHtml(person.name || "Member")}</div>
                    <div class="task-body">${escapeHtml(emailLabel)}</div>
                </div>
                <div style="text-align:right;">
                    <div class="status-pill success">${formatNumber(person.reward)} Points</div>
                    <div class="network-time" style="margin-top:6px;">${escapeHtml(timeLabel)}</div>
                </div>
            </div>
        `;
    }).join("");

    if (rankCard) {
        rankCard.hidden = true;
    }
}

async function fetchReferralPayload() {
    try {
        const data = await requestFirst([
            { path: "/referrals", method: "GET" },
            { path: "/user/referrals", method: "GET" }
        ], { auth: true });

        if (data?.user) {
            state.user = normalizeUser(data.user);
            persistUser(state.user);
        }

        return {
            referralCode: data?.referralCode || state.user?.referralCode,
            totalReferrals: numberFrom(data?.totalReferrals, state.user?.referrals, 0),
            totalEarnings: numberFrom(data?.totalEarnings, state.user?.referralEarnings, 0),
            todayReferrals: numberFrom(data?.todayReferrals, 0),
            dailyLimit: numberFrom(data?.dailyLimit, 10),
            leaderboard: Array.isArray(data?.leaderboard) ? data.leaderboard : [],
            weeklyLeaderboard: Array.isArray(data?.weeklyLeaderboard) ? data.weeklyLeaderboard : [],
            network: normalizeNetwork(data?.network || [])
        };
    } catch (error) {
        return {
            referralCode: state.user?.referralCode || "ANVI0000",
            totalReferrals: numberFrom(state.user?.referrals, 0),
            totalEarnings: numberFrom(state.user?.referralEarnings, 0),
            todayReferrals: 0,
            dailyLimit: 10,
            leaderboard: [],
            weeklyLeaderboard: [],
            network: []
        };
    }
}

function renderReferralNetwork(network) {
    const container = document.getElementById("referral-list");
    if (!container) {
        return;
    }

    if (!network.length) {
        container.innerHTML = emptyStateMarkup("ri-user-follow-line", "Your verified referrals will appear here after they join.");
        return;
    }

    container.innerHTML = network.map((person) => {
        const emailLabel = person.email ? maskEmail(person.email) : "Joined via email link";
        return `
            <div class="network-item">
                <div class="list-info">
                    <div class="task-title">${escapeHtml(person.name)}</div>
                    <div class="task-body">${escapeHtml(emailLabel)}</div>
                </div>
                <div style="text-align:right;">
                    <div class="status-pill success">${formatNumber(person.reward)} Points</div>
                    <div class="network-time" style="margin-top:6px;">${escapeHtml(formatLongDate(person.time))}</div>
                </div>
            </div>
        `;
    }).join("");
}

async function initNotificationsPage() {
    const notifications = await fetchNotificationsPayload();
    renderNotifications(notifications);

    // Add "Mark All as Read" functionality
    const markAllReadBtn = document.getElementById("mark-all-read-btn");
    if (markAllReadBtn) {
        markAllReadBtn.addEventListener("click", () => {
            const updatedNotifications = state.notifications.map((item) => ({ ...item, unread: false }));
            state.notifications = updatedNotifications;
            persistNotifications();
            renderNotifications(updatedNotifications);
            showToast("All notifications marked as read", "success");
        });
    }
}

async function fetchNotificationsPayload() {
    try {
        const data = await requestFirst([
            { path: "/notifications", method: "GET" },
            { path: "/user/notifications", method: "GET" }
        ], { auth: true });

        const normalized = normalizeNotifications(data?.notifications || data || []);
        state.notifications = mergeNotifications(normalized, state.notifications);
        persistNotifications();
        return state.notifications;
    } catch (error) {
        return state.notifications;
    }
}

function renderNotifications(list) {
    const container = document.getElementById("notification-list");
    if (!container) {
        return;
    }

    if (!list.length) {
        container.innerHTML = emptyStateMarkup("ri-notification-off-line", "No alerts yet. Reward updates will show here.");
        updateUnreadSummary(0);
        return;
    }

    const unreadCount = list.filter((item) => item.unread).length;
    updateUnreadSummary(unreadCount);

    renderPaginatedList({
        container,
        records: list,
        emptyMessage: "No alerts yet. Reward updates will show here.",
        initialCount: 30,
        stepCount: 15,
        listKey: "notifications",
        renderItem: (item, index) => `
            <article class="notification-card ${item.unread ? "notification-unread" : ""}" data-index="${index}" style="cursor:pointer;">
                <div class="notification-main">
                    <div class="notification-title">${escapeHtml(item.title)}</div>
                    <div class="notification-body">${escapeHtml(item.message)}</div>
                </div>
                <div style="text-align:right;">
                    <div class="notification-time">${escapeHtml(formatRelative(item.time))}</div>
                    <div class="meta-text" style="margin-top:6px;">${escapeHtml(formatLongDate(item.time))}</div>
                </div>
            </article>
        `,
        afterRender: () => {
            // Add click handlers to mark notifications as read
            container.querySelectorAll(".notification-card").forEach((card) => {
                card.addEventListener("click", () => {
                    const index = parseInt(card.dataset.index);
                    if (list[index] && list[index].unread) {
                        list[index].unread = false;
                        state.notifications = list;
                        persistNotifications(list);
                        renderNotifications(list);
                    }
                });
            });
        }
    });
}

function updateUnreadSummary(count) {
    setText("unread-count-label", `Unread: ${formatNumber(count)}`);
    setAllText("header-unread-badge", `${formatNumber(count)} Unread`);
    setText("mobile-unread-badge", `${formatNumber(count)} Unread`);
    updateSidebarUnreadBadge(count);
}

async function initSpinPage() {
    renderSpinWheel();

    const button = document.getElementById("btn-spin");
    const message = document.getElementById("spin-msg");
    const alreadyUsed = isTaskCompleted("daily-spin");

    if (alreadyUsed && message) {
        message.textContent = "Today's spin is already used. Come back tomorrow.";
        button.disabled = true;
        button.textContent = "Spin used";
    }

    button?.addEventListener("click", async () => {
        if (state.spinning || isTaskCompleted("daily-spin")) {
            showToast("You already used your daily spin.", "warning");
            return;
        }

        state.spinning = true;
        playSpinSound();

        try {
            const reward = await fetchSpinReward();
            const spins = 8 + Math.floor(Math.random() * 3);
            const spinDuration = getSpinDuration(spins);
            const stopTick = startSpinTickSound(spinDuration);
            await animateWheelToReward(reward.index, { spins, duration: spinDuration });
            stopTick();
            await completeRewardFlow({
                taskId: "daily-spin",
                title: "Spin & Win",
                message: `Spin reward credited: ${reward.points} points.`,
                points: reward.points,
                type: "spin",
                requestVariants: reward.requestVariants
            });

            if (message) {
                message.textContent = `Today's spin rewarded ${reward.points} points.`;
            }

            button.disabled = true;
            button.textContent = "Spin used";
        } catch (error) {
            const friendly = error?.message || "Spin failed. Please try again.";
            showToast(friendly, "error");
            if (message) {
                message.textContent = friendly;
            }
        } finally {
            state.spinning = false;
        }
    });
}

function enforceAutoLogout() {
    const last = Number(localStorage.getItem(SECURITY_ACTIVITY_KEY) || 0);
    if (last && Date.now() - last > INACTIVITY_LIMIT_MS) {
        logout();
    }
}

function bindActivityListeners() {
    const mark = () => {
        localStorage.setItem(SECURITY_ACTIVITY_KEY, String(Date.now()));
    };
    mark();
    ["click", "keydown", "mousemove", "touchstart", "scroll"].forEach((evt) => {
        window.addEventListener(evt, mark, { passive: true });
    });
}

function renderSpinWheel() {
    const wheel = document.getElementById("wheel");
    if (!wheel) {
        return;
    }

    wheel.innerHTML = SPIN_REWARDS.map((reward, index) => {
        const angle = index * (360 / SPIN_REWARDS.length) + (360 / SPIN_REWARDS.length) / 2;
        return `<span class="wheel-segment-label" style="--angle:${angle}; --distance:120px;">${reward}</span>`;
    }).join("");
}

async function fetchSpinReward() {
    const data = await requestFirst([
        { path: "/spin", method: "POST", body: {} },
        { path: "/spin/reward", method: "POST", body: {} }
    ], { auth: true });

    const points = numberFrom(data?.points, data?.reward, SPIN_REWARDS[Math.floor(Math.random() * SPIN_REWARDS.length)]);
    const index = Math.max(0, SPIN_REWARDS.findIndex((value) => value === points));
    const rewardToken = String(data?.rewardToken || "").trim();

    if (!rewardToken) {
        throw new Error("Spin reward token missing. Please try again.");
    }

    return {
        points,
        index,
        requestVariants: [
            {
                path: "/add-points",
                method: "POST",
                body: {
                    source: "spin",
                    taskId: "daily-spin",
                    rewardToken,
                    points,
                    title: "Spin & Win"
                }
            }
        ]
    };
}

function animateWheelToReward(index, { spins = 7, duration = 4800 } = {}) {
    const wheel = document.getElementById("wheel");
    if (!wheel) {
        return Promise.resolve();
    }

    const segmentAngle = 360 / SPIN_REWARDS.length;
    const stopAngle = 360 - (index * segmentAngle + segmentAngle / 2);
    state.wheelRotation += spins * 360 + stopAngle;
    wheel.style.transition = `transform ${duration}ms cubic-bezier(0.12, 0.78, 0.14, 1)`;
    wheel.style.transform = `rotate(${state.wheelRotation}deg)`;

    return new Promise((resolve) => {
        window.setTimeout(resolve, duration + 80);
    });
}

function getSpinDuration(spins) {
    return Math.max(4200, spins * 520);
}

async function initRechargePage() {
    bindRechargePlanFilters();
    bindRechargeQuickAmounts();
    bindRechargeDiscount();
    updateRechargePreview();

    const form = document.getElementById("recharge-form");
    form?.addEventListener("submit", async (event) => {
        event.preventDefault();

        const payload = buildRechargePayload();
        if (!payload) {
            return;
        }

        const button = document.getElementById("recharge-pay-btn");
        await withButtonState(button, "Processing...", async () => {
            const data = await requestRechargeOrder(payload);

            createWalletEntry({
                title: "Recharge request created",
                message: `Recharge request for ${payload.mobile} is ready for payment.`,
                amount: payload.payableAmount,
                type: "recharge",
                direction: "debit",
                status: "pending"
            });

            pushNotification({
                title: "Recharge request created",
                message: `Payment link prepared for ${payload.operator} ₹${formatDecimal(payload.amount)} recharge.`,
                type: "recharge"
            });

            setText("recharge-status", data?.message || "Recharge request created. Continue in the payment window.");
            showRewardPopup({
                icon: "📱",
                title: "Recharge ready",
                message: data?.message || "Your order is created and waiting for checkout confirmation.",
                value: `Pay ₹${formatDecimal(payload.payableAmount)}`
            });

            if (data?.checkoutUrl) {
                window.location.href = data.checkoutUrl;
                return;
            }

            if (data?.paymentUrl) {
                window.location.href = data.paymentUrl;
                return;
            }
        });
    });
}

function bindRechargePlanFilters() {
    document.querySelectorAll(".rx-filter-btn").forEach((button) => {
        button.addEventListener("click", () => {
            const selected = button.getAttribute("data-cat") || "all";
            document.querySelectorAll(".rx-filter-btn").forEach((item) => item.classList.remove("active"));
            button.classList.add("active");

            document.querySelectorAll(".recharge-plan-item").forEach((plan) => {
                const category = plan.getAttribute("data-cat") || "";
                plan.style.display = selected === "all" || category === selected ? "" : "none";
            });
        });
    });

    document.querySelectorAll(".recharge-plan-item").forEach((button) => {
        button.addEventListener("click", () => {
            const amount = button.getAttribute("data-amount") || "";
            document.getElementById("recharge-amount").value = amount;
            document.querySelectorAll(".recharge-plan-item").forEach((item) => item.classList.remove("active"));
            button.classList.add("active");
            updateRechargePreview();
        });
    });
}

function bindRechargeQuickAmounts() {
    document.querySelectorAll(".rx-quick-btn").forEach((button) => {
        button.addEventListener("click", () => {
            const amount = button.getAttribute("data-quick") || "";
            document.getElementById("recharge-amount").value = amount;
            document.querySelectorAll(".rx-quick-btn").forEach((item) => item.classList.remove("active"));
            button.classList.add("active");
            updateRechargePreview();
        });
    });

    ["recharge-mobile", "recharge-operator", "recharge-circle", "recharge-amount", "token-discount-input"].forEach((id) => {
        document.getElementById(id)?.addEventListener("input", updateRechargePreview);
        document.getElementById(id)?.addEventListener("change", updateRechargePreview);
    });
}

function bindRechargeDiscount() {
    const checkbox = document.getElementById("use-token-discount");
    const input = document.getElementById("token-discount-input");

    checkbox?.addEventListener("change", () => {
        if (input) {
            input.disabled = !checkbox.checked;
            if (!checkbox.checked) {
                input.value = "";
            }
        }

        updateRechargePreview();
    });
}

function buildRechargePayload() {
    const mobile = document.getElementById("recharge-mobile")?.value.trim() || "";
    const operator = document.getElementById("recharge-operator")?.value.trim() || "";
    const circle = document.getElementById("recharge-circle")?.value.trim() || "";
    const amount = Number(document.getElementById("recharge-amount")?.value || 0);
    const useTokens = Boolean(document.getElementById("use-token-discount")?.checked);
    const requestedDiscount = Number(document.getElementById("token-discount-input")?.value || 0);
    const maxDiscount = maxRechargeDiscount(amount);
    const tokenDiscount = useTokens ? Math.min(maxDiscount, Math.max(0, requestedDiscount)) : 0;
    const payableAmount = Math.max(0, amount - tokenDiscount);

    if (!/^\d{10}$/.test(mobile)) {
        setText("recharge-status", "Enter a valid 10-digit mobile number.");
        showToast("Enter a valid 10-digit mobile number.", "error");
        return null;
    }

    if (!operator || !circle || amount < 10) {
        setText("recharge-status", "Complete the recharge details before continuing.");
        showToast("Complete the recharge details before continuing.", "error");
        return null;
    }

    return {
        mobile,
        operator,
        circle,
        amount,
        tokenDiscount,
        payableAmount
    };
}

async function requestRechargeOrder(payload) {
    try {
        const data = await requestFirst([
            { path: "/recharge", method: "POST", body: payload },
            { path: "/recharge/initiate", method: "POST", body: payload }
        ], { auth: true });

        if (data?.user) {
            state.user = normalizeUser(data.user);
            persistUser(state.user);
            renderCommonUserState();
        }

        return data || {};
    } catch (error) {
        return {
            message: "Recharge request saved. Payment gateway will be provided by your backend."
        };
    }
}

function updateRechargePreview() {
    const amount = Number(document.getElementById("recharge-amount")?.value || 0);
    const requestedDiscount = Number(document.getElementById("token-discount-input")?.value || 0);
    const useTokens = Boolean(document.getElementById("use-token-discount")?.checked);
    const selectedPlan = document.querySelector(".recharge-plan-item.active strong")?.textContent || "No plan selected";
    const maxDiscount = maxRechargeDiscount(amount);
    const discount = useTokens ? Math.min(maxDiscount, Math.max(0, requestedDiscount)) : 0;
    const payable = Math.max(0, amount - discount);

    setText("rx-mini-plan", selectedPlan);
    setText("rx-mini-amount", `Rs ${formatDecimal(amount)}`);
    setText("rx-mini-token-discount", `- Rs ${formatDecimal(discount)}`);
    setText("recharge-preview-amount", `Rs ${formatDecimal(amount)}`);
    setText("recharge-preview-token-discount", `- Rs ${formatDecimal(discount)}`);
    setText("recharge-preview-payable", `Rs ${formatDecimal(payable)}`);
    setText("token-available-pill", `${formatDecimal(state.user?.tokens || 0)} Tokens`);
    setText("token-max-note", amount > 0
        ? `Maximum usable token discount right now: ₹${formatDecimal(maxDiscount)}`
        : "Enter an amount to calculate the token discount limit.");
    setText("recharge-status", amount > 0
        ? `Payable amount after discount: ₹${formatDecimal(payable)}`
        : "Select a plan or enter a custom amount.");
}

function maxRechargeDiscount(amount) {
    return roundTo(Math.min(state.user?.tokens || 0, amount * 0.1), 2);
}

async function initProfilePage() {
    renderCommonUserState();
    const button = document.getElementById("delete-account-btn");
    button?.addEventListener("click", async () => {
        const confirmed = await showDeleteAccountFlow();
        if (!confirmed) {
            return;
        }

        await withButtonState(button, "Deleting...", async () => {
            const data = await requestFirst([
                { path: "/profile/delete", method: "DELETE" },
                { path: "/user", method: "DELETE" }
            ], { auth: true });
            const deadline = data?.recovery?.deleteAfter ? formatLongDate(data.recovery.deleteAfter) : "the next 7 days";
            showToast(`Account scheduled for deletion. Restore it before ${deadline}.`, "warning");
            logout();
        });
    });
}

function initSupportPage() {
    renderCommonUserState();
}

async function completeRewardFlow({ taskId, title, message, points, type, requestVariants = null }) {
    if (taskId && isTaskCompleted(taskId)) {
        showToast("This reward is already claimed today.", "warning");
        return;
    }

    let serverActivityHandled = false;

    if (requestVariants?.length) {
        const data = await requestVariantsLoop(requestVariants);
        if (data?.user) {
            state.user = normalizeUser(data.user);
            persistUser(state.user);
        }
        if (data?.history?.length || data?.transactions?.length || data?.activityEntry) {
            syncActivityState(data.history || data.transactions || [data.activityEntry], { replace: true });
            serverActivityHandled = true;
        }
    } else {
        const data = await requestFirst([
            { path: "/add-points", method: "POST", body: { source: type, taskId, points, title, message } }
        ], { auth: true });

        if (data?.user) {
            state.user = normalizeUser(data.user);
            persistUser(state.user);
        }
        if (data?.history?.length || data?.transactions?.length || data?.activityEntry) {
            syncActivityState(data.history || data.transactions || [data.activityEntry], { replace: true });
            serverActivityHandled = true;
        }
    }

    if (taskId) {
        markTaskCompleted(taskId);
    }

    if (!serverActivityHandled) {
        createWalletEntry({
            title,
            message,
            amount: points,
            type,
            direction: "credit",
            status: "completed",
            taskId
        });
    }

    pushNotification({
        title: "Reward added",
        message: `${title}: ${points} points credited.`,
        type
    });

    renderCommonUserState();
    playRewardSound();
    showRewardPopup({
        icon: "🎉",
        title: "Reward received",
        message: message || "Your account has been updated.",
        value: `${formatNumber(points)} Points`
    });
}

async function requestVariantsLoop(variants) {
    let lastError = null;

    for (const variant of variants) {
        try {
            return await requestJson(variant.path, {
                method: variant.method,
                body: variant.body,
                auth: true
            });
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Request failed.");
}

async function fetchDashboardPayload() {
    try {
        const data = await requestFirst([
            { path: "/dashboard", method: "GET" },
            { path: "/user/dashboard", method: "GET" }
        ], { auth: true });

        if (data?.user) {
            state.user = normalizeUser(data.user);
            persistUser(state.user);
        }

        const mergedHistory = syncActivityState(data?.history || data?.transactions || [], { replace: true });
        const taskStats = buildTaskStats();
        const surveyStats = buildSurveyStats();

        return {
            stats: {
                points: state.user?.points || 0,
                referralEarnings: numberFrom(data?.stats?.referralEarnings, state.user?.referralEarnings, 0),
                taskRewards: Math.max(numberFrom(data?.stats?.taskRewards, 0), taskStats.earnedPoints),
                surveyEarnings: Math.max(numberFrom(data?.stats?.surveyEarnings, 0), surveyStats.earnedPoints)
            },
            history: mergedHistory.sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time))
        };
    } catch (error) {
        const taskStats = buildTaskStats();
        const surveyStats = buildSurveyStats();
        return {
            stats: {
                points: state.user?.points || 0,
                referralEarnings: numberFrom(state.user?.referralEarnings, 0),
                taskRewards: taskStats.earnedPoints,
                surveyEarnings: surveyStats.earnedPoints
            },
            history: [...state.activity].sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time))
        };
    }
}

function renderPaginatedList({
    container,
    records,
    emptyMessage,
    emptyIcon = "ri-history-line",
    renderItem,
    initialCount = 10,
    stepCount = 15,
    buttonLabel = "Show All",
    listKey = "",
    afterRender
}) {
    if (!container) {
        return;
    }

    if (!records.length) {
        container.innerHTML = emptyStateMarkup(emptyIcon, emptyMessage);
        container.dataset.visibleCount = "";
        return;
    }

    const total = records.length;
    const key = listKey || container.id || "";
    const previousKey = container.dataset.listKey || "";
    const storedCount = Number(container.dataset.visibleCount);
    const shouldReset = !Number.isFinite(storedCount) || storedCount <= 0 || (key && previousKey && key !== previousKey);
    const baseCount = shouldReset ? initialCount : storedCount;
    const visibleCount = Math.min(Math.max(baseCount, initialCount), total);

    if (key) {
        container.dataset.listKey = key;
    }
    container.dataset.visibleCount = String(visibleCount);

    const visibleRecords = records.slice(0, visibleCount);
    const listMarkup = visibleRecords.map((item, index) => renderItem(item, index)).join("");
    const showMoreMarkup = total > visibleCount
        ? `
            <div class="show-more-row">
                <button type="button" class="btn-primary--ghost show-more-btn">${buttonLabel}</button>
                <div class="show-more-meta">Showing ${visibleCount} of ${total}</div>
            </div>
        `
        : "";

    container.innerHTML = listMarkup + showMoreMarkup;

    if (typeof afterRender === "function") {
        afterRender({
            container,
            records,
            visibleRecords,
            visibleCount,
            total
        });
    }

    if (total > visibleCount) {
        const button = container.querySelector(".show-more-btn");
        button?.addEventListener("click", () => {
            const nextCount = Math.min(visibleCount + stepCount, total);
            container.dataset.visibleCount = String(nextCount);
            renderPaginatedList({
                container,
                records,
                emptyMessage,
                renderItem,
                initialCount,
                stepCount,
                buttonLabel,
                listKey: key,
                afterRender
            });
        });
    }
}

function renderHistoryList(container, records, emptyMessage, options = {}) {
    renderPaginatedList({
        container,
        records,
        emptyMessage,
        emptyIcon: options.emptyIcon || "ri-history-line",
        renderItem: historyMarkup,
        initialCount: numberFrom(options.initialCount, 10),
        stepCount: numberFrom(options.stepCount, 15),
        buttonLabel: options.buttonLabel || "Show All",
        listKey: options.listKey || ""
    });
}

function historyMarkup(entry) {
    const sign = entry.direction === "debit" ? "-" : "+";
    const amountClass = entry.direction === "debit" ? "warning" : "success";

    return `
        <article class="history-row">
            <div class="history-main">
                <div class="history-title">${escapeHtml(entry.title)}</div>
                <div class="history-body">${escapeHtml(entry.message || "Account activity update")}</div>
                <div class="history-time">${escapeHtml(formatLongDate(entry.time))}</div>
            </div>
            <div style="text-align:right;">
                <div class="status-pill ${amountClass}">${sign}${formatDecimal(entry.amount)}${entry.type === "convert" || entry.type === "recharge" ? "" : " pts"}</div>
                <div class="meta-text" style="margin-top:6px;">${escapeHtml(capitalize(entry.status || "completed"))}</div>
            </div>
        </article>
    `;
}

function buildTaskStats() {
    const taskEntries = state.activity.filter((entry) => entry.type === "task" || entry.type === "spin");
    return {
        completedCount: taskEntries.length,
        earnedPoints: taskEntries.reduce((sum, item) => sum + numberFrom(item.amount, 0), 0)
    };
}

function buildSurveyStats() {
    const surveyEntries = state.activity.filter((entry) => entry.type === "survey");
    return {
        completedCount: surveyEntries.length,
        earnedPoints: surveyEntries.reduce((sum, item) => sum + numberFrom(item.amount, 0), 0)
    };
}

function createWalletEntry(entry) {
    const normalized = normalizeActivityItem({
        id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        title: entry.title,
        message: entry.message,
        amount: numberFrom(entry.amount, 0),
        type: entry.type || "wallet",
        direction: entry.direction || "credit",
        status: entry.status || "completed",
        time: new Date().toISOString(),
        taskId: entry.taskId || ""
    });

    state.activity = [normalized, ...state.activity].slice(0, 30);
    persistActivity();
}

function pushNotification(notification) {
    const normalized = normalizeNotificationItem({
        id: `noti-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        title: notification.title,
        message: notification.message,
        type: notification.type || "system",
        unread: true,
        time: new Date().toISOString()
    });

    state.notifications = [normalized, ...state.notifications].slice(0, 40);
    persistNotifications();
}

function showToast(message, type = "success") {
    const stack = document.querySelector(".app-toast-stack");
    if (!stack) {
        return;
    }

    const toast = document.createElement("div");
    toast.className = `app-toast ${type}`;
    toast.textContent = message;
    stack.appendChild(toast);

    window.setTimeout(() => {
        toast.remove();
    }, 3200);
}

function showRewardPopup({ icon, title, message, value }) {
    const modal = document.querySelector(".reward-modal");
    if (!modal) {
        return;
    }

    setText("reward-icon", icon || "🎉");
    setText("reward-title", title || "Reward unlocked");
    setText("reward-message", message || "Your action completed successfully.");
    setText("reward-value", value || "Updated");
    modal.hidden = false;
}

function hideRewardPopup() {
    const modal = document.querySelector(".reward-modal");
    if (modal) {
        modal.hidden = true;
    }
}

function showDeleteAccountFlow() {
    const modal = document.querySelector(".danger-confirm-modal");
    if (!modal) {
        return Promise.resolve(window.confirm("Schedule this account for permanent deletion after 7 days?"));
    }

    if (deleteAccountFlowResolver) {
        closeDeleteAccountFlow(false);
    } else {
        closeDeleteAccountFlow(false, { silent: true });
    }

    deleteAccountFlowStep = 0;
    syncDeleteAccountModal();
    modal.hidden = false;
    document.body.classList.add("modal-open");

    window.setTimeout(() => {
        document.getElementById("danger-confirm-confirm")?.focus();
    }, 10);

    return new Promise((resolve) => {
        deleteAccountFlowResolver = resolve;
    });
}

function syncDeleteAccountModal() {
    const step = DELETE_ACCOUNT_FLOW_STEPS[deleteAccountFlowStep] || DELETE_ACCOUNT_FLOW_STEPS[0];
    const pointsContainer = document.getElementById("danger-confirm-points");
    const ackWrap = document.getElementById("danger-confirm-ack-wrap");
    const ackInput = document.getElementById("danger-confirm-ack");
    const progress = document.getElementById("danger-confirm-progress");
    const confirmButton = document.getElementById("danger-confirm-confirm");

    setText("danger-confirm-badge", step.badge);
    setText("danger-confirm-title", step.title);
    setText("danger-confirm-message", step.message);
    setText("danger-confirm-ack-label", step.acknowledgement || "I understand this action cannot be undone.");

    if (pointsContainer) {
        pointsContainer.innerHTML = step.points.map((item) => `
            <div class="danger-confirm-point">
                <i class="ri-alert-line"></i>
                <span>${escapeHtml(item)}</span>
            </div>
        `).join("");
    }

    if (progress) {
        progress.innerHTML = DELETE_ACCOUNT_FLOW_STEPS.map((_, index) => `
            <span class="danger-confirm-dot ${index <= deleteAccountFlowStep ? "active" : ""}"></span>
        `).join("");
    }

    if (ackWrap && ackInput) {
        ackWrap.hidden = !step.acknowledgement;
        ackInput.checked = false;
    }

    if (confirmButton) {
        confirmButton.textContent = step.confirmLabel;
    }

    syncDeleteAccountConfirmButton();
}

function syncDeleteAccountConfirmButton() {
    const step = DELETE_ACCOUNT_FLOW_STEPS[deleteAccountFlowStep] || DELETE_ACCOUNT_FLOW_STEPS[0];
    const ackInput = document.getElementById("danger-confirm-ack");
    const confirmButton = document.getElementById("danger-confirm-confirm");

    if (!confirmButton) {
        return;
    }

    confirmButton.disabled = Boolean(step.acknowledgement) && !ackInput?.checked;
}

function advanceDeleteAccountFlow() {
    if (deleteAccountFlowStep < DELETE_ACCOUNT_FLOW_STEPS.length - 1) {
        deleteAccountFlowStep += 1;
        syncDeleteAccountModal();
        return;
    }

    closeDeleteAccountFlow(true);
}

function closeDeleteAccountFlow(result, options = {}) {
    const modal = document.querySelector(".danger-confirm-modal");
    if (modal) {
        modal.hidden = true;
    }

    document.body.classList.remove("modal-open");
    deleteAccountFlowStep = 0;

    if (!options.silent && deleteAccountFlowResolver) {
        const resolver = deleteAccountFlowResolver;
        deleteAccountFlowResolver = null;
        resolver(Boolean(result));
        return;
    }

    if (options.silent) {
        deleteAccountFlowResolver = null;
    }
}

function showAccountRecoveryModal(data) {
    const modal = document.querySelector(".account-recovery-modal");
    if (!modal) {
        showToast(data?.message || "Account recovery is available.", "warning");
        return;
    }

    accountRestoreContext = {
        restoreToken: data?.restoreToken || "",
        email: data?.user?.email || data?.email || "",
        deleteAfter: data?.recovery?.deleteAfter || data?.user?.deleteAfter || "",
        recoveryWindowDays: data?.recovery?.recoveryWindowDays || 7
    };

    setText("account-recovery-email", accountRestoreContext.email || "Your account");
    setText("account-recovery-deadline", accountRestoreContext.deleteAfter
        ? formatLongDate(accountRestoreContext.deleteAfter)
        : `${accountRestoreContext.recoveryWindowDays} days from now`);
    setText("account-recovery-message", data?.message || "This account is scheduled for permanent deletion, but you can still bring it back before the deadline.");
    setText("account-recovery-note", `Restore now to keep your rewards, balance, and activity history. If you do nothing, permanent deletion happens automatically after ${accountRestoreContext.recoveryWindowDays} days.`);
    modal.hidden = false;
    document.body.classList.add("modal-open");

    window.setTimeout(() => {
        document.getElementById("account-recovery-confirm")?.focus();
    }, 10);
}

function hideAccountRecoveryModal() {
    const modal = document.querySelector(".account-recovery-modal");
    if (modal) {
        modal.hidden = true;
    }

    document.body.classList.remove("modal-open");
    accountRestoreContext = null;
}

async function restoreScheduledAccount() {
    const restoreButton = document.getElementById("account-recovery-confirm");

    if (!accountRestoreContext?.restoreToken) {
        showToast("Recovery session expired. Please login again.", "error");
        hideAccountRecoveryModal();
        return;
    }

    await withButtonState(restoreButton, "Restoring...", async () => {
        const data = await requestJson("/account/restore", {
            method: "POST",
            body: { restoreToken: accountRestoreContext.restoreToken },
            auth: false
        });

        if (data?.token) {
            localStorage.setItem(STORAGE_KEYS.token, data.token);
            state.token = data.token;
        }

        state.user = normalizeUser(data?.user || data);
        persistUser(state.user);
        hideAccountRecoveryModal();
        showToast("Account restored successfully.", "success");

        window.setTimeout(() => {
            window.location.replace("home.html");
        }, 700);
    });
}

function playRewardSound() {
    playToneSequence([
        { frequency: 523.25, duration: 0.12 },
        { frequency: 659.25, duration: 0.12 },
        { frequency: 783.99, duration: 0.18 }
    ]);
}

function playSpinSound() {
    playToneSequence([
        { frequency: 220, duration: 0.08 },
        { frequency: 260, duration: 0.08 },
        { frequency: 320, duration: 0.08 },
        { frequency: 380, duration: 0.08 },
        { frequency: 460, duration: 0.1 }
    ]);
}

function startSpinTickSound(durationMs = 4800) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
        return () => {};
    }

    const context = new AudioContextClass();
    void context.resume().catch(() => {});
    let active = true;

    const playTick = () => {
        if (!active) return;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const now = context.currentTime;

        oscillator.type = "square";
        oscillator.frequency.value = 720;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.06, now + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.055);
    };

    const interval = window.setInterval(playTick, 90);
    const stop = () => {
        if (!active) return;
        active = false;
        window.clearInterval(interval);
        void context.close().catch(() => {});
    };

    window.setTimeout(stop, durationMs + 200);
    return stop;
}

function playToneSequence(steps) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
        return;
    }

    const context = new AudioContextClass();
    void context.resume().catch(() => {});
    const now = context.currentTime;

    steps.forEach((step, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = now + index * 0.08;

        oscillator.type = "triangle";
        oscillator.frequency.value = step.frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.08, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + step.duration);

        oscillator.connect(gain);
        gain.connect(context.destination);

        oscillator.start(start);
        oscillator.stop(start + step.duration + 0.02);
    });

    window.setTimeout(() => {
        void context.close().catch(() => { });
    }, 1200);
}

async function withButtonState(button, busyLabel, callback) {
    if (!button) {
        await callback();
        return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;

    try {
        await callback();
    } catch (error) {
        showToast(error.message || "Something went wrong.", "error");
    } finally {
        if (button.dataset.locked === "true") {
            button.disabled = true;
            button.textContent = button.dataset.lockedLabel || originalText;
        } else {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

async function requestFirst(variants, options = {}) {
    // Simplified to only use the first variant to avoid 405/404 spamming
    const v = variants[0];
    return requestJson(v.path, {
        method: v.method || "GET",
        body: v.body,
        auth: options.auth !== false
    });
}

async function requestJson(path, { method = "GET", body, auth = true } = {}) {
    const headers = {
        Accept: "application/json"
    };

    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    if (auth && state.token) {
        headers.Authorization = `Bearer ${state.token}`;
    }

    let response;
    const url = `${API_BASE}${API_PREFIX}${path.startsWith("/") ? "" : "/"}${path}`;
    const requestKey = method === "GET" && body === undefined
        ? `${method}:${url}:${auth ? state.token : ""}`
        : "";

    console.log(`🔗 API Call: ${method} ${url}`);

    if (requestKey && inflightRequests.has(requestKey)) {
        return inflightRequests.get(requestKey);
    }
    const fetchPromise = (async () => {
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined
            });
        } catch (networkError) {
            console.error("❌ FAILED TO FETCH:", url);
            console.error("❌ Error:", networkError.message);
            console.error("💡 Make sure 'node server.js' is running on port 5050!");
            throw new Error(`Server unreachable. Is backend running? (${networkError.message})`);
        }

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
            if (typeof payload === "object" && payload) {
                error.code = payload.code;
                error.recovery = payload.recovery;
            }
            throw error;
        }

        return payload;
    })();

    if (requestKey) {
        inflightRequests.set(requestKey, fetchPromise);
    }

    try {
        return await fetchPromise;
    } finally {
        if (requestKey) {
            inflightRequests.delete(requestKey);
        }
    }
}

function logout() {
    Object.values(STORAGE_KEYS).forEach((key) => {
        localStorage.removeItem(key);
    });
    state.token = "";
    state.user = null;
    state.activity = [];
    state.notifications = [];
    window.location.replace("index.html");
}

function redirectToLogin() {
    window.location.replace("index.html");
}

function readStore(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
        return fallback;
    }
}

function persistUser(user) {
    state.user = normalizeUser(user);
    // User data is NOT stored in localStorage - only in MongoDB
    // This ensures data consistency across devices
    syncUserLocalCache(state.user);
}

function syncUserLocalCache(user) {
    if (!user) {
        return;
    }

    const userKey = String(user.id || user.email || "").trim().toLowerCase();
    if (!userKey) {
        return;
    }

    try {
        const previous = localStorage.getItem(STORAGE_KEYS.activeUser) || "";
        if (previous && previous !== userKey) {
            localStorage.removeItem(STORAGE_KEYS.notifications);
            localStorage.removeItem(STORAGE_KEYS.activity);
            localStorage.removeItem(STORAGE_KEYS.tasks);
            localStorage.removeItem(STORAGE_KEYS.watchState);
            localStorage.removeItem(STORAGE_KEYS.referralSeenCount);
            state.notifications = [];
            state.activity = [];
            updateSidebarUnreadBadge(0);
        }

        localStorage.setItem(STORAGE_KEYS.activeUser, userKey);
    } catch (error) {
        // Ignore storage errors (private mode, quota, etc.)
    }
}

function persistNotifications(list = state.notifications) {
    const normalized = normalizeNotifications(Array.isArray(list) ? list : []);
    state.notifications = normalized;
    localStorage.setItem(STORAGE_KEYS.notifications, JSON.stringify(state.notifications.slice(0, 40)));
    updateSidebarUnreadBadge();
}

function persistActivity() {
    localStorage.setItem(STORAGE_KEYS.activity, JSON.stringify(state.activity.slice(0, 40)));
}

function activityDedupKey(item) {
    return [
        item.taskId || "",
        item.type || "",
        item.title || "",
        item.message || "",
        numberFrom(item.amount, 0),
        toTimestamp(item.time)
    ].join(":");
}

function syncActivityState(records, { replace = false } = {}) {
    const normalized = normalizeActivity(records || []);
    const merged = replace
        ? normalized
        : uniqueByKey([...normalized, ...state.activity], activityDedupKey)
            .sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time));

    state.activity = merged.slice(0, 40);
    persistActivity();
    return state.activity;
}

function normalizeUser(user) {
    if (!user) {
        return null;
    }

    const existingReferralCode = state.user?.referralCode || "";

    return {
        id: user.id || user._id || "",
        name: user.name || user.fullName || user.userName || "AnviPayz User",
        email: user.email || "",
        phone: user.phone || user.mobile || user.phoneNumber || "",
        points: numberFrom(user.points, user.balance, user.walletPoints, 0),
        tokens: roundTo(numberFrom(user.tokens, user.tokenBalance, user.walletTokens, 0), 2),
        referrals: numberFrom(user.referrals, user.totalReferrals, user.referralCount, 0),
        referralEarnings: numberFrom(user.referralEarnings, user.referIncome, user.referralIncome, 0),
        taskEarnings: numberFrom(user.taskEarnings, user.taskRewards, user.taskIncome, 0),
        surveyEarnings: numberFrom(user.surveyEarnings, user.surveyIncome, 0),
        joinedAt: user.joinedAt || user.createdAt || user.registeredAt || new Date().toISOString(),
        referralCode: user.referralCode || user.refCode || user.myReferCode || existingReferralCode,
        accountStatus: user.accountStatus || "active",
        deletionRequestedAt: user.deletionRequestedAt || null,
        deleteAfter: user.deleteAfter || null,
        recoveryWindowDays: numberFrom(user.recoveryWindowDays, 7)
    };
}

function normalizeTaskList(tasks) {
    return (Array.isArray(tasks) ? tasks : []).map((task) => ({
        id: task.id || task._id || `task-${Math.random().toString(16).slice(2, 7)}`,
        title: task.title || "Task",
        description: task.description || task.desc || "",
        rewardPoints: numberFrom(task.rewardPoints, task.points, task.reward, 0),
        taskType: task.taskType || task.type || "task",
        completed: Boolean(task.completed),
        link: task.link || task.url || ""
    }));
}

function normalizeNotifications(list) {
    return (Array.isArray(list) ? list : []).map(normalizeNotificationItem);
}

function normalizeNotificationItem(item) {
    const message = item.message || item.body || "";
    return {
        id: item.id || item._id || `noti-${Math.random().toString(16).slice(2, 8)}`,
        title: normalizeDisplayTitle(item.title, {
            fallback: "Notification",
            type: item.type,
            message
        }),
        message,
        type: item.type || "system",
        unread: item.unread !== undefined ? Boolean(item.unread) : item.read !== undefined ? !Boolean(item.read) : true,
        time: item.time || item.date || item.createdAt || new Date().toISOString()
    };
}

function notificationDedupKey(item) {
    return `${item.type}:${item.title}:${item.message}:${toTimestamp(item.time)}`;
}

function mergeNotifications(primary, secondary) {
    const readLookup = new Map(
        (Array.isArray(secondary) ? secondary : []).map((item) => [notificationDedupKey(item), item?.unread])
    );

    return uniqueByKey([...primary, ...secondary], notificationDedupKey)
        .map((item) => {
            const key = notificationDedupKey(item);
            if (readLookup.has(key)) {
                return { ...item, unread: readLookup.get(key) };
            }
            return item;
        })
        .sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time));
}

function normalizeActivity(list) {
    return (Array.isArray(list) ? list : []).map(normalizeActivityItem)
        .sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time));
}

function normalizeActivityItem(item) {
    const message = item.message || item.description || "";
    return {
        id: item.id || item._id || `act-${Math.random().toString(16).slice(2, 8)}`,
        title: normalizeDisplayTitle(item.title || item.name, {
            fallback: "Account activity",
            type: item.type,
            message
        }),
        message,
        amount: numberFrom(item.amount, item.points, item.value, 0),
        type: item.type || "wallet",
        direction: item.direction || (numberFrom(item.amount, 0) < 0 ? "debit" : "credit"),
        status: item.status || "completed",
        time: item.time || item.date || item.createdAt || new Date().toISOString(),
        taskId: item.taskId || item.taskKey || ""
    };
}

function normalizeNetwork(list) {
    return (Array.isArray(list) ? list : []).map((person) => ({
        name: person.name || person.fullName || "New referral",
        email: person.email || "",
        reward: numberFrom(person.reward, person.points, 0),
        time: person.time || person.createdAt || new Date().toISOString()
    }));
}

function isTaskCompleted(taskId) {
    const taskState = todayTaskState();
    return Boolean(taskState.completed?.[taskId]);
}

function markTaskCompleted(taskId) {
    const taskState = todayTaskState();
    taskState.completed = taskState.completed || {};
    taskState.completed[taskId] = new Date().toISOString();
    localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(taskState));
}

function todayTaskState() {
    const saved = readStore(STORAGE_KEYS.tasks, {});
    const key = todayKey();
    if (saved.date !== key) {
        return { date: key, completed: {} };
    }

    return saved;
}

function todayKey() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: INDIA_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}

function updateTaskButton(button, taskId, doneLabel) {
    if (!button) {
        return;
    }

    if (isTaskCompleted(taskId)) {
        button.disabled = true;
        button.textContent = doneLabel;
    }
}

function emptyStateMarkup(icon, message) {
    return `
        <div class="empty-state">
            <i class="${icon}"></i>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function setAllText(id, value) {
    document.querySelectorAll(`[id="${id}"]`).forEach((element) => {
        element.textContent = value;
    });
}

function formatNumber(value) {
    return Math.round(numberFrom(value, 0)).toLocaleString("en-IN");
}

function formatDecimal(value) {
    const formatted = roundTo(numberFrom(value, 0), 2).toFixed(2);
    return formatted.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function formatLongDate(value) {
    const timestamp = toTimestamp(value);
    if (!timestamp) {
        return "-";
    }

    return new Date(timestamp).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function formatRelative(value) {
    const timestamp = toTimestamp(value);
    if (!timestamp) {
        return "Just now";
    }

    const diff = Date.now() - timestamp;
    if (diff < 60 * 1000) {
        return "Just now";
    }

    if (diff < 60 * 60 * 1000) {
        return `${Math.floor(diff / (60 * 1000))}m ago`;
    }

    if (diff < 24 * 60 * 60 * 1000) {
        return `${Math.floor(diff / (60 * 60 * 1000))}h ago`;
    }

    return `${Math.floor(diff / (24 * 60 * 60 * 1000))}d ago`;
}

function createReferralCode(user) {
    const base = (user?.name || user?.email || "anvi").replace(/[^a-z0-9]/gi, "").toUpperCase();
    const suffix = ((user?.id || user?.email || "000000").replace(/[^a-z0-9]/gi, "").slice(-6) || "000000").toUpperCase();
    return `${base.slice(0, 4) || "ANVI"}${suffix}`;
}

function initialsFromName(name) {
    return String(name || "A")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join("") || "A";
}

function firstName(name) {
    return String(name || "Member").split(" ")[0] || "Member";
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function maskEmail(email) {
    const raw = String(email || "").trim();
    if (!raw || !raw.includes("@")) {
        return raw;
    }

    const [local, domain] = raw.split("@");
    if (!local || !domain) {
        return raw;
    }

    const visibleStart = local.slice(0, Math.min(6, local.length));
    const visibleEnd = local.length > 1 ? local.slice(-1) : "";
    const dots = ".....";

    if (local.length <= 2) {
        return `${local.charAt(0) || "*"}${dots}@${domain}`;
    }

    return `${visibleStart}${dots}${visibleEnd}@${domain}`;
}

function numberFrom(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) {
            return number;
        }
    }

    return 0;
}

function roundTo(value, digits) {
    const factor = 10 ** digits;
    return Math.round(numberFrom(value, 0) * factor) / factor;
}

function toTimestamp(value) {
    if (!value) {
        return 0;
    }

    if (typeof value === "number") {
        return value > 100_000_000_000 ? value : value * 1000;
    }

    if (typeof value === "string") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return numeric > 100_000_000_000 ? numeric : numeric * 1000;
        }

        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    if (typeof value.toMillis === "function") {
        return value.toMillis();
    }

    if (typeof value.seconds === "number") {
        return value.seconds * 1000;
    }

    return 0;
}

function uniqueByKey(list, keyFn) {
    const seen = new Set();
    return list.filter((item) => {
        const key = keyFn(item);
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function capitalize(value) {
    const raw = String(value || "");
    if (!raw) {
        return "";
    }

    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function normalizeDisplayTitle(value, { fallback = "Item", type = "", message = "" } = {}) {
    const raw = String(value || "").trim();
    if (!raw) {
        return fallback;
    }

    const compact = raw.toLowerCase();
    const aliasMap = {
        fttr: "Reward Credit",
        rtrr: "Reward Credit"
    };
    if (aliasMap[compact]) {
        return aliasMap[compact];
    }

    const cleaned = raw
        .replace(/[_-]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();

    if (/^[a-z0-9 ]+$/i.test(cleaned)) {
        const titled = cleaned
            .split(" ")
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
            .join(" ");

        if (/^[a-z]{2,5}$/i.test(raw) && /credited successfully|coins added|reward/i.test(message)) {
            return type === "survey" ? "Survey Reward" : "Reward Credit";
        }

        return titled || fallback;
    }

    return cleaned || fallback;
}

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
