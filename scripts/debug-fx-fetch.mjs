#!/usr/bin/env node
import dns from "node:dns/promises";
import https from "node:https";

const SINKHOLE = new Set(["10.10.34.36"]);
const FALLBACK = {
  "www.navasan.net": ["104.21.44.125", "172.67.199.191"],
  "bonbast.com": ["104.21.44.125", "172.67.199.191"]
};

async function doh(host) {
  const resolvers = [
    { ip: "1.1.1.1", name: "cloudflare-dns.com" },
    { ip: "8.8.8.8", name: "dns.google" }
  ];
  for (const r of resolvers) {
    try {
      const text = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: r.ip,
            servername: r.name,
            path: `/dns-query?name=${host}&type=A`,
            headers: { accept: "application/dns-json", host: r.name }
          },
          (res) => {
            let d = "";
            res.on("data", (c) => (d += c));
            res.on("end", () => resolve(d));
          }
        );
        req.setTimeout(8000, () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.on("error", reject);
        req.end();
      });
      const j = JSON.parse(text);
      const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data).filter((ip) => !SINKHOLE.has(ip));
      if (ips.length) return ips;
    } catch (e) {
      console.log("doh fail", r.name, e.message);
    }
  }
  return FALLBACK[host] || [];
}

function get(url, host, ip) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ip,
        servername: host,
        path: u.pathname + u.search,
        headers: { host, "user-agent": "Mozilla/5.0" }
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, len: d.length, sample: d.slice(0, 120) }));
      }
    );
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

for (const host of ["www.navasan.net", "bonbast.com"]) {
  const sys = await dns.lookup(host).then((x) => x.address).catch(() => "err");
  console.log(host, "system", sys);
  const ips = await doh(host);
  console.log(host, "resolved", ips);
  for (const ip of ips) {
    try {
      const path = host.includes("navasan") ? "/initrates.php" : "/";
      const r = await get(`https://${host}${path}`, host, ip);
      console.log("  ok", ip, r.status, r.len, r.sample.replace(/\s+/g, " "));
    } catch (e) {
      console.log("  fail", ip, e.message);
    }
  }
}