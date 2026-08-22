/**
 * DPRO NAIL PRODUCT READY SECURITY LAYER
 * Version: NAIL-PR1-20260822
 * Canonical SYSTEM_CODE: NAIL
 *
 * This file is intentionally thin. It does not redesign the existing UI.
 * It upgrades request credentials at the browser boundary:
 * - DEMO nail_demo keeps the existing management code flow.
 * - Production Owner calls use DPRO Common Owner Auth bearer session.
 * - Production customer-private / booking calls attach a LIFF ID token for Worker-side verification.
 * - Optional staff_mode on owner-ipad exchanges a verified Owner/demo session for a short-lived scoped staff token.
 */
(() => {
  "use strict";

  const VERSION = "NAIL-PR1-20260822";
  const SYSTEM_CODE = "NAIL";
  const WORKER_ORIGIN = "https://dpro-nail-line-api.dpromstk2000.workers.dev";
  const OWNER_AUTH_LOGIN = "https://dpromstk2000-lab.github.io/dpro-owner-auth/login.html";
  const OWNER_SESSION_KEY = "dpro_owner_session";
  const STAFF_SESSION_KEY = "dpro_nail_staff_session";
  const STAFF_EXPIRES_KEY = "dpro_nail_staff_session_expires_at";
  const OWNER_PLACEHOLDER = "OWNER_SESSION";
  const DEMO_SHOP = "nail_demo";
  const params = new URLSearchParams(location.search);
  const shopCode = String(params.get("shop_code") || DEMO_SHOP).trim();
  const explicitProduction = params.get("demo") === "0" || shopCode !== DEMO_SHOP;
  const demo = !explicitProduction && shopCode === DEMO_SHOP;
  const staffMode = params.get("staff_mode") === "1" && Boolean(params.get("staff_code") || params.get("staff_id"));
  const nativeFetch = window.fetch.bind(window);
  let redirecting = false;

  function getStored(keys) {
    for (const storage of [sessionStorage, localStorage]) {
      for (const key of keys) {
        try {
          const value = storage.getItem(key);
          if (value) return value;
        } catch (_) {}
      }
    }
    return "";
  }

  function getOwnerToken() {
    return getStored([OWNER_SESSION_KEY]);
  }

  function getStaffToken() {
    const token = getStored([STAFF_SESSION_KEY]);
    const expiresAt = getStored([STAFF_EXPIRES_KEY]);
    if (!token) return "";
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      try { sessionStorage.removeItem(STAFF_SESSION_KEY); } catch (_) {}
      try { sessionStorage.removeItem(STAFF_EXPIRES_KEY); } catch (_) {}
      return "";
    }
    return token;
  }

  function currentFacilityCode() {
    return String(params.get("facility_code") || params.get("facility") || shopCode).trim();
  }

  function ownerLoginUrl() {
    const q = new URLSearchParams({
      project: "GENERAL",
      system: SYSTEM_CODE,
      facility: currentFacilityCode(),
      next: location.pathname + location.search + location.hash
    });
    return `${OWNER_AUTH_LOGIN}?${q.toString()}`;
  }

  function redirectToOwnerLogin() {
    if (demo || redirecting) return;
    redirecting = true;
    location.replace(ownerLoginUrl());
  }

  function isWorkerUrl(input) {
    try {
      const u = input instanceof Request ? new URL(input.url) : new URL(String(input), location.href);
      return u.origin === WORKER_ORIGIN;
    } catch (_) {
      return false;
    }
  }

  function parseBody(init) {
    if (!init || typeof init.body !== "string") return null;
    try { return JSON.parse(init.body); } catch (_) { return null; }
  }

  function stripLegacyCredentials(url, init) {
    for (const key of ["admin_code", "admin_token", "code"]) url.searchParams.delete(key);
    const body = parseBody(init);
    if (body && typeof body === "object") {
      delete body.admin_code;
      delete body.admin_token;
      delete body.code;
      init.body = JSON.stringify(body);
    }
  }

  async function getLineIdToken() {
    try {
      if (window.liff && typeof window.liff.getIDToken === "function") {
        if (typeof window.liff.isLoggedIn === "function" && !window.liff.isLoggedIn()) return "";
        return String(window.liff.getIDToken() || "").trim();
      }
    } catch (_) {}
    return "";
  }

  function isCustomerPrivatePath(path) {
    return [
      "/api/public/customer",
      "/api/public/repeat-template",
      "/api/reservations/create",
      "/api/reservations/change",
      "/api/reservations/cancel",
      "/api/reservations/repeat"
    ].includes(path);
  }

  function isAdminPath(path) {
    return path.startsWith("/api/admin/") || path === "/api/line/log-copy" || path === "/api/security/staff/session";
  }

  function isStaffAllowedRewrite(path) {
    if (path === "/api/admin/day") return "/api/staff/day";
    if (path === "/api/admin/reservations/workflow") return "/api/staff/reservations/workflow";
    return "";
  }

  function blockUnscopedStaffAdmin(path) {
    return new Response(JSON.stringify({
      ok: false,
      error: "staff_scope_forbidden",
      error_code: "STAFF_SCOPE_FORBIDDEN",
      message: "スタッフモードでは担当予約の確認・進捗更新だけ利用できます。",
      path,
      systemCode: SYSTEM_CODE
    }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  async function secureWorkerFetch(input, init = {}) {
    const sourceRequest = input instanceof Request ? input : null;
    const url = new URL(sourceRequest ? sourceRequest.url : String(input), location.href);
    const nextInit = { ...init, headers: new Headers(init.headers || sourceRequest?.headers || {}) };
    const method = String(nextInit.method || sourceRequest?.method || "GET").toUpperCase();
    let path = url.pathname;

    nextInit.headers.set("X-DPRO-Frontend-Version", VERSION);

    if (!demo && isCustomerPrivatePath(path)) {
      const idToken = await getLineIdToken();
      if (!idToken) {
        throw new Error("本番利用ではLINE本人確認が必要です。LINE内の正規LIFF画面から開いてください。");
      }
      nextInit.headers.set("X-Line-ID-Token", idToken);
      for (const key of ["line_user_id", "line_id", "phone", "customer_no"]) {
        if (method === "GET") url.searchParams.delete(key);
      }
      const body = parseBody(nextInit);
      if (body && typeof body === "object") {
        delete body.line_user_id;
        delete body.line_id;
        delete body.lineUserId;
        delete body.customer_id;
        delete body.id_token;
        delete body.idToken;
        nextInit.body = JSON.stringify(body);
      }
    }

    if (!demo && isAdminPath(path)) {
      stripLegacyCredentials(url, nextInit);
      const staffToken = staffMode ? getStaffToken() : "";
      const rewrite = staffToken ? isStaffAllowedRewrite(path) : "";
      if (staffToken && rewrite) {
        url.pathname = rewrite;
        path = rewrite;
        nextInit.headers.set("Authorization", `Bearer ${staffToken}`);
      } else if (staffToken && path.startsWith("/api/admin/")) {
        return blockUnscopedStaffAdmin(path);
      } else {
        const ownerToken = getOwnerToken();
        if (!ownerToken) {
          redirectToOwnerLogin();
          throw new Error("オーナーログインへ移動します。");
        }
        nextInit.headers.set("Authorization", `Bearer ${ownerToken}`);
      }
    }

    const response = await nativeFetch(url.toString(), nextInit);
    if (!demo && response.status === 401 && isAdminPath(path) && !staffMode) {
      redirectToOwnerLogin();
    }
    return response;
  }

  window.fetch = async function dproNailSecureFetch(input, init) {
    if (!isWorkerUrl(input)) return nativeFetch(input, init);
    return secureWorkerFetch(input, init || {});
  };

  async function provisionStaffSession() {
    const staffCode = String(params.get("staff_code") || "").trim();
    const staffId = String(params.get("staff_id") || "").trim();
    if (!staffMode || (!staffCode && !staffId)) return null;
    const existing = getStaffToken();
    if (existing) return existing;

    const body = { shop_code: shopCode };
    if (staffCode) body.staff_code = staffCode;
    if (staffId) body.staff_id = staffId;
    if (demo) body.admin_code = "1234";

    const response = await window.fetch(`${WORKER_ORIGIN}/api/security/staff/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false || !data.staffSessionToken) {
      throw new Error(data.message || data.error || "スタッフセッションを開始できませんでした。");
    }
    sessionStorage.setItem(STAFF_SESSION_KEY, data.staffSessionToken);
    sessionStorage.setItem(STAFF_EXPIRES_KEY, data.expiresAt || "");
    return data.staffSessionToken;
  }

  function primeExistingOwnerUi() {
    if (demo) return;
    if (!getOwnerToken()) {
      redirectToOwnerLogin();
      return;
    }
    // Existing UI uses non-empty management-code storage only as its unlock trigger.
    // The placeholder is not a credential; secureWorkerFetch removes it before every production request.
    try { localStorage.setItem("DPRO_NAIL_OWNER_ADMIN_CODE", OWNER_PLACEHOLDER); } catch (_) {}
    try { localStorage.setItem("DPRO_NAIL_ADMIN_CODE", OWNER_PLACEHOLDER); } catch (_) {}
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!demo) primeExistingOwnerUi();
    if (staffMode) {
      try {
        await provisionStaffSession();
        document.documentElement.dataset.dproStaffScoped = "1";
      } catch (error) {
        console.error("DPRO NAIL staff session:", error);
      }
    }
    document.documentElement.dataset.dproNailPr1 = VERSION;
  }, { once: true });

  window.DPRO_NAIL_PR1 = Object.freeze({
    version: VERSION,
    systemCode: SYSTEM_CODE,
    workerOrigin: WORKER_ORIGIN,
    demo,
    staffMode,
    getOwnerToken,
    getStaffToken,
    provisionStaffSession,
    ownerLoginUrl
  });
})();
