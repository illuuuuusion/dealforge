# DealForge MVP · Find. Fix. Flip.

Eigenständige, responsive WebApp als Nachfolger des Discord-Bots [`illuuuuusion/gpu-search`](https://github.com/illuuuuusion/gpu-search). Für die lokale Demo sind **keine Dependencies oder API-Keys** erforderlich (Node.js 22.13+).

## Starten

```bash
cd dealforge-mvp
npm test
npm start
# Öffnen: http://127.0.0.1:3000
```

Standardmäßig ist `DEMO_MODE=true`, der Scheduler deaktiviert und die Anwendung ausschließlich an `127.0.0.1` gebunden. Die angezeigten fünf Demo-Inserate sind **synthetische Beispieldaten**, keine echten Marktplatzangebote. Das SQLite-Modul von Node 22 ist experimentell und kann eine Start-Warnung ausgeben.

Mit .env:

```bash
cp .env.example .env
node --env-file=.env src/server.js
```

Für eine passwortgeschützte Instanz `APP_PASSWORD` (mindestens 16 Zeichen), `SESSION_SECRET` (zufällig und dauerhaft, z. B. `openssl rand -hex 32`), `APP_ORIGIN`, `DB_PATH` setzen. Bei Docker `APP_PASSWORD` und `SESSION_SECRET` in `.env` angeben, danach `docker compose up --build -d`. Der Compose-Port ist absichtlich nur auf `127.0.0.1:3000` veröffentlicht. Für Zugriff über das Internet einen HTTPS-Reverse-Proxy und HTTPS-Origin konfigurieren. **Keinen ungeschützten öffentlichen Server betreiben.**

## Enthalten

- Responsive Single-User-Dashboard, Feed nach Quelle, Schnappern, Preisalarmen und Repair-Fällen filterbar
- Suchprofile anlegen/pausieren/löschen; separate Kaufgrenzen für intakt/defekt, optionale Wiederverkaufsschätzung und Reparaturbudget
- GPU-Modellerkennung mit 49 Profilen aus `gpu-search` (Aliase, Ausschluss-Aliase, VRAM-Varianten): „RTX 4070 Super“ trifft keine 4070 Ti Super, „RTX 3060 12GB“ keine 8-GB-Karte. Zubehör (Lüfter, Halterungen, Wasserkühler, Kabel, Kartons, Displays), Komplett-PCs/Laptops und Platinen ohne Chip werden ausgeschlossen. Suchprofile mit einem bekannten Modell nutzen dieses Matching, freie Suchbegriffe den Textvergleich.
- Deterministische Zustands-/Symptomerkennung und erklärbarer, bewusst vorsichtiger Reparaturscore
- Separate Flags für frisch entdeckt (`SCHNAPPER`), Preisvorteil gegenüber **deiner Kaufgrenze** (`DEAL`) und Defektchance (`REPAIR`)
- Unbekannte Versandkosten zählen nicht als 0 €: kein `DEAL`/`SCHNAPPER`, stattdessen „Preis prüfen“ – außer das Suchprofil akzeptiert unbekannten Versand (Abholung)
- eBay-Auktionen werden mit abgefragt; ein aktuelles Gebot zählt erst in den letzten 5 Stunden vor Ende als Deal
- SQLite: Upserts pro Quelle und Inserats-ID, Preisänderungs-Historie, erster/letzter Fund, Favoriten
- eBay Browse OAuth-Adapter (API-Schlüssel erforderlich) und Kleinanzeigen Agent REST-Adapter (explizit risikobehaftete Drittanbieter-Quelle; Schlüssel und Freigabe erforderlich)
- Facebook Marketplace ausschließlich über manuellen JSON-Testdatenimport. Keine ungeprüfte automatische Datenbeschaffung
- Konfigurierbarer Polling-Scanner, manuelles Scan-API und Provider-Statusanzeige
- Browser-Notifications für neue Alerts bei **geöffneter Seite** und erteilter Berechtigung; noch kein echtes serverseitiges Web Push
- Funktionale `node:test`-Tests und explizite, optionale Live-Provider-Probes

## Datenquellen

| Quelle | Zugriff | Status |
|---|---|---|
| eBay | Offizielle Browse API + OAuth | Implementiert, Live-Accounttest offen |
| Kleinanzeigen | `api.kleinanzeigen-agent.de/api/v2/kleinanzeigen/search` mit `klaz_key` | REST-Adapter implementiert, End-to-end-Test/ToS-Freigabe offen |
| Facebook Marketplace | JSON-Import aus Testexport | Import implementiert, Live-Scraping/Apify bewusst nicht integriert |

**Keine dieser Live-Schnittstellen wurde in dieser Umgebung mit echten Zugangsdaten getestet.** Es wurden Schema-Unit-Tests sowie lokale API-Smoke-Tests durchgeführt. API-Schlüssel niemals committen.

### Provider technisch prüfen

```bash
# Kein Netzaufruf, keine Kosten – zeigt nur die geplanten Calls:
npm run probe -- ebay
npm run probe -- kleinanzeigen
npm run probe -- facebook

# eBay-Live-Probe (DF-002): 3 Queries × Sofortkauf/Auktion × 2 Wiederholungen = 12 Calls
EBAY_APP_ID='...' EBAY_CLIENT_SECRET='...' npm run probe -- ebay --live
# Optional: PROBE_QUERIES='RTX 4070 Super|RTX 5080' PROBE_REPEAT=3 PROBE_MAX_CALLS=20

# NUR nach ausdrücklicher Kosten-/Rechtsfreigabe und API-Key-Konfiguration:
KLAZ_API_KEY='...' PROBE_QUERY='RTX 4070 Super' npm run probe -- kleinanzeigen --live

# Apify: beliebiger zugelassener Actor mit eigenem validiertem Input-Schema.
# Actor-Aufruf kann Gebühren verursachen; keine automatische Aktivierung.
APIFY_TOKEN='...' FB_ACTOR_ID='anbieter/actor' FB_ACTOR_INPUT_JSON='{"searchQuery":"RTX 4070 Super","maxItems":20}' \
  npm run probe -- facebook --live
```

Ein Probe-Lauf bricht vor dem ersten Request ab, wenn die geplanten Calls `PROBE_MAX_CALLS` (Standard 12) überschreiten. Er schreibt jeden Call als JSONL nach `data/probes/<provider>-YYYY-MM-DD.jsonl` (ohne Secrets, Beschreibungen oder Verkäuferdaten) und fasst Erfolgsquote, p50/p95-Latenz, Validität, stabile IDs, fehlende Veröffentlichungszeit, Angebotstypen und Fehler zusammen. **Er ist noch kein Nachweis für Geschwindigkeit oder Zuverlässigkeit**: Dafür braucht es mindestens 24–72 Stunden wiederholte Testabfragen mit Benchmarks, Budgetgrenzen und Vergleich zu manueller Stichprobe. Apify-Actors haben unterschiedliche Eingabe-/Ausgabe-Schemas; Anpassung und Mapping können notwendig sein.

### eBay-Live-Suche aktivieren

```
DEMO_MODE=false
EBAY_APP_ID=...
EBAY_CLIENT_SECRET=...
ENABLE_SCHEDULER=true
POLL_INTERVAL_SECONDS=300
APPROVED_PROVIDERS=ebay
PROVIDER_DAILY_CALL_LIMIT=200
```

Live abgefragt werden nur Quellen in `APPROVED_PROVIDERS`, und erst nach dokumentiertem GO laut [`docs/decisions/001-provider-policy.md`](docs/decisions/001-provider-policy.md). Konfigurierte, aber nicht freigegebene Quellen erscheinen in der UI als „nicht freigegeben“. Facebook ist nie live. Ab `PROVIDER_DAILY_CALL_LIMIT` Abfragen pro Quelle und UTC-Tag sendet der Scan keine Requests mehr.

Die App startet in diesem Modus nur mit `APP_PASSWORD`. In einer lokalen passwortgeschützten Instanz stehen die Suchprofile als Startkonfiguration bereit. `scan` kann über die UI manuell gestartet werden. eBay-API-Limits und Bedingungen beachten. Suchprofile mit bekanntem GPU-Modell teilen sich sechs breite eBay-Such-Buckets (z. B. „NVIDIA Ada“) mit je 200 Treffern inkl. Auktionen; die Zuordnung zum Profil passiert lokal. Freie Suchbegriffe kosten weiterhin einen Request pro Begriff.

### Facebook JSON-Import-Beispiel

```json
[
  {"id":"123456789", "title":"RTX 5080 16GB", "priceAmount":550, "url":"https://www.facebook.com/marketplace/item/123456789", "createdAt":"2026-10-31T14:00:00Z"}
]
```

Nur `https://facebook.com` und die gebräuchlichen Subdomains werden angenommen. Keine Verkäufer-Kontaktdaten speichern. Beispieldaten und echte Inserate sind in der UI unterscheidbar.

## Was fehlt bewusst noch?

Produktionsfähiger mehrinstanzfähiger Betrieb (Postgres/Worker/Redis), serverseitige Web-Push-Benachrichtigungen auch bei geschlossenem Browser, echte marktplatzübergreifende Angebots-Dubletten, echte Marktpreise und Preistrends, Auth per OIDC/Passkey, saubere Metrik-Erfassung für Latenz und Coverage, API-Anbieter-Abnahme. Für den Beta-Betrieb ist außerdem ein Security Review notwendig.

Die Roadmap und Abnahmekriterien stehen in [`docs/MVP_UMSETZUNGSPLAN.md`](docs/MVP_UMSETZUNGSPLAN.md).

## Entwicklung

```bash
npm ci
npm run lint
npm test
```

CI (`.github/workflows/ci.yml`) führt Lint und Tests bei jedem Push/PR aus und scannt die Historie mit gitleaks nach Secrets. Regressionsfälle für Modell-/Zubehörerkennung stehen in `fixtures/gpu-listings.json`, neue Fehltreffer dort ergänzen.

## API-Oberfläche

- `GET /health`
- `POST /api/login`
- `GET /api/state`
- `GET /api/deals?mode=all|schnapper|deal|repair&source=all|ebay|kleinanzeigen|facebook`
- `POST /api/watchlists`, `PATCH|DELETE /api/watchlists/:id`
- `PATCH /api/listings/:id/status` mit `new`, `saved`, `dismissed`, `contacted`
- `POST /api/scan` (`{"source":"all"}`)
- `POST /api/import/facebook` (`{"items":[...]}`)

Mutation-Endpoints verlangen eine Session und den Header `X-Dealforge-Action: 1`. Alle Secrets verbleiben serverseitig.

## Hinweise zu Plattformregeln

Kleinanzeigen untersagt in seinen Nutzungsbedingungen Crawler/Scraper ohne schriftliche Zustimmung; der unabhängige Drittanbieter Kleinanzeigen Agent erklärt in eigenen AGB, **nicht** von Kleinanzeigen lizenziert zu sein. Meta gestattet automatisierte Datensammlung ohne Freigabe ebenfalls nicht. Der Einsatz eines Drittanbieter-API-Anbieters beseitigt nicht automatisch diese Risiken. Die Anbieterfreigabe ist ein obligatorischer Go/No-Go-Schritt.

- Kleinanzeigen: https://themen.kleinanzeigen.de/nutzungsbedingungen/
- Kleinanzeigen-Agent AGB: https://kleinanzeigen-agent.de/agb
- Kleinanzeigen-Agent API: https://kleinanzeigen-agent.de/dokumentation
- Meta Scraping: https://about.fb.com/de/news/2021/04/so-gehen-wir-gegen-scraping-vor/
- eBay Browse API: https://developer.ebay.com/develop/api/buy/browse_api
