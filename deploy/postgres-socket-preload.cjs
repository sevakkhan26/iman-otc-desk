/**
 * Force postgres.js to use Unix socket (OTC_DB_SOCKET) instead of Docker bridge TCP.
 * Loaded via NODE_OPTIONS=--require for production without image rebuild.
 */
"use strict";

const socket = process.env.OTC_DB_SOCKET && String(process.env.OTC_DB_SOCKET).trim();
if (!socket) {
  // no-op
} else {
  const Module = require("module");
  const path = require("path");
  const origLoad = Module._load;

  function parsePgUrl(url) {
    const out = { username: "otc_app", password: "", database: "otc_desk" };
    if (!url || typeof url !== "string") return out;
    try {
      const u = new URL(url.replace(/^postgres(ql)?:\/\//i, "http://"));
      if (u.username) out.username = decodeURIComponent(u.username);
      if (u.password) out.password = decodeURIComponent(u.password);
      const db = u.pathname.replace(/^\//, "");
      if (db) out.database = db;
    } catch (_) {
      /* ignore */
    }
    if (process.env.POSTGRES_USER) out.username = process.env.POSTGRES_USER;
    if (process.env.POSTGRES_PASSWORD != null && process.env.POSTGRES_PASSWORD !== "") {
      out.password = process.env.POSTGRES_PASSWORD;
    }
    if (process.env.POSTGRES_DB) out.database = process.env.POSTGRES_DB;
    return out;
  }

  Module._load = function (request, parent, isMain) {
    const exp = origLoad.apply(this, arguments);
    // Match bare "postgres" and pnpm paths .../node_modules/postgres/...
    const base = path.basename(String(request));
    const isPostgres =
      request === "postgres" ||
      request === "postgres/cjs" ||
      /\/node_modules\/postgres(\/|$)/.test(String(request)) ||
      base === "postgres";
    if (!isPostgres || typeof exp !== "function") return exp;
    if (exp.__otcSocketWrapped) return exp;

    function wrapped(a, b) {
      const creds = parsePgUrl(typeof a === "string" ? a : process.env.DATABASE_URL);
      const opts = typeof a === "object" && a !== null ? { ...a } : { ...(b || {}) };
      // Always prefer shared volume socket
      opts.host = socket;
      delete opts.port;
      if (!opts.database) opts.database = creds.database;
      if (!opts.username && !opts.user) opts.username = creds.username;
      if (opts.password == null) opts.password = creds.password;
      if (opts.max == null) opts.max = Math.min(Number(process.env.DATABASE_POOL_MAX || 6) || 6, 6);
      if (opts.connect_timeout == null) opts.connect_timeout = 8;
      if (opts.prepare == null) opts.prepare = false;
      if (opts.fetch_types == null) opts.fetch_types = false;
      if (opts.idle_timeout == null) opts.idle_timeout = 60;
      return exp(opts);
    }
    wrapped.__otcSocketWrapped = true;
    try {
      Object.keys(exp).forEach((k) => {
        try {
          wrapped[k] = exp[k];
        } catch (_) {}
      });
    } catch (_) {}
    return wrapped;
  };

  console.log("[postgres-socket-preload] active — host=" + socket);
}
