// ChessRadar account auth (talks to the chess-radar Node API, never MongoDB).
(() => {
  // Change this when you deploy the API. Keep in sync with host_permissions.
  const API_BASE = "http://localhost:4000";

  async function api(path, { method = "GET", body, token } = {}) {
    const headers = { Accept: "application/json" };
    if (body != null) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Cannot reach ChessRadar API. Is the backend running?");
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function getSession() {
    const { authToken = "", authUser = null } = await chrome.storage.local.get(["authToken", "authUser"]);
    return { token: authToken || "", user: authUser || null };
  }

  async function setSession(token, user) {
    await chrome.storage.local.set({ authToken: token || "", authUser: user || null });
  }

  async function clearSession() {
    await chrome.storage.local.remove(["authToken", "authUser"]);
  }

  async function register({ email, username, password }) {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: { email, username, password },
    });
    await setSession(data.token, data.user);
    return data;
  }

  async function login({ emailOrUsername, password }) {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: { emailOrUsername, password },
    });
    await setSession(data.token, data.user);
    return data;
  }

  async function me() {
    const { token } = await getSession();
    if (!token) return null;
    try {
      const data = await api("/api/auth/me", { token });
      await setSession(token, data.user);
      return data.user;
    } catch {
      await clearSession();
      return null;
    }
  }

  async function logout() {
    const { token } = await getSession();
    if (token) {
      try {
        await api("/api/auth/logout", { method: "POST", token });
      } catch {
        // offline logout is fine
      }
    }
    await clearSession();
  }

  window.ChessRadarAuth = {
    API_BASE,
    getSession,
    setSession,
    clearSession,
    register,
    login,
    me,
    logout,
  };
})();
