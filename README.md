# DealForge MVP · Find. Fix. Flip.

Eigenständige, responsive WebApp als Nachfolger des Discord-Bots [`illuuuuusion/gpu-search`](https://github.com/illuuuuusion/gpu-search). TypeScript-Monorepo mit Fastify-API, BullMQ-Worker, PostgreSQL und Redis; alles läuft lokal per `docker compose` (Node.js 22.18+ und pnpm über Corepack für die Entwicklung).

> **Server erst am Ende:** DealForge wird bis zur letzten Plan-Phase (P7) nur lokal entwickelt und getestet. Der Scheduler pollt nur, solange der Rechner und der Stack laufen; Messwerte aus diesem Betrieb gelten als „lokal, nicht durchgehend“.

## Starten (Docker Compose)

```bash
cp .env.example .env     # APP_PASSWORD (≥16 Zeichen) und SECRETS_KEY (openssl rand -base64 32) setzen
docker compose up --build -d
# Öffnen: http://127.0.0.1:3000
```

Der Stack besteht aus `api` (Port `127.0.0.1:3000`), `worker`, `postgres` (`127.0.0.1:55432`) und `redis` (`127.0.0.1:56379`, AOF-persistiert). Die API wendet beim Start die versionierten Migrationen an und legt bei leerer Datenbank vier Startprofile an. Ohne `APP_PASSWORD` (mindestens 16 Zeichen) und `SECRETS_KEY` (mindestens 32 Zeichen) startet die API nur im Demo-Modus auf localhost. Für HTTPS das Proxy-Profil nutzen (siehe [Betrieb](#betrieb)). **Keinen ungeschützten öffentlichen Server betreiben.**

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

Der Import übernimmt Suchprofile, Inserate, Treffer, Preisverlauf und Läufe mit ihren IDs und vergleicht danach Zeilenanzahlen, ID-Summen, Preissummen und Inhalts-Hashes; bei Abweichung endet er mit Exit-Code 1. `--replace` leert die Zieldatenbank vorher (nötig, weil die API Startprofile anlegt). Vorher ein Backup ziehen (`scripts/backup.sh`); Migrationen haben keine Down-Skripte, Rollback = Backup einspielen (`scripts/restore.sh`).

## Enthalten

- Responsive Single-User-Dashboard, Feed nach Quelle, Schnappern, Preisalarmen und Repair-Fällen filterbar
- Suchprofile anlegen/pausieren/löschen; separate Kaufgrenzen für intakt/defekt, optionale Wiederverkaufsschätzung und Reparaturbudget
- GPU-Modellerkennung mit 49 Profilen aus `gpu-search` (Aliase, Ausschluss-Aliase, VRAM-Varianten): „RTX 4070 Super“ trifft keine 4070 Ti Super, „RTX 3060 12GB“ keine 8-GB-Karte. Zubehör (Lüfter, Halterungen, Wasserkühler, Kabel, Kartons, Displays), Komplett-PCs/Laptops und Platinen ohne Chip werden ausgeschlossen. Suchprofile mit einem bekannten Modell nutzen dieses Matching, freie Suchbegriffe den Textvergleich.
- Deterministische Zustands-/Symptomerkennung und erklärbarer, bewusst vorsichtiger Reparaturscore
- Repair Lab: Fehlerklassen (`NO_DISPLAY`, `ARTIFACTS`, `DRIVER_CRASH`, `NO_POWER`, `WATER_DAMAGE`, `BURN_DAMAGE`, `PARTS_MISSING`, sonst `UNKNOWN`), auch mehrere je Inserat; Warnungen (Wasser-/Brandschaden, Reparaturversuch, „kein Bild“ ist keine Diagnose) und Widersprüche im Text senken die Konfidenz. Eigene Annahmen (Stundensatz, Verkaufsgebühren, Versand, Teile/Zeit je Fehlerklasse, optional je Modell) getrennt von Kaufgrenzen. Aus einem Inserat wird per Klick ein Reparaturprojekt mit Worst-/Basis-/Best-Szenario – ohne Erfolgswahrscheinlichkeit. Kauf, Teile, Zeitaufwand, Ergebnis und Verkauf werden erfasst; die tatsächliche Marge erscheint bei „Verkauft“/„Aufgegeben“. Erfolgsquoten je Fehlerklasse erst ab 5 eigenen abgeschlossenen Projekten, immer mit Stichprobengröße
- Separate Flags für frisch entdeckt (`SCHNAPPER`), Preisvorteil gegenüber **deiner Kaufgrenze** (`DEAL`) und Defektchance (`REPAIR`)
- Unbekannte Versandkosten zählen nicht als 0 €: kein `DEAL`/`SCHNAPPER`, stattdessen „Preis prüfen“ – außer das Suchprofil akzeptiert unbekannten Versand (Abholung)
- eBay-Auktionen werden mit abgefragt; ein aktuelles Gebot zählt erst in den letzten 5 Stunden vor Ende als Deal
- PostgreSQL: Upserts pro Quelle und Inserats-ID, Beobachtungs-/Preis-Historie, erster/letzter Fund, Favoriten
- eBay Browse OAuth-Adapter (API-Schlüssel erforderlich) und Kleinanzeigen Agent REST-Adapter (explizit risikobehaftete Drittanbieter-Quelle; Schlüssel und Freigabe erforderlich)
- Facebook Marketplace ausschließlich über manuellen JSON-Testdatenimport. Keine ungeprüfte automatische Datenbeschaffung
- Worker mit Poll-Scheduler, manuellem Scan, Budget-Gate, Laufzeitschalter je Quelle und Systemstatus
- Alert-Engine: `SCHNAPPER`, `DEAL`, `REPAIR` höchstens einmal je Inserat und Suchprofil, `PRICE_DROP` (≥5 % gesunken, innerhalb der Kaufgrenze) einmal je neuem Preis – wiederholte Jobs und Replays erzeugen keine Dubletten
- Live-Alerts per Server-Sent Events (`/api/v1/events`, Fortsetzung über `Last-Event-ID`)
- Web Push (VAPID, Service Worker): „Push-Alerts“ abonniert das Gerät, Alerts kommen auch ohne geöffneten Tab. Je Alert ein Dispatch-Job mit Retry; abgelaufene Abos (404/410) werden entfernt. Zustellungslog: versandt = vom Push-Dienst angenommen, angezeigt = Empfangsbestätigung des Service Workers. Ohne Push-API fällt die App auf Notifications bei geöffneter Seite zurück
- Latenz je Quelle (p50/p95, 7 Tage): Inserat→Fund, Abruf→Alert, Alert→Push, Alert→angezeigt
- Schnell-Modus je Suchprofil: eigener Abfragetakt (`FAST_POLL_INTERVAL_SECONDS`, Standard 60 s) nur für Quellen in `FAST_PROVIDERS`; Budgets gelten weiter
- Marktwerte aus **Angebotspreisen** (nie als Verkaufspreise ausgegeben): je erkanntem Modell inkl. VRAM-Variante („RTX 3060 (8GB)“ ≠ „(12GB)“), Zustand und Quelle; eine Beobachtung je Inserat, Ausreißer außerhalb 1,5×IQR entfernt, P25/P50/P75 linear interpoliert. Auktionen (Gebot), Inserate ohne erkennbare VRAM-Variante und Verschenktes zählen nicht und werden mit Grund ausgewiesen. Unter der Mindeststichprobe (Standard 20) erscheint „keine verlässliche Schätzung“. Jeder Wert nennt Zeitfenster, Stichprobe und Berechnung; Inserate, die länger als 3 Tage nicht gesehen wurden, gelten nicht als verkauft
- Modellansicht „Marktwerte“: Verteilung, Wochenverlauf (Median und P25–P75 ab 5 Angeboten je Woche), Preisänderungen, Filter für Zustand, Quelle und Zeitfenster
- Ranking ohne Black Box: Priorität = 25 + Frische + Kaufgrenze + Reparatur + Angebots-Median + persönliche Signale (gemerkte/gekaufte Modelle, eigene Repair-Bilanz ab 3 Projekten, Profile mit vielen Fehltreffern), jeder Teil mit eigenem Gewicht 0–3 und auf der Karte aufgeschlüsselt
- „Als Fehltreffer melden“ (falsches Modell, Zubehör, Zustand, Sonstiges) entfernt das Inserat aus Feed und Marktwert; Fehltreffer-Quote je Quelle und Profil, dazu Bilanz aus Favoriten, Kontakten, Käufen und tatsächlicher Repair-Marge
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

## Betrieb

Alles hier ist lokal erprobt. Server-spezifische Schritte (Domain, Cron, Deploy-Secrets) folgen in P7.

**HTTPS-Proxy.** `docker compose --profile proxy up -d` startet zusätzlich Caddy ([`deploy/Caddyfile`](deploy/Caddyfile)). Lokal erhält `https://localhost:8443` ein Zertifikat der internen Caddy-CA (Browserwarnung); dafür `APP_ORIGIN=https://localhost:8443` setzen. Auf dem Server: `DEALFORGE_DOMAIN`, `CADDY_TLS=<E-Mail>` (Let's Encrypt), `PROXY_BIND=0.0.0.0`, `PROXY_HTTPS_PORT=443`, `PROXY_HTTP_PORT=80`, `APP_ORIGIN=https://<domain>`. HTTP leitet auf HTTPS (Port 443) um. SSE läuft ungepuffert durch.

**Sitzungen und Header.** Sessions liegen serverseitig in PostgreSQL. Das Cookie enthält nur ein Zufallstoken, gespeichert wird dessen SHA-256. Sie überstehen Neustarts. „Abmelden“ beendet die eigene Sitzung, „Alle Sitzungen beenden“ alle (`POST /api/v1/auth/logout`). Ein neues `APP_PASSWORD` beendet automatisch jede alte Sitzung. Über HTTPS heißt das Cookie `__Host-df_session` (Secure, HttpOnly, SameSite=Strict), dazu kommen HSTS und `upgrade-insecure-requests`. Jede Antwort trägt CSP (`script-src 'self'`, keine Inline-Skripte), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` und COOP. CORS gibt es nicht: fremde Origins bekommen weder lesenden Zugriff noch Mutationen. Hinter dem Proxy nimmt die API die Client-IP aus `X-Forwarded-For` (`TRUST_PROXY`, in Compose `loopback,uniquelocal`). Dadurch gilt die Login-Sperre (8 Fehlversuche → 60 s) je Client.

**Secrets.** Provider-Schlüssel und Passwörter kommen aus der Umgebung oder aus Dateien (`APP_PASSWORD_FILE=/run/secrets/…`, funktioniert für jede Variable). Sie stehen nie in der Datenbank und damit nie in Backups. In der Datenbank gespeicherte Secrets (VAPID-Schlüssel) sind mit `SECRETS_KEY` per AES-256-GCM verschlüsselt. **Rotation:** neuen Schlüssel als `SECRETS_KEY` setzen, den alten als `SECRETS_KEY_PREVIOUS`, API neu starten (sie verschlüsselt beim Start um), danach `SECRETS_KEY_PREVIOUS` entfernen und Worker neu starten. Provider-Schlüssel rotieren: Wert in `.env` ändern, `docker compose up -d`. Alle Log-Zeilen und gespeicherten Provider-Fehler laufen durch einen Redactor: konfigurierte Secret-Werte, `Bearer`/`Basic`, `access_token`, `klaz_key`, `api_key`, Passwörter in URLs. Das Audit-Log (`GET /api/v1/audit`, in der UI unter „Sicherheit“) zeigt jede ändernde und jede abgewiesene Anfrage (401/403/429) mit IP.

**Backup und Restore.** `scripts/backup.sh` schreibt einen geprüften `pg_dump` nach `backups/daily/` (7 Tage), sonntags zusätzlich nach `backups/weekly/` (30 Tage). Redis braucht kein Backup: Jobs und Scheduler legt der Worker neu an. `scripts/restore.sh <dump>` ersetzt alle Daten des Stacks (mit Rückfrage). `scripts/restore-test.sh [dump]` spielt ein Backup in ein leeres, separates Compose-Projekt ein, vergleicht die Daten Zeile für Zeile mit dem Dump, startet API und Worker darauf, prüft `/health/ready` und räumt wieder auf. Für den Restore wird der `SECRETS_KEY` gebraucht, der beim Backup aktiv war: Schlüssel getrennt von den Backups aufbewahren. Server-Cron: `15 3 * * * cd /opt/dealforge && scripts/backup.sh >> backups/backup.log 2>&1`.

**Deploy und Rollback.** `scripts/deploy.sh <revision>` läuft auf dem Server: Checkout → Backup → Image-Build → Migrations-Dry-Run (alle offenen Migrationen in einer zurückgerollten Transaktion) → Start mit Proxy → Readiness-Check. Schlägt ein Schritt fehl, bricht das Release ab. Rollback: `scripts/deploy.sh <vorherige revision>`. Muss eine Migration zurück, das vom Deploy erstellte Backup einspielen. Der CI-Job `deploy` ruft das Skript per SSH auf, sobald Tests und Secret-Scan grün sind. Er ist inaktiv, bis die Repository-Variable `DEPLOY_ENABLED=true` und die Secrets `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` gesetzt sind (P7).

**Störungen.** Im Dauerbetrieb (`ENABLE_SCHEDULER=true`) prüft die API jede Minute den Worker-Heartbeat und jede Live-Quelle. Ein Ausfall (Worker offline, eine Quelle `down`: drei Fehlläufe in Folge oder drei Intervalle ohne Erfolg) öffnet genau einen Incident und schickt einen Push. Die Behebung schickt einen zweiten. Offene Incidents stehen oben unter „Quellen & Integration“. Die Latenzanzeige markiert verfehlte Ziele (Abruf→Alert p95 ≤5 s, Alert→Push p95 ≤10 s). Lokal gemessen: Worker gestoppt → Incident nach 88 s.

**Aufbewahrung.** Stündlich löscht die API abgelaufene Sessions sowie Audit-Log, Provider-Läufe, Zustellungslog, Abfragezähler und behobene Incidents nach 90 Tagen. Inserate, die 400 Tage nicht mehr gesehen wurden, löscht sie ebenfalls, außer sie sind gemerkt, kontaktiert, gekauft oder in einem Reparaturprojekt. Begründung und Betriebsformen: [ADR 002](docs/decisions/002-privacy-retention.md).

## Was fehlt noch?

Server-Betrieb (24/7, Domain/TLS, Backup-Cron, Deploy-Secrets – P7), eingehende Provider-Webhooks und Push-Tests auf Mobilgeräten (erst mit Server, P7), echte marktplatzübergreifende Angebots-Dubletten, Marktpreise und Preistrends, Auth per OIDC/Passkey (optional, bewusst nicht umgesetzt), Mehrbenutzerbetrieb (Voraussetzung für Zugang Dritter, ADR 002), React/Vite-Oberfläche (die bestehende UI wurde nur auf `/api/v1` umgehängt), API-Anbieter-Abnahme. Für den Beta-Betrieb ist außerdem ein Security Review notwendig.

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

Jede Testdatei bekommt ein eigenes Postgres-Schema und ein eigenes Redis-Prefix; Tests laufen also neben einem laufenden Stack. CI (`.github/workflows/ci.yml`) startet Postgres und Redis als Services und führt Lint, Typecheck, Build und Tests aus. Danach folgen Migrations-Dry-Run, Migration und erneuter Dry-Run (es darf nichts offen sein), Docker-Image-Build und ein Smoke-Test des Images (Dry-Run und `/health/live`). Außerdem scannt CI die Historie mit gitleaks nach Secrets. Ohne Node 22 lokal laufen die Checks auch im Container: `docker run --rm --network host -v "$PWD":/app -w /app node:22-alpine sh -c 'corepack enable && pnpm test'`. Regressionsfälle für Modell-/Zubehörerkennung stehen in `fixtures/gpu-listings.json`, neue Fehltreffer dort ergänzen.

## API-Oberfläche

Vollständig als OpenAPI 3.1 unter `GET /api/v1/openapi.json` (aus den Zod-Contracts erzeugt; ein Test stellt sicher, dass jede Route dokumentiert ist). Fehlerantworten haben immer die Form `{ code, message, requestId }`.

- `GET /api/v1/health/live`, `GET /api/v1/health/ready` (DB, Redis, Worker-Heartbeat)
- `POST /api/v1/auth/login`, `POST /api/v1/auth/logout` (`{"all":true}` beendet alle Sessions), `GET /api/v1/audit?limit=…`
- `GET /api/v1/state`, `GET /api/v1/providers/status`, `PATCH /api/v1/providers/:source` (`{"enabled":false}`)
- `GET|POST /api/v1/watchlists`, `PATCH|DELETE /api/v1/watchlists/:id`
- `GET /api/v1/listings?mode=all|schnapper|deal|repair&source=…&watchlistId=…&limit=…&cursor=…`, `GET /api/v1/listings/:id`
- `PATCH /api/v1/listings/:id/user-state` mit `new`, `saved`, `dismissed`, `contacted`, `purchased`
- `GET /api/v1/alerts?limit=…` (neueste zuerst), `GET /api/v1/alerts/latency?days=…`, `GET /api/v1/events` (SSE, `event: alert`)
- `GET /api/v1/push/public-key`, `GET|POST /api/v1/push-subscriptions`, `DELETE /api/v1/push-subscriptions/:id` (nur bekannte Push-Dienste: FCM, Mozilla, Apple, WNS)
- `POST /api/v1/push/test`, `POST /api/v1/push/receipts` (Service Worker), `GET /api/v1/push/deliveries`
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
