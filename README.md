# DealForge MVP · Find. Fix. Flip.

Eigenständige, responsive WebApp als Nachfolger des Discord-Bots [`illuuuuusion/gpu-search`](https://github.com/illuuuuusion/gpu-search). TypeScript-Monorepo mit Fastify-API, BullMQ-Worker, PostgreSQL und Redis; alles läuft lokal per `docker compose` (Node.js 22.18+ und pnpm über Corepack für die Entwicklung).

> **Server erst am Ende:** DealForge wird bis zur letzten Plan-Phase (P7) nur lokal entwickelt und getestet. Der Scheduler pollt nur, solange der Rechner und der Stack laufen; Messwerte aus diesem Betrieb gelten als „lokal, nicht durchgehend“.

## Starten (Docker Compose)

```bash
cp .env.example .env     # APP_PASSWORD (≥16 Zeichen) und SESSION_SECRET setzen
docker compose up --build -d
# Öffnen: http://127.0.0.1:3000
```

Der Stack besteht aus `api` (Port `127.0.0.1:3000`), `worker`, `postgres` (`127.0.0.1:55432`) und `redis` (`127.0.0.1:56379`, AOF-persistiert). Die API wendet beim Start die versionierten Migrationen an und legt bei leerer Datenbank vier Startprofile an. Ohne `APP_PASSWORD` mit mindestens 16 Zeichen startet die API außerhalb des Demo-Modus auf localhost nicht. Für Zugriff über das Internet einen HTTPS-Reverse-Proxy und HTTPS-`APP_ORIGIN` konfigurieren. **Keinen ungeschützten öffentlichen Server betreiben.**

Mit `DEMO_MODE=true` zeigt die App fünf **synthetische** Beispielinserate; beim Wechsel auf `DEMO_MODE=false` werden sie wieder gelöscht.

## Architektur

```text
apps/web        statisches Dashboard (von der API ausgeliefert)
apps/api        Fastify, /api/v1, Session-Auth, OpenAPI, Systemstatus
apps/worker     BullMQ: Poll-Scheduler, ein Fetch-Worker je Provider
packages/domain       GPU-Modell-/Zustandserkennung, Scoring (pure Funktionen)
packages/providers    Adapter-Vertrag, eBay/Kleinanzeigen/Facebook-Normalisierung, HTTP mit Retry/Backoff
packages/contracts    Zod-Schemas für Requests/Responses → OpenAPI
packages/db           PostgreSQL: Migrationen, Repository, Budget-Ledger, SQLite-Import
packages/jobs         Queues, Einplanung mit Deduplizierung, Systemstatus
packages/config       Environment-Validierung
```

- **Scan-Ablauf:** Scheduler (alle `POLL_INTERVAL_SECONDS`, in Redis gespeichert, übersteht Neustarts; erster Lauf auf der nächsten Intervallgrenze) oder „Jetzt prüfen“ → Planer bildet Such-Buckets → ein Job je Quelle/Suchfilter in der Queue der Quelle. Solange ein Job für denselben Suchfilter wartet oder läuft, wird kein zweiter angelegt (manueller Doppel-Scan → `409`).
- **Fehler und Drosselung:** Netzwerkfehler und `5xx` werden bis zu 3-mal mit exponentiellem Backoff und Full Jitter wiederholt, Timeout 14 s. `429` wird nicht sofort wiederholt: Die Queue *nur dieser Quelle* pausiert für `Retry-After` (Standard 60 s), danach läuft der Job erneut. Andere Quellen laufen weiter.
- **Hartes Budget:** Vor *jedem* Request (auch Retries) wird ein Call atomar gebucht – pro Quelle und UTC-Tag, Kalendermonat und Suchfilter/Tag. Ist ein Limit erreicht, geht kein Request mehr raus; der Lauf wird als `QUOTA` protokolliert und die UI zeigt die Sperre. Ein manueller Scan wird dann mit `429` abgelehnt.
- **Freigabe:** Live nur mit Zugangsdaten **und** Eintrag in `APPROVED_PROVIDERS` **und** eingeschaltetem Laufzeitschalter (UI-Button „Ausschalten“ bzw. `PATCH /api/v1/providers/:source`).
- **Zeitstempel:** `published_at` = Zeit der Quelle (nie erfunden, sonst `NULL`), `first_seen_at`/`last_seen_at` = eigene Ingest-Zeit, `fetched_at` = Empfang der Provider-Antwort. Ein Snapshot entsteht nur, wenn sich Preis, Versand, Titel oder Zustand ändern; Replays derselben oder einer älteren Abfrage ändern nichts.
- **Systemstatus:** Je Quelle Zustand `ok`/`degraded`/`down`/`idle`/`off`, Queue-Länge, Drosselung, letzter erfolgreicher Poll, Fehlerquote 24 h, letzter Fehler, Calls heute/Monat; Worker-Heartbeat. `down` = Worker offline, die letzten 3 Läufe fehlgeschlagen oder 3 Intervalle ohne Erfolg.

### Daten aus dem SQLite-Prototyp übernehmen

```bash
# Alte Compose-Installation: Volume dealforge_db ist read-only unter /legacy eingehängt.
docker compose run --rm api node packages/db/dist/cli.js import-sqlite /legacy/dealforge.sqlite --replace
# Ohne Docker:
pnpm db import-sqlite ./data/dealforge.sqlite --replace
```

Der Import übernimmt Suchprofile, Inserate, Treffer, Preisverlauf und Läufe mit ihren IDs und vergleicht danach Zeilenanzahlen, ID-Summen, Preissummen und Inhalts-Hashes; bei Abweichung endet er mit Exit-Code 1. `--replace` leert die Zieldatenbank vorher (nötig, weil die API Startprofile anlegt). Vorher ein Backup ziehen (`docker compose exec postgres pg_dump -U dealforge dealforge > backup.sql`); Migrationen haben keine Down-Skripte, Rollback = Backup einspielen.

## Enthalten

- Responsive Single-User-Dashboard, Feed nach Quelle, Schnappern, Preisalarmen und Repair-Fällen filterbar
- Suchprofile anlegen/pausieren/löschen; separate Kaufgrenzen für intakt/defekt, optionale Wiederverkaufsschätzung und Reparaturbudget
- GPU-Modellerkennung mit 49 Profilen aus `gpu-search` (Aliase, Ausschluss-Aliase, VRAM-Varianten): „RTX 4070 Super“ trifft keine 4070 Ti Super, „RTX 3060 12GB“ keine 8-GB-Karte. Zubehör (Lüfter, Halterungen, Wasserkühler, Kabel, Kartons, Displays), Komplett-PCs/Laptops und Platinen ohne Chip werden ausgeschlossen. Suchprofile mit einem bekannten Modell nutzen dieses Matching, freie Suchbegriffe den Textvergleich.
- Deterministische Zustands-/Symptomerkennung und erklärbarer, bewusst vorsichtiger Reparaturscore
- Separate Flags für frisch entdeckt (`SCHNAPPER`), Preisvorteil gegenüber **deiner Kaufgrenze** (`DEAL`) und Defektchance (`REPAIR`)
- Unbekannte Versandkosten zählen nicht als 0 €: kein `DEAL`/`SCHNAPPER`, stattdessen „Preis prüfen“ – außer das Suchprofil akzeptiert unbekannten Versand (Abholung)
- eBay-Auktionen werden mit abgefragt; ein aktuelles Gebot zählt erst in den letzten 5 Stunden vor Ende als Deal
- PostgreSQL: Upserts pro Quelle und Inserats-ID, Beobachtungs-/Preis-Historie, erster/letzter Fund, Favoriten
- eBay Browse OAuth-Adapter (API-Schlüssel erforderlich) und Kleinanzeigen Agent REST-Adapter (explizit risikobehaftete Drittanbieter-Quelle; Schlüssel und Freigabe erforderlich)
- Facebook Marketplace ausschließlich über manuellen JSON-Testdatenimport. Keine ungeprüfte automatische Datenbeschaffung
- Worker mit Poll-Scheduler, manuellem Scan, Budget-Gate, Laufzeitschalter je Quelle und Systemstatus
- Browser-Notifications für neue Alerts bei **geöffneter Seite** und erteilter Berechtigung; noch kein echtes serverseitiges Web Push
- `node:test`-Tests (Domain, Provider, Datenbank, Worker, API-Contract) und explizite, optionale Live-Provider-Probes

## Datenquellen

| Quelle | Zugriff | Status |
|---|---|---|
| eBay | Offizielle Browse API + OAuth | GO LIMITED, live getestet (siehe ADR 001) |
| Kleinanzeigen | `api.kleinanzeigen-agent.de/api/v2/kleinanzeigen/search` mit `klaz_key` | REST-Adapter implementiert, End-to-end-Test/ToS-Freigabe offen |
| Facebook Marketplace | JSON-Import aus Testexport | Import implementiert, Live-Scraping/Apify bewusst nicht integriert |

Nur eBay wurde mit echten Zugangsdaten getestet; Kleinanzeigen und Facebook nur gegen Schema-Fixtures. API-Schlüssel niemals committen.

### Provider technisch prüfen

Die Probe ist bewusst von der App getrennt: eigene Zugangsdaten aus der Umgebung, eigenes Call-Limit (`PROBE_MAX_CALLS`), keine Datenbank, keine Queue, kein App-Budget, keine Retries.

```bash
# Kein Netzaufruf, keine Kosten – zeigt nur die geplanten Calls:
pnpm probe ebay
pnpm probe kleinanzeigen
pnpm probe facebook

# eBay-Live-Probe (DF-002): 3 Queries × Sofortkauf/Auktion × 2 Wiederholungen = 12 Calls
EBAY_APP_ID='...' EBAY_CLIENT_SECRET='...' pnpm probe ebay --live
# Optional: PROBE_QUERIES='RTX 4070 Super|RTX 5080' PROBE_REPEAT=3 PROBE_MAX_CALLS=20

# NUR nach ausdrücklicher Kosten-/Rechtsfreigabe und API-Key-Konfiguration:
KLAZ_API_KEY='...' PROBE_QUERY='RTX 4070 Super' pnpm probe kleinanzeigen --live

# Apify: beliebiger zugelassener Actor mit eigenem validiertem Input-Schema.
# Actor-Aufruf kann Gebühren verursachen; keine automatische Aktivierung.
APIFY_TOKEN='...' FB_ACTOR_ID='anbieter/actor' FB_ACTOR_INPUT_JSON='{"searchQuery":"RTX 4070 Super","maxItems":20}' \
  pnpm probe facebook --live
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

Live abgefragt werden nur Quellen in `APPROVED_PROVIDERS`, und erst nach dokumentiertem GO laut [`docs/decisions/001-provider-policy.md`](docs/decisions/001-provider-policy.md). Konfigurierte, aber nicht freigegebene Quellen erscheinen in der UI als „nicht freigegeben“. Facebook ist nie live. Ab `PROVIDER_DAILY_CALL_LIMIT` Abfragen pro Quelle und UTC-Tag (bzw. Monats-/Suchfilter-Limit) sendet der Worker keine Requests mehr. Rechenbeispiel: 4 eBay-Buckets × alle 720 s = 480 Calls/Tag – das Standardlimit 200 ist dann nach gut 10 h erreicht.

Die App startet in diesem Modus nur mit `APP_PASSWORD`. Ein Scan kann über die UI („Jetzt prüfen“) manuell eingeplant werden. eBay-API-Limits und Bedingungen beachten. Suchprofile mit bekanntem GPU-Modell teilen sich sechs breite eBay-Such-Buckets (z. B. „NVIDIA Ada“) mit je 200 Treffern inkl. Auktionen; die Zuordnung zum Profil passiert lokal. Freie Suchbegriffe kosten weiterhin einen Request pro Begriff.

### Facebook JSON-Import-Beispiel

```json
[
  {"id":"123456789", "title":"RTX 5080 16GB", "priceAmount":550, "url":"https://www.facebook.com/marketplace/item/123456789", "createdAt":"2026-10-31T14:00:00Z"}
]
```

Nur `https://facebook.com` und die gebräuchlichen Subdomains werden angenommen. Keine Verkäufer-Kontaktdaten speichern. Beispieldaten und echte Inserate sind in der UI unterscheidbar.

## Was fehlt noch?

Server-Betrieb (24/7, HTTPS, Backups – siehe Randbedingung im Umsetzungsplan), eingehende Provider-Webhooks und serverseitiges Web Push (P3), echte marktplatzübergreifende Angebots-Dubletten, Marktpreise und Preistrends, Auth per OIDC/Passkey, React/Vite-Oberfläche (die bestehende UI wurde nur auf `/api/v1` umgehängt), API-Anbieter-Abnahme. Für den Beta-Betrieb ist außerdem ein Security Review notwendig.

Die Roadmap und Abnahmekriterien stehen in [`DealForge_Umsetzungsplan_Detailliert.md`](DealForge_Umsetzungsplan_Detailliert.md).

## Entwicklung

```bash
corepack enable
pnpm install
docker compose up -d postgres redis   # Datenbank- und Worker-Tests brauchen beide
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm dev:api                          # API aus den TS-Quellen (Node-Type-Stripping), liest DATABASE_URL/REDIS_URL
pnpm dev:worker
```

Jede Testdatei bekommt ein eigenes Postgres-Schema und ein eigenes Redis-Prefix; Tests laufen also neben einem laufenden Stack. CI (`.github/workflows/ci.yml`) startet Postgres und Redis als Services, führt Lint, Typecheck, Build und Tests aus und scannt die Historie mit gitleaks nach Secrets. Regressionsfälle für Modell-/Zubehörerkennung stehen in `fixtures/gpu-listings.json`, neue Fehltreffer dort ergänzen.

## API-Oberfläche

Vollständig als OpenAPI 3.1 unter `GET /api/v1/openapi.json` (aus den Zod-Contracts erzeugt; ein Test stellt sicher, dass jede Route dokumentiert ist). Fehlerantworten haben immer die Form `{ code, message, requestId }`.

- `GET /api/v1/health/live`, `GET /api/v1/health/ready` (DB, Redis, Worker-Heartbeat)
- `POST /api/v1/auth/login`
- `GET /api/v1/state`, `GET /api/v1/providers/status`, `PATCH /api/v1/providers/:source` (`{"enabled":false}`)
- `GET|POST /api/v1/watchlists`, `PATCH|DELETE /api/v1/watchlists/:id`
- `GET /api/v1/listings?mode=all|schnapper|deal|repair&source=…&watchlistId=…&limit=…&cursor=…`, `GET /api/v1/listings/:id`
- `PATCH /api/v1/listings/:id/user-state` mit `new`, `saved`, `dismissed`, `contacted`, `purchased`
- `POST /api/v1/admin/scans` (`{"source":"all"}`) → `202`, `409` bei laufendem Scan, `429` bei erschöpftem Budget
- `POST /api/v1/import/facebook` (`{"items":[...]}`)

Mutation-Endpoints verlangen eine Session und den Header `X-Dealforge-Action: 1`. Alle Secrets verbleiben serverseitig.

## Hinweise zu Plattformregeln

Kleinanzeigen untersagt in seinen Nutzungsbedingungen Crawler/Scraper ohne schriftliche Zustimmung; der unabhängige Drittanbieter Kleinanzeigen Agent erklärt in eigenen AGB, **nicht** von Kleinanzeigen lizenziert zu sein. Meta gestattet automatisierte Datensammlung ohne Freigabe ebenfalls nicht. Der Einsatz eines Drittanbieter-API-Anbieters beseitigt nicht automatisch diese Risiken. Die Anbieterfreigabe ist ein obligatorischer Go/No-Go-Schritt.

- Kleinanzeigen: https://themen.kleinanzeigen.de/nutzungsbedingungen/
- Kleinanzeigen-Agent AGB: https://kleinanzeigen-agent.de/agb
- Kleinanzeigen-Agent API: https://kleinanzeigen-agent.de/dokumentation
- Meta Scraping: https://about.fb.com/de/news/2021/04/so-gehen-wir-gegen-scraping-vor/
- eBay Browse API: https://developer.ebay.com/develop/api/buy/browse_api
