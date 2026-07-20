# Ubuntu / production LP diagnostics (Exir, OMPFinex, Ramzinex)

Run on the **Ubuntu host** and **inside the app container**. Do not claim production fixed without these results.

## Hostnames

| LP | Host | Path |
|----|------|------|
| Exir | `api.exir.io` | `/v1/orderbook?symbol=usdt-irt` |
| OMPFinex | `api.ompfinex.com` | `/v1/market/9/depth?limit=10` |
| Ramzinex | `publicapi.ramzinex.com` | `/exchange/api/v1.0/exchange/pairs/11` |

## On Ubuntu host

```bash
export UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

for host in api.exir.io api.ompfinex.com publicapi.ramzinex.com; do
  echo "===== DNS $host ====="
  getent ahosts "$host" || true
  dig +short A "$host" || true
  dig +short AAAA "$host" || true
done

echo "===== proxy env ====="
env | grep -iE 'http_proxy|https_proxy|no_proxy|ALL_PROXY' || echo none

# IPv4
curl -4 -v --connect-timeout 5 --max-time 15 \
  -H "user-agent: $UA" -H 'accept: application/json' \
  -w '\ncode=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  'https://api.exir.io/v1/orderbook?symbol=usdt-irt' -o /tmp/exir.json

curl -4 -v --connect-timeout 5 --max-time 15 \
  -H "user-agent: $UA" -H 'accept: application/json' \
  -w '\ncode=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  'https://api.ompfinex.com/v1/market/9/depth?limit=10' -o /tmp/omp.json

curl -4 -v --connect-timeout 5 --max-time 15 \
  -H "user-agent: $UA" -H 'accept: application/json' \
  -w '\ncode=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  'https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs/11' -o /tmp/rx.json

# IPv6 (if available)
curl -6 --connect-timeout 5 --max-time 15 -H "user-agent: $UA" -H 'accept: application/json' \
  -w 'exir6 code=%{http_code} total=%{time_total}\n' -o /dev/null \
  'https://api.exir.io/v1/orderbook?symbol=usdt-irt' || echo 'exir ipv6 fail'

# Safe body samples
head -c 200 /tmp/exir.json; echo
head -c 200 /tmp/omp.json; echo
head -c 200 /tmp/rx.json; echo
```

## Inside production container

```bash
# replace name if different
docker exec -it iman-otc-desk sh -c '
  echo DATABASE_URL set? $( [ -n "$DATABASE_URL" ] && echo yes || echo NO )
  env | grep -i proxy || true
  wget -qO- --timeout=15 "https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs/11" | head -c 200
  echo
  wget -qO- --timeout=15 "https://api.ompfinex.com/v1/market/9/depth?limit=10" | head -c 200
  echo
  wget -qO- --timeout=15 -U "Mozilla/5.0" "https://api.exir.io/v1/orderbook?symbol=usdt-irt" | head -c 200
  echo
'

# or with curl if present in image
docker exec -it iman-otc-desk sh -c 'command -v curl; command -v wget; command -v node'
```

## Interpret

| Result | Meaning |
|--------|---------|
| Host 200, container timeout | container DNS / egress / firewall |
| Host timeout, container timeout | upstream or Ubuntu egress block |
| HTTP 403 body nginx/CloudFront | WAF/IP block — need allowlist / different egress IP |
| Host 200 with full Chrome UA, 403 with short UA | WAF UA rule |
| IPv6 hang, IPv4 200 | prefer IPv4 (app already A-record first) |

## After deploy of this fix

App changes:

- No retry on 403/401/404
- No double HTTP request after 403 in `fetchJson`
- Exir: no Origin header thrash; timeout 12s; maxRetries 0
- OMP: `depth?limit=10`, browser UA, one transient retry
- Ramzinex: single-pair `/pairs/11` (not full list)

Paste host + container curl outputs before claiming production is healthy.
