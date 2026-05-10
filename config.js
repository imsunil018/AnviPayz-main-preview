const API_BASE_URL =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
        ? "http://localhost:5000"
        : "https://anvipayz-main-preview-production.up.railway.app";

const ADMIN_API_BASE_URL = `${API_BASE_URL}/api/admin`;
