# ADR 001 – Provider-Policy: GO/NO-GO für Datenquellen

**Status:** angenommen · **Datum:** 31.10.2026 · **Ticket:** DF-001

## Kontext

DealForge bezieht Inserate von eBay, Kleinanzeigen und Facebook Marketplace. Technische Erreichbarkeit einer Schnittstelle ist kein Nachweis, dass ihre Nutzung erlaubt, stabil oder bezahlbar ist. Ohne verbindliche Regel droht eine Architektur, die auf einer unbelegten Drittanbieterbehauptung aufbaut.

## Entscheidung

1. Jede Quelle hat genau einen Status: `PENDING`, `GO`, `GO LIMITED` oder `NO GO`.
2. Live-Abfragen (Scan und Scheduler) laufen **nur** für Quellen, die in `APPROVED_PROVIDERS` stehen **und** Zugangsdaten haben. Standard: leer, also keine Live-Abfrage. Eine Quelle kommt nur nach einem dokumentierten `GO`/`GO LIMITED` in diese Liste.
3. Nicht freigegebene Quellen bleiben in der UI sichtbar und werden als „nicht freigegeben“ angezeigt.
4. Pro Quelle gilt ein hartes Budget: pro UTC-Tag (`PROVIDER_DAILY_CALL_LIMIT`, Standard 200), pro Kalendermonat (`PROVIDER_MONTHLY_CALL_LIMIT`, 5000) und pro Suchfilter und Tag (`QUERY_DAILY_CALL_LIMIT`, 100). Es wird vor jedem einzelnen Request (auch Retries) gebucht; ist es erreicht, wird kein weiterer Request gesendet.
4a. Eine freigegebene Quelle lässt sich zur Laufzeit ausschalten (`PATCH /api/v1/providers/:source`); das wirkt ab dem nächsten Job, ohne Neustart.
5. Fällt ein Provider aus, gibt es kein Fallback-Scraping. Captcha-, Login- und Anti-Bot-Schutz werden nie umgangen. Es gibt kein Auto-Buying und kein Auto-Messaging.
6. Secrets liegen nur in der Server-Umgebung, niemals im Repo, im Browser, in Logs oder in Probe-Berichten.

## Harte Gates (alle erforderlich für `GO`)

| Gate | Ziel | Wenn verfehlt |
|---|---|---|
| Rechtliche/vertragliche Freigabe | explizit dokumentiert | **NO GO**, auch bei guter Technik |
| Treffervalidität | ≥95 % korrekte ID, Titel, URL, numerischer Preis | Normalisierung nacharbeiten |
| Laufstabilität | ≥95 % erfolgreiche Calls | keine kritischen Alerts aus dieser Quelle |
| Dubletten | stabile IDs, deterministisch deduplizierbar | vor Livebetrieb fixen |
| Fehlende Veröffentlichungszeit | quantifiziert, in der UI sichtbar | keine Behauptung einer Publikationslatenz |
| Latenz | Schnapper p95 ≤60 s nur mit Ground Truth; Standard p95 ≤5 min | als Standardquelle bzw. mit niedrigerer Priorität einstufen |
| Kosten | Preis je 1.000 brauchbare einmalige Treffer bekannt | Limit, Alternative oder NO GO |
| Budget | hartes Limit greift vor Überschreitung | Quelle bleibt deaktiviert |

`GO LIMITED` heißt: nutzbar, aber mit Einschränkung, z. B. nur als Standardquelle ohne Schnapper-Priorität oder nur per Import.

## Quellen

### eBay – Status: `GO LIMITED` (Standardquelle; Bericht [`ebay-2026-10-31`](../provider-evaluation/ebay-2026-10-31.md))

- **Zugang:** offizielle Browse API `GET /buy/browse/v1/item_summary/search` mit OAuth Client Credentials und `EBAY_DE`.
- **Erlaubnis:** offizielles Developer Program; die API License Agreement gilt. Vor dem `GO` werden Retention und Anzeigeregeln geprüft.
- **Datenschutz:** nur Inseratsdaten speichern, keine Verkäuferdaten außer dem Nötigsten.
- **Limit:** Tageskontingent der Anwendung laut Developer-Portal (Analytics/Rate Limits) prüfen. App-seitig gilt zusätzlich `PROVIDER_DAILY_CALL_LIMIT`.
- **DF-002 erledigt (31.10.2026):** 12/12 Calls erfolgreich, 100 % valide, Sofortkauf- und Auktionstreffer, Links korrekt.
- **Offen bis `GO`:** Freshness-Benchmark über 24–72 h und Bestätigung der API License Agreement.
- **Alternativen:** keine nötig. eBay ist der bevorzugte erste Live-Provider.

### Kleinanzeigen (über Kleinanzeigen Agent) – Status: `NO GO` (bis Freigabe)

- **Zugang:** Drittanbieter-REST `api.kleinanzeigen-agent.de/api/v2/kleinanzeigen/search` mit `klaz_key`. Suche, Historie und Webhooks werden getrennt abgerechnet.
- **Erlaubnis:** Die Nutzungsbedingungen von Kleinanzeigen untersagen Crawler und Scraper ohne schriftliche Zustimmung. Der Anbieter erklärt selbst, nicht von Kleinanzeigen lizenziert zu sein. **Ohne geklärte Nutzungsrechte NO GO**, unabhängig vom technischen Ergebnis.
- **Datenschutz:** keine Verkäufernamen oder Kontaktdaten speichern; Rohdaten nur befristet.
- **Limit/Kosten:** Credits pro Suche; Webhooks laut Anbieter ab 39 € netto/Monat pro Filter (60 s). Vor jedem Test ein Budget festlegen.
- **Offen (DF-003):** Response-Schema gegen echte Daten prüfen, Fehlermodi (401/403/429/Timeout) und Credits pro Call erfassen. Nur nach Rechts- und Kostenfreigabe.
- **Alternativen:** manuelle Suche; andere Anbieter nur mit plausibler Dokumentation und Nutzungsrecht.

### Facebook Marketplace – Status: `GO LIMITED` (nur manueller Import), Live: `NO GO`

- **Zugang:** Es gibt keine offizielle Such-API für fremde Marketplace-Inserate. Im MVP gibt es nur den manuellen JSON-Import (`POST /api/v1/import/facebook`, nur Facebook-Domains, max. 100 Einträge).
- **Erlaubnis:** Meta untersagt automatisierte Datensammlung ohne Freigabe. Ein Apify-Actor oder anderer Drittanbieter macht das nicht automatisch zulässig.
- **Datenschutz:** keine Verkäuferkontaktdaten importieren oder speichern.
- **Offen (DF-004):** Recherche eines dokumentierten, erlaubten Anbieters. Ein Trial (Apify) nur nach ausdrücklicher Freigabe, dann 72 h Messung oder ein dokumentiertes NO GO.
- **Code-Garantie:** `providerReady().facebook.live` ist immer `false`. Ein Eintrag in `APPROVED_PROVIDERS` ändert daran nichts.

## Freigabeprozess

1. Status `PENDING` eintragen, Budget für Tests festlegen (`PROBE_MAX_CALLS`).
2. Dry Run: `npm run probe -- <provider>` zeigt die geplanten Calls ohne Request.
3. Live-Probe: `npm run probe -- <provider> --live`. Sie schreibt `data/probes/<provider>-YYYY-MM-DD.jsonl` (gitignored, ohne Secrets und Verkäuferdaten) und gibt eine Zusammenfassung aus: Erfolgsquote, p50/p95-Latenz, Validität, stabile IDs, fehlende Veröffentlichungszeit, Angebotstypen und Fehler.
4. Für einen Frische-Benchmark über 24–72 h die Probe wiederholt im erlaubten Takt laufen lassen und eine manuelle Referenzstichprobe ziehen. Unter 100 eindeutigen Treffern lautet das Ergebnis „Stichprobe zu klein“.
5. Bericht `docs/provider-evaluation/<provider>-YYYY-MM-DD.md` anlegen: Gates-Tabelle mit Messwerten, Kostenprognose, Rechtsgrundlage, Entscheidung.
6. Erst bei `GO`/`GO LIMITED` die Quelle in `APPROVED_PROVIDERS` aufnehmen und den Status in diesem ADR aktualisieren.

## Konsequenzen

- Ohne `APPROVED_PROVIDERS=ebay` ruft auch ein konfigurierter eBay-Zugang nichts ab.
- Der MVP darf nur mit eBay live gehen. Kleinanzeigen und Facebook dürfen dauerhaft auf NO GO bleiben.
- Monatsbudgets, Budgets pro Suchfilter und `provider_configs` in der Datenbank folgen mit dem Worker (DF-206).
