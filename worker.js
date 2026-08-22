// =========================================================
// DPRO NAIL LINE NEXT
// STEP NAIL-NEXT-3
// Cloudflare Worker API / SAFE-COMPAT COMPLETE
// Version: NAIL-NEXT-3-WORKER-API-COMPLETE-20260722
//
// Required environment variables:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY or SUPABASE_SECRET_KEY
// Optional:
// - SHOP_CODE (default: nail_demo)
// - ADMIN_CODE (default: DB nail_settings.admin_code)
// - PHOTO_UPLOAD_SECRET (default: Supabase service key)
//
// Design:
// - Existing routes and response keys are preserved.
// - NEXT routes are additive.
// - Browser pages never connect to Supabase directly.
// - nail-media remains private; media is proxied/signed by this Worker.
// =========================================================

const BASELINE_WORKER_VERSION = "NAIL-NEXT-3-WORKER-API-COMPLETE-20260722";
const WORKER_VERSION = "NAIL-PR1-SECURITY-BOUNDARY-20260822";
const EXPECTED_WORKER_VERSION = "NAIL-PR1-SECURITY-BOUNDARY-20260822";
const EXPECTED_DATABASE_VERSION = "NAIL-NEXT-2-SUPABASE-20260722";
const FRONTEND_RELEASE_VERSION = "NAIL-PR1-20260822";
const EXPECTED_FRONTEND_VERSION = "NAIL-PR1-20260822";
const SYSTEM_CODE = "NAIL";
const LEGACY_INTERNAL_RELEASE_IDENTIFIER = "DPRO_NAIL_LINE_NEXT";
const SOURCE_LOCK_COMMIT = "64f79fd443edd763901bcacafe37639ee6944063";
const RECOVERED_BASELINE_SHA256 = "914567cf337f608eec640ac213b08af11de73980e861c96239232bfe2d08f431";
const DEFAULT_OWNER_AUTH_URL = "https://dpro-owner-auth-general.dpromstk2000.workers.dev";
const CANONICAL_BROWSER_ORIGIN = "https://dpromstk2000-lab.github.io";
const STAFF_TOKEN_PREFIX = "nsv1";
const STAFF_TOKEN_ISSUER = "DPRO_NAIL";
const STAFF_ROLE = "staff";
const STAFF_SCOPES = Object.freeze(["day.read", "workflow.write"]);
const STAFF_SESSION_TTL_SECONDS = 900;
const AUTH_CONTEXT = new WeakMap();
const DEFAULT_SHOP_CODE = "nail_demo";
const MEDIA_BUCKET = "nail-media";
const ACTIVE_RESERVATION_STATUSES = [
  "reserved", "confirmed", "changed", "manual",
  "phone_reserved", "shop_reserved", "instagram_reserved"
];
const CLOSED_RESERVATION_STATUSES = [
  "cancelled", "changed_before", "completed", "no_show", "deleted"
];
const WORKFLOW_STATUSES = [
  "reserved", "arrived", "preparing", "in_service",
  "checkout_wait", "completed", "cancelled", "no_show"
];
const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": CANONICAL_BROWSER_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With, X-Admin-Code, X-Admin-Token, X-Line-ID-Token, X-DPRO-Frontend-Version",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const EXISTING_ROUTE_CONTRACT = [
  "GET /",
  "GET /api/health",
  "GET /api/public/status",
  "GET /api/public/services",
  "GET /api/public/options",
  "GET /api/public/staff",
  "GET /api/public/available-days",
  "GET /api/public/available-times",
  "GET /api/public/customer",
  "POST /api/reservations/create",
  "POST /api/reservations/change",
  "POST /api/reservations/cancel",
  "GET /api/admin/settings",
  "POST /api/admin/settings/update",
  "GET /api/admin/staff",
  "GET /api/admin/services",
  "POST /api/admin/services/update",
  "POST /api/admin/options/update",
  "POST /api/admin/staff/update",
  "POST /api/admin/staff-services/update",
  "GET /api/admin/day",
  "GET /api/admin/summary",
  "GET /api/admin/customers/search",
  "POST /api/admin/reservations/manual-create",
  "POST /api/admin/followups/update-status",
  "POST /api/admin/demo/prepare",
  "POST /api/line/log-copy"
];

const NEXT_ROUTE_CONTRACT = [
  "GET /api/public/designs",
  "GET /api/public/designs/detail",
  "GET /api/public/media",
  "GET /api/public/repeat-template",
  "POST /api/reservations/repeat",
  "GET /api/admin/customers/detail",
  "GET /api/admin/designs",
  "POST /api/admin/designs/save",
  "POST /api/admin/designs/archive",
  "GET /api/admin/treatments",
  "POST /api/admin/treatments/save",
  "POST /api/admin/treatments/complete",
  "POST /api/admin/reservations/workflow",
  "GET /api/admin/reservations/workflow-history",
  "POST /api/admin/photos/prepare",
  "PUT /api/admin/photos/upload",
  "POST /api/admin/photos/complete",
  "GET /api/admin/photos/signed-url",
  "POST /api/admin/photos/delete",
  "GET /api/admin/system-check"
];

const SECURITY_ROUTE_CONTRACT = Object.freeze([
  "POST /api/security/staff/session",
  "GET /api/staff/day",
  "POST /api/staff/reservations/workflow"
]);

class AppError extends Error {
  constructor(status, message, detail = null, code = "APP_ERROR") {
    super(message);
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const requestOrigin = clean(request.headers.get("Origin"));
    if (requestOrigin && requestOrigin !== CANONICAL_BROWSER_ORIGIN) {
      return new Response(JSON.stringify({
        ok: false,
        error: "origin_not_allowed",
        error_code: "ORIGIN_NOT_ALLOWED",
        systemCode: SYSTEM_CODE
      }), {
        status: 403,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const started = Date.now();
    const requestId = crypto.randomUUID();

    try {
      assertEnv(env);
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);
      const method = request.method.toUpperCase();

      // Health / public compatibility
      if (method === "GET" && (path === "/" || path === "/api/health")) {
        return json(await health(env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/status") {
        return json(await publicStatus(url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/services") {
        return json(await publicServices(url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/options") {
        return json(await publicOptions(url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/staff") {
        return json(await publicStaff(url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/available-days") {
        return json(await publicAvailableDays(url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/available-times") {
        return json(await publicAvailableTimes(url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/customer") {
        const secureUrl = await secureCustomerIdentityUrl(request, url, env);
        return json(await publicCustomer(secureUrl, env), 200, requestId, started);
      }

      // NEXT public
      if (method === "GET" && path === "/api/public/designs") {
        return json(await publicDesigns(request, url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/designs/detail") {
        return json(await publicDesignDetail(request, url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/public/media") {
        return await publicMedia(request, url, env, requestId, started);
      }
      if (method === "GET" && path === "/api/public/repeat-template") {
        const secureUrl = await secureCustomerIdentityUrl(request, url, env);
        return json(await publicRepeatTemplate(secureUrl, env), 200, requestId, started);
      }

      // Reservation compatibility / NEXT repeat
      if (method === "POST" && path === "/api/reservations/create") {
        const body = await secureCustomerIdentityBody(request, await readJson(request), env);
        return json(await createReservation(body, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/reservations/change") {
        const body = await secureCustomerIdentityBody(request, await readJson(request), env);
        return json(await changeReservation(body, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/reservations/cancel") {
        const body = await secureCustomerIdentityBody(request, await readJson(request), env);
        return json(await cancelReservation(body, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/reservations/repeat") {
        const body = await secureCustomerIdentityBody(request, await readJson(request), env);
        return json(await repeatReservation(body, env), 200, requestId, started);
      }

      // PRODUCT READY SECURITY / staff scoped session
      if (method === "POST" && path === "/api/security/staff/session") {
        const body = await readJson(request);
        return json(await issueStaffSessionRoute(request, body, env), 201, requestId, started);
      }
      if (method === "GET" && path === "/api/staff/day") {
        return json(await staffDayRoute(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/staff/reservations/workflow") {
        const body = await readJson(request);
        return json(await staffWorkflowRoute(request, body, env), 200, requestId, started);
      }

      // Existing admin
      if (method === "GET" && path === "/api/admin/settings") {
        return json(await adminSettings(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/settings/update") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_settings_update", "nail_settings",
          () => adminUpdateSettings(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/staff") {
        return json(await adminStaff(request, url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/services") {
        return json(await adminServices(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/services/update") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_service_update", "nail_services",
          () => adminUpdateService(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/options/update") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_option_update", "nail_service_options",
          () => adminUpdateOption(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/staff/update") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_staff_update", "nail_staff",
          () => adminUpdateStaff(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/staff-services/update") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_staff_services_update", "nail_staff_services",
          () => adminUpdateStaffServices(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/day") {
        return json(await adminDay(request, url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/summary") {
        return json(await adminSummary(request, url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/customers/search") {
        return json(await adminCustomerSearch(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/reservations/manual-create") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_manual_reservation_create", "nail_reservations",
          () => adminManualReservationCreate(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/followups/update-status") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_followup_update", "nail_followups",
          () => adminUpdateFollowupStatus(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/demo/prepare") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_demo_prepare", "nail_settings",
          () => adminPrepareDemo(request, body, env)
        ), 200, requestId, started);
      }

      // NEXT admin
      if (method === "GET" && path === "/api/admin/customers/detail") {
        return json(await adminCustomerDetail(request, url, env), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/designs") {
        return json(await adminDesigns(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/designs/save") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_design_save", "nail_design_catalog",
          () => adminSaveDesign(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/designs/archive") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_design_archive", "nail_design_catalog",
          () => adminArchiveDesign(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/treatments") {
        return json(await adminTreatments(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/treatments/save") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_treatment_save", "nail_treatment_records",
          () => adminSaveTreatment(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/treatments/complete") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_treatment_complete", "nail_treatment_records",
          () => adminCompleteTreatment(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/reservations/workflow") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_workflow_update", "nail_reservations",
          () => adminUpdateWorkflow(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/reservations/workflow-history") {
        return json(await adminWorkflowHistory(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/photos/prepare") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_photo_prepare", "nail_treatment_photos",
          () => adminPhotoPrepare(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "PUT" && path === "/api/admin/photos/upload") {
        return json(await runVerifiedOwnerMutation(
          request, env, {}, "owner_photo_upload", "storage.objects",
          () => adminPhotoUpload(request, url, env)
        ), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/photos/complete") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_photo_complete", "nail_treatment_photos",
          () => adminPhotoComplete(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/photos/signed-url") {
        return json(await adminPhotoSignedUrl(request, url, env), 200, requestId, started);
      }
      if (method === "POST" && path === "/api/admin/photos/delete") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_photo_delete", "nail_treatment_photos",
          () => adminPhotoDelete(request, body, env)
        ), 200, requestId, started);
      }
      if (method === "GET" && path === "/api/admin/system-check") {
        return json(await adminSystemCheck(request, url, env), 200, requestId, started);
      }

      // Existing LINE log
      if (method === "POST" && path === "/api/line/log-copy") {
        const body = await readJson(request);
        return json(await runVerifiedOwnerMutation(
          request, env, body, "owner_line_log_copy", "nail_line_messages",
          () => logLineCopy(request, body, env)
        ), 200, requestId, started);
      }

      return json({
        ok: false,
        error: "not_found",
        path,
        method,
        worker_version: WORKER_VERSION,
        systemCode: SYSTEM_CODE
      }, 404, requestId, started);
    } catch (error) {
      const status = Number(error?.status || 500);
      return json({
        ok: false,
        error: error?.message || "Internal Server Error",
        error_code: error?.code || "INTERNAL_ERROR",
        detail: error?.detail || null,
        worker_version: WORKER_VERSION,
        systemCode: SYSTEM_CODE
      }, status, requestId, started);
    }
  }
};

// =========================================================
// Health / public configuration
// =========================================================

async function health(env) {
  const shopCode = clean(env.SHOP_CODE || DEFAULT_SHOP_CODE);
  let databaseCheck = null;
  let settings = null;
  try {
    databaseCheck = await sbRpc(env, "nail_next_system_check", { p_shop_code: shopCode });
  } catch (error) {
    databaseCheck = { ok: false, error: clean(error?.message || error), version: "" };
  }
  try {
    settings = await getSettings(env, shopCode);
  } catch (error) {
    settings = { shop_code: shopCode, demo_mode: false, error: clean(error?.message || error) };
  }

  const databaseCurrent = clean(databaseCheck?.version);
  const frontendCurrent = FRONTEND_RELEASE_VERSION;
  const workerAligned = WORKER_VERSION === EXPECTED_WORKER_VERSION;
  const databaseAligned = databaseCurrent === EXPECTED_DATABASE_VERSION;
  const frontendAligned = frontendCurrent === EXPECTED_FRONTEND_VERSION;
  const versionsAligned = workerAligned && databaseAligned && frontendAligned;
  const isDemo = isExplicitDemoRuntime(shopCode, settings, env);
  const production = !isDemo;
  const facilityCode = expectedFacilityCode(shopCode, env);
  const staffBoundaryReady = Boolean(getStaffSessionSecret(env));
  const lineIdentityConfigured = !production || Boolean(clean(env.LINE_LOGIN_CHANNEL_ID));
  const ownerAuthConfigured = !production || Boolean(clean(env.OWNER_AUTH_URL || DEFAULT_OWNER_AUTH_URL));
  const productionGuard = isDemo
    ? shopCode === "nail_demo" && Boolean(settings?.demo_mode)
    : shopCode !== "nail_demo" && Boolean(facilityCode);
  const systemCheckReady = Boolean(
    databaseCheck?.ok && versionsAligned && staffBoundaryReady &&
    lineIdentityConfigured && ownerAuthConfigured && productionGuard
  );

  return {
    ok: systemCheckReady,
    service: "DPRO NAIL LINE",
    systemCode: SYSTEM_CODE,
    legacyInternalReleaseIdentifier: LEGACY_INTERNAL_RELEASE_IDENTIFIER,
    worker_version: WORKER_VERSION,
    workerVersion: { current: WORKER_VERSION, expected: EXPECTED_WORKER_VERSION, aligned: workerAligned },
    databaseVersion: { current: databaseCurrent, expected: EXPECTED_DATABASE_VERSION, aligned: databaseAligned },
    frontendVersion: { current: frontendCurrent, expected: EXPECTED_FRONTEND_VERSION, aligned: frontendAligned, evidence: "paired_frontend_release_meta" },
    versionsAligned,
    shop_code: shopCode,
    facilityCode,
    environment: isDemo ? "demo" : "production",
    productionGuard,
    systemCheckReady,
    systemCheckOk: systemCheckReady,
    sourceLockCommit: SOURCE_LOCK_COMMIT,
    recoveredBaseline: {
      version: BASELINE_WORKER_VERSION,
      sha256: RECOVERED_BASELINE_SHA256
    },
    database: {
      ...databaseCheck,
      ok: Boolean(databaseCheck?.ok),
      version: databaseCurrent,
      expected_version: EXPECTED_DATABASE_VERSION
    },
    security: {
      ownerAuthBoundary: "DPRO_COMMON_OWNER_AUTH",
      ownerAuthConfigured,
      lineIdentityServerVerify: true,
      lineIdentityConfigured,
      staffScopedSession: true,
      staffBoundaryReady,
      staffScopes: STAFF_SCOPES,
      verifiedAuditActorBinding: true,
      corsOrigin: CANONICAL_BROWSER_ORIGIN,
      secretsClientExposed: false,
      productionConfigurationDeferred: isDemo
    },
    features: {
      existing_api_compatible: true,
      lightweight_available_days: true,
      phone_normalization: true,
      design_catalog: true,
      private_media: true,
      treatment_chart: true,
      workflow_status: true,
      repeat_booking: true,
      system_check: true
    },
    message: systemCheckReady
      ? "Nail PR1 security boundary is ready."
      : "Nail PR1 is deployed but configuration/version evidence is incomplete."
  };
}

async function publicStatus(url, env) {
  const shopCode = getShopCode(url, env);
  const [settings, staff, services, designCount] = await Promise.all([
    getSettings(env, shopCode),
    getActiveStaff(env, shopCode),
    getActiveServices(env, shopCode),
    countRows(env, "nail_design_catalog", [
      eq("shop_code", shopCode), eq("is_active", true), eq("is_public", true)
    ]).catch(() => 0)
  ]);

  return {
    ok: true,
    worker_version: WORKER_VERSION,
    shop_code: shopCode,
    shop_name: settings.shop_name,
    service_name: settings.service_name,
    timezone: settings.timezone,
    open_time: normalizeTime(settings.open_time, "10:00"),
    close_time: normalizeTime(settings.close_time, "19:00"),
    reservation_slot_minutes: 30,
    holidays: normalizeIntArray(settings.holidays),
    closed_dates: normalizeDateArray(settings.closed_dates),
    multi_staff_enabled: Boolean(settings.multi_staff_enabled),
    staff_request_enabled: Boolean(settings.staff_request_enabled),
    auto_assign_staff_enabled: Boolean(settings.auto_assign_staff_enabled),
    resource_management_enabled: Boolean(settings.resource_management_enabled),
    max_active_reservations_per_customer: Number(settings.max_active_reservations_per_customer || 2),
    default_buffer_minutes: Number(settings.default_buffer_minutes || 10),
    booking_open_days: Number(settings.booking_open_days || 60),
    salon_address: settings.salon_address || "",
    salon_note: settings.salon_note || "",
    demo_mode: Boolean(settings.demo_mode),
    staff_count: staff.length,
    services_count: services.length,
    design_count: designCount,
    next_features: {
      design_catalog: true,
      treatment_chart: true,
      private_media: true,
      workflow_status: true,
      repeat_booking: true
    }
  };
}

async function publicServices(url, env) {
  const shopCode = getShopCode(url, env);
  const category = clean(url.searchParams.get("category"));
  const services = await getActiveServices(env, shopCode);
  const filtered = category
    ? services.filter(row => clean(row.category) === category)
    : services;
  return { ok: true, shop_code: shopCode, services: filtered };
}

async function publicOptions(url, env) {
  const shopCode = getShopCode(url, env);
  const serviceCode = clean(url.searchParams.get("service_code"));
  const options = await getActiveOptions(env, shopCode, serviceCode);
  return {
    ok: true,
    shop_code: shopCode,
    service_code: serviceCode || null,
    options: options.map(normalizeOptionForClient)
  };
}

async function publicStaff(url, env) {
  const shopCode = getShopCode(url, env);
  const serviceCode = clean(url.searchParams.get("service_code"));
  const settings = await getSettings(env, shopCode);
  const staff = await getEligibleStaffForService(env, shopCode, serviceCode);
  return {
    ok: true,
    shop_code: shopCode,
    multi_staff_enabled: Boolean(settings.multi_staff_enabled),
    staff_request_enabled: Boolean(settings.staff_request_enabled),
    service_code: serviceCode || null,
    staff
  };
}

async function publicDesigns(request, url, env) {
  const shopCode = getShopCode(url, env);
  const handFoot = normalizeHandFoot(url.searchParams.get("hand_foot"), true);
  const category = clean(url.searchParams.get("category"));
  const featured = url.searchParams.has("featured")
    ? parseBool(url.searchParams.get("featured"), false)
    : null;
  const q = normalizeSearchText(url.searchParams.get("q"));
  const limit = clampNumber(Number(url.searchParams.get("limit") || 24), 1, 60);
  const offset = clampNumber(Number(url.searchParams.get("offset") || 0), 0, 5000);

  const filters = [
    sel("*"),
    eq("shop_code", shopCode),
    eq("is_active", true),
    eq("is_public", true)
  ];
  if (handFoot) filters.push(eq("hand_foot", handFoot));
  if (category) filters.push(eq("category", category));
  if (featured !== null) filters.push(eq("is_featured", featured));
  filters.push("order=is_featured.desc,sort_order.asc,created_at.desc", "limit=500");

  let designs = await sbSelect(env, "nail_design_catalog", filters);
  if (q) {
    designs = designs.filter(row => [
      row.design_name, row.description, row.category, row.season_label,
      ...(normalizeArray(row.style_tags)),
      ...(normalizeArray(row.color_tags))
    ].map(normalizeSearchText).some(value => value.includes(q)));
  }

  const total = designs.length;
  designs = designs.slice(offset, offset + limit);
  const photos = await getPrimaryDesignPhotos(env, shopCode, designs.map(row => row.id));
  const byDesign = new Map(photos.map(row => [String(row.design_id), row]));
  const origin = new URL(request.url).origin;

  return {
    ok: true,
    shop_code: shopCode,
    total,
    limit,
    offset,
    designs: designs.map(row => {
      const photo = byDesign.get(String(row.id)) || null;
      return {
        ...row,
        primary_photo: photo ? sanitizePhotoMeta(photo) : null,
        photo_url: photo
          ? `${origin}/api/public/media?shop_code=${encodeURIComponent(shopCode)}&photo_id=${encodeURIComponent(photo.id)}`
          : ""
      };
    })
  };
}

async function publicDesignDetail(request, url, env) {
  const shopCode = getShopCode(url, env);
  const id = clean(url.searchParams.get("id"));
  const code = clean(url.searchParams.get("design_code"));
  if (!id && !code) throw new AppError(400, "id または design_code が必要です。");

  const filters = [
    sel("*"), eq("shop_code", shopCode),
    eq("is_active", true), eq("is_public", true)
  ];
  if (id) filters.push(eq("id", id));
  if (code) filters.push(eq("design_code", code));
  filters.push("limit=1");

  const design = (await sbSelect(env, "nail_design_catalog", filters))[0];
  if (!design) throw new AppError(404, "デザインが見つかりません。");

  const photos = await sbSelect(env, "nail_design_photos", [
    sel("*"), eq("shop_code", shopCode), eq("design_id", design.id),
    eq("is_deleted", false), "order=is_primary.desc,sort_order.asc,created_at.asc", "limit=50"
  ]);
  const origin = new URL(request.url).origin;
  return {
    ok: true,
    shop_code: shopCode,
    design,
    photos: photos.map(photo => ({
      ...sanitizePhotoMeta(photo),
      photo_url: `${origin}/api/public/media?shop_code=${encodeURIComponent(shopCode)}&photo_id=${encodeURIComponent(photo.id)}`
    }))
  };
}

async function publicMedia(request, url, env, requestId, started) {
  const shopCode = getShopCode(url, env);
  const photoId = clean(url.searchParams.get("photo_id"));
  if (!photoId) return json({ ok: false, error: "photo_id が必要です。" }, 400, requestId, started);

  const photo = (await sbSelect(env, "nail_design_photos", [
    sel("*"), eq("shop_code", shopCode), eq("id", photoId),
    eq("is_deleted", false), "limit=1"
  ]))[0];
  if (!photo) return json({ ok: false, error: "写真が見つかりません。" }, 404, requestId, started);

  const design = (await sbSelect(env, "nail_design_catalog", [
    sel("id,is_public,is_active"), eq("shop_code", shopCode), eq("id", photo.design_id), "limit=1"
  ]))[0];
  if (!design || !design.is_public || !design.is_active) {
    return json({ ok: false, error: "公開されていない写真です。" }, 403, requestId, started);
  }

  const upstream = await storageDownload(env, photo.storage_bucket || MEDIA_BUCKET, photo.storage_path);
  if (!upstream.ok) {
    return json({ ok: false, error: "写真を取得できませんでした。" }, upstream.status, requestId, started);
  }

  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", upstream.headers.get("Content-Type") || photo.mime_type || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Request-Id", requestId);
  headers.set("X-Elapsed-Ms", String(Date.now() - started));
  return new Response(upstream.body, { status: 200, headers });
}

async function publicCustomer(url, env) {
  const shopCode = getShopCode(url, env);
  const lineUserId = clean(url.searchParams.get("line_user_id") || url.searchParams.get("line_id"));
  const phone = normalizePhoneForStorage(url.searchParams.get("phone"));
  if (!lineUserId && !phone) {
    throw new AppError(400, "line_user_id または phone が必要です。");
  }

  const settings = await getSettings(env, shopCode);
  if (!lineUserId && phone && !settings.demo_mode) {
    throw new AppError(401, "本番環境ではLINE本人確認が必要です。", null, "MEMBER_AUTH_REQUIRED");
  }

  const customers = await findCustomers(env, shopCode, { line_user_id: lineUserId, phone });
  if (!customers.length) {
    return {
      ok: true, shop_code: shopCode, found: false,
      customer: null, reservations: [], history: [],
      followups: [], line_messages: [], treatment_records: [],
      repeat_template: null
    };
  }

  const customer = customers[0];
  const [reservations, history, followupRows, messageRows, treatments] = await Promise.all([
    getCustomerReservations(env, shopCode, customer),
    sbSelect(env, "nail_customer_events", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
      "order=created_at.desc", "limit=50"
    ]),
    sbSelect(env, "nail_followups", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
      "order=due_date.asc,created_at.desc", "limit=50"
    ]),
    sbSelect(env, "nail_line_messages", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
      "order=created_at.desc", "limit=30"
    ]),
    sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
      "order=treatment_date.desc,created_at.desc", "limit=20"
    ]).catch(() => [])
  ]);

  const followups = await filterRelevantFollowups(env, shopCode, followupRows);
  const lineMessages = await filterCurrentLineMessages(env, shopCode, messageRows);
  const repeatTemplate = await buildRepeatTemplate(env, shopCode, customer, reservations, treatments);

  return {
    ok: true,
    shop_code: shopCode,
    found: true,
    customer,
    reservations,
    latest_reservation: reservations[0] || null,
    history,
    followups,
    line_messages: lineMessages,
    treatment_records: treatments.map(sanitizeTreatmentForMember),
    repeat_template: repeatTemplate
  };
}

async function publicRepeatTemplate(url, env) {
  const shopCode = getShopCode(url, env);
  const lineUserId = clean(url.searchParams.get("line_user_id") || url.searchParams.get("line_id"));
  const phone = normalizePhoneForStorage(url.searchParams.get("phone"));
  if (!lineUserId && !phone) {
    throw new AppError(400, "line_user_id または phone が必要です。");
  }
  const settings = await getSettings(env, shopCode);
  if (!lineUserId && phone && !settings.demo_mode) {
    throw new AppError(401, "本番環境ではLINE本人確認が必要です。", null, "MEMBER_AUTH_REQUIRED");
  }

  const customer = (await findCustomers(env, shopCode, {
    line_user_id: lineUserId, phone
  }))[0];
  if (!customer) {
    return { ok: true, found: false, customer: null, repeat_template: null };
  }

  const [reservations, treatments] = await Promise.all([
    getCustomerReservations(env, shopCode, customer),
    sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
      "order=treatment_date.desc,created_at.desc", "limit=20"
    ]).catch(() => [])
  ]);

  return {
    ok: true,
    found: true,
    shop_code: shopCode,
    customer,
    repeat_template: await buildRepeatTemplate(
      env, shopCode, customer, reservations, treatments
    )
  };
}


// =========================================================
// Availability
// =========================================================

async function publicAvailableDays(url, env) {
  const shopCode = getShopCode(url, env);
  const settings = await getSettings(env, shopCode);
  const from = isValidDateString(url.searchParams.get("from"))
    ? url.searchParams.get("from")
    : todayJst();
  const days = clampNumber(
    Number(url.searchParams.get("days") || settings.booking_open_days || 60),
    7,
    120
  );
  const serviceCode = clean(url.searchParams.get("service_code"));
  let specSummary = null;

  if (serviceCode) {
    try {
      const optionCodes = parseOptionCodes(
        url.searchParams.get("option_codes") || url.searchParams.get("options")
      );
      const hasOff = parseBool(
        url.searchParams.get("has_off"),
        optionCodes.includes("replace_off")
      );
      const spec = await buildReservationSpec(env, shopCode, {
        service_code: serviceCode,
        option_codes: optionCodes,
        has_off: hasOff
      });
      specSummary = {
        service_code: spec.service.service_code,
        service_name: spec.service.service_name,
        total_minutes: spec.total_minutes,
        total_price: spec.total_price
      };
    } catch (_) {
      specSummary = null;
    }
  }

  // Important: date cards remain lightweight. Detailed availability is checked
  // only after one date is selected and again immediately before insert.
  const resultDays = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    const validation = validateDateOnly(date, settings);
    resultDays.push({
      date,
      weekday: getWeekdayFromDateString(date),
      weekday_label: weekdayLabelJp(date),
      is_closed: !validation.ok,
      closed_reason: validation.ok ? null : validation.message,
      available_count: null,
      availability_mode: "business_day_only",
      can_reserve: validation.ok
    });
  }

  return {
    ok: true,
    shop_code: shopCode,
    from,
    to: addDays(from, days - 1),
    service_code: serviceCode || null,
    total_minutes: specSummary?.total_minutes || null,
    service_summary: specSummary,
    availability_mode: "business_day_only",
    message:
      "日付一覧は営業日候補のみを軽量表示しています。空き時間は日付選択後に詳しく確認します。",
    days: resultDays
  };
}

async function publicAvailableTimes(url, env) {
  const shopCode = getShopCode(url, env);
  const date = clean(url.searchParams.get("date"));
  const serviceCode = clean(url.searchParams.get("service_code"));
  if (!isValidDateString(date)) {
    throw new AppError(400, "date が必要です。YYYY-MM-DD形式で指定してください。");
  }
  if (!serviceCode) throw new AppError(400, "service_code が必要です。");

  const optionCodes = parseOptionCodes(
    url.searchParams.get("option_codes") || url.searchParams.get("options")
  );
  const hasOff = parseBool(
    url.searchParams.get("has_off"),
    optionCodes.includes("replace_off")
  );
  const staffId = clean(url.searchParams.get("staff_id"));
  const staffRequested = parseBool(
    url.searchParams.get("staff_requested"),
    Boolean(staffId)
  );

  const [spec, settings] = await Promise.all([
    buildReservationSpec(env, shopCode, {
      service_code: serviceCode,
      option_codes: optionCodes,
      has_off: hasOff
    }),
    getSettings(env, shopCode)
  ]);

  const dateValidation = validateDateOnly(date, settings);
  if (!dateValidation.ok) {
    return {
      ok: true,
      shop_code: shopCode,
      date,
      service_code: serviceCode,
      total_minutes: spec.total_minutes,
      times: [],
      message: dateValidation.message
    };
  }

  const times = await computeAvailableTimes(env, shopCode, date, spec, {
    staff_id: staffId,
    staff_requested: staffRequested,
    include_detail: true
  });

  return {
    ok: true,
    shop_code: shopCode,
    date,
    service: spec.service,
    options: spec.options,
    total_minutes: spec.total_minutes,
    total_price: spec.total_price,
    staff_id: staffId || null,
    staff_requested: staffRequested,
    times
  };
}

async function computeAvailableTimes(env, shopCode, date, spec, options = {}) {
  const [settings, eligibleStaff, shifts, closedDates, reservations] =
    await Promise.all([
      getSettings(env, shopCode),
      getEligibleStaffForService(env, shopCode, spec.service.service_code),
      getStaffShiftsByWeekday(env, shopCode, getWeekdayFromDateString(date)),
      sbSelect(env, "nail_staff_closed_dates", [
        sel("*"), eq("shop_code", shopCode), eq("closed_date", date), "limit=500"
      ]),
      getReservationRowsByDate(env, shopCode, date)
    ]);

  const openMin = timeToMinutes(normalizeTime(settings.open_time, "10:00"));
  const closeMin = timeToMinutes(normalizeTime(settings.close_time, "19:00"));
  const slotMinutes = 30;
  const requestedStaffId = clean(options.staff_id);
  const staffRequested = Boolean(options.staff_requested);
  let staffPool = eligibleStaff;

  if (staffRequested) {
    staffPool = eligibleStaff.filter(row => String(row.id) === requestedStaffId);
  }

  const rows = [];
  for (let startMin = openMin; startMin + spec.total_minutes <= closeMin; startMin += slotMinutes) {
    const start = minutesToTime(startMin);
    const end = minutesToTime(startMin + spec.total_minutes);
    const availableStaff = staffPool.filter(staff =>
      isStaffAvailableForInterval({
        staff,
        date,
        start,
        end,
        shifts,
        closedDates,
        reservations,
        excludeReservationId: clean(options.exclude_reservation_id)
      })
    );

    rows.push({
      time: start,
      end_time: end,
      can_reserve: availableStaff.length > 0,
      available_staff_count: availableStaff.length,
      available_staff: options.include_detail
        ? availableStaff.map(staff => ({
            id: staff.id,
            staff_name: staff.staff_name,
            display_name: staff.display_name
          }))
        : undefined,
      disabled_reason:
        availableStaff.length > 0
          ? null
          : staffRequested
            ? "指名スタッフに空きがありません"
            : "対応可能スタッフに空きがありません",
      total_minutes: spec.total_minutes,
      total_price: spec.total_price
    });
  }
  return rows;
}

function isStaffAvailableForInterval({
  staff,
  start,
  end,
  shifts,
  closedDates,
  reservations,
  excludeReservationId
}) {
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  const shift = shifts.find(row => String(row.staff_id) === String(staff.id));

  if (!shift || !shift.is_working) return false;
  const shiftStart = timeToMinutes(normalizeTime(shift.start_time, "00:00"));
  const shiftEnd = timeToMinutes(normalizeTime(shift.end_time, "00:00"));
  if (startMin < shiftStart || endMin > shiftEnd) return false;

  if (shift.break_start_time && shift.break_end_time) {
    const breakStart = timeToMinutes(normalizeTime(shift.break_start_time, ""));
    const breakEnd = timeToMinutes(normalizeTime(shift.break_end_time, ""));
    if (overlapsMinutes(startMin, endMin, breakStart, breakEnd)) return false;
  }

  for (const closed of closedDates.filter(
    row => String(row.staff_id) === String(staff.id)
  )) {
    if (closed.is_full_day) return false;
    const closedStart = timeToMinutes(normalizeTime(closed.start_time, ""));
    const closedEnd = timeToMinutes(normalizeTime(closed.end_time, ""));
    if (overlapsMinutes(startMin, endMin, closedStart, closedEnd)) return false;
  }

  for (const reservation of reservations) {
    if (excludeReservationId && String(reservation.id) === String(excludeReservationId)) continue;
    if (!isActiveReservationStatus(reservation.status)) continue;
    if (String(reservation.staff_id || "") !== String(staff.id)) continue;
    const reservedStart = timeToMinutes(normalizeTime(reservation.start_time, ""));
    const reservedEnd = timeToMinutes(normalizeTime(reservation.end_time, ""));
    if (overlapsMinutes(startMin, endMin, reservedStart, reservedEnd)) return false;
  }

  return true;
}

async function assignStaffForSlot(env, shopCode, date, startTime, spec, options = {}) {
  const times = await computeAvailableTimes(env, shopCode, date, spec, {
    staff_id: options.staff_id,
    staff_requested: options.staff_requested,
    exclude_reservation_id: options.exclude_reservation_id,
    include_detail: true
  });
  const slot = times.find(row => normalizeTime(row.time, "") === normalizeTime(startTime, ""));
  if (!slot || !slot.can_reserve || !slot.available_staff?.length) {
    return {
      ok: false,
      message: options.staff_requested
        ? "選択したスタッフはこの時間に空きがありません。"
        : "この時間に対応できるスタッフがいません。",
      detail: { date, start_time: startTime }
    };
  }

  const chosen = slot.available_staff[0];
  const fullStaff = (await getActiveStaff(env, shopCode)).find(
    row => String(row.id) === String(chosen.id)
  ) || chosen;
  return { ok: true, staff: fullStaff, slot };
}

// =========================================================
// Reservation API
// =========================================================

async function createReservation(body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  const settings = await getSettings(env, shopCode);
  const customerName = clean(body.customer_name || body.name);
  const phone = normalizePhoneForStorage(body.phone);
  const lineUserId = clean(body.line_user_id || body.line_id || body.lineUserId);
  const reservationDate = clean(body.reservation_date || body.date);
  const startTime = normalizeTime(
    body.start_time || body.reservation_time || body.time,
    ""
  );
  const source = normalizeReservationSource(body.source || "line");
  const staffId = clean(body.staff_id);
  const staffRequested = parseBool(
    body.staff_requested ?? body.is_staff_requested,
    Boolean(staffId)
  );

  if (!customerName) throw new AppError(400, "お名前が必要です。");
  if (!lineUserId && !phone) {
    throw new AppError(400, "LINEユーザーIDまたは電話番号が必要です。");
  }
  if (!isValidDateString(reservationDate)) {
    throw new AppError(400, "予約日が必要です。YYYY-MM-DD形式で指定してください。");
  }
  if (!startTime) throw new AppError(400, "予約時間が必要です。");

  const optionCodes = parseOptionCodes(body.option_codes || body.options);
  const spec = await buildReservationSpec(env, shopCode, {
    service_code: body.service_code,
    option_codes: optionCodes,
    has_off: parseBool(body.has_off, optionCodes.includes("replace_off"))
  });

  const dateValidation = validateDateOnly(reservationDate, settings);
  if (!dateValidation.ok) throw new AppError(400, dateValidation.message);
  validateLeadTime(reservationDate, startTime, settings);

  await assertActiveReservationLimit(env, shopCode, {
    line_user_id: lineUserId,
    phone,
    exclude_id: null
  }, settings);

  const assignment = await assignStaffForSlot(
    env, shopCode, reservationDate, startTime, spec,
    { staff_id: staffId, staff_requested: staffRequested }
  );
  if (!assignment.ok) {
    throw new AppError(409, assignment.message, assignment.detail, "SLOT_NOT_AVAILABLE");
  }

  const customer = await upsertCustomer(env, shopCode, {
    line_user_id: lineUserId || null,
    line_display_name: clean(body.line_display_name || body.displayName),
    customer_name: customerName,
    phone,
    email: clean(body.email),
    nail_visit_history: clean(body.nail_visit_history),
    preferred_staff_id: assignment.staff?.id || null,
    allergy_note: clean(body.allergy_note),
    design_preference: clean(body.design_preference),
    last_design_note: clean(body.design_note || body.design_preference),
    source
  });

  const endTime = minutesToTime(timeToMinutes(startTime) + spec.total_minutes);
  const status = normalizeReservationStatus(
    body.status ||
      (source === "phone"
        ? "phone_reserved"
        : source === "shop"
          ? "shop_reserved"
          : source === "instagram"
            ? "instagram_reserved"
            : "reserved")
  );
  const handFoot = normalizeHandFoot(
    body.hand_foot || categoryToHandFoot(spec.service.category),
    false
  );
  const offSource = normalizeOffSource(
    body.off_source ||
      (spec.has_off ? "unknown" : "none")
  );
  const extensionCount = clampNumber(
    Number(body.length_extension_count || body.extension_count || 0),
    0,
    20
  );
  const repairCount = clampNumber(Number(body.repair_count || 0), 0, 20);
  const referenceDesignId = clean(body.reference_design_id) || null;

  const inserted = await sbInsert(env, "nail_reservations", {
    shop_code: shopCode,
    customer_id: customer?.id || null,
    line_user_id: lineUserId || null,
    customer_name: customerName,
    phone,
    staff_id: assignment.staff?.id || null,
    staff_name:
      assignment.staff?.staff_name || assignment.staff?.display_name || "",
    is_staff_requested: Boolean(staffRequested),
    assigned_type: staffRequested ? "requested" : "auto",
    service_id: spec.service.id || null,
    service_code: spec.service.service_code,
    service_name: spec.service.service_name,
    option_codes: spec.option_codes,
    option_names: spec.option_names,
    has_off: spec.has_off,
    base_minutes: spec.base_minutes,
    option_minutes: spec.option_minutes,
    buffer_minutes: spec.buffer_minutes,
    total_minutes: spec.total_minutes,
    base_price: spec.base_price,
    option_price: spec.option_price,
    total_price: spec.total_price,
    reservation_date: reservationDate,
    start_time: startTime,
    end_time: endTime,
    status,
    workflow_status: "reserved",
    source,
    hand_foot: handFoot,
    off_source: offSource,
    length_extension_count: extensionCount,
    repair_count: repairCount,
    reference_design_id: referenceDesignId,
    design_note: clean(body.design_note),
    design_image_url: clean(body.design_image_url),
    request_note: clean(body.request_note || body.memo),
    admin_note: clean(body.admin_note),
    created_by: clean(body.created_by || "system")
  });
  const reservation = inserted[0];

  await sbInsert(env, "nail_customer_events", {
    shop_code: shopCode,
    customer_id: customer?.id || null,
    reservation_id: reservation?.id || null,
    line_user_id: lineUserId || null,
    customer_name: customerName,
    event_type: "reservation_created",
    title: "予約受付",
    memo: `${reservationDate} ${startTime} ${spec.service.service_name}`,
    status,
    event_date: reservationDate,
    source,
    meta: {
      service_code: spec.service.service_code,
      option_codes: spec.option_codes,
      total_minutes: spec.total_minutes,
      staff_name: reservation?.staff_name || "",
      hand_foot: handFoot,
      reference_design_id: referenceDesignId
    }
  });

  const lineMessageBody = buildReservationReceivedMessage({
    customerName,
    shopName: settings.shop_name,
    reservationDate,
    startTime,
    serviceName: spec.service.service_name,
    optionNames: spec.option_names,
    totalMinutes: spec.total_minutes,
    staffName: reservation?.staff_name || "",
    salonNote: settings.salon_note || ""
  });

  await sbInsert(env, "nail_line_messages", {
    shop_code: shopCode,
    customer_id: customer?.id || null,
    reservation_id: reservation?.id || null,
    line_user_id: lineUserId || null,
    customer_name: customerName,
    message_type:
      ["phone", "shop", "instagram"].includes(source)
        ? "line_connect_guidance"
        : "reservation_received",
    message_title:
      source === "line" ? "予約受付メッセージ" : "LINE登録案内文面",
    message_body:
      source === "line"
        ? lineMessageBody
        : buildLineConnectGuidanceMessage({
            customerName,
            shopName: settings.shop_name
          }),
    send_method: "copy",
    status: "draft",
    source_screen: clean(body.created_by || "index.html"),
    meta: { source, total_minutes: spec.total_minutes }
  });

  const nextVisitDays = clampNumber(Number(body.next_visit_days || 21), 0, 180);
  const followupRows = await sbInsert(env, "nail_followups", {
    shop_code: shopCode,
    customer_id: customer?.id || null,
    reservation_id: reservation?.id || null,
    line_user_id: lineUserId || null,
    customer_name: customerName,
    followup_type: "next_replacement",
    title: "次回付け替え案内",
    memo: "施術後の付け替え時期を確認し、必要な場合だけご案内します。",
    due_date: addDays(reservationDate, nextVisitDays || 21),
    priority: "normal",
    status: "open"
  });

  await audit(env, shopCode, "reservation_created", "customer", reservation?.id || "", {
    source,
    customer_id: customer?.id || null,
    total_minutes: spec.total_minutes,
    staff_id: reservation?.staff_id || null,
    reference_design_id: referenceDesignId,
    verified_line_user_id: clean(body.__verified_line_user_id) || null
  });

  return {
    ok: true,
    success: true,
    shop_code: shopCode,
    message: "予約を受け付けました。",
    customer,
    reservation,
    followup: followupRows[0] || null,
    line_message: lineMessageBody
  };
}

async function repeatReservation(body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  const lineUserId = clean(body.line_user_id || body.line_id);
  const phone = normalizePhoneForStorage(body.phone);
  const customerId = clean(body.customer_id);

  let customer = null;
  if (customerId) {
    customer = (await sbSelect(env, "nail_customers", [
      sel("*"), eq("shop_code", shopCode), eq("id", customerId), "limit=1"
    ]))[0] || null;
  } else {
    customer = (await findCustomers(env, shopCode, {
      line_user_id: lineUserId, phone
    }))[0] || null;
  }
  if (!customer) throw new AppError(404, "お客様情報が見つかりません。");

  const settings = await getSettings(env, shopCode);
  if (!lineUserId && phone && !settings.demo_mode) {
    throw new AppError(401, "本番環境ではLINE本人確認が必要です。");
  }

  const [reservations, treatments] = await Promise.all([
    getCustomerReservations(env, shopCode, customer),
    sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
      "order=treatment_date.desc,created_at.desc", "limit=20"
    ]).catch(() => [])
  ]);
  const template = await buildRepeatTemplate(
    env, shopCode, customer, reservations, treatments
  );
  if (!template) throw new AppError(404, "複製できる前回内容がありません。");

  return await createReservation({
    ...template.reservation_input,
    ...body,
    shop_code: shopCode,
    customer_name: clean(body.customer_name || customer.customer_name),
    phone: normalizePhoneForStorage(body.phone || customer.phone),
    line_user_id: clean(body.line_user_id || customer.line_user_id),
    source: clean(body.source || "line"),
    created_by: clean(body.created_by || "repeat_booking")
  }, env);
}

async function changeReservation(body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  const settings = await getSettings(env, shopCode);
  const target = await findReservationTarget(env, shopCode, body);
  if (!target) {
    throw new AppError(
      404,
      "変更前の予約が見つかりませんでした。画面を開き直して再度お試しください。"
    );
  }

  const newDate = clean(
    body.new_reservation_date || body.reservation_date || body.date
  );
  const newTime = normalizeTime(
    body.new_start_time || body.new_reservation_time ||
      body.start_time || body.time,
    ""
  );
  if (!isValidDateString(newDate)) {
    throw new AppError(400, "変更後の日付が必要です。");
  }
  if (!newTime) throw new AppError(400, "変更後の時間が必要です。");
  if (
    String(target.reservation_date) === newDate &&
    normalizeTime(target.start_time, "") === newTime
  ) {
    throw new AppError(400, "変更前と同じ日時です。別の日時を選択してください。");
  }

  const serviceCode = clean(body.service_code || target.service_code);
  const optionCodes =
    body.option_codes !== undefined
      ? parseOptionCodes(body.option_codes)
      : normalizeArray(target.option_codes);
  const staffId = clean(body.staff_id || target.staff_id);
  const staffRequested = parseBool(
    body.staff_requested ?? body.is_staff_requested,
    Boolean(target.is_staff_requested)
  );
  const spec = await buildReservationSpec(env, shopCode, {
    service_code: serviceCode,
    option_codes: optionCodes,
    has_off: parseBool(body.has_off, Boolean(target.has_off))
  });

  const validation = validateDateOnly(newDate, settings);
  if (!validation.ok) throw new AppError(400, validation.message);
  validateLeadTime(newDate, newTime, settings);

  const assignment = await assignStaffForSlot(
    env, shopCode, newDate, newTime, spec,
    {
      staff_id: staffId,
      staff_requested: staffRequested,
      exclude_reservation_id: target.id
    }
  );
  if (!assignment.ok) {
    throw new AppError(409, assignment.message, assignment.detail);
  }

  await sbUpdate(env, "nail_reservations", [
    eq("shop_code", shopCode), eq("id", target.id)
  ], {
    status: "changed_before",
    handled: true,
    handled_at: new Date().toISOString(),
    handled_note: `予約変更：${newDate} ${newTime}へ変更`
  });

  await archiveDraftLineMessagesForReservations(
    env, shopCode, [target.id],
    ["reservation_received", "line_connect_guidance"],
    "changed_before"
  );

  const inserted = await sbInsert(env, "nail_reservations", {
    shop_code: shopCode,
    customer_id: target.customer_id || null,
    line_user_id: clean(body.line_user_id || target.line_user_id) || null,
    customer_name: clean(body.customer_name || target.customer_name || "お客様"),
    phone: normalizePhoneForStorage(body.phone || target.phone),
    staff_id: assignment.staff?.id || null,
    staff_name:
      assignment.staff?.staff_name || assignment.staff?.display_name || "",
    is_staff_requested: Boolean(staffRequested),
    assigned_type: staffRequested ? "requested" : "auto",
    service_id: spec.service.id || null,
    service_code: spec.service.service_code,
    service_name: spec.service.service_name,
    option_codes: spec.option_codes,
    option_names: spec.option_names,
    has_off: spec.has_off,
    base_minutes: spec.base_minutes,
    option_minutes: spec.option_minutes,
    buffer_minutes: spec.buffer_minutes,
    total_minutes: spec.total_minutes,
    base_price: spec.base_price,
    option_price: spec.option_price,
    total_price: spec.total_price,
    reservation_date: newDate,
    start_time: newTime,
    end_time: minutesToTime(timeToMinutes(newTime) + spec.total_minutes),
    status: "changed",
    workflow_status: "reserved",
    source: normalizeReservationSource(body.source || target.source || "line"),
    previous_reservation_id: target.id,
    hand_foot: normalizeHandFoot(
      body.hand_foot || target.hand_foot ||
        categoryToHandFoot(spec.service.category),
      false
    ),
    off_source: normalizeOffSource(
      body.off_source || target.off_source ||
        (spec.has_off ? "unknown" : "none")
    ),
    length_extension_count: clampNumber(
      Number(
        body.length_extension_count ??
        target.length_extension_count ??
        0
      ),
      0,
      20
    ),
    repair_count: clampNumber(
      Number(body.repair_count ?? target.repair_count ?? 0),
      0,
      20
    ),
    reference_design_id:
      clean(body.reference_design_id || target.reference_design_id) || null,
    design_note: clean(body.design_note || target.design_note),
    design_image_url: clean(body.design_image_url || target.design_image_url),
    request_note: clean(body.request_note || body.reason),
    created_by: clean(body.created_by || "system")
  });
  const reservation = inserted[0];

  const customerName = reservation?.customer_name || target.customer_name || "お客様";
  const messageBody = buildReservationChangeMessage({
    customerName,
    previousDate: target.reservation_date,
    previousTime: normalizeTime(target.start_time, ""),
    newDate,
    newTime,
    serviceName: spec.service.service_name,
    staffName: reservation?.staff_name || ""
  });

  await sbInsert(env, "nail_line_messages", {
    shop_code: shopCode,
    customer_id: target.customer_id || null,
    reservation_id: reservation?.id || null,
    line_user_id: reservation?.line_user_id || null,
    customer_name: customerName,
    message_type: "reservation_changed",
    message_title: "予約変更受付メッセージ",
    message_body: messageBody,
    send_method: "copy",
    status: "draft",
    source_screen: "member.html"
  });

  await moveOpenNextReplacementFollowups(
    env, shopCode, target.id, reservation?.id || null, addDays(newDate, 21)
  );
  await audit(env, shopCode, "reservation_changed", "customer", reservation?.id || "", {
    previous_reservation_id: target.id,
    new_date: newDate,
    new_time: newTime,
    verified_line_user_id: clean(body.__verified_line_user_id) || null
  });

  return {
    ok: true,
    success: true,
    shop_code: shopCode,
    message: "予約変更を受け付けました。",
    reservation,
    line_message: messageBody
  };
}

async function cancelReservation(body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  const target = await findReservationTarget(env, shopCode, body);
  if (!target) {
    throw new AppError(
      404,
      "キャンセル対象の有効予約が見つかりませんでした。更新して再度お試しください。"
    );
  }
  const reason = clean(body.reason || body.cancel_reason);

  await sbUpdate(env, "nail_reservations", [
    eq("shop_code", shopCode), eq("id", target.id)
  ], {
    status: "cancelled",
    workflow_status: "cancelled",
    cancel_reason: reason,
    handled: true,
    handled_at: new Date().toISOString(),
    handled_note: reason || "お客様によるキャンセル希望"
  });

  const relatedIds = [target.id, target.previous_reservation_id].filter(Boolean);
  await archiveDraftLineMessagesForReservations(
    env, shopCode, relatedIds,
    ["reservation_received", "reservation_changed", "line_connect_guidance"],
    "reservation_cancelled"
  );
  await closeOpenNextReplacementFollowups(
    env, shopCode, relatedIds,
    "キャンセル済みのため次回付け替え案内を停止しました。"
  );

  await sbInsert(env, "nail_customer_events", {
    shop_code: shopCode,
    customer_id: target.customer_id || null,
    reservation_id: target.id,
    line_user_id: target.line_user_id || null,
    customer_name: target.customer_name || "",
    event_type: "reservation_cancelled",
    title: "予約キャンセル",
    memo: [
      `対象予約：${target.reservation_date} ${normalizeTime(target.start_time, "")}`,
      reason ? `理由：${reason}` : null
    ].filter(Boolean).join("\n"),
    status: "cancelled",
    event_date: target.reservation_date,
    source: "customer"
  });

  const messageBody = buildReservationCancelMessage({
    customerName: target.customer_name || "お客様",
    reservationDate: target.reservation_date,
    startTime: normalizeTime(target.start_time, ""),
    reason
  });
  await sbInsert(env, "nail_line_messages", {
    shop_code: shopCode,
    customer_id: target.customer_id || null,
    reservation_id: target.id,
    line_user_id: target.line_user_id || null,
    customer_name: target.customer_name || "",
    message_type: "reservation_cancelled",
    message_title: "キャンセル受付メッセージ",
    message_body: messageBody,
    send_method: "copy",
    status: "draft",
    source_screen: "member.html"
  });

  await sbInsert(env, "nail_followups", {
    shop_code: shopCode,
    customer_id: target.customer_id || null,
    reservation_id: target.id,
    line_user_id: target.line_user_id || null,
    customer_name: target.customer_name || "",
    followup_type: "cancel_rebook",
    title: "キャンセル後の再予約案内",
    memo: "キャンセル後、別日での再予約候補を案内します。",
    due_date: todayJst(),
    priority: "normal",
    status: "open"
  });

  await audit(env, shopCode, "reservation_cancelled", "customer", target.id, {
    reason,
    verified_line_user_id: clean(body.__verified_line_user_id) || null
  });
  return {
    ok: true,
    success: true,
    shop_code: shopCode,
    message: "キャンセルを受け付けました。",
    cancelled: target,
    line_message: messageBody
  };
}


// =========================================================
// Existing admin API
// =========================================================

async function adminSettings(request, url, env) {
  const shopCode = getShopCode(url, env);
  const settings = await requireAdmin(request, env, shopCode);
  return { ok: true, shop_code: shopCode, settings };
}

async function adminUpdateSettings(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  const current = await requireAdmin(request, env, shopCode, body);
  const payload = normalizeSettingsPayload(body, current, shopCode);
  const rows = await sbUpdate(env, "nail_settings", [
    eq("shop_code", shopCode)
  ], payload);
  await audit(env, shopCode, "settings_updated", "owner", current.id || "1", {
    keys: Object.keys(payload)
  });
  return {
    ok: true,
    shop_code: shopCode,
    settings: rows[0] || { ...current, ...payload }
  };
}

async function adminStaff(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const staff = await getActiveStaff(env, shopCode, true);
  return { ok: true, shop_code: shopCode, staff };
}

async function adminServices(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const [services, options, staffServices] = await Promise.all([
    getActiveServices(env, shopCode, true),
    getActiveOptions(env, shopCode, "", true),
    sbSelect(env, "nail_staff_services", [
      sel("*"), eq("shop_code", shopCode), "limit=2000"
    ])
  ]);
  return {
    ok: true,
    shop_code: shopCode,
    services,
    options: options.map(normalizeOptionForClient),
    staff_services: staffServices
  };
}

async function adminUpdateService(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const current = await findServiceForAdmin(env, shopCode, body);
  const payload = normalizeServiceUpdatePayload(body, current);
  const rows = await sbUpdate(env, "nail_services", [
    eq("shop_code", shopCode), eq("id", current.id)
  ], payload);
  await audit(env, shopCode, "service_easy_updated", "owner", current.id, {
    service_code: current.service_code,
    keys: Object.keys(payload)
  });
  return {
    ok: true,
    shop_code: shopCode,
    service: rows[0] || { ...current, ...payload }
  };
}

async function adminUpdateOption(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const current = await findOptionForAdmin(env, shopCode, body);
  const payload = normalizeOptionUpdatePayload(body, current);
  const rows = await sbUpdate(env, "nail_service_options", [
    eq("shop_code", shopCode), eq("id", current.id)
  ], payload);
  await audit(env, shopCode, "option_easy_updated", "owner", current.id, {
    option_code: current.option_code,
    keys: Object.keys(payload)
  });
  return {
    ok: true,
    shop_code: shopCode,
    option: normalizeOptionForClient(rows[0] || { ...current, ...payload })
  };
}

async function adminUpdateStaff(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const current = await findStaffForAdmin(env, shopCode, body);
  const payload = {
    staff_name:
      body.staff_name !== undefined ? clean(body.staff_name) : current.staff_name,
    display_name:
      body.display_name !== undefined ? clean(body.display_name) : current.display_name,
    profile:
      body.profile !== undefined ? clean(body.profile) : current.profile,
    can_be_requested:
      body.can_be_requested !== undefined
        ? Boolean(body.can_be_requested)
        : Boolean(current.can_be_requested),
    is_active:
      body.is_active !== undefined
        ? Boolean(body.is_active)
        : Boolean(current.is_active),
    sort_order:
      body.sort_order !== undefined
        ? clampNumber(Number(body.sort_order), 0, 9999)
        : Number(current.sort_order || 100)
  };
  if (!payload.staff_name) throw new AppError(400, "スタッフ名が必要です。");

  const rows = await sbUpdate(env, "nail_staff", [
    eq("shop_code", shopCode), eq("id", current.id)
  ], payload);
  await audit(env, shopCode, "staff_easy_updated", "owner", current.id, {
    staff_code: current.staff_code,
    keys: Object.keys(payload)
  });
  return {
    ok: true,
    shop_code: shopCode,
    staff: rows[0] || { ...current, ...payload }
  };
}

async function adminUpdateStaffServices(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const serviceId = clean(body.service_id);
  const staffIds = unique(normalizeArray(body.staff_ids).map(clean).filter(Boolean));
  if (!serviceId) throw new AppError(400, "service_id が必要です。");

  const service = (await sbSelect(env, "nail_services", [
    sel("*"), eq("shop_code", shopCode), eq("id", serviceId), "limit=1"
  ]))[0];
  if (!service) throw new AppError(404, "メニューが見つかりません。");

  const current = await sbSelect(env, "nail_staff_services", [
    sel("*"), eq("shop_code", shopCode), eq("service_id", serviceId), "limit=500"
  ]);
  const currentByStaff = new Map(current.map(row => [String(row.staff_id), row]));

  for (const row of current) {
    const shouldEnable = staffIds.includes(String(row.staff_id));
    if (Boolean(row.is_available) !== shouldEnable) {
      await sbUpdate(env, "nail_staff_services", [
        eq("shop_code", shopCode), eq("id", row.id)
      ], { is_available: shouldEnable });
    }
  }

  for (const staffId of staffIds) {
    if (!currentByStaff.has(String(staffId))) {
      await sbInsert(env, "nail_staff_services", {
        shop_code: shopCode,
        staff_id: staffId,
        service_id: serviceId,
        is_available: true
      });
    }
  }

  const rows = await sbSelect(env, "nail_staff_services", [
    sel("*"), eq("shop_code", shopCode), eq("service_id", serviceId), "limit=500"
  ]);
  await audit(env, shopCode, "staff_services_updated", "owner", serviceId, {
    staff_ids: staffIds
  });
  return {
    ok: true,
    shop_code: shopCode,
    service_id: serviceId,
    staff_ids: rows.filter(row => row.is_available).map(row => row.staff_id),
    staff_services: rows
  };
}

async function adminDay(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const date = isValidDateString(url.searchParams.get("date"))
    ? url.searchParams.get("date")
    : todayJst();
  const settings = await getSettings(env, shopCode);
  const nextBusinessDate = findNextBusinessDate(date, settings);

  const [todayRows, nextRows, followupRows, lineMessageRows, staff] =
    await Promise.all([
      getReservationRowsByDate(env, shopCode, date),
      getReservationRowsByDate(env, shopCode, nextBusinessDate),
      sbSelect(env, "nail_followups", [
        sel("*"), eq("shop_code", shopCode),
        inFilter("status", ["open", "pending"]),
        lte("due_date", date),
        "order=priority.desc,due_date.asc,created_at.asc",
        "limit=300"
      ]),
      sbSelect(env, "nail_line_messages", [
        sel("*"), eq("shop_code", shopCode), eq("status", "draft"),
        "order=created_at.asc", "limit=300"
      ]),
      getActiveStaff(env, shopCode, true)
    ]);

  const activeToday = todayRows.filter(row => isActiveReservationStatus(row.status));
  const activeNext = nextRows.filter(row => isActiveReservationStatus(row.status));
  const relevantFollowups = await filterRelevantFollowups(env, shopCode, followupRows);
  const relevantMessages = await filterCurrentLineMessages(
    env, shopCode, lineMessageRows
  );
  const todayTasks = buildTodayTasks(relevantFollowups, relevantMessages);
  const byStaff = groupReservationsByStaff(activeToday, staff);

  return {
    ok: true,
    shop_code: shopCode,
    date,
    today: date,
    today_tasks: todayTasks,
    today_reservations: activeToday,
    today_reservations_by_staff: byStaff,
    next_business_date: nextBusinessDate,
    next_business_reservations: activeNext,
    workflow_counts: countBy(activeToday, row => clean(row.workflow_status || "reserved")),
    settings: {
      shop_name: settings.shop_name,
      open_time: normalizeTime(settings.open_time, "10:00"),
      close_time: normalizeTime(settings.close_time, "19:00")
    }
  };
}

async function adminSummary(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const today = todayJst();
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = addDays(addMonths(monthStart, 1), -1);

  const [todayRows, monthRows, followups, customers, treatments, designs] =
    await Promise.all([
      getReservationRowsByDate(env, shopCode, today),
      getReservationRowsInRange(env, shopCode, monthStart, monthEnd),
      sbSelect(env, "nail_followups", [
        sel("*"), eq("shop_code", shopCode),
        inFilter("status", ["open", "pending"]), "limit=5000"
      ]),
      sbSelect(env, "nail_customers", [
        sel("*"), eq("shop_code", shopCode), "limit=5000"
      ]),
      sbSelect(env, "nail_treatment_records", [
        sel("id,shop_code,next_visit_date,is_completed"),
        eq("shop_code", shopCode), "limit=5000"
      ]).catch(() => []),
      sbSelect(env, "nail_design_catalog", [
        sel("id,shop_code,is_active,is_public"),
        eq("shop_code", shopCode), "limit=5000"
      ]).catch(() => [])
    ]);

  const openFollowups = followups.filter(row =>
    ["open", "pending"].includes(clean(row.status || "open"))
  );
  const activeToday = todayRows.filter(row => isActiveReservationStatus(row.status));
  const activeMonth = monthRows.filter(row => isActiveReservationStatus(row.status));

  return {
    ok: true,
    shop_code: shopCode,
    today,
    counts: {
      today_reservations: activeToday.length,
      month_reservations: activeMonth.length,
      open_followups: openFollowups.length,
      overdue_followups: openFollowups.filter(
        row => row.due_date && row.due_date < today
      ).length,
      customers: customers.length,
      line_connected_customers: customers.filter(row => clean(row.line_user_id)).length,
      treatment_records: treatments.length,
      active_designs: designs.filter(row => row.is_active).length,
      public_designs: designs.filter(row => row.is_active && row.is_public).length,
      due_repeat_customers: treatments.filter(
        row => row.is_completed && row.next_visit_date && row.next_visit_date <= today
      ).length
    },
    workflow_counts: countBy(
      activeToday,
      row => clean(row.workflow_status || "reserved")
    )
  };
}

async function adminCustomerSearch(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const rawQ = url.searchParams.get("q") || url.searchParams.get("keyword") || "";
  const q = normalizeSearchText(rawQ);
  const phoneQ = normalizePhoneForStorage(rawQ);
  const rows = await sbSelect(env, "nail_customers", [
    sel("*"), eq("shop_code", shopCode),
    "order=updated_at.desc,created_at.desc", "limit=1000"
  ]);

  const customers = rows.filter(customer => {
    if (!q && !phoneQ) return true;
    const textHit = [
      customer.customer_name,
      customer.line_user_id,
      customer.line_display_name,
      customer.email,
      customer.memo,
      customer.last_design_note,
      customer.design_preference
    ].map(normalizeSearchText).some(value => q && value.includes(q));
    const phoneHit =
      phoneQ && normalizePhoneForStorage(customer.phone).includes(phoneQ);
    return textHit || phoneHit;
  }).slice(0, 100);

  return { ok: true, shop_code: shopCode, q: rawQ, customers };
}

async function adminManualReservationCreate(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const source = normalizeReservationSource(body.source || "phone");
  const result = await createReservation({
    ...body,
    shop_code: shopCode,
    source,
    created_by: clean(body.created_by || "owner_manual"),
    status:
      source === "instagram"
        ? "instagram_reserved"
        : source === "shop"
          ? "shop_reserved"
          : "phone_reserved"
  }, env);
  await audit(env, shopCode, "manual_reservation_created", "owner",
    result.reservation?.id || "", { source });
  return { ok: true, shop_code: shopCode, ...result };
}

async function adminUpdateFollowupStatus(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const id = clean(body.followup_id || body.id);
  if (!id) throw new AppError(400, "followup_id が必要です。");

  const status = clean(body.status || "handled");
  const rows = await sbUpdate(env, "nail_followups", [
    eq("shop_code", shopCode), eq("id", id)
  ], {
    status,
    handled_at: ["handled", "closed", "done"].includes(status)
      ? new Date().toISOString()
      : null,
    handled_note: clean(body.handled_note || body.note)
  });
  if (!rows.length) throw new AppError(404, "フォローが見つかりません。");
  await audit(env, shopCode, "followup_status_updated", "owner", id, { status });
  return { ok: true, shop_code: shopCode, followup: rows[0] };
}

async function logLineCopy(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  // Existing pages use admin_code in body. Keep it optional only for demo copy flow;
  // production always requires the configured code.
  const settings = await getSettings(env, shopCode);
  const supplied = getAdminCredential(request, body);
  if (!settings.demo_mode || supplied) {
    assertAdminCredential(supplied, settings, env);
  }

  const messageId = clean(body.message_id || body.id);
  const followupId = clean(body.followup_id);
  const now = new Date().toISOString();
  let message = null;

  if (messageId) {
    const rows = await sbUpdate(env, "nail_line_messages", [
      eq("shop_code", shopCode), eq("id", messageId)
    ], {
      message_title: body.message_title !== undefined
        ? clean(body.message_title)
        : undefined,
      message_body: body.message_body !== undefined
        ? clean(body.message_body)
        : undefined,
      status: "copied",
      copied_at: now,
      meta: {
        copied_from: clean(body.source_screen || "owner"),
        mark_followup_handled: Boolean(body.mark_followup_handled)
      }
    });
    message = rows[0] || null;
  }

  if (followupId && body.mark_followup_handled) {
    await sbUpdate(env, "nail_followups", [
      eq("shop_code", shopCode), eq("id", followupId)
    ], {
      status: "handled",
      handled_at: now,
      handled_note: "LINE文面をコピーして対応済みにしました。"
    });
  }

  await audit(env, shopCode, "line_message_copied", "owner", messageId, {
    followup_id: followupId,
    marked_handled: Boolean(body.mark_followup_handled)
  });

  return {
    ok: true,
    shop_code: shopCode,
    message,
    followup_id: followupId || null,
    copied_at: now
  };
}


// =========================================================
// NEXT customer detail / design catalog
// =========================================================

async function adminCustomerDetail(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const customerId = clean(url.searchParams.get("customer_id") || url.searchParams.get("id"));
  if (!customerId) throw new AppError(400, "customer_id が必要です。");

  const customer = (await sbSelect(env, "nail_customers", [
    sel("*"), eq("shop_code", shopCode), eq("id", customerId), "limit=1"
  ]))[0];
  if (!customer) throw new AppError(404, "顧客が見つかりません。");

  const [reservations, treatments, events, followups] = await Promise.all([
    sbSelect(env, "nail_reservations", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customerId),
      "order=reservation_date.desc,start_time.desc,created_at.desc", "limit=100"
    ]),
    sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customerId),
      "order=treatment_date.desc,created_at.desc", "limit=100"
    ]),
    sbSelect(env, "nail_customer_events", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customerId),
      "order=created_at.desc", "limit=100"
    ]),
    sbSelect(env, "nail_followups", [
      sel("*"), eq("shop_code", shopCode), eq("customer_id", customerId),
      "order=due_date.desc,created_at.desc", "limit=100"
    ])
  ]);

  const treatmentIds = treatments.map(row => row.id);
  const photos = treatmentIds.length
    ? await sbSelect(env, "nail_treatment_photos", [
        sel("*"), eq("shop_code", shopCode),
        inFilter("treatment_record_id", treatmentIds),
        eq("is_deleted", false),
        "order=taken_at.desc,sort_order.asc", "limit=500"
      ])
    : [];
  const photosByTreatment = groupBy(photos, row => String(row.treatment_record_id));

  return {
    ok: true,
    shop_code: shopCode,
    customer,
    reservations,
    treatment_records: treatments.map(row => ({
      ...row,
      photos: (photosByTreatment.get(String(row.id)) || []).map(sanitizePhotoMeta)
    })),
    events,
    followups,
    repeat_template: await buildRepeatTemplate(
      env, shopCode, customer, reservations, treatments
    )
  };
}

async function adminDesigns(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const includeInactive = parseBool(url.searchParams.get("include_inactive"), true);
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (!includeInactive) filters.push(eq("is_active", true));
  filters.push("order=is_active.desc,is_featured.desc,sort_order.asc,created_at.desc", "limit=1000");

  const designs = await sbSelect(env, "nail_design_catalog", filters);
  const designIds = designs.map(row => row.id);
  const photos = designIds.length
    ? await sbSelect(env, "nail_design_photos", [
        sel("*"), eq("shop_code", shopCode),
        inFilter("design_id", designIds), eq("is_deleted", false),
        "order=is_primary.desc,sort_order.asc,created_at.asc", "limit=2000"
      ])
    : [];
  const photosByDesign = groupBy(photos, row => String(row.design_id));

  return {
    ok: true,
    shop_code: shopCode,
    designs: designs.map(row => ({
      ...row,
      photos: (photosByDesign.get(String(row.id)) || []).map(sanitizePhotoMeta)
    }))
  };
}

async function adminSaveDesign(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const id = clean(body.id);
  const designCode = clean(body.design_code) ||
    `design_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
  const designName = clean(body.design_name);
  if (!designName) throw new AppError(400, "デザイン名が必要です。");

  const serviceCode = clean(body.service_code);
  let serviceId = clean(body.service_id) || null;
  if (!serviceId && serviceCode) {
    const service = (await sbSelect(env, "nail_services", [
      sel("id,service_code"), eq("shop_code", shopCode),
      eq("service_code", serviceCode), "limit=1"
    ]))[0];
    serviceId = service?.id || null;
  }

  const payload = {
    shop_code: shopCode,
    design_code: designCode,
    design_name: designName,
    category: clean(body.category || "simple"),
    hand_foot: normalizeHandFoot(body.hand_foot || "hand", false),
    style_tags: normalizeTextArray(body.style_tags),
    color_tags: normalizeTextArray(body.color_tags),
    base_price: clampNumber(Number(body.base_price || 0), 0, 1000000),
    estimated_minutes: clampNumber(Number(body.estimated_minutes || 60), 15, 480),
    service_id: serviceId,
    service_code: serviceCode,
    staff_ids: unique(normalizeArray(body.staff_ids).map(clean).filter(Boolean)),
    season_label: clean(body.season_label),
    description: clean(body.description),
    is_featured: parseBool(body.is_featured, false),
    is_public: parseBool(body.is_public, true),
    is_active: parseBool(body.is_active, true),
    sort_order: clampNumber(Number(body.sort_order || 100), 0, 9999),
    published_at:
      parseBool(body.is_public, true)
        ? clean(body.published_at) || new Date().toISOString()
        : null,
    created_by: clean(body.created_by || "owner")
  };

  let design;
  if (id) {
    const current = (await sbSelect(env, "nail_design_catalog", [
      sel("*"), eq("shop_code", shopCode), eq("id", id), "limit=1"
    ]))[0];
    if (!current) throw new AppError(404, "デザインが見つかりません。");
    const rows = await sbUpdate(env, "nail_design_catalog", [
      eq("shop_code", shopCode), eq("id", id)
    ], payload);
    design = rows[0] || { ...current, ...payload };
  } else {
    const rows = await sbInsert(env, "nail_design_catalog", payload);
    design = rows[0];
  }

  await audit(env, shopCode, id ? "design_updated" : "design_created",
    "owner", design?.id || id, { design_code: designCode });
  return { ok: true, shop_code: shopCode, design };
}

async function adminArchiveDesign(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const id = clean(body.id || body.design_id);
  if (!id) throw new AppError(400, "design_id が必要です。");

  const rows = await sbUpdate(env, "nail_design_catalog", [
    eq("shop_code", shopCode), eq("id", id)
  ], {
    is_active: false,
    is_public: false
  });
  if (!rows.length) throw new AppError(404, "デザインが見つかりません。");
  await audit(env, shopCode, "design_archived", "owner", id, {});
  return { ok: true, shop_code: shopCode, design: rows[0] };
}

// =========================================================
// NEXT treatments / workflow
// =========================================================

async function adminTreatments(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const customerId = clean(url.searchParams.get("customer_id"));
  const reservationId = clean(url.searchParams.get("reservation_id"));
  const id = clean(url.searchParams.get("id"));
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (id) filters.push(eq("id", id));
  if (customerId) filters.push(eq("customer_id", customerId));
  if (reservationId) filters.push(eq("reservation_id", reservationId));
  filters.push("order=treatment_date.desc,created_at.desc", "limit=500");

  const treatments = await sbSelect(env, "nail_treatment_records", filters);
  const ids = treatments.map(row => row.id);
  const photos = ids.length
    ? await sbSelect(env, "nail_treatment_photos", [
        sel("*"), eq("shop_code", shopCode),
        inFilter("treatment_record_id", ids),
        eq("is_deleted", false),
        "order=photo_type.asc,sort_order.asc,taken_at.asc", "limit=2000"
      ])
    : [];
  const grouped = groupBy(photos, row => String(row.treatment_record_id));

  return {
    ok: true,
    shop_code: shopCode,
    treatments: treatments.map(row => ({
      ...row,
      photos: (grouped.get(String(row.id)) || []).map(sanitizePhotoMeta)
    }))
  };
}

async function adminSaveTreatment(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const id = clean(body.id);
  const reservationId = clean(body.reservation_id) || null;
  let reservation = null;

  if (reservationId) {
    reservation = (await sbSelect(env, "nail_reservations", [
      sel("*"), eq("shop_code", shopCode), eq("id", reservationId), "limit=1"
    ]))[0];
    if (!reservation) throw new AppError(404, "予約が見つかりません。");
  }

  const customerId = clean(body.customer_id || reservation?.customer_id);
  if (!customerId) throw new AppError(400, "customer_id が必要です。");
  const customer = (await sbSelect(env, "nail_customers", [
    sel("id,customer_name,line_user_id,phone"),
    eq("shop_code", shopCode), eq("id", customerId), "limit=1"
  ]))[0];
  if (!customer) throw new AppError(404, "顧客が見つかりません。");

  const serviceSnapshot = normalizeJsonObject(
    body.service_snapshot,
    reservation
      ? {
          service_id: reservation.service_id,
          service_code: reservation.service_code,
          service_name: reservation.service_name,
          base_price: reservation.base_price,
          total_price: reservation.total_price,
          total_minutes: reservation.total_minutes
        }
      : {}
  );
  const optionSnapshot = normalizeJsonArrayValue(
    body.option_snapshot,
    reservation
      ? normalizeArray(reservation.option_codes).map((code, index) => ({
          option_code: code,
          option_name: normalizeArray(reservation.option_names)[index] || ""
        }))
      : []
  );

  const payload = {
    shop_code: shopCode,
    customer_id: customerId,
    reservation_id: reservationId,
    staff_id: clean(body.staff_id || reservation?.staff_id) || null,
    treatment_date:
      isValidDateString(body.treatment_date)
        ? body.treatment_date
        : clean(reservation?.reservation_date) || todayJst(),
    hand_foot: normalizeHandFoot(
      body.hand_foot || reservation?.hand_foot || "hand",
      false
    ),
    service_snapshot: serviceSnapshot,
    option_snapshot: optionSnapshot,
    nail_shape: clean(body.nail_shape),
    nail_length: clean(body.nail_length),
    color_codes: normalizeTextArray(body.color_codes),
    gel_brand: clean(body.gel_brand),
    gel_product: clean(body.gel_product),
    off_method: clean(body.off_method),
    extension_count: clampNumber(
      Number(body.extension_count ?? reservation?.length_extension_count ?? 0),
      0,
      20
    ),
    repair_count: clampNumber(
      Number(body.repair_count ?? reservation?.repair_count ?? 0),
      0,
      20
    ),
    nail_condition: clean(body.nail_condition),
    allergy_confirmed: parseBool(body.allergy_confirmed, false),
    treatment_note: clean(body.treatment_note),
    next_visit_days: clampNumber(Number(body.next_visit_days || 21), 0, 180),
    next_visit_date:
      isValidDateString(body.next_visit_date)
        ? body.next_visit_date
        : null,
    next_recommendation: clean(body.next_recommendation),
    is_completed: parseBool(body.is_completed, false),
    completed_at:
      parseBool(body.is_completed, false)
        ? clean(body.completed_at) || new Date().toISOString()
        : null,
    created_by: clean(body.created_by || "owner"),
    updated_by: clean(body.updated_by || "owner")
  };

  let treatment;
  if (id) {
    const current = (await sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode), eq("id", id), "limit=1"
    ]))[0];
    if (!current) throw new AppError(404, "カルテが見つかりません。");
    const rows = await sbUpdate(env, "nail_treatment_records", [
      eq("shop_code", shopCode), eq("id", id)
    ], payload);
    treatment = rows[0] || { ...current, ...payload };
  } else if (reservationId) {
    const existing = (await sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode), eq("reservation_id", reservationId),
      "limit=1"
    ]))[0];
    if (existing) {
      const rows = await sbUpdate(env, "nail_treatment_records", [
        eq("shop_code", shopCode), eq("id", existing.id)
      ], payload);
      treatment = rows[0] || { ...existing, ...payload };
    } else {
      treatment = (await sbInsert(env, "nail_treatment_records", payload))[0];
    }
  } else {
    treatment = (await sbInsert(env, "nail_treatment_records", payload))[0];
  }

  await audit(env, shopCode, id ? "treatment_updated" : "treatment_saved",
    "owner", treatment?.id || id, {
      customer_id: customerId,
      reservation_id: reservationId,
      is_completed: payload.is_completed
    });

  return { ok: true, shop_code: shopCode, treatment };
}

async function adminCompleteTreatment(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const result = await adminSaveTreatment(request, {
    ...body,
    shop_code: shopCode,
    is_completed: true,
    completed_at: clean(body.completed_at) || new Date().toISOString()
  }, env);
  const treatment = result.treatment;

  if (treatment?.reservation_id) {
    await sbUpdate(env, "nail_reservations", [
      eq("shop_code", shopCode), eq("id", treatment.reservation_id)
    ], {
      workflow_status: parseBool(body.checkout_complete, false)
        ? "completed"
        : "checkout_wait",
      status: parseBool(body.checkout_complete, false)
        ? "completed"
        : undefined
    });
  }

  if (treatment?.customer_id && treatment?.next_visit_date) {
    const open = await sbSelect(env, "nail_followups", [
      sel("*"), eq("shop_code", shopCode),
      eq("customer_id", treatment.customer_id),
      eq("followup_type", "next_replacement"),
      inFilter("status", ["open", "pending"]),
      "order=created_at.desc", "limit=10"
    ]);
    if (open.length) {
      await sbUpdate(env, "nail_followups", [
        eq("shop_code", shopCode), eq("id", open[0].id)
      ], {
        reservation_id: treatment.reservation_id || open[0].reservation_id,
        due_date: treatment.next_visit_date,
        memo:
          treatment.next_recommendation ||
          "施術カルテの次回来店目安に合わせてご案内します。"
      });
    }
  }

  await audit(env, shopCode, "treatment_completed", "owner",
    treatment?.id || "", {
      reservation_id: treatment?.reservation_id || null,
      next_visit_date: treatment?.next_visit_date || null
    });
  return {
    ok: true,
    shop_code: shopCode,
    message: "施術カルテを完了しました。",
    treatment
  };
}

async function adminUpdateWorkflow(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const reservationId = clean(body.reservation_id || body.id);
  const workflowStatus = clean(body.workflow_status || body.status);
  if (!reservationId) throw new AppError(400, "reservation_id が必要です。");
  if (!WORKFLOW_STATUSES.includes(workflowStatus)) {
    throw new AppError(400, "workflow_status が正しくありません。", {
      allowed: WORKFLOW_STATUSES
    });
  }

  const current = (await sbSelect(env, "nail_reservations", [
    sel("*"), eq("shop_code", shopCode), eq("id", reservationId), "limit=1"
  ]))[0];
  if (!current) throw new AppError(404, "予約が見つかりません。");

  const patch = { workflow_status: workflowStatus };
  if (workflowStatus === "cancelled") patch.status = "cancelled";
  if (workflowStatus === "no_show") patch.status = "no_show";
  if (workflowStatus === "completed") patch.status = "completed";

  const rows = await sbUpdate(env, "nail_reservations", [
    eq("shop_code", shopCode), eq("id", reservationId)
  ], patch);
  const reservation = rows[0] || { ...current, ...patch };

  if (workflowStatus === "completed") {
    const treatment = (await sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode), eq("reservation_id", reservationId),
      "limit=1"
    ]))[0];
    if (treatment && !treatment.is_completed) {
      await sbUpdate(env, "nail_treatment_records", [
        eq("shop_code", shopCode), eq("id", treatment.id)
      ], { is_completed: true, completed_at: new Date().toISOString() });
    }
  }

  await audit(env, shopCode, "workflow_status_updated", "owner",
    reservationId, {
      old_workflow_status: current.workflow_status || "reserved",
      new_workflow_status: workflowStatus,
      note: clean(body.note)
    });
  return {
    ok: true,
    shop_code: shopCode,
    reservation,
    workflow_status: workflowStatus
  };
}

async function adminWorkflowHistory(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const reservationId = clean(url.searchParams.get("reservation_id"));
  if (!reservationId) throw new AppError(400, "reservation_id が必要です。");
  const history = await sbSelect(env, "nail_reservation_status_history", [
    sel("*"), eq("shop_code", shopCode), eq("reservation_id", reservationId),
    "order=changed_at.desc", "limit=200"
  ]);
  return { ok: true, shop_code: shopCode, reservation_id: reservationId, history };
}

// =========================================================
// NEXT private photo flow
// =========================================================

async function adminPhotoPrepare(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const targetType = normalizePhotoTargetType(body.target_type);
  const targetId = clean(body.target_id);
  const mimeType = clean(body.mime_type).toLowerCase();
  const fileSize = Number(body.file_size_bytes || body.size || 0);
  const originalName = clean(body.file_name || body.filename || "photo");
  const photoType = targetType === "design"
    ? "design"
    : normalizeTreatmentPhotoType(body.photo_type || "after");

  if (!targetId) throw new AppError(400, "target_id が必要です。");
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
    throw new AppError(400, "対応していない画像形式です。", {
      allowed: [...ALLOWED_IMAGE_MIME]
    });
  }
  if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_IMAGE_BYTES) {
    throw new AppError(400, "画像サイズは10MB以下にしてください。");
  }

  const target = await assertPhotoTarget(env, shopCode, targetType, targetId);
  const resolvedCustomerId = clean(body.customer_id || target.customer_id) || null;
  const resolvedReservationId = clean(body.reservation_id || target.reservation_id) || null;
  const extension = extensionForMime(mimeType);
  const safeName = `${Date.now()}_${crypto.randomUUID()}.${extension}`;
  const storagePath = targetType === "design"
    ? `${shopCode}/catalog/${targetId}/${safeName}`
    : `${shopCode}/customers/${resolvedCustomerId || "unknown"}/treatments/${targetId}/${safeName}`;

  const payload = {
    v: 1,
    shop_code: shopCode,
    target_type: targetType,
    target_id: targetId,
    photo_type: photoType,
    storage_bucket: MEDIA_BUCKET,
    storage_path: storagePath,
    mime_type: mimeType,
    file_size_bytes: fileSize,
    original_name: originalName,
    customer_id: resolvedCustomerId,
    reservation_id: resolvedReservationId,
    exp: Math.floor(Date.now() / 1000) + 15 * 60
  };
  const token = await signUploadToken(payload, env);
  const origin = new URL(request.url).origin;

  return {
    ok: true,
    shop_code: shopCode,
    upload_token: token,
    upload_url: `${origin}/api/admin/photos/upload?token=${encodeURIComponent(token)}`,
    complete_url: `${origin}/api/admin/photos/complete`,
    method: "PUT",
    content_type: mimeType,
    max_bytes: MAX_IMAGE_BYTES,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    storage_bucket: MEDIA_BUCKET,
    storage_path: storagePath
  };
}

async function adminPhotoUpload(request, url, env) {
  const token = clean(url.searchParams.get("token"));
  if (!token) throw new AppError(400, "upload token が必要です。");
  const payload = await verifyUploadToken(token, env);
  const contentType = clean(request.headers.get("Content-Type")).toLowerCase();
  const lengthHeader = Number(request.headers.get("Content-Length") || 0);

  if (contentType && contentType !== payload.mime_type) {
    throw new AppError(400, "Content-Typeが準備時と一致しません。");
  }
  if (lengthHeader > MAX_IMAGE_BYTES) {
    throw new AppError(413, "画像サイズは10MB以下にしてください。");
  }

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError(413, "画像サイズは10MB以下にしてください。");
  }
  if (payload.file_size_bytes && bytes.byteLength !== Number(payload.file_size_bytes)) {
    throw new AppError(400, "画像サイズが準備時と一致しません。");
  }

  await storageUpload(
    env,
    payload.storage_bucket,
    payload.storage_path,
    bytes,
    payload.mime_type
  );
  return {
    ok: true,
    uploaded: true,
    storage_bucket: payload.storage_bucket,
    storage_path: payload.storage_path,
    bytes: bytes.byteLength,
    upload_token: token
  };
}

async function adminPhotoComplete(request, body, env) {
  const token = clean(body.upload_token || body.token);
  if (!token) throw new AppError(400, "upload_token が必要です。");
  const payload = await verifyUploadToken(token, env);
  await requireAdmin(request, env, payload.shop_code, body);
  await storageAssertExists(env, payload.storage_bucket, payload.storage_path);

  let photo;
  if (payload.target_type === "design") {
    const existing = (await sbSelect(env, "nail_design_photos", [
      sel("*"), eq("shop_code", payload.shop_code),
      eq("design_id", payload.target_id),
      eq("storage_path", payload.storage_path), "limit=1"
    ]))[0];
    const row = {
      shop_code: payload.shop_code,
      design_id: payload.target_id,
      storage_bucket: payload.storage_bucket,
      storage_path: payload.storage_path,
      thumbnail_path: clean(body.thumbnail_path),
      mime_type: payload.mime_type,
      file_size_bytes: payload.file_size_bytes,
      width_px: nullablePositiveInt(body.width_px, 20000),
      height_px: nullablePositiveInt(body.height_px, 20000),
      alt_text: clean(body.alt_text),
      is_primary: parseBool(body.is_primary, false),
      is_deleted: false,
      sort_order: clampNumber(Number(body.sort_order || 100), 0, 9999),
      created_by: clean(body.created_by || "owner")
    };
    if (row.is_primary) {
      await sbUpdate(env, "nail_design_photos", [
        eq("shop_code", payload.shop_code),
        eq("design_id", payload.target_id),
        eq("is_primary", true)
      ], { is_primary: false }).catch(() => []);
    }
    if (existing) {
      photo = (await sbUpdate(env, "nail_design_photos", [
        eq("shop_code", payload.shop_code), eq("id", existing.id)
      ], row))[0];
    } else {
      photo = (await sbInsert(env, "nail_design_photos", row))[0];
    }
  } else {
    const treatment = await assertPhotoTarget(
      env, payload.shop_code, "treatment", payload.target_id
    );
    const customerId = clean(payload.customer_id || treatment.customer_id);
    if (!customerId) throw new AppError(400, "customer_idを確認できません。");

    const existing = (await sbSelect(env, "nail_treatment_photos", [
      sel("*"), eq("shop_code", payload.shop_code),
      eq("treatment_record_id", payload.target_id),
      eq("storage_path", payload.storage_path), "limit=1"
    ]))[0];
    const row = {
      shop_code: payload.shop_code,
      treatment_record_id: payload.target_id,
      customer_id: customerId,
      reservation_id:
        clean(payload.reservation_id || treatment.reservation_id) || null,
      photo_type: normalizeTreatmentPhotoType(payload.photo_type),
      storage_bucket: payload.storage_bucket,
      storage_path: payload.storage_path,
      thumbnail_path: clean(body.thumbnail_path),
      mime_type: payload.mime_type,
      file_size_bytes: payload.file_size_bytes,
      width_px: nullablePositiveInt(body.width_px, 20000),
      height_px: nullablePositiveInt(body.height_px, 20000),
      caption: clean(body.caption),
      is_customer_visible: parseBool(body.is_customer_visible, true),
      is_deleted: false,
      taken_at: clean(body.taken_at) || new Date().toISOString(),
      sort_order: clampNumber(Number(body.sort_order || 100), 0, 9999),
      created_by: clean(body.created_by || "owner")
    };
    if (existing) {
      photo = (await sbUpdate(env, "nail_treatment_photos", [
        eq("shop_code", payload.shop_code), eq("id", existing.id)
      ], row))[0];
    } else {
      photo = (await sbInsert(env, "nail_treatment_photos", row))[0];
    }
  }

  await audit(env, payload.shop_code, "private_photo_completed", "owner",
    photo?.id || "", {
      target_type: payload.target_type,
      target_id: payload.target_id,
      storage_path: payload.storage_path
    });

  return {
    ok: true,
    shop_code: payload.shop_code,
    photo: sanitizePhotoMeta(photo),
    storage_private: true
  };
}

async function adminPhotoSignedUrl(request, url, env) {
  const shopCode = getShopCode(url, env);
  await requireAdmin(request, env, shopCode);
  const photoId = clean(url.searchParams.get("photo_id") || url.searchParams.get("id"));
  const targetType = normalizePhotoTargetType(url.searchParams.get("target_type") || "treatment");
  if (!photoId) throw new AppError(400, "photo_id が必要です。");

  const table = targetType === "design"
    ? "nail_design_photos"
    : "nail_treatment_photos";
  const photo = (await sbSelect(env, table, [
    sel("*"), eq("shop_code", shopCode), eq("id", photoId),
    eq("is_deleted", false), "limit=1"
  ]))[0];
  if (!photo) throw new AppError(404, "写真が見つかりません。");

  const expiresIn = clampNumber(Number(url.searchParams.get("expires_in") || 300), 60, 3600);
  const signed = await storageCreateSignedUrl(
    env,
    photo.storage_bucket || MEDIA_BUCKET,
    photo.storage_path,
    expiresIn
  );
  return {
    ok: true,
    shop_code: shopCode,
    photo: sanitizePhotoMeta(photo),
    signed_url: signed,
    expires_in: expiresIn,
    storage_private: true
  };
}

async function adminPhotoDelete(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  await requireAdmin(request, env, shopCode, body);
  const photoId = clean(body.photo_id || body.id);
  const targetType = normalizePhotoTargetType(body.target_type || "treatment");
  if (!photoId) throw new AppError(400, "photo_id が必要です。");

  const table = targetType === "design"
    ? "nail_design_photos"
    : "nail_treatment_photos";
  const photo = (await sbSelect(env, table, [
    sel("*"), eq("shop_code", shopCode), eq("id", photoId), "limit=1"
  ]))[0];
  if (!photo) throw new AppError(404, "写真が見つかりません。");

  const rows = await sbUpdate(env, table, [
    eq("shop_code", shopCode), eq("id", photoId)
  ], {
    is_deleted: true,
    ...(targetType === "design" ? { is_primary: false } : {})
  });

  if (parseBool(body.delete_storage_object, false)) {
    await storageDelete(env, photo.storage_bucket || MEDIA_BUCKET, [
      photo.storage_path
    ]).catch(() => {});
    if (photo.thumbnail_path) {
      await storageDelete(env, photo.storage_bucket || MEDIA_BUCKET, [
        photo.thumbnail_path
      ]).catch(() => {});
    }
  }

  await audit(env, shopCode, "private_photo_deleted", "owner", photoId, {
    target_type: targetType,
    storage_deleted: parseBool(body.delete_storage_object, false)
  });
  return { ok: true, shop_code: shopCode, photo: rows[0] || photo };
}


// =========================================================
// Demo prepare / system check
// =========================================================

async function adminPrepareDemo(request, body, env) {
  const shopCode = clean(body.shop_code) || env.SHOP_CODE || DEFAULT_SHOP_CODE;
  const settings = await requireAdmin(request, env, shopCode, body);

  let nextDb = null;
  try {
    nextDb = await sbRpc(env, "nail_next_demo_prepare", {
      p_shop_code: shopCode
    });
  } catch (error) {
    nextDb = { ok: false, error: clean(error?.message || error) };
  }

  const [services, options, staff] = await Promise.all([
    getActiveServices(env, shopCode),
    getActiveOptions(env, shopCode),
    getActiveStaff(env, shopCode)
  ]);
  if (!services.length || !staff.length) {
    throw new AppError(409, "デモ準備にはメニューとスタッフが必要です。");
  }

  const today = todayJst();
  const nextDate = findNextBusinessDate(today, settings);
  const serviceByCode = new Map(services.map(row => [row.service_code, row]));
  const optionByCode = new Map(options.map(row => [row.option_code, row]));
  const staffByIndex = index => staff[Math.min(index, staff.length - 1)] || staff[0];

  const demoCustomers = [
    {
      key: "haruka",
      line_user_id: "DEMO_NAIL_HARUKA",
      line_display_name: "Haruka",
      customer_name: "山田はるか",
      phone: "09011112222",
      nail_visit_history: "リピーター",
      design_preference: "ベージュ・上品",
      last_design_note: "前回はヌードベージュのワンカラー。",
      allergy_note: "",
      source: "demo_prepare"
    },
    {
      key: "yui",
      line_user_id: "DEMO_NAIL_YUI",
      line_display_name: "Yui",
      customer_name: "佐々木ゆい",
      phone: "09033334444",
      nail_visit_history: "2回目",
      design_preference: "マグネット・ピンク",
      last_design_note: "オフィスマグネット希望。",
      allergy_note: "爪が薄くなりやすい。",
      source: "demo_prepare"
    },
    {
      key: "naoko",
      line_user_id: "DEMO_NAIL_NAOKO",
      line_display_name: "Naoko",
      customer_name: "井上なおこ",
      phone: "09099990000",
      nail_visit_history: "リピーター",
      design_preference: "フットネイル",
      last_design_note: "次回付け替え案内対象。",
      allergy_note: "",
      source: "demo_prepare"
    }
  ];

  const saved = {};
  for (const input of demoCustomers) {
    saved[input.key] = await upsertCustomer(env, shopCode, input);
  }

  const templates = [
    {
      key: "haruka",
      date: today,
      time: normalizeDemoTime(settings, "10:00"),
      service: serviceByCode.get("one_color") || services[0],
      option_codes: ["replace_off"],
      staff: staffByIndex(0),
      staff_requested: true,
      workflow_status: "arrived",
      design_note: "前回と同じヌードベージュ。"
    },
    {
      key: "yui",
      date: today,
      time: normalizeDemoTime(settings, "13:00"),
      service: serviceByCode.get("simple_design") || services[1] || services[0],
      option_codes: [],
      staff: staffByIndex(1),
      staff_requested: true,
      workflow_status: "reserved",
      design_note: "上品なピンク系マグネット。"
    },
    {
      key: "naoko",
      date: today,
      time: normalizeDemoTime(settings, "16:00"),
      service: serviceByCode.get("foot_nail") || services[0],
      option_codes: ["replace_off"],
      staff: staffByIndex(0),
      staff_requested: false,
      workflow_status: "in_service",
      design_note: "フット・クラシックレッド。"
    },
    {
      key: "haruka",
      date: nextDate,
      time: normalizeDemoTime(settings, "11:00"),
      service: serviceByCode.get("simple_design") || services[0],
      option_codes: [],
      staff: staffByIndex(0),
      staff_requested: true,
      workflow_status: "reserved",
      design_note: "次営業日のデモ予約。"
    },
    {
      key: "yui",
      date: nextDate,
      time: normalizeDemoTime(settings, "15:00"),
      service: serviceByCode.get("nail_care") || services[0],
      option_codes: [],
      staff: staffByIndex(1),
      staff_requested: false,
      workflow_status: "reserved",
      design_note: "ケア中心。"
    }
  ];

  const reservations = [];
  for (const template of templates) {
    const customer = saved[template.key];
    const optionRows = template.option_codes
      .map(code => optionByCode.get(code))
      .filter(Boolean);
    reservations.push(await ensureDemoReservation(
      env, shopCode, settings, customer, template, optionRows
    ));
  }

  // One past treatment record makes repeat-booking and chart history useful
  // without marking today's appointment as already completed.
  const sampleReservation = reservations.find(
    row => row.customer_id === saved.haruka.id
  );
  const pastTreatmentDate = addDays(today, -21);
  let treatment = null;
  if (sampleReservation) {
    const existing = (await sbSelect(env, "nail_treatment_records", [
      sel("*"), eq("shop_code", shopCode),
      eq("customer_id", saved.haruka.id),
      eq("treatment_date", pastTreatmentDate),
      "order=created_at.desc", "limit=1"
    ]))[0];
    const payload = {
      shop_code: shopCode,
      customer_id: saved.haruka.id,
      reservation_id: null,
      staff_id: sampleReservation.staff_id || null,
      treatment_date: pastTreatmentDate,
      hand_foot: sampleReservation.hand_foot || "hand",
      service_snapshot: {
        service_code: sampleReservation.service_code,
        service_name: sampleReservation.service_name,
        total_price: sampleReservation.total_price,
        total_minutes: sampleReservation.total_minutes
      },
      option_snapshot: normalizeArray(sampleReservation.option_codes).map(
        (code, index) => ({
          option_code: code,
          option_name: normalizeArray(sampleReservation.option_names)[index] || ""
        })
      ),
      nail_shape: "ラウンド",
      nail_length: "ショート",
      color_codes: ["N-102"],
      gel_brand: "DPRO DEMO GEL",
      gel_product: "Nude Beige",
      off_method: "フィルイン",
      extension_count: 0,
      repair_count: 0,
      nail_condition: "良好。乾燥が少しあるため保湿案内。",
      allergy_confirmed: true,
      treatment_note: "前回と同じ色味。次回も同内容で予約可能。",
      next_visit_days: 21,
      next_visit_date: today,
      next_recommendation: "3週間後を目安に付け替え。",
      is_completed: true,
      completed_at: new Date().toISOString(),
      created_by: "demo_prepare",
      updated_by: "demo_prepare"
    };
    treatment = existing
      ? (await sbUpdate(env, "nail_treatment_records", [
          eq("shop_code", shopCode), eq("id", existing.id)
        ], payload))[0]
      : (await sbInsert(env, "nail_treatment_records", payload))[0];
  }

  for (const reservation of reservations.slice(0, 3)) {
    await ensureDemoLineMessage(env, shopCode, reservation);
  }
  await ensureDemoFollowup(
    env, shopCode, saved.naoko,
    reservations.find(row => row.customer_id === saved.naoko.id),
    today
  );

  const [todayRows, nextRows, messages, followups] = await Promise.all([
    getReservationRowsByDate(env, shopCode, today),
    getReservationRowsByDate(env, shopCode, nextDate),
    sbSelect(env, "nail_line_messages", [
      sel("id"), eq("shop_code", shopCode), eq("status", "draft"), "limit=500"
    ]),
    sbSelect(env, "nail_followups", [
      sel("id"), eq("shop_code", shopCode),
      inFilter("status", ["open", "pending"]), "limit=500"
    ])
  ]);

  await audit(env, shopCode, "next_demo_prepared", "owner", "", {
    version: WORKER_VERSION,
    today,
    next_business_date: nextDate,
    next_db: nextDb
  });

  return {
    ok: true,
    shop_code: shopCode,
    message:
      "営業前デモデータを準備しました。既存データを削除せず、今日・次営業日・カルテ・デザインを確認できます。",
    today,
    next_business_date: nextDate,
    today_reservations: todayRows.filter(row => isActiveReservationStatus(row.status)).length,
    next_business_reservations: nextRows.filter(row => isActiveReservationStatus(row.status)).length,
    line_messages_count: messages.length,
    followups_count: followups.length,
    treatment_record: treatment,
    next_database_prepare: nextDb
  };
}

async function adminSystemCheck(request, url, env) {
  const shopCode = getShopCode(url, env);
  const settings = await requireAdmin(request, env, shopCode);
  const items = [];
  const add = (key, ok, label, detail = "") => {
    items.push({ key, ok: Boolean(ok), label, detail: clean(detail) });
  };

  add("worker", true, "Worker起動", WORKER_VERSION);
  add("shop_code", shopCode === clean(settings.shop_code || shopCode),
    "店舗コード", shopCode);
  add("slot_30", Number(settings.reservation_slot_minutes || 30) === 30,
    "30分予約枠", String(settings.reservation_slot_minutes || 30));
  add("phone_normalize",
    normalizePhoneForStorage("＋８１ ９０－１２３４－５６７８") === "09012345678",
    "電話番号正規化", normalizePhoneForStorage("＋８１ ９０－１２３４－５６７８"));
  add("existing_routes", EXISTING_ROUTE_CONTRACT.length === 27,
    "既存API契約", `${EXISTING_ROUTE_CONTRACT.length} routes`);
  add("next_routes", NEXT_ROUTE_CONTRACT.length === 20,
    "NEXT API契約", `${NEXT_ROUTE_CONTRACT.length} routes`);

  let dbCheck = null;
  try {
    dbCheck = await sbRpc(env, "nail_next_system_check", {
      p_shop_code: shopCode
    });
    add("db_rpc", dbCheck?.ok, "Supabase NEXT基盤",
      JSON.stringify({
        required_tables_ok: dbCheck?.required_tables_ok,
        reservation_columns_ok: dbCheck?.reservation_columns_ok,
        storage_ok: dbCheck?.storage?.ok
      }));
  } catch (error) {
    add("db_rpc", false, "Supabase NEXT基盤", error?.message);
  }

  const tableChecks = [
    "nail_settings",
    "nail_staff",
    "nail_services",
    "nail_service_options",
    "nail_customers",
    "nail_reservations",
    "nail_design_catalog",
    "nail_design_photos",
    "nail_treatment_records",
    "nail_treatment_photos",
    "nail_reservation_status_history"
  ];

  const tableResults = await Promise.all(tableChecks.map(async table => {
    try {
      await sbSelect(env, table, [sel("id"), eq("shop_code", shopCode), "limit=1"]);
      return { table, ok: true };
    } catch (error) {
      return { table, ok: false, error: error?.message };
    }
  }));
  for (const result of tableResults) {
    add(`table_${result.table}`, result.ok, result.table, result.error || "accessible");
  }

  let counts = {};
  try {
    const [staff, services, options, customers, reservations, designs, treatments] =
      await Promise.all([
        countRows(env, "nail_staff", [eq("shop_code", shopCode)]),
        countRows(env, "nail_services", [eq("shop_code", shopCode)]),
        countRows(env, "nail_service_options", [eq("shop_code", shopCode)]),
        countRows(env, "nail_customers", [eq("shop_code", shopCode)]),
        countRows(env, "nail_reservations", [eq("shop_code", shopCode)]),
        countRows(env, "nail_design_catalog", [eq("shop_code", shopCode)]),
        countRows(env, "nail_treatment_records", [eq("shop_code", shopCode)])
      ]);
    counts = { staff, services, options, customers, reservations, designs, treatments };
    add("staff_data", staff > 0, "スタッフデータ", `${staff}`);
    add("service_data", services > 0, "メニューデータ", `${services}`);
    add("design_data", designs > 0, "デザインカタログ", `${designs}`);
  } catch (error) {
    add("data_counts", false, "データ件数", error?.message);
  }

  // Read-only slot test: no reservation is inserted.
  try {
    const service = (await getActiveServices(env, shopCode))[0];
    if (service) {
      const candidateDate = findNextBusinessDate(todayJst(), settings, true);
      const spec = await buildReservationSpec(env, shopCode, {
        service_code: service.service_code,
        option_codes: [],
        has_off: false
      });
      const slots = await computeAvailableTimes(
        env, shopCode, candidateDate, spec, { include_detail: false }
      );
      add("available_times", Array.isArray(slots), "空き時間計算",
        `${candidateDate} / ${slots.length} slots`);
    } else {
      add("available_times", false, "空き時間計算", "メニューなし");
    }
  } catch (error) {
    add("available_times", false, "空き時間計算", error?.message);
  }

  const frontendCurrent = FRONTEND_RELEASE_VERSION;
  const databaseCurrent = clean(dbCheck?.version);
  const versionAligned =
    WORKER_VERSION === EXPECTED_WORKER_VERSION &&
    databaseCurrent === EXPECTED_DATABASE_VERSION &&
    frontendCurrent === EXPECTED_FRONTEND_VERSION;
  const explicitDemo = isExplicitDemoRuntime(shopCode, settings, env);
  const productionGuardOk = explicitDemo
    ? shopCode === "nail_demo" && Boolean(settings.demo_mode)
    : shopCode !== "nail_demo";

  add("canonical_system_code", SYSTEM_CODE === "NAIL", "Canonical SYSTEM_CODE", SYSTEM_CODE);
  add("worker_version_contract", WORKER_VERSION === EXPECTED_WORKER_VERSION,
    "Worker version contract", `${WORKER_VERSION} / ${EXPECTED_WORKER_VERSION}`);
  add("database_version_contract", databaseCurrent === EXPECTED_DATABASE_VERSION,
    "Database version contract", `${databaseCurrent} / ${EXPECTED_DATABASE_VERSION}`);
  add("frontend_version_contract", frontendCurrent === EXPECTED_FRONTEND_VERSION,
    "Frontend version contract", `${frontendCurrent} / ${EXPECTED_FRONTEND_VERSION}`);
  add("versions_aligned", versionAligned, "Version alignment", String(versionAligned));
  add("production_guard", productionGuardOk, "DEMO / Production guard",
    explicitDemo ? "nail_demo explicit demo" : "production fail-closed");
  add("owner_auth_boundary", Boolean(DEFAULT_OWNER_AUTH_URL),
    "Common Owner Auth", "production Bearer session / exact system+facility");
  add("line_server_verify", true, "LINE server verify",
    "https://api.line.me/oauth2/v2.1/verify / verified sub authoritative");
  add("staff_scoped_session", Boolean(getStaffSessionSecret(env)),
    "Staff scoped session", STAFF_SCOPES.join(","));
  add("verified_audit_actor", true, "Verified audit actor binding",
    "Owner/Staff critical mutations require auditVerified");
  add("cors_explicit", CORS_HEADERS["Access-Control-Allow-Origin"] === CANONICAL_BROWSER_ORIGIN,
    "Explicit CORS origin", CANONICAL_BROWSER_ORIGIN);
  add("security_routes", SECURITY_ROUTE_CONTRACT.length === 3,
    "Security route contract", `${SECURITY_ROUTE_CONTRACT.length} routes`);

  const failed = items.filter(item => !item.ok);
  return {
    ok: failed.length === 0,
    all_ok: failed.length === 0,
    service: "DPRO NAIL LINE NEXT System Check",
    version: WORKER_VERSION,
    shop_code: shopCode,
    time: new Date().toISOString(),
    jst_date: todayJst(),
    passed: items.length - failed.length,
    failed: failed.length,
    total: items.length,
    items,
    database: dbCheck,
    counts,
    route_contract: {
      existing: EXISTING_ROUTE_CONTRACT,
      next: NEXT_ROUTE_CONTRACT,
      security: SECURITY_ROUTE_CONTRACT
    },
    systemCode: SYSTEM_CODE,
    workerVersion: { current: WORKER_VERSION, expected: EXPECTED_WORKER_VERSION },
    databaseVersion: { current: clean(dbCheck?.version), expected: EXPECTED_DATABASE_VERSION },
    frontendVersion: { current: FRONTEND_RELEASE_VERSION, expected: EXPECTED_FRONTEND_VERSION, evidence: "paired_frontend_release_meta" },
    versionsAligned: versionAligned,
    sourceLockCommit: SOURCE_LOCK_COMMIT,
    security: {
      ownerAuthBoundary: "DPRO_COMMON_OWNER_AUTH",
      lineIdentityServerVerify: true,
      staffScopedSession: true,
      verifiedAuditActorBinding: true,
      corsOrigin: CANONICAL_BROWSER_ORIGIN
    },
    production_guard: productionGuardOk
  };
}

// =========================================================
// Demo helpers
// =========================================================

async function ensureDemoReservation(
  env, shopCode, settings, customer, template, optionRows
) {
  const existing = (await sbSelect(env, "nail_reservations", [
    sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
    eq("reservation_date", template.date), eq("start_time", template.time),
    neq("status", "deleted"), "order=created_at.desc", "limit=1"
  ]))[0];

  const service = template.service;
  const baseMinutes = Number(service.base_minutes || 60);
  const optionMinutes = optionRows.reduce(
    (sum, row) => sum + Number(row.add_minutes || 0), 0
  );
  const bufferMinutes = Number(
    service.buffer_minutes ?? settings.default_buffer_minutes ?? 10
  );
  const totalMinutes = baseMinutes + optionMinutes + bufferMinutes;
  const basePrice = Number(service.base_price || 0);
  const optionPrice = optionRows.reduce(
    (sum, row) => sum + Number(row.add_price || 0), 0
  );
  const payload = {
    shop_code: shopCode,
    customer_id: customer.id,
    line_user_id: customer.line_user_id || null,
    customer_name: customer.customer_name,
    phone: normalizePhoneForStorage(customer.phone),
    staff_id: template.staff?.id || null,
    staff_name: template.staff?.staff_name || "",
    is_staff_requested: Boolean(template.staff_requested),
    assigned_type: template.staff_requested ? "requested" : "auto",
    service_id: service.id,
    service_code: service.service_code,
    service_name: service.service_name,
    option_codes: optionRows.map(row => row.option_code),
    option_names: optionRows.map(row => row.option_name),
    has_off: optionRows.some(row => row.option_code === "replace_off"),
    base_minutes: baseMinutes,
    option_minutes: optionMinutes,
    buffer_minutes: bufferMinutes,
    total_minutes: totalMinutes,
    base_price: basePrice,
    option_price: optionPrice,
    total_price: basePrice + optionPrice,
    reservation_date: template.date,
    start_time: template.time,
    end_time: minutesToTime(timeToMinutes(template.time) + totalMinutes),
    status: "reserved",
    workflow_status: template.workflow_status || "reserved",
    source: "demo_prepare",
    hand_foot: categoryToHandFoot(service.category),
    off_source:
      optionRows.some(row => row.option_code === "replace_off")
        ? "own_shop"
        : "none",
    length_extension_count: 0,
    repair_count: 0,
    design_note: template.design_note || "",
    request_note: "STEP NAIL-NEXT-3営業デモ",
    created_by: "demo_prepare"
  };

  if (existing) {
    return (await sbUpdate(env, "nail_reservations", [
      eq("shop_code", shopCode), eq("id", existing.id)
    ], payload))[0] || { ...existing, ...payload };
  }
  return (await sbInsert(env, "nail_reservations", payload))[0];
}

async function ensureDemoLineMessage(env, shopCode, reservation) {
  const existing = (await sbSelect(env, "nail_line_messages", [
    sel("*"), eq("shop_code", shopCode),
    eq("reservation_id", reservation.id),
    eq("message_type", "reservation_received"),
    inFilter("status", ["draft", "copied"]),
    "limit=1"
  ]))[0];
  if (existing) return existing;

  return (await sbInsert(env, "nail_line_messages", {
    shop_code: shopCode,
    customer_id: reservation.customer_id || null,
    reservation_id: reservation.id,
    line_user_id: reservation.line_user_id || null,
    customer_name: reservation.customer_name,
    message_type: "reservation_received",
    message_title: "予約受付メッセージ",
    message_body:
      `${reservation.customer_name}様\n` +
      `${reservation.reservation_date} ${normalizeTime(reservation.start_time, "")}より` +
      `「${reservation.service_name}」で承っています。\n` +
      `ご来店をお待ちしております。`,
    send_method: "copy",
    status: "draft",
    source_screen: "demo_prepare",
    meta: { step: "NAIL-NEXT-3" }
  }))[0];
}

async function ensureDemoFollowup(env, shopCode, customer, reservation, dueDate) {
  const existing = (await sbSelect(env, "nail_followups", [
    sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
    eq("followup_type", "next_replacement"),
    inFilter("status", ["open", "pending"]), "limit=1"
  ]))[0];
  if (existing) {
    return (await sbUpdate(env, "nail_followups", [
      eq("shop_code", shopCode), eq("id", existing.id)
    ], {
      reservation_id: reservation?.id || existing.reservation_id,
      due_date: dueDate,
      priority: "high",
      memo: "付け替え目安が近いため、LINE文面を確認してください。"
    }))[0];
  }

  return (await sbInsert(env, "nail_followups", {
    shop_code: shopCode,
    customer_id: customer.id,
    reservation_id: reservation?.id || null,
    line_user_id: customer.line_user_id || null,
    customer_name: customer.customer_name,
    followup_type: "next_replacement",
    title: "次回付け替え案内",
    memo: "付け替え目安が近いため、LINE文面を確認してください。",
    due_date: dueDate,
    priority: "high",
    status: "open"
  }))[0];
}

function normalizeDemoTime(settings, desired) {
  const open = timeToMinutes(normalizeTime(settings.open_time, "10:00"));
  const close = timeToMinutes(normalizeTime(settings.close_time, "19:00"));
  let value = timeToMinutes(normalizeTime(desired, "10:00"));
  value = Math.max(open, Math.min(value, close - 60));
  value = Math.ceil(value / 30) * 30;
  return minutesToTime(value);
}


// =========================================================
// Nail data helpers
// =========================================================

async function getSettings(env, shopCode) {
  let rows = await sbSelect(env, "nail_settings", [
    sel("*"), eq("shop_code", shopCode), "limit=1"
  ]);
  if (!rows.length) {
    rows = await sbSelect(env, "nail_settings", [sel("*"), eq("id", 1), "limit=1"]);
  }
  if (!rows.length) throw new AppError(500, "店舗設定が見つかりません。");
  return rows[0];
}

async function getActiveStaff(env, shopCode, includeInactive = false) {
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (!includeInactive) filters.push(eq("is_active", true));
  filters.push("order=sort_order.asc,created_at.asc", "limit=500");
  return await sbSelect(env, "nail_staff", filters);
}

async function getActiveServices(env, shopCode, includeInactive = false) {
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (!includeInactive) filters.push(eq("is_active", true));
  filters.push("order=sort_order.asc,created_at.asc", "limit=500");
  return await sbSelect(env, "nail_services", filters);
}

async function getActiveOptions(env, shopCode, serviceCode = "", includeInactive = false) {
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (!includeInactive) filters.push(eq("is_active", true));
  filters.push("order=sort_order.asc,created_at.asc", "limit=500");
  const rows = await sbSelect(env, "nail_service_options", filters);
  if (!serviceCode) return rows;
  return rows.filter(row => {
    const compatible = normalizeArray(row.compatible_service_codes);
    return !compatible.length || compatible.includes(serviceCode);
  });
}

async function getEligibleStaffForService(env, shopCode, serviceCode) {
  const staff = await getActiveStaff(env, shopCode);
  if (!serviceCode) return staff;
  const service = (await sbSelect(env, "nail_services", [
    sel("id,service_code"), eq("shop_code", shopCode),
    eq("service_code", serviceCode), eq("is_active", true), "limit=1"
  ]))[0];
  if (!service) return [];

  const links = await sbSelect(env, "nail_staff_services", [
    sel("*"), eq("shop_code", shopCode), eq("service_id", service.id),
    eq("is_available", true), "limit=500"
  ]);
  if (!links.length) return staff;
  const allowed = new Set(links.map(row => String(row.staff_id)));
  return staff.filter(row => allowed.has(String(row.id)));
}

async function getStaffShiftsByWeekday(env, shopCode, weekday) {
  return await sbSelect(env, "nail_staff_shifts", [
    sel("*"), eq("shop_code", shopCode), eq("weekday", weekday), "limit=500"
  ]);
}

async function getReservationRowsByDate(env, shopCode, date) {
  return await sbSelect(env, "nail_reservations", [
    sel("*"), eq("shop_code", shopCode), eq("reservation_date", date),
    "order=start_time.asc,created_at.asc", "limit=2000"
  ]);
}

async function getReservationRowsInRange(env, shopCode, from, to) {
  return await sbSelect(env, "nail_reservations", [
    sel("*"), eq("shop_code", shopCode),
    gte("reservation_date", from), lte("reservation_date", to),
    "order=reservation_date.asc,start_time.asc", "limit=5000"
  ]);
}

async function buildReservationSpec(env, shopCode, input) {
  const serviceCode = clean(input.service_code);
  if (!serviceCode) throw new AppError(400, "service_code が必要です。");
  const service = (await sbSelect(env, "nail_services", [
    sel("*"), eq("shop_code", shopCode), eq("service_code", serviceCode),
    eq("is_active", true), "limit=1"
  ]))[0];
  if (!service) throw new AppError(404, "メニューが見つかりません。");

  const requestedCodes = unique(parseOptionCodes(input.option_codes));
  const availableOptions = await getActiveOptions(env, shopCode, serviceCode);
  const byCode = new Map(availableOptions.map(row => [row.option_code, row]));
  const selected = requestedCodes.map(code => byCode.get(code)).filter(Boolean);
  const hasOff =
    parseBool(input.has_off, false) ||
    selected.some(row => clean(row.option_code) === "replace_off");
  if (hasOff && !selected.some(row => row.option_code === "replace_off")) {
    const off = byCode.get("replace_off");
    if (off) selected.push(off);
  }

  const baseMinutes = Number(service.base_minutes || 60);
  const optionMinutes = selected.reduce(
    (sum, row) => sum + Number(row.add_minutes || 0), 0
  );
  const bufferMinutes = Number(service.buffer_minutes || 0);
  const basePrice = Number(service.base_price || 0);
  const optionPrice = selected.reduce(
    (sum, row) => sum + Number(row.add_price || 0), 0
  );

  return {
    service,
    options: selected.map(normalizeOptionForClient),
    option_codes: selected.map(row => row.option_code),
    option_names: selected.map(row => row.option_name),
    has_off: hasOff,
    base_minutes: baseMinutes,
    option_minutes: optionMinutes,
    buffer_minutes: bufferMinutes,
    total_minutes: baseMinutes + optionMinutes + bufferMinutes,
    base_price: basePrice,
    option_price: optionPrice,
    total_price: basePrice + optionPrice
  };
}

async function upsertCustomer(env, shopCode, input) {
  const lineUserId = clean(input.line_user_id);
  const phone = normalizePhoneForStorage(input.phone);
  let existing = [];

  if (lineUserId) {
    existing = await sbSelect(env, "nail_customers", [
      sel("*"), eq("shop_code", shopCode), eq("line_user_id", lineUserId),
      "order=updated_at.desc", "limit=1"
    ]);
  }
  if (!existing.length && phone) {
    existing = await findCustomersByNormalizedPhone(env, shopCode, phone, 1);
  }

  const payload = {
    shop_code: shopCode,
    line_user_id: lineUserId || null,
    line_display_name: clean(input.line_display_name),
    customer_name: clean(input.customer_name || input.name || "お客様"),
    phone,
    email: clean(input.email),
    nail_visit_history: clean(input.nail_visit_history),
    preferred_staff_id: clean(input.preferred_staff_id) || null,
    allergy_note: clean(input.allergy_note),
    design_preference: clean(input.design_preference),
    last_design_note: clean(input.last_design_note || input.design_note),
    source: normalizeReservationSource(input.source || "line"),
    memo: clean(input.memo)
  };

  if (existing.length) {
    const rows = await sbUpdate(env, "nail_customers", [
      eq("shop_code", shopCode), eq("id", existing[0].id)
    ], payload);
    return rows[0] || { ...existing[0], ...payload };
  }
  return (await sbInsert(env, "nail_customers", payload))[0];
}

async function findCustomers(env, shopCode, identity = {}) {
  const lineUserId = clean(identity.line_user_id);
  const verifiedLineUserId = clean(identity.__verified_line_user_id);
  const phone = normalizePhoneForStorage(identity.phone);
  if (lineUserId) {
    const rows = await sbSelect(env, "nail_customers", [
      sel("*"), eq("shop_code", shopCode), eq("line_user_id", lineUserId),
      "order=updated_at.desc", "limit=20"
    ]);
    if (rows.length) return rows;
    if (verifiedLineUserId) return [];
  }
  if (phone && !verifiedLineUserId) {
    return await findCustomersByNormalizedPhone(env, shopCode, phone, 20);
  }
  return [];
}

async function findCustomersByNormalizedPhone(env, shopCode, phone, limit = 20) {
  const normalized = normalizePhoneForStorage(phone);
  if (!normalized) return [];
  const exact = await sbSelect(env, "nail_customers", [
    sel("*"), eq("shop_code", shopCode), eq("phone", normalized),
    "order=updated_at.desc", `limit=${limit}`
  ]);
  if (exact.length) return exact;

  // Old rows may contain hyphens/full-width characters. Scan a bounded list and
  // compare normalized values without changing the stored data.
  const candidates = await sbSelect(env, "nail_customers", [
    sel("*"), eq("shop_code", shopCode),
    "order=updated_at.desc", "limit=1000"
  ]);
  return candidates.filter(
    row => normalizePhoneForStorage(row.phone) === normalized
  ).slice(0, limit);
}

async function getCustomerReservations(env, shopCode, customer) {
  const rows = await sbSelect(env, "nail_reservations", [
    sel("*"), eq("shop_code", shopCode), eq("customer_id", customer.id),
    "order=reservation_date.desc,start_time.desc,created_at.desc", "limit=200"
  ]);
  return rows;
}

async function findReservationTarget(env, shopCode, body) {
  const id = clean(body.reservation_id || body.id);
  if (id) {
    const row = (await sbSelect(env, "nail_reservations", [
      sel("*"), eq("shop_code", shopCode), eq("id", id), "limit=1"
    ]))[0];
    if (row && clean(body.__verified_line_user_id) &&
        clean(row.line_user_id) !== clean(body.__verified_line_user_id)) {
      return null;
    }
    if (row && isActiveReservationStatus(row.status)) return row;
    return null;
  }

  const lineUserId = clean(body.line_user_id);
  const phone = normalizePhoneForStorage(body.phone);
  const date = clean(body.reservation_date || body.date);
  const time = normalizeTime(body.start_time || body.time, "");
  const filters = [
    sel("*"), eq("shop_code", shopCode),
    inFilter("status", ACTIVE_RESERVATION_STATUSES)
  ];
  if (lineUserId) filters.push(eq("line_user_id", lineUserId));
  if (date) filters.push(eq("reservation_date", date));
  if (time) filters.push(eq("start_time", time));
  filters.push("order=created_at.desc", "limit=100");

  let rows = await sbSelect(env, "nail_reservations", filters);
  if (!rows.length && phone && !clean(body.__verified_line_user_id)) {
    const candidates = await sbSelect(env, "nail_reservations", [
      sel("*"), eq("shop_code", shopCode),
      inFilter("status", ACTIVE_RESERVATION_STATUSES),
      "order=created_at.desc", "limit=1000"
    ]);
    rows = candidates.filter(
      row => normalizePhoneForStorage(row.phone) === phone
    );
  }
  return rows[0] || null;
}

async function assertActiveReservationLimit(env, shopCode, identity, settings) {
  const limit = Number(settings.max_active_reservations_per_customer || 2);
  if (limit <= 0) return;

  const filters = [
    sel("id,status,line_user_id,phone"),
    eq("shop_code", shopCode),
    inFilter("status", ACTIVE_RESERVATION_STATUSES),
    gte("reservation_date", todayJst()),
    "limit=1000"
  ];
  const rows = await sbSelect(env, "nail_reservations", filters);
  const matches = rows.filter(row => {
    if (identity.exclude_id && String(row.id) === String(identity.exclude_id)) {
      return false;
    }
    const lineHit =
      identity.line_user_id &&
      clean(row.line_user_id) === clean(identity.line_user_id);
    const phoneHit =
      identity.phone &&
      normalizePhoneForStorage(row.phone) ===
        normalizePhoneForStorage(identity.phone);
    return lineHit || phoneHit;
  });
  if (matches.length >= limit) {
    throw new AppError(
      409,
      `有効な予約はお一人${limit}件までです。会員ページから予約をご確認ください。`,
      { active_count: matches.length, limit },
      "ACTIVE_RESERVATION_LIMIT"
    );
  }
}

async function buildRepeatTemplate(env, shopCode, customer, reservations, treatments) {
  const completedTreatment =
    (treatments || []).find(row => row.is_completed) ||
    (treatments || [])[0] ||
    null;
  let baseReservation = null;

  if (completedTreatment?.reservation_id) {
    baseReservation = reservations.find(
      row => String(row.id) === String(completedTreatment.reservation_id)
    ) || null;
    if (!baseReservation) {
      baseReservation = (await sbSelect(env, "nail_reservations", [
        sel("*"), eq("shop_code", shopCode),
        eq("id", completedTreatment.reservation_id), "limit=1"
      ]))[0] || null;
    }
  }

  if (!baseReservation) {
    baseReservation =
      reservations.find(row =>
        ["completed", "changed", "reserved", "confirmed"].includes(clean(row.status))
      ) || reservations[0] || null;
  }
  if (!baseReservation && !completedTreatment) return null;

  const serviceSnapshot = normalizeJsonObject(
    completedTreatment?.service_snapshot, {}
  );
  const optionSnapshot = normalizeJsonArrayValue(
    completedTreatment?.option_snapshot, []
  );
  const serviceCode =
    clean(baseReservation?.service_code || serviceSnapshot.service_code);
  if (!serviceCode) return null;

  const optionCodes = baseReservation
    ? normalizeArray(baseReservation.option_codes)
    : optionSnapshot.map(row => clean(row.option_code)).filter(Boolean);
  const staffId = clean(
    baseReservation?.staff_id || completedTreatment?.staff_id
  );
  const referenceDesignId = clean(baseReservation?.reference_design_id);

  return {
    source: completedTreatment ? "treatment_record" : "reservation",
    customer_id: customer.id,
    reservation_id: baseReservation?.id || null,
    treatment_record_id: completedTreatment?.id || null,
    service_code: serviceCode,
    service_name:
      clean(baseReservation?.service_name || serviceSnapshot.service_name),
    option_codes: optionCodes,
    option_names: baseReservation
      ? normalizeArray(baseReservation.option_names)
      : optionSnapshot.map(row => clean(row.option_name)).filter(Boolean),
    staff_id: staffId || null,
    staff_name: clean(baseReservation?.staff_name),
    staff_requested: Boolean(baseReservation?.is_staff_requested && staffId),
    hand_foot: normalizeHandFoot(
      completedTreatment?.hand_foot ||
      baseReservation?.hand_foot ||
      "hand",
      false
    ),
    off_source: normalizeOffSource(
      baseReservation?.off_source ||
      (baseReservation?.has_off ? "unknown" : "none")
    ),
    length_extension_count: Number(
      completedTreatment?.extension_count ??
      baseReservation?.length_extension_count ??
      0
    ),
    repair_count: Number(
      completedTreatment?.repair_count ??
      baseReservation?.repair_count ??
      0
    ),
    reference_design_id: referenceDesignId || null,
    design_note: clean(
      completedTreatment?.treatment_note ||
      baseReservation?.design_note ||
      customer.last_design_note
    ),
    last_photo_available: Boolean(completedTreatment),
    reservation_input: {
      service_code: serviceCode,
      option_codes: optionCodes,
      staff_id: staffId || "",
      staff_requested: Boolean(baseReservation?.is_staff_requested && staffId),
      hand_foot: normalizeHandFoot(
        completedTreatment?.hand_foot ||
        baseReservation?.hand_foot ||
        "hand",
        false
      ),
      off_source: normalizeOffSource(
        baseReservation?.off_source ||
        (baseReservation?.has_off ? "unknown" : "none")
      ),
      length_extension_count: Number(
        completedTreatment?.extension_count ??
        baseReservation?.length_extension_count ??
        0
      ),
      repair_count: Number(
        completedTreatment?.repair_count ??
        baseReservation?.repair_count ??
        0
      ),
      reference_design_id: referenceDesignId || "",
      design_note: clean(
        completedTreatment?.treatment_note ||
        baseReservation?.design_note ||
        customer.last_design_note
      )
    }
  };
}

async function getPrimaryDesignPhotos(env, shopCode, designIds) {
  const ids = unique(designIds.map(String).filter(Boolean));
  if (!ids.length) return [];
  const photos = await sbSelect(env, "nail_design_photos", [
    sel("*"), eq("shop_code", shopCode), inFilter("design_id", ids),
    eq("is_deleted", false),
    "order=is_primary.desc,sort_order.asc,created_at.asc", "limit=2000"
  ]);
  const seen = new Set();
  return photos.filter(photo => {
    const key = String(photo.design_id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function assertPhotoTarget(env, shopCode, targetType, targetId) {
  const table = targetType === "design"
    ? "nail_design_catalog"
    : "nail_treatment_records";
  const row = (await sbSelect(env, table, [
    sel("*"), eq("shop_code", shopCode), eq("id", targetId), "limit=1"
  ]))[0];
  if (!row) {
    throw new AppError(
      404,
      targetType === "design"
        ? "デザインが見つかりません。"
        : "施術カルテが見つかりません。"
    );
  }
  return row;
}

async function findServiceForAdmin(env, shopCode, body) {
  const id = clean(body.id || body.service_id);
  const code = clean(body.service_code);
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (id) filters.push(eq("id", id));
  else if (code) filters.push(eq("service_code", code));
  else throw new AppError(400, "service id または service_code が必要です。");
  filters.push("limit=1");
  const row = (await sbSelect(env, "nail_services", filters))[0];
  if (!row) throw new AppError(404, "メニューが見つかりません。");
  return row;
}

async function findOptionForAdmin(env, shopCode, body) {
  const id = clean(body.id || body.option_id);
  const code = clean(body.option_code);
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (id) filters.push(eq("id", id));
  else if (code) filters.push(eq("option_code", code));
  else throw new AppError(400, "option id または option_code が必要です。");
  filters.push("limit=1");
  const row = (await sbSelect(env, "nail_service_options", filters))[0];
  if (!row) throw new AppError(404, "オプションが見つかりません。");
  return row;
}

async function findStaffForAdmin(env, shopCode, body) {
  const id = clean(body.id || body.staff_id);
  const code = clean(body.staff_code);
  const filters = [sel("*"), eq("shop_code", shopCode)];
  if (id) filters.push(eq("id", id));
  else if (code) filters.push(eq("staff_code", code));
  else throw new AppError(400, "staff id または staff_code が必要です。");
  filters.push("limit=1");
  const row = (await sbSelect(env, "nail_staff", filters))[0];
  if (!row) throw new AppError(404, "スタッフが見つかりません。");
  return row;
}


// =========================================================
// Follow-up / task / message helpers
// =========================================================

async function filterCurrentLineMessages(env, shopCode, messages = []) {
  const rows = (messages || []).filter(
    row => clean(row.status || "draft") === "draft"
  );
  const reservationIds = unique(
    rows.map(row => clean(row.reservation_id)).filter(Boolean)
  );
  if (!reservationIds.length) return rows;

  const reservations = await sbSelect(env, "nail_reservations", [
    sel("id,status"), eq("shop_code", shopCode),
    inFilter("id", reservationIds), "limit=500"
  ]).catch(() => []);
  const statusById = new Map(
    reservations.map(row => [String(row.id), clean(row.status)])
  );
  const staleTypes = new Set([
    "reservation_received", "reservation_changed", "line_connect_guidance"
  ]);

  return rows.filter(message => {
    const reservationId = clean(message.reservation_id);
    if (!reservationId || !staleTypes.has(clean(message.message_type))) return true;
    const status = statusById.get(String(reservationId));
    return !status || isActiveReservationStatus(status);
  });
}

async function filterRelevantFollowups(env, shopCode, followups = []) {
  const rows = (followups || []).filter(row =>
    ["open", "pending"].includes(clean(row.status || "open"))
  );
  const reservationIds = unique(
    rows.map(row => clean(row.reservation_id)).filter(Boolean)
  );
  if (!reservationIds.length) return rows;

  const reservations = await sbSelect(env, "nail_reservations", [
    sel("id,status"), eq("shop_code", shopCode),
    inFilter("id", reservationIds), "limit=500"
  ]).catch(() => []);
  const statusById = new Map(
    reservations.map(row => [String(row.id), clean(row.status)])
  );

  return rows.filter(followup => {
    if (clean(followup.followup_type) === "cancel_rebook") return true;
    const reservationId = clean(followup.reservation_id);
    if (!reservationId) return true;
    const status = statusById.get(String(reservationId));
    return !status || isActiveReservationStatus(status);
  });
}

async function archiveDraftLineMessagesForReservations(
  env, shopCode, reservationIds = [], messageTypes = [], reason = "obsolete"
) {
  const ids = unique(reservationIds.map(clean).filter(Boolean));
  if (!ids.length) return [];
  const filters = [
    eq("shop_code", shopCode),
    inFilter("reservation_id", ids),
    eq("status", "draft")
  ];
  const types = unique(messageTypes.map(clean).filter(Boolean));
  if (types.length) filters.push(inFilter("message_type", types));
  return await sbUpdate(env, "nail_line_messages", filters, {
    status: "obsolete",
    meta: {
      archived_reason: reason,
      archived_at: new Date().toISOString(),
      step: "NAIL-NEXT-3"
    }
  }).catch(() => []);
}

async function closeOpenNextReplacementFollowups(
  env, shopCode, reservationIds, note
) {
  const ids = unique(reservationIds.map(clean).filter(Boolean));
  if (!ids.length) return [];
  const rows = await sbSelect(env, "nail_followups", [
    sel("*"), eq("shop_code", shopCode),
    inFilter("reservation_id", ids),
    eq("followup_type", "next_replacement"),
    inFilter("status", ["open", "pending"]), "limit=500"
  ]).catch(() => []);
  const updated = [];
  for (const row of rows) {
    const result = await sbUpdate(env, "nail_followups", [
      eq("shop_code", shopCode), eq("id", row.id)
    ], {
      status: "closed",
      handled_at: new Date().toISOString(),
      handled_note: note
    });
    if (result[0]) updated.push(result[0]);
  }
  return updated;
}

async function moveOpenNextReplacementFollowups(
  env, shopCode, oldReservationId, newReservationId, dueDate
) {
  const rows = await sbSelect(env, "nail_followups", [
    sel("*"), eq("shop_code", shopCode),
    eq("reservation_id", oldReservationId),
    eq("followup_type", "next_replacement"),
    inFilter("status", ["open", "pending"]), "limit=100"
  ]).catch(() => []);
  const updated = [];
  for (const row of rows) {
    const result = await sbUpdate(env, "nail_followups", [
      eq("shop_code", shopCode), eq("id", row.id)
    ], {
      reservation_id: newReservationId,
      due_date: dueDate,
      handled_note: "予約変更後の日時に合わせて付け替えました。"
    });
    if (result[0]) updated.push(result[0]);
  }
  return updated;
}

function buildTodayTasks(followups = [], lineMessages = []) {
  const tasks = [];
  const followupById = new Map(
    followups.map(row => [String(row.id), row])
  );
  const linkedFollowups = new Set();

  for (const message of lineMessages) {
    const followupId = clean(message.followup_id);
    const followup = followupId
      ? followupById.get(String(followupId))
      : null;
    if (followupId) linkedFollowups.add(String(followupId));
    tasks.push({
      type: "line_message",
      id: message.id,
      title: message.message_title || "LINE文面",
      subtitle: followup?.title || "LINE文面確認",
      customer_name: message.customer_name || "",
      priority: followup?.priority || "normal",
      due_date: followup?.due_date || null,
      memo: followup?.memo || "",
      message_type: message.message_type,
      message_body: message.message_body,
      followup: followup || null,
      line_message: message
    });
  }

  for (const followup of followups) {
    if (linkedFollowups.has(String(followup.id))) continue;
    tasks.push({
      type: "followup",
      id: followup.id,
      title: followup.title || "フォロー",
      subtitle: followup.followup_type || "followup",
      customer_name: followup.customer_name || "",
      priority: followup.priority || "normal",
      due_date: followup.due_date,
      memo: followup.memo || "",
      followup
    });
  }

  return tasks.sort((a, b) => {
    const priority = priorityRank(a.priority) - priorityRank(b.priority);
    if (priority) return priority;
    return String(a.due_date || "").localeCompare(String(b.due_date || ""));
  });
}

function groupReservationsByStaff(reservations, staff) {
  const staffMap = new Map(
    staff.map(row => [String(row.id), {
      staff_id: row.id,
      staff_name: row.staff_name,
      display_name: row.display_name,
      reservations: []
    }])
  );
  const unassigned = {
    staff_id: null,
    staff_name: "未割当・自動割当",
    display_name: "未割当",
    reservations: []
  };

  for (const reservation of reservations) {
    const key = String(reservation.staff_id || "");
    if (key && staffMap.has(key)) {
      staffMap.get(key).reservations.push(reservation);
    } else {
      unassigned.reservations.push(reservation);
    }
  }

  const result = [...staffMap.values()].filter(
    group => group.reservations.length
  );
  if (unassigned.reservations.length) result.push(unassigned);
  return result;
}

function buildReservationReceivedMessage(input) {
  const options = input.optionNames?.length
    ? `\nオプション：${input.optionNames.join("、")}`
    : "";
  const staff = input.staffName
    ? `\n担当：${input.staffName}`
    : "\n担当：指名なし";
  const note = input.salonNote ? `\n\n${input.salonNote}` : "";
  return (
    `${input.customerName}様\n` +
    `${input.shopName}です。\n\n` +
    `ご予約を受け付けました。\n` +
    `日時：${input.reservationDate} ${input.startTime}\n` +
    `メニュー：${input.serviceName}${options}${staff}\n` +
    `所要時間目安：約${input.totalMinutes}分` +
    `${note}`
  );
}

function buildLineConnectGuidanceMessage(input) {
  return (
    `${input.customerName}様\n` +
    `${input.shopName}です。\n\n` +
    `ご予約ありがとうございます。` +
    `予約確認・変更や次回のご案内をLINEで受け取れるよう、` +
    `この公式アカウントを友だち追加してください。`
  );
}

function buildReservationChangeMessage(input) {
  return (
    `${input.customerName}様\n` +
    `予約変更を受け付けました。\n\n` +
    `変更前：${input.previousDate} ${input.previousTime}\n` +
    `変更後：${input.newDate} ${input.newTime}\n` +
    `メニュー：${input.serviceName}\n` +
    `担当：${input.staffName || "指名なし"}`
  );
}

function buildReservationCancelMessage(input) {
  const reason = input.reason ? `\n理由：${input.reason}` : "";
  return (
    `${input.customerName}様\n` +
    `下記予約のキャンセルを受け付けました。\n\n` +
    `${input.reservationDate} ${input.startTime}${reason}\n\n` +
    `別日をご希望の場合は、予約画面から改めてお申し込みください。`
  );
}

async function audit(
  env, shopCode, action, actorType = "system", targetId = "", detail = {}
) {
  try {
    const verifiedLine = clean(detail?.verified_line_user_id);
    const actor_type = verifiedLine
      ? "customer_line_verified"
      : (actorType === "owner" ? "owner_compat" : actorType);
    const actor_name = verifiedLine
      ? `line:${verifiedLine}`
      : (actorType === "owner" ? "owner_compat_server_path" : actorType);
    await sbInsert(env, "nail_audit_logs", {
      shop_code: shopCode,
      action,
      actor_type,
      actor_name,
      target_table: "",
      target_id: targetId ? String(targetId) : "",
      detail: {
        ...detail,
        verified_actor: Boolean(verifiedLine),
        verified_by: verifiedLine ? "LINE_ID_TOKEN_SERVER_VERIFY" : "compatibility_log_not_authoritative"
      }
    });
  } catch (_) {
    // Compatibility audit must not break the existing primary operation.
    // Critical Owner/Staff mutations additionally use auditVerified(), which is mandatory.
  }
}

// =========================================================
// PRODUCT READY SECURITY BOUNDARY (NAIL-PR1)
// =========================================================

function expectedFacilityCode(shopCode, env) {
  return clean(env.FACILITY_CODE || shopCode);
}

function isExplicitDemoRuntime(shopCode, settings, env) {
  const envMode = clean(env.NAIL_ENVIRONMENT || env.OWNER_ENVIRONMENT).toLowerCase();
  if (envMode === "production") return false;
  if (envMode === "demo") {
    return shopCode === "nail_demo" && Boolean(settings?.demo_mode);
  }
  // nail_demo + DB demo_mode is the existing explicit demo contract.
  return shopCode === "nail_demo" && Boolean(settings?.demo_mode);
}

function getBearerToken(request) {
  const value = clean(request.headers.get("Authorization"));
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? clean(match[1]) : "";
}

async function verifyCommonOwnerSession(request, env, shopCode) {
  const token = getBearerToken(request);
  if (!token) {
    throw new AppError(401, "オーナーログインが必要です。", null, "OWNER_SESSION_REQUIRED");
  }
  if (token.startsWith(`${STAFF_TOKEN_PREFIX}.`)) {
    throw new AppError(403, "スタッフセッションではオーナー操作を実行できません。", null, "STAFF_TOKEN_NOT_OWNER");
  }
  const facilityCode = expectedFacilityCode(shopCode, env);
  if (!facilityCode) {
    throw new AppError(503, "施設コードが設定されていません。", null, "FACILITY_CODE_REQUIRED");
  }
  const authUrl = clean(env.OWNER_AUTH_URL || DEFAULT_OWNER_AUTH_URL).replace(/\/+$/, "");
  if (!authUrl) {
    throw new AppError(503, "Common Owner Authが設定されていません。", null, "OWNER_AUTH_NOT_CONFIGURED");
  }
  const response = await fetch(`${authUrl}/auth/session`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.authenticated !== true) {
    throw new AppError(401, "オーナーセッションが無効です。", null, "OWNER_SESSION_INVALID");
  }
  if (clean(data.systemCode).toUpperCase() !== SYSTEM_CODE) {
    throw new AppError(403, "このシステムへのアクセス権がありません。", null, "OWNER_SYSTEM_MISMATCH");
  }
  if (clean(data.facilityCode) !== facilityCode) {
    throw new AppError(403, "別店舗のセッションではアクセスできません。", null, "OWNER_FACILITY_MISMATCH");
  }
  if (clean(data.environment).toLowerCase() !== "production") {
    throw new AppError(403, "本番環境のオーナーセッションが必要です。", null, "OWNER_ENVIRONMENT_MISMATCH");
  }
  return {
    verified: true,
    actor_type: "owner",
    actor_name: clean(data.facilityName) || `owner:${facilityCode}`,
    actor_id: facilityCode,
    system_code: SYSTEM_CODE,
    facility_code: facilityCode,
    environment: "production",
    verified_by: "DPRO_COMMON_OWNER_AUTH",
    expires_at: clean(data.expiresAt)
  };
}

function getDemoCredential(request, body = null) {
  const url = new URL(request.url);
  return clean(
    body?.admin_code || body?.code || body?.admin_token ||
    request.headers.get("X-Admin-Code") || request.headers.get("X-Admin-Token") ||
    url.searchParams.get("admin_code") || url.searchParams.get("code") ||
    url.searchParams.get("admin_token")
  );
}

async function authorizeOwnerOrDemo(request, env, shopCode, body = null) {
  const cached = AUTH_CONTEXT.get(request);
  if (cached && cached.shop_code === shopCode) return cached;

  const settings = await getSettings(env, shopCode);
  let actor;
  if (isExplicitDemoRuntime(shopCode, settings, env)) {
    const credential = getDemoCredential(request, body);
    assertAdminCredential(credential, settings, env);
    actor = {
      verified: true,
      actor_type: "demo_owner",
      actor_name: "demo:nail_demo",
      actor_id: "nail_demo",
      system_code: SYSTEM_CODE,
      facility_code: "nail_demo",
      environment: "demo",
      verified_by: "DEMO_MANAGEMENT_CODE"
    };
  } else {
    // Production never falls back to admin_code/body/query credentials.
    actor = await verifyCommonOwnerSession(request, env, shopCode);
  }

  const context = { shop_code: shopCode, settings, actor };
  AUTH_CONTEXT.set(request, context);
  return context;
}

async function verifiedActorForRequest(request, env, shopCode, body = null) {
  return (await authorizeOwnerOrDemo(request, env, shopCode, body)).actor;
}

async function verifyLineIdentity(request, body, env) {
  const idToken = clean(
    request.headers.get("X-Line-ID-Token") || body?.id_token || body?.idToken
  );
  if (!idToken) {
    throw new AppError(401, "LINE本人確認が必要です。", null, "LINE_ID_TOKEN_REQUIRED");
  }
  const clientId = clean(env.LINE_LOGIN_CHANNEL_ID);
  if (!clientId) {
    throw new AppError(503, "LINE Login Channel IDが設定されていません。", null, "LINE_CHANNEL_NOT_CONFIGURED");
  }
  const params = new URLSearchParams({ id_token: idToken, client_id: clientId });
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !clean(data?.sub)) {
    throw new AppError(401, "LINE本人確認に失敗しました。", null, "LINE_IDENTITY_INVALID");
  }
  return {
    sub: clean(data.sub),
    name: clean(data.name),
    verified: true,
    verified_by: "LINE_ID_TOKEN_SERVER_VERIFY"
  };
}

async function secureCustomerIdentityUrl(request, url, env) {
  const safeUrl = new URL(url.toString());
  const shopCode = getShopCode(safeUrl, env);
  const settings = await getSettings(env, shopCode);
  if (isExplicitDemoRuntime(shopCode, settings, env)) return safeUrl;

  const identity = await verifyLineIdentity(request, null, env);
  safeUrl.searchParams.set("line_user_id", identity.sub);
  safeUrl.searchParams.delete("line_id");
  safeUrl.searchParams.delete("phone");
  safeUrl.searchParams.delete("customer_no");
  return safeUrl;
}

async function secureCustomerIdentityBody(request, body, env) {
  const safeBody = { ...(body || {}) };
  const shopCode = clean(safeBody.shop_code) || clean(env.SHOP_CODE) || DEFAULT_SHOP_CODE;
  const settings = await getSettings(env, shopCode);
  if (isExplicitDemoRuntime(shopCode, settings, env)) return safeBody;

  const identity = await verifyLineIdentity(request, safeBody, env);
  safeBody.line_user_id = identity.sub;
  safeBody.__verified_line_user_id = identity.sub;
  delete safeBody.line_id;
  delete safeBody.lineUserId;
  delete safeBody.customer_id; // repeat/direct lookup cannot select another customer in production.
  delete safeBody.id_token;
  delete safeBody.idToken;
  return safeBody;
}

function getStaffSessionSecret(env) {
  // Domain-separated, server-only key. No new DB/storage secret is introduced.
  const base = clean(env.STAFF_SESSION_SIGNING_SECRET || env.PHOTO_UPLOAD_SECRET || getServiceKey(env));
  return base ? `DPRO_NAIL_STAFF_SESSION_V1:${base}` : "";
}

async function issueStaffScopedToken(env, shopCode, staff) {
  const secret = getStaffSessionSecret(env);
  if (!secret) throw new AppError(503, "スタッフセッション署名鍵が利用できません。", null, "STAFF_SIGNING_KEY_MISSING");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + STAFF_SESSION_TTL_SECONDS;
  const payload = {
    v: 1,
    iss: STAFF_TOKEN_ISSUER,
    system: SYSTEM_CODE,
    facility: expectedFacilityCode(shopCode, env),
    shop_code: shopCode,
    staff_id: clean(staff.id),
    staff_code: clean(staff.staff_code) || clean(staff.id),
    staff_name: clean(staff.display_name || staff.staff_name),
    role: STAFF_ROLE,
    scopes: STAFF_SCOPES,
    iat: now,
    exp,
    jti: crypto.randomUUID()
  };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${STAFF_TOKEN_PREFIX}.${encoded}`;
  const signature = base64UrlEncode(await hmacSha256(signingInput, secret));
  return {
    token: `${signingInput}.${signature}`,
    payload,
    expires_at: new Date(exp * 1000).toISOString()
  };
}

async function verifyStaffScopedToken(request, env, requiredScope) {
  const token = getBearerToken(request);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== STAFF_TOKEN_PREFIX) {
    throw new AppError(401, "スタッフセッションが必要です。", null, "STAFF_SESSION_REQUIRED");
  }
  const secret = getStaffSessionSecret(env);
  if (!secret) throw new AppError(503, "スタッフセッション署名鍵が利用できません。", null, "STAFF_SIGNING_KEY_MISSING");
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = base64UrlEncode(await hmacSha256(signingInput, secret));
  if (!constantTimeEqual(parts[2], expected)) {
    throw new AppError(401, "スタッフセッションが無効です。", null, "STAFF_SESSION_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch (_) {
    throw new AppError(401, "スタッフセッションが無効です。", null, "STAFF_SESSION_INVALID");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    payload?.v !== 1 || payload?.iss !== STAFF_TOKEN_ISSUER ||
    payload?.system !== SYSTEM_CODE || payload?.role !== STAFF_ROLE ||
    Number(payload?.exp || 0) <= now
  ) {
    throw new AppError(403, "スタッフセッションの権限または有効期限が正しくありません。", null, "STAFF_SCOPE_INVALID");
  }
  if (!normalizeArray(payload.scopes).includes(requiredScope)) {
    throw new AppError(403, "このスタッフ操作の権限がありません。", null, "STAFF_SCOPE_REQUIRED");
  }
  if (!clean(payload.staff_id) || !clean(payload.staff_code) || !clean(payload.shop_code)) {
    throw new AppError(403, "スタッフ本人情報が不足しています。", null, "STAFF_IDENTITY_INVALID");
  }
  if (clean(payload.facility) !== expectedFacilityCode(clean(payload.shop_code), env)) {
    throw new AppError(403, "別店舗のスタッフセッションです。", null, "STAFF_FACILITY_MISMATCH");
  }
  return payload;
}

async function auditVerified(
  env, shopCode, action, actor, targetTable = "", targetId = "", detail = {}, result = "success"
) {
  if (!actor?.verified || !clean(actor.actor_type) || !clean(actor.actor_name)) {
    throw new AppError(500, "監査actorを確定できません。", null, "AUDIT_ACTOR_UNVERIFIED");
  }
  const rows = await sbInsert(env, "nail_audit_logs", {
    shop_code: shopCode,
    action,
    actor_type: actor.actor_type,
    actor_name: actor.actor_name,
    target_table: clean(targetTable),
    target_id: targetId ? String(targetId) : "",
    detail: {
      ...detail,
      result,
      system_code: SYSTEM_CODE,
      facility_code: clean(actor.facility_code || shopCode),
      actor_id: clean(actor.actor_id),
      staff_code: clean(actor.staff_code),
      verified_by: clean(actor.verified_by),
      verified_actor: true,
      recorded_at: new Date().toISOString()
    }
  });
  if (!rows.length) {
    throw new AppError(500, "監査ログを記録できません。", null, "AUDIT_WRITE_FAILED");
  }
  return rows[0];
}

function extractMutationTargetId(result, body = {}) {
  const candidates = [
    result?.reservation?.id, result?.staff?.id, result?.service?.id,
    result?.option?.id, result?.followup?.id, result?.design?.id,
    result?.treatment?.id, result?.photo?.id, result?.settings?.id,
    body?.reservation_id, body?.followup_id, body?.staff_id,
    body?.service_id, body?.design_id, body?.treatment_id,
    body?.photo_id, body?.id, body?.target_id
  ];
  return clean(candidates.find(value => value !== undefined && value !== null && value !== ""));
}

async function runVerifiedOwnerMutation(request, env, body, action, targetTable, executor) {
  const shopCode = clean(body?.shop_code) || getShopCode(new URL(request.url), env);
  const actor = await verifiedActorForRequest(request, env, shopCode, body);
  const preliminaryTarget = extractMutationTargetId(null, body);
  await auditVerified(env, shopCode, `${action}:attempt`, actor, targetTable, preliminaryTarget, {
    path: new URL(request.url).pathname
  }, "attempt");
  const result = await executor();
  await auditVerified(env, shopCode, action, actor, targetTable, extractMutationTargetId(result, body), {
    path: new URL(request.url).pathname
  }, "success");
  return result;
}

async function issueStaffSessionRoute(request, body, env) {
  const shopCode = clean(body.shop_code) || clean(env.SHOP_CODE) || DEFAULT_SHOP_CODE;
  const owner = await verifiedActorForRequest(request, env, shopCode, body);
  const staffId = clean(body.staff_id);
  const staffCode = clean(body.staff_code);
  if (!staffId && !staffCode) {
    throw new AppError(400, "staff_id または staff_code が必要です。", null, "STAFF_ID_REQUIRED");
  }
  const filters = [sel("*"), eq("shop_code", shopCode), eq("is_active", true)];
  if (staffId) filters.push(eq("id", staffId));
  else filters.push(eq("staff_code", staffCode));
  filters.push("limit=1");
  const staff = (await sbSelect(env, "nail_staff", filters))[0];
  if (!staff) throw new AppError(404, "対象スタッフが見つかりません。", null, "STAFF_NOT_FOUND");

  const issued = await issueStaffScopedToken(env, shopCode, staff);
  await auditVerified(env, shopCode, "staff_session_issued", owner, "nail_staff", staff.id, {
    staff_code: clean(staff.staff_code) || clean(staff.id),
    staff_name: clean(staff.display_name || staff.staff_name),
    scopes: STAFF_SCOPES,
    expires_at: issued.expires_at
  });
  return {
    ok: true,
    systemCode: SYSTEM_CODE,
    shop_code: shopCode,
    facilityCode: expectedFacilityCode(shopCode, env),
    role: STAFF_ROLE,
    scopes: STAFF_SCOPES,
    staff: {
      id: staff.id,
      staff_code: clean(staff.staff_code) || clean(staff.id),
      staff_name: clean(staff.display_name || staff.staff_name)
    },
    staffSessionToken: issued.token,
    expiresAt: issued.expires_at,
    ttlSeconds: STAFF_SESSION_TTL_SECONDS
  };
}

function staffActor(payload) {
  return {
    verified: true,
    actor_type: "staff",
    actor_name: `${clean(payload.staff_code)}:${clean(payload.staff_name)}`,
    actor_id: clean(payload.staff_id),
    staff_code: clean(payload.staff_code),
    facility_code: clean(payload.facility),
    system_code: SYSTEM_CODE,
    environment: "staff_scoped",
    verified_by: "NAIL_SIGNED_STAFF_SESSION"
  };
}

async function staffDayRoute(request, url, env) {
  const session = await verifyStaffScopedToken(request, env, "day.read");
  const shopCode = clean(session.shop_code);
  const date = isValidDateString(url.searchParams.get("date"))
    ? url.searchParams.get("date") : todayJst();
  const settings = await getSettings(env, shopCode);
  const nextBusinessDate = findNextBusinessDate(date, settings);
  const [todayRows, nextRows, staffRows] = await Promise.all([
    getReservationRowsByDate(env, shopCode, date),
    getReservationRowsByDate(env, shopCode, nextBusinessDate),
    sbSelect(env, "nail_staff", [sel("*"), eq("shop_code", shopCode), eq("id", session.staff_id), "limit=1"])
  ]);
  const mine = rows => rows.filter(row =>
    isActiveReservationStatus(row.status) && clean(row.staff_id) === clean(session.staff_id)
  );
  const activeToday = mine(todayRows);
  const activeNext = mine(nextRows);
  const staff = staffRows[0] || {
    id: session.staff_id,
    staff_code: session.staff_code,
    staff_name: session.staff_name,
    display_name: session.staff_name
  };
  return {
    ok: true,
    access: "staff_scoped",
    role: STAFF_ROLE,
    scopes: session.scopes,
    shop_code: shopCode,
    date,
    today: date,
    today_tasks: [],
    today_reservations: activeToday,
    today_reservations_by_staff: groupReservationsByStaff(activeToday, [staff]),
    next_business_date: nextBusinessDate,
    next_business_reservations: activeNext,
    workflow_counts: countBy(activeToday, row => clean(row.workflow_status || "reserved")),
    settings: {
      shop_name: settings.shop_name,
      open_time: normalizeTime(settings.open_time, "10:00"),
      close_time: normalizeTime(settings.close_time, "19:00")
    },
    staff_identity: {
      staff_id: session.staff_id,
      staff_code: session.staff_code,
      staff_name: session.staff_name
    },
    expires_at: new Date(Number(session.exp) * 1000).toISOString()
  };
}

async function staffWorkflowRoute(request, body, env) {
  const session = await verifyStaffScopedToken(request, env, "workflow.write");
  const shopCode = clean(session.shop_code);
  const reservationId = clean(body.reservation_id || body.id);
  const workflowStatus = clean(body.workflow_status || body.status);
  if (!reservationId) throw new AppError(400, "reservation_id が必要です。");
  if (!WORKFLOW_STATUSES.includes(workflowStatus)) {
    throw new AppError(400, "workflow_status が正しくありません。", { allowed: WORKFLOW_STATUSES });
  }
  const current = (await sbSelect(env, "nail_reservations", [
    sel("*"), eq("shop_code", shopCode), eq("id", reservationId), "limit=1"
  ]))[0];
  if (!current) throw new AppError(404, "予約が見つかりません。");
  if (clean(current.staff_id) !== clean(session.staff_id)) {
    throw new AppError(403, "自分に割り当てられた予約のみ操作できます。", null, "STAFF_ASSIGNMENT_MISMATCH");
  }

  const actor = staffActor(session);
  await auditVerified(env, shopCode, "staff_workflow_update:attempt", actor,
    "nail_reservations", reservationId, {
      old_workflow_status: clean(current.workflow_status || "reserved"),
      requested_workflow_status: workflowStatus
    }, "attempt");

  const patch = { workflow_status: workflowStatus };
  if (["cancelled", "no_show", "completed"].includes(workflowStatus)) patch.status = workflowStatus;
  const rows = await sbUpdate(env, "nail_reservations", [
    eq("shop_code", shopCode), eq("id", reservationId), eq("staff_id", session.staff_id)
  ], patch);
  if (!rows.length) throw new AppError(409, "予約状態を更新できませんでした。");
  const reservation = rows[0];
  await auditVerified(env, shopCode, "staff_workflow_update", actor,
    "nail_reservations", reservationId, {
      old_workflow_status: clean(current.workflow_status || "reserved"),
      new_workflow_status: workflowStatus,
      note: clean(body.note)
    }, "success");
  return {
    ok: true,
    access: "staff_scoped",
    shop_code: shopCode,
    reservation,
    workflow_status: workflowStatus,
    actor: {
      actor_type: "staff",
      staff_code: session.staff_code,
      staff_name: session.staff_name
    }
  };
}

// =========================================================
// Admin authentication / payload normalization
// =========================================================

async function requireAdmin(request, env, shopCode, body = null) {
  return (await authorizeOwnerOrDemo(request, env, shopCode, body)).settings;
}

function getAdminCredential(request, body = null) {
  // Compatibility helper. Production authorization never calls this function.
  return getDemoCredential(request, body);
}

function assertAdminCredential(credential, settings, env) {
  const expected = clean(env.DEMO_MANAGEMENT_CODE || env.ADMIN_CODE || settings.admin_code || "1234");
  if (!expected) {
    throw new AppError(500, "DEMO管理コードが設定されていません。");
  }
  if (!constantTimeEqual(clean(credential), expected)) {
    throw new AppError(401, "管理コードが正しくありません。", null, "ADMIN_CODE_INVALID");
  }
}

function normalizeSettingsPayload(body, current, shopCode) {
  const payload = { shop_code: shopCode };
  const textKeys = [
    "shop_name", "service_name", "salon_address", "salon_note", "owner_note"
  ];
  for (const key of textKeys) {
    if (body[key] !== undefined) payload[key] = clean(body[key]);
  }
  if (body.open_time !== undefined) {
    payload.open_time = normalizeTime(body.open_time, normalizeTime(current.open_time, "10:00"));
  }
  if (body.close_time !== undefined) {
    payload.close_time = normalizeTime(body.close_time, normalizeTime(current.close_time, "19:00"));
  }
  if (timeToMinutes(payload.open_time || current.open_time) >=
      timeToMinutes(payload.close_time || current.close_time)) {
    throw new AppError(400, "営業時間を確認してください。");
  }

  const boolKeys = [
    "multi_staff_enabled",
    "staff_request_enabled",
    "auto_assign_staff_enabled",
    "resource_management_enabled",
    "allow_same_day_reservation"
  ];
  for (const key of boolKeys) {
    if (body[key] !== undefined) payload[key] = parseBool(body[key], false);
  }

  if (body.booking_open_days !== undefined) {
    payload.booking_open_days = clampNumber(Number(body.booking_open_days), 7, 180);
  }
  if (body.default_buffer_minutes !== undefined) {
    payload.default_buffer_minutes =
      roundTo15(clampNumber(Number(body.default_buffer_minutes), 0, 120));
  }
  if (body.max_active_reservations_per_customer !== undefined) {
    payload.max_active_reservations_per_customer =
      clampNumber(Number(body.max_active_reservations_per_customer), 1, 20);
  }
  if (body.min_reservation_lead_minutes !== undefined) {
    payload.min_reservation_lead_minutes =
      roundTo15(clampNumber(Number(body.min_reservation_lead_minutes), 0, 10080));
  }
  if (body.holidays !== undefined) {
    payload.holidays = normalizeIntArray(body.holidays)
      .filter(value => value >= 0 && value <= 6);
  }
  if (body.closed_dates !== undefined) {
    payload.closed_dates = normalizeDateArray(body.closed_dates);
  }
  payload.reservation_slot_minutes = 30;
  return removeUndefined(payload);
}

function normalizeServiceUpdatePayload(body, current) {
  const payload = {};
  if (body.service_name !== undefined) {
    payload.service_name = clean(body.service_name);
    if (!payload.service_name) throw new AppError(400, "メニュー名が必要です。");
  }
  if (body.description !== undefined) payload.description = clean(body.description);
  if (body.base_price !== undefined) {
    payload.base_price = clampNumber(Number(body.base_price), 0, 1000000);
  }
  if (body.base_minutes !== undefined) {
    payload.base_minutes = roundTo15(
      clampNumber(Number(body.base_minutes), 15, 480)
    );
  }
  if (body.buffer_minutes !== undefined) {
    payload.buffer_minutes = roundTo15(
      clampNumber(Number(body.buffer_minutes), 0, 120)
    );
  }
  if (body.allow_staff_request !== undefined) {
    payload.allow_staff_request = parseBool(body.allow_staff_request, true);
  }
  if (body.requires_design_note !== undefined) {
    payload.requires_design_note = parseBool(body.requires_design_note, false);
  }
  if (body.is_active !== undefined) {
    payload.is_active = parseBool(body.is_active, true);
  }
  if (body.sort_order !== undefined) {
    payload.sort_order = clampNumber(Number(body.sort_order), 0, 9999);
  }
  return payload;
}

function normalizeOptionUpdatePayload(body) {
  const payload = {};
  if (body.option_name !== undefined) {
    payload.option_name = clean(body.option_name);
    if (!payload.option_name) throw new AppError(400, "オプション名が必要です。");
  }
  if (body.description !== undefined) payload.description = clean(body.description);
  if (body.add_price !== undefined) {
    payload.add_price = clampNumber(Number(body.add_price), 0, 1000000);
  }
  if (body.add_minutes !== undefined) {
    payload.add_minutes = roundTo15(
      clampNumber(Number(body.add_minutes), 0, 240)
    );
  }
  if (body.is_active !== undefined) {
    payload.is_active = parseBool(body.is_active, true);
  }
  if (body.sort_order !== undefined) {
    payload.sort_order = clampNumber(Number(body.sort_order), 0, 9999);
  }
  if (body.compatible_service_codes !== undefined) {
    payload.compatible_service_codes =
      normalizeTextArray(body.compatible_service_codes);
  }
  return payload;
}

function normalizeOptionForClient(row) {
  return {
    ...row,
    add_minutes: Number(row.add_minutes || 0),
    add_price: Number(row.add_price || 0),
    compatible_service_codes: normalizeArray(row.compatible_service_codes)
  };
}


// =========================================================
// Supabase REST / RPC
// =========================================================

function assertEnv(env) {
  const missing = [];
  if (!clean(env.SUPABASE_URL)) missing.push("SUPABASE_URL");
  if (!getServiceKey(env)) {
    missing.push(
      "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY or SUPABASE_SECRET_KEY"
    );
  }
  if (missing.length) {
    throw new AppError(500, `Missing environment variables: ${missing.join(", ")}`);
  }
}

function getServiceKey(env) {
  return clean(
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SERVICE_KEY ||
    env.SUPABASE_SECRET_KEY
  );
}

async function sbRequest(env, resource, options = {}) {
  const base = clean(env.SUPABASE_URL).replace(/\/+$/, "");
  const key = getServiceKey(env);
  const headers = new Headers(options.headers || {});
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${key}`);
  if (!headers.has("Content-Type") && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.prefer) headers.set("Prefer", options.prefer);

  const response = await fetch(`${base}/rest/v1/${resource}`, {
    method: options.method || "GET",
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }
  if (!response.ok) {
    throw new AppError(
      response.status,
      clean(data?.message || data?.error || data || "Supabase request failed"),
      {
        resource,
        code: data?.code || null,
        hint: data?.hint || null,
        details: data?.details || null
      },
      "SUPABASE_ERROR"
    );
  }
  return { data, response };
}

async function sbSelect(env, table, filters = []) {
  const query = filters.filter(Boolean).join("&");
  const { data } = await sbRequest(env, `${table}?${query}`);
  return Array.isArray(data) ? data : [];
}

async function sbInsert(env, table, values) {
  const rows = Array.isArray(values) ? values : [values];
  const { data } = await sbRequest(env, table, {
    method: "POST",
    body: rows,
    prefer: "return=representation"
  });
  return Array.isArray(data) ? data : [];
}

async function sbUpdate(env, table, filters, patch) {
  const cleanPatch = removeUndefined(patch);
  if (!Object.keys(cleanPatch).length) return [];
  const query = filters.filter(Boolean).join("&");
  const { data } = await sbRequest(env, `${table}?${query}`, {
    method: "PATCH",
    body: cleanPatch,
    prefer: "return=representation"
  });
  return Array.isArray(data) ? data : [];
}

async function sbDelete(env, table, filters) {
  const query = filters.filter(Boolean).join("&");
  const { data } = await sbRequest(env, `${table}?${query}`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  return Array.isArray(data) ? data : [];
}

async function sbRpc(env, functionName, args = {}) {
  const { data } = await sbRequest(env, `rpc/${functionName}`, {
    method: "POST",
    body: args
  });
  return data;
}

async function countRows(env, table, filters = []) {
  const query = [sel("id"), ...filters, "limit=1"].filter(Boolean).join("&");
  const base = clean(env.SUPABASE_URL).replace(/\/+$/, "");
  const key = getServiceKey(env);
  const response = await fetch(`${base}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
      Range: "0-0"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new AppError(response.status, text || "count failed");
  }
  const contentRange = response.headers.get("Content-Range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  if (match) return Number(match[1]);
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data.length : 0;
}

// =========================================================
// Supabase private Storage
// =========================================================

async function storageUpload(env, bucket, path, bytes, mimeType) {
  const base = clean(env.SUPABASE_URL).replace(/\/+$/, "");
  const key = getServiceKey(env);
  const response = await fetch(
    `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": mimeType,
        "x-upsert": "true"
      },
      body: bytes
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new AppError(response.status, text || "画像アップロードに失敗しました。");
  }
  return await response.json().catch(() => ({}));
}

async function storageDownload(env, bucket, path) {
  const base = clean(env.SUPABASE_URL).replace(/\/+$/, "");
  const key = getServiceKey(env);
  return await fetch(
    `${base}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`
      }
    }
  );
}

async function storageAssertExists(env, bucket, path) {
  const response = await storageDownload(env, bucket, path);
  if (!response.ok) {
    throw new AppError(404, "アップロード済み画像を確認できません。");
  }
  try {
    await response.body?.cancel();
  } catch (_) {}
  return true;
}

async function storageCreateSignedUrl(env, bucket, path, expiresIn = 300) {
  const base = clean(env.SUPABASE_URL).replace(/\/+$/, "");
  const key = getServiceKey(env);
  const response = await fetch(
    `${base}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(response.status, data?.message || "署名URLを作成できません。");
  }
  const signed = clean(data.signedURL || data.signedUrl || data.url);
  if (!signed) throw new AppError(500, "署名URLが空です。");
  return signed.startsWith("http") ? signed : `${base}/storage/v1${signed}`;
}

async function storageDelete(env, bucket, paths) {
  const base = clean(env.SUPABASE_URL).replace(/\/+$/, "");
  const key = getServiceKey(env);
  const response = await fetch(
    `${base}/storage/v1/object/${encodeURIComponent(bucket)}`,
    {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prefixes: paths })
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new AppError(response.status, text || "Storage削除に失敗しました。");
  }
  return await response.json().catch(() => ({}));
}

function encodeStoragePath(path) {
  return clean(path)
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

// =========================================================
// Upload token HMAC
// =========================================================

async function signUploadToken(payload, env) {
  const encoded = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const signature = await hmacSha256(encoded, getPhotoSecret(env));
  return `${encoded}.${base64UrlEncode(signature)}`;
}

async function verifyUploadToken(token, env) {
  const [encoded, signature] = clean(token).split(".");
  if (!encoded || !signature) {
    throw new AppError(401, "upload token が正しくありません。");
  }
  const expected = base64UrlEncode(
    await hmacSha256(encoded, getPhotoSecret(env))
  );
  if (!constantTimeEqual(signature, expected)) {
    throw new AppError(401, "upload token の署名が正しくありません。");
  }

  let payload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded))
    );
  } catch (_) {
    throw new AppError(401, "upload token を読み取れません。");
  }
  if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) {
    throw new AppError(401, "upload token の有効期限が切れています。");
  }
  if (
    !payload.shop_code ||
    !payload.target_type ||
    !payload.target_id ||
    !payload.storage_path
  ) {
    throw new AppError(401, "upload token の内容が不足しています。");
  }
  return payload;
}

function getPhotoSecret(env) {
  return clean(env.PHOTO_UPLOAD_SECRET || getServiceKey(env));
}

async function hmacSha256(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
  );
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

// =========================================================
// Query builders
// =========================================================

function sel(columns = "*") {
  return `select=${encodeURIComponent(columns)}`;
}

function eq(column, value) {
  return `${encodeURIComponent(column)}=eq.${encodeURIComponent(formatFilterValue(value))}`;
}

function neq(column, value) {
  return `${encodeURIComponent(column)}=neq.${encodeURIComponent(formatFilterValue(value))}`;
}

function gte(column, value) {
  return `${encodeURIComponent(column)}=gte.${encodeURIComponent(formatFilterValue(value))}`;
}

function lte(column, value) {
  return `${encodeURIComponent(column)}=lte.${encodeURIComponent(formatFilterValue(value))}`;
}

function inFilter(column, values) {
  const list = unique(
    normalizeArray(values)
      .filter(value => value !== null && value !== undefined && value !== "")
      .map(value => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"'))
  );
  const expression = `(${list.map(value => `"${value}"`).join(",")})`;
  return `${encodeURIComponent(column)}=in.${encodeURIComponent(expression)}`;
}

function formatFilterValue(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// =========================================================
// Generic utilities
// =========================================================

function json(payload, status = 200, requestId = "", started = Date.now()) {
  const body = {
    ...payload,
    request_id: requestId || undefined,
    elapsed_ms: Math.max(0, Date.now() - started)
  };
  return new Response(JSON.stringify(removeUndefined(body)), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(requestId ? { "X-Request-Id": requestId } : {})
    }
  });
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new AppError(400, "JSONの形式が正しくありません。", null, "INVALID_JSON");
  }
}

function normalizePath(pathname) {
  const value = String(pathname || "/").replace(/\/+/g, "/");
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function getShopCode(url, env) {
  return clean(
    url.searchParams.get("shop_code") ||
    env.SHOP_CODE ||
    DEFAULT_SHOP_CODE
  );
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeSearchText(value) {
  return clean(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizePhoneForStorage(value) {
  let text = clean(value)
    .normalize("NFKC")
    .replace(/[＋]/g, "+")
    .replace(/\(0\)/g, "")
    .replace(/[^0-9+]/g, "");
  if (text.startsWith("+81")) text = `0${text.slice(3)}`;
  else if (text.startsWith("0081")) text = `0${text.slice(4)}`;
  else if (
    text.startsWith("81") &&
    text.length >= 11 &&
    !text.startsWith("810")
  ) {
    text = `0${text.slice(2)}`;
  }
  return text.replace(/\D/g, "");
}

function normalizeTime(value, fallback = "") {
  const match = clean(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeToMinutes(value) {
  const time = normalizeTime(value, "00:00");
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(value) {
  const total = Math.max(0, Number(value || 0));
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function overlapsMinutes(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function todayJst() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function nowJstDateTime() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(value))) return false;
  const [year, month, day] = clean(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function addDays(dateString, days) {
  if (!isValidDateString(dateString)) {
    throw new AppError(400, "日付形式が正しくありません。");
  }
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function addMonths(dateString, months) {
  if (!isValidDateString(dateString)) {
    throw new AppError(400, "日付形式が正しくありません。");
  }
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCMonth(date.getUTCMonth() + Number(months || 0));
  return date.toISOString().slice(0, 10);
}

function getWeekdayFromDateString(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function weekdayLabelJp(dateString) {
  return ["日", "月", "火", "水", "木", "金", "土"][
    getWeekdayFromDateString(dateString)
  ];
}

function validateDateOnly(date, settings) {
  if (!isValidDateString(date)) {
    return { ok: false, message: "日付形式が正しくありません。" };
  }
  const today = todayJst();
  if (date < today) {
    return { ok: false, message: "過去の日付は予約できません。" };
  }
  const maxDate = addDays(
    today,
    clampNumber(Number(settings.booking_open_days || 60), 1, 365)
  );
  if (date > maxDate) {
    return { ok: false, message: "予約受付期間外です。" };
  }
  const weekday = getWeekdayFromDateString(date);
  if (normalizeIntArray(settings.holidays).includes(weekday)) {
    return { ok: false, message: "定休日です。" };
  }
  if (normalizeDateArray(settings.closed_dates).includes(date)) {
    return { ok: false, message: "臨時休業日です。" };
  }
  return { ok: true, message: "" };
}

function validateLeadTime(date, time, settings) {
  if (!settings.allow_same_day_reservation && date === todayJst()) {
    throw new AppError(400, "当日予約は受け付けていません。");
  }
  const leadMinutes = Number(settings.min_reservation_lead_minutes || 0);
  if (leadMinutes <= 0) return;

  const target = new Date(`${date}T${normalizeTime(time, "00:00")}:00+09:00`);
  if (target.getTime() - Date.now() < leadMinutes * 60 * 1000) {
    throw new AppError(
      400,
      `予約は開始${leadMinutes}分前までにお申し込みください。`
    );
  }
}

function findNextBusinessDate(startDate, settings, allowSame = false) {
  for (let offset = allowSame ? 0 : 1; offset <= 120; offset += 1) {
    const date = addDays(startDate, offset);
    if (validateDateOnly(date, settings).ok) return date;
  }
  return addDays(startDate, 1);
}

function normalizeReservationSource(value) {
  const source = clean(value).toLowerCase();
  const allowed = new Set([
    "line", "phone", "shop", "instagram", "other",
    "demo_prepare", "repeat_booking"
  ]);
  return allowed.has(source) ? source : "line";
}

function normalizeReservationStatus(value) {
  const status = clean(value).toLowerCase();
  const allowed = new Set([
    ...ACTIVE_RESERVATION_STATUSES,
    ...CLOSED_RESERVATION_STATUSES
  ]);
  return allowed.has(status) ? status : "reserved";
}

function isActiveReservationStatus(value) {
  return ACTIVE_RESERVATION_STATUSES.includes(clean(value));
}

function normalizeHandFoot(value, allowBlank = false) {
  const normalized = clean(value).toLowerCase();
  if (!normalized && allowBlank) return "";
  if (["hand", "foot", "both"].includes(normalized)) return normalized;
  return "hand";
}

function categoryToHandFoot(category) {
  const value = clean(category).toLowerCase();
  if (value === "foot") return "foot";
  return "hand";
}

function normalizeOffSource(value) {
  const normalized = clean(value).toLowerCase();
  return ["none", "own_shop", "other_shop", "off_only", "unknown"].includes(normalized)
    ? normalized
    : "unknown";
}

function normalizePhotoTargetType(value) {
  const normalized = clean(value).toLowerCase();
  if (!["design", "treatment"].includes(normalized)) {
    throw new AppError(400, "target_type は design または treatment です。");
  }
  return normalized;
}

function normalizeTreatmentPhotoType(value) {
  const normalized = clean(value).toLowerCase();
  return ["before", "after", "detail", "reference"].includes(normalized)
    ? normalized
    : "after";
}

function extensionForMime(mime) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif"
  };
  return map[mime] || "bin";
}

function sanitizePhotoMeta(photo) {
  if (!photo) return null;
  return {
    id: photo.id,
    shop_code: photo.shop_code,
    design_id: photo.design_id || null,
    treatment_record_id: photo.treatment_record_id || null,
    customer_id: photo.customer_id || null,
    reservation_id: photo.reservation_id || null,
    photo_type: photo.photo_type || null,
    thumbnail_path: photo.thumbnail_path || "",
    mime_type: photo.mime_type || "",
    file_size_bytes: photo.file_size_bytes || null,
    width_px: photo.width_px || null,
    height_px: photo.height_px || null,
    alt_text: photo.alt_text || "",
    caption: photo.caption || "",
    is_primary: Boolean(photo.is_primary),
    is_customer_visible:
      photo.is_customer_visible === undefined
        ? true
        : Boolean(photo.is_customer_visible),
    sort_order: Number(photo.sort_order || 100),
    taken_at: photo.taken_at || null,
    created_at: photo.created_at || null
  };
}

function sanitizeTreatmentForMember(row) {
  return {
    id: row.id,
    reservation_id: row.reservation_id,
    treatment_date: row.treatment_date,
    hand_foot: row.hand_foot,
    service_snapshot: row.service_snapshot,
    option_snapshot: row.option_snapshot,
    nail_shape: row.nail_shape,
    nail_length: row.nail_length,
    color_codes: normalizeArray(row.color_codes),
    gel_brand: row.gel_brand,
    gel_product: row.gel_product,
    extension_count: row.extension_count,
    repair_count: row.repair_count,
    next_visit_days: row.next_visit_days,
    next_visit_date: row.next_visit_date,
    next_recommendation: row.next_recommendation,
    is_completed: Boolean(row.is_completed),
    completed_at: row.completed_at
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
    return text.split(/[,、\n]/).map(item => item.trim()).filter(Boolean);
  }
  return [value];
}

function normalizeTextArray(value) {
  return unique(normalizeArray(value).map(clean).filter(Boolean)).slice(0, 100);
}

function normalizeIntArray(value) {
  return unique(
    normalizeArray(value)
      .map(item => Number(item))
      .filter(Number.isInteger)
  );
}

function normalizeDateArray(value) {
  return unique(
    normalizeArray(value).map(clean).filter(isValidDateString)
  );
}

function parseOptionCodes(value) {
  return unique(
    normalizeArray(value)
      .flatMap(item =>
        typeof item === "string"
          ? item.split(/[,、]/)
          : [item]
      )
      .map(clean)
      .filter(Boolean)
  );
}

function normalizeJsonObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {}
  }
  return fallback;
}

function normalizeJsonArrayValue(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return fallback;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function nullablePositiveInt(value, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) return null;
  return number;
}

function roundTo15(value) {
  return Math.round(Number(value || 0) / 15) * 15;
}

function unique(values) {
  return [...new Set(values)];
}

function removeUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  );
}

function groupBy(rows, getter) {
  const map = new Map();
  for (const row of rows || []) {
    const key = getter(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function countBy(rows, getter) {
  const result = {};
  for (const row of rows || []) {
    const key = getter(row) || "unknown";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function priorityRank(value) {
  const priority = clean(value).toLowerCase();
  if (priority === "high") return 0;
  if (priority === "normal") return 1;
  return 2;
}

function constantTimeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

