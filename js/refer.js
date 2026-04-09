document.addEventListener("DOMContentLoaded", () => {
    const container = document.querySelector(".ref-container");
    if (!container) {
        return;
    }

    const progressText = document.getElementById("daily-limit-text");
    const progressFill = document.getElementById("ref-progress-fill");
    const progressBar = document.querySelector(".ref-progress-bar");
    const leaderboard = document.getElementById("referral-list");

    const updateProgress = () => {
        if (!progressText || !progressFill) {
            return;
        }

        const raw = progressText.textContent || "";
        const match = raw.match(/(\d+)\s*\/\s*(\d+)/);
        const current = match ? Number(match[1]) : 0;
        const total = match ? Number(match[2]) : 0;
        const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

        progressFill.style.width = `${percent}%`;

        if (progressBar) {
            progressBar.setAttribute("aria-valuenow", String(current));
            progressBar.setAttribute("aria-valuemax", String(total || 0));
        }
    };

    const normalizeEmptyState = () => {
        if (!leaderboard) {
            return;
        }

        const emptyText = leaderboard.querySelector(".empty-state p");
        if (emptyText) {
            emptyText.textContent = "No leaderboard data yet";
        }

        const placeholder = leaderboard.querySelector(".ref-empty");
        if (placeholder) {
            placeholder.textContent = "No leaderboard data yet";
        }
    };

    updateProgress();
    normalizeEmptyState();

    if (progressText) {
        const progressObserver = new MutationObserver(updateProgress);
        progressObserver.observe(progressText, { childList: true, characterData: true, subtree: true });
    }

    if (leaderboard) {
        const leaderboardObserver = new MutationObserver(normalizeEmptyState);
        leaderboardObserver.observe(leaderboard, { childList: true, subtree: true });
    }
});
