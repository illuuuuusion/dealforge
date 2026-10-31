# DealForge – MVP und anschließender Umsetzungsplan

**Stand:** 31.10.2026 · **Ausgangsprojekt:** `illuuuuusion/gpu-search` · **Neues Repo:** `illuuuuusion/dealforge` (vorgeschlagen, nicht automatisch erstellt)  
**Zielbild:** Eine gehostete, mobile und Desktop-fähige WebApp für eBay, Kleinanzeigen und Facebook Marketplace – ohne Discord; priorisiert nach Deal, Schnapper und Repair.

## 0. Bestandsanalyse und Migration

Im bestehenden Repo sind eine getestete eBay Browse OAuth-Integration, GPU-Profile mit Preisgrenzen, fünf breite Such-Buckets, Beschreibungs-/Alias-Matching, Defekt- und Ausschlussfilter, separater `repairabilityScore`, `dreamDealScore`, persistenter `seen`-State, rollierende Preisstatistiken sowie Retry/Rate-Limit-Handling vorhanden. Die JSON-Persistenz ist prozesslokal und der Kleinanzeigen-Scraper ist laut README/Quellkommentar experimentell und deaktiviert. Discord, Valorant und AI-Agent/Socket sind als UI-Altlasten für die neue App nicht relevant.

**Gezielte Portierung statt monolithischem Fork:** `src/domains/gpu/config/gpu-profiles.json`, `searchBuckets.ts`, `aliasMatcher.ts`, `listingSignals.ts`, `filterEngine.ts`, `repairabilityScore.ts`, `dreamDealScore.ts`, relevante Tests und eBay-Infrastruktur nach und nach als unabhängiges `packages/domain` / `packages/providers/ebay` übernehmen. Nichts aus `src/integrations/discord` portieren.

## 1. Produktdefinition: was ein guter Fund ist

1. **Deal:** All-in-Preis (Angebot + tatsächlich bekannte Versand-/Gebührenkosten) liegt unter persönlicher Kaufgrenze bzw. später unter vergleichbarem, empirischem Marktpreis. Ergebnis erklärt die Referenz und ihre Datenbasis.
2. **Schnapper:** Neu oder gerade erstmals entdeckt. Benachrichtigen, wenn die Suchregeln erfüllt sind – auch bevor genügend Preis-Historie existiert. Zeitquelle stets kennzeichnen (`published_at` vs. `first_seen_at`).
3. **Repair:** Defekte/ungetestete Ware gesondert bewerten, positive Symptome und Negativsignale erkennen. Gewinnszenario = erwarteter Wiederverkaufspreis - Kaufpreis - Versand - geschätzte Teile/Arbeit - Verkaufsgebühr - Weiter-Versand. Hohe Risiken deutlich markieren; Textheuristik ersetzt keine Diagnose.

**Beispiel:** Eine RTX 4070 Super mit „kein Bild“, aber drehenden Lüftern und vollständig vorhandenem Kühler darf nicht herausgefiltert werden. Bei 89 € + 6,99 € Versand, 60 € Reparaturbudget, 550 € angenommenem Wiederverkauf, 12 % Verkaufskosten und 8 € Ausgeh-Versand liegt das *optimistische* Szenario bei ca. 320 € Marge. Davon sind Reparaturerfolg, Arbeitszeit, Transportrisiko und Mehrwertsteuer nicht abgedeckt; der UI-Wert muss als Schätzung gekennzeichnet werden.

## 2. MVP v0.1 (bereits als lauffähiges Projekt enthalten)

| Funktion | Aktueller Stand | Grenzen |
|---|---|---|
| Dashboard / Responsive Feed / Filter | Vorhanden | Kein virtuelles Scrolling |
| Suchprofile / Preisgrenzen / Repair-Budget | Vorhanden | Nur Kernfelder, keine Aliase/VRAM-Sonderlogik |
| eBay Browse mit OAuth | Adapter implementiert | Live-Zugang und Abnahme fehlen |
| Kleinanzeigen-Agent REST Suche | Adapter implementiert | Live-Test, Rechtslage und Vertrag offen |
| Facebook Marketplace | JSON-Import | Kein Live-Provider aktiv |
| Scanning | Polling und manueller Scan | Sequentiell, standardmäßig 5 Minuten; noch keine Low-Latency-Garantie |
| Scoring / getrennte Alerts | Regelbasiert | Kaufgrenze ≠ Marktwert, Reparatur nur heuristisch |
| Speicherung / Preisänderungen | SQLite/WAL | Nur Single Instance, Node-SQLite noch experimentell |
| Sofortmeldungen | Browser-Notifications bei offener Seite | Kein Web Push bei geschlossenem Browser |
| Sicherheit | Passwort-Session, HttpOnly-Cookie, Origin-/Headercheck | Vor öffentlichem Beta weitere Security-Abnahme |
| Tests | Unit + lokaler HTTP-Smoke | Keine echten API-Live-Tests ohne Schlüssel |

### MVP-Abnahmekriterien

- Ein neues Inserat erscheint spätestens beim nächsten erfolgreichen Poll; Dubletten derselben Quelle/ID erscheinen nicht erneut.
- Gleicher Titel von eBay/Kleinanzeigen ist noch **nicht** automatisch eine Dublette; Quellen werden nie blind zusammengelegt.
- Mindestens drei Testfälle: intakter günstiger Artikel, frisches normales Angebot, reparierbarer und riskanter Defekt – alle unterscheiden sich im Feed.
- Unbekannte Versandkosten sind als unbekannt markiert, nicht als 0 € behauptet.
- Deaktivierte Provider lösen keine Live-Abfragen aus; fehlerhafte APIs verändern kein vorhandenes Angebot.
- Bei ablaufenden API-Credits/429 wird die Quelle als fehlerhaft protokolliert statt heimlich zu scrapen.
- Keine API-Keys in Browser-Bundles oder im Git-Repo.

## 3. API-Evaluation: Go/No-Go vor Fremdanbieter-Bindung

**Reihenfolge:** (A) Vertrag/Nutzungsbedingungen und Datenschutz prüfen, (B) minimalen Sandbox-/Trial-Key organisieren, (C) reale Abfragen, (D) 24–72h Monitoring, (E) Budget und SLA, (F) Freigabe. *Technische Machbarkeit ist nicht gleich Nutzungsberechtigung.*

| Anbieter | Konkrete Testhypothese | Prüfpunkt |
|---|---|---|
| eBay (offiziell) | `item_summary/search` + OAuth liefern aktuelle deutsche GPU-Anzeigen | Zeitstempel, Sortierung, Auktionen, Throttling, Terms |
| Kleinanzeigen Agent | `GET /api/v2/kleinanzeigen/search` mit `klaz_key` liefert `data.ads[]` | 200, 429/402, 60s-Update-Fenster, ad_id, Preis, URL, Zeitstempel, rechtliche Freigabe |
| ReefAPI (Alternative) | REST-Suche nach Begriff/PLZ/Umkreis | Felder, Preise, Telemetrie, Terms, Ausfälle |
| Apify Marketplace Actor | Ein ausgewählter Actor liefert öffentlich zugängliche Marketplace-Ergebnisse | Geografische Genauigkeit, Alter der Daten, Fehlerrate, Account-/Rechtsrisiko |
| ScrapeCreators (Alternative) | Marketplace-Search REST + Item Details | 1. Treffer, Frische, Credits/Call, Regionsfilter, Datenqualität |

**Messprotokoll pro Provider:** drei Suchbegriffe (`RTX 4070 Super`, `RTX 5080`, `defekt grafikkarte`), zwei Regionen / eine bundesweite Suche, min. 100 tatsächliche Stichproben. `query_at`, `provider_response_at`, `published_at`, `first_seen_at`, `item_id`, `price`, `title`, `condition`, `shipping`, `URL`, `duplicate`, `errors`, `credits` protokollieren. Besonderes Gewicht auf p50/p95 der *Entdeckungsverzögerung* gegenüber manuell beobachtbaren neuen Inseraten (Provider-Zeitstempel allein reicht nicht für einen objektiven Beweis).

**Vorgeschlagene Go/No-Go-Ziele:** mindestens 95 % valide Titel/Preis/URL/ID, höchstens 5 % fehlgeschlagene Runs, möglichst p95 ≤60 s bei Premium-Schnapper-Quellen (wenn realistisch und finanzierbar), p95 ≤5 min bei Standardquellen, stabil über 72h, Budgetlimit zuverlässig wirksam. Nicht bestandene Anbieter bleiben deaktiviert. Preise pro 1.000 *echte neue und brauchbare* Treffer vergleichen, nicht nominale Produktpreise.

**Wichtige Einschränkung:** Kein öffentliches generelles Meta-Marketplace-Listing-Search-API für normale Entwickler. Meta Content Library ist für zugelassene Forschung; Marketplace-Partner-APIs dienen anderen Zwecken. Kleinanzeigen-Import-Schnittstellen für gewerbliche Inserate sind keine allgemeine Lesesuche. Offiziell zugängliche Schreib-/Business-Endpunkte lösen daher das Käufer-Suchproblem nicht.

**Rechtliche Ampel:** Für direkte oder indirekte automatisierte Erhebung ohne ausdrückliche Zustimmung besteht ein relevantes ToS-Risiko. Vor produktiver Nutzung in Deutschland fachlich/vertraglich klären. Bei fehlender Freigabe nur eBay und erlaubte Import-/Benachrichtigungswege; keine Anti-Bot-Umgehung als Abkürzung.

## 4. Umsetzungsroadmap nach dem MVP

| Phase | Dauer (Richtwert) | Lieferung / Definition of Done |
|---|---|---|
| **P0 – API- und Rechts-Spike** | 3–5 Tage | 2–3 Provider real testen, Messprotokolle, Kostenvergleich, No-Go-Regeln, Freigabeentscheid |
| **P1 – Domain-Migration** | 4–6 Tage | Vollständige GPU-Profile, VRAM-Erkennung, Alias-Tests, fünf eBay Buckets, Auktionen, Statuschecks portiert |
| **P2 – Zuverlässige Datenpipeline** | 5–7 Tage | PostgreSQL, Redis/BullMQ Worker, Scheduler je Quelle, Idempotenz, Dead-Letter, 429/backoff, Quota-Budget, Metrics |
| **P3 – Schnapper-Modus** | 4–6 Tage | Echte eventbasierte Webhooks wo verfügbar, serverseitiges Web Push, WebSocket/SSE-Feed, High-Priority-Alerts, Alert-Audit |
| **P4 – Repair Lab 2.0** | 5–8 Tage | Reparatur-Risikomatrix, Fehlerklassifikation, geschätzte Ersatzteile, persönliche Kompetenz/Stundensatz, profit/risk Szenarien |
| **P5 – Marktwert & Analytics** | 5–8 Tage | Vergleiche nach exakt erkanntem GPU-Modell/VRAM/Condition, Ausreißerfilter, Preis-Quantile, Preisänderungen, Verlauf; Mindeststichprobe |
| **P6 – Beta und Härtung** | 4–7 Tage | OIDC/Passkeys, HTTPS, DB-Migrationspfad, Backups, Security/DSGVO-Review, Rate-Limit-Tests, Alert-Falschtreffer-Messung |

Die Dauern sind Planungsrichtwerte für einen erfahrenen Full-Stack-Entwickler mit verfügbaren API-Zugängen, keine Zusage. API-Freigaben und externe Provider-Schwankungen können die Laufzeit stark beeinflussen. Priorität P0 vor Produktionsbetrieb.

## 5. Zielarchitektur nach P2

```text
Next.js-WebApp (Dashboard, PWA, Suchprofile, Repair Lab)
            |
       Backend API (Auth, preferences, results, alerts)
            |
  -------------------------------------
  | PostgreSQL   | Redis/Queues       |
  -------------------------------------
            |
     Scanner Workers / Webhook Ingest
            |
    ProviderAdapter Interface
    |      |               |
  eBay    Kleinanzeigen  Facebook (nur geprüfter Anbieter)
            |
   Normalisierung + Match + Score + Dedupe
            |
  Alert Engine (Web Push / optional E-Mail)
```

**Datenmodell:** `users`, `watchlists`, `search_queries`, `source_runs`, `listings`, `listing_snapshots`, `listing_watchlist_matches`, `price_observations`, `alerts`, `feedback`, `provider_configs`, `provider_budgets`. Jede Quelle hat `source`, `external_id`, `source_published_at`, `first_seen_at`, `last_seen_at`, `fetched_at`, `raw_json` (mit Retention), `data_confidence`. Ungewisse Werte bleiben `NULL`. Keine unnötigen privaten Verkäuferinformationen.

**Deployment:** Für einen persönlichen Prototyp reicht Docker Compose mit SQLite und HTTPS-Reverse-Proxy. Für echte schnelle Schnapper auf mehreren Märkten ist ein dauerhafter Server/Worker nötig; Serverless Cron allein ist wegen Frequenz/Kaltstart begrenzt. Empfehlung: WebApp + separater persistenter Worker auf VPS/Container-Host, Postgres managed oder im selben Host mit Backups, Redis optional.

## 6. Erfolgsmessung

- **Frische:** p50/p95 `first_seen_at - published_at` sowie unabhängige manuelle Stichprobe; vor allem neue Inserate in 1–3 Minuten.
- **Qualität:** 1) Falsch-positive Deal-Alerts, 2) falsche GPU-Varianten, 3) korrekte Defekt-Erkennung, 4) Reparatur-ROI-Fehlannahmen.
- **Kosten:** API-Credits/Tag, Kosten pro brauchbarem einzigartigem Treffer, Alerts mit Relevanz-Feedback.
- **Stabilität:** Query-Erfolgsrate, 429-/402-Fälle, Delay, Duplikate, DB-Writes, Warnungen bei Budget >80 %.
- **Erfolg für den Nutzer:** gespeicherte Angebote, Käufe, tatsächliche Reparaturkosten, realisierte Marge, verpasste Schnellangebote.

## 7. Risiken und klare Grenzen

- Fehlende Freigabe von Kleinanzeigen/Meta darf nicht durch aggressives Scraping, Captcha-Umgehung oder das Teilen privater Zugangsdaten ersetzt werden.
- Verkäuferdaten DSGVO-minimal behandeln; keine automatischen Marketplace-Nachrichten im MVP.
- Ein „Kein Bild“-Fehler ist eine *Hypothese*, keine sichere Reparatur. Wasserschaden/Verbrennung sind Risikosignale, nicht absolute Diagnosen.
- Wiederverkaufswerte werden zuerst vom Nutzer konfiguriert; datengetriebene Marktwerte erst nach belastbaren Stichproben.
- Preisänderungen, Versand- und Gebührenänderungen müssen bei Warnungen berücksichtigt werden.
- Ein Browser-Alert bei geöffneter App ist keine sofortige Push-Mitteilung bei geschlossenem Handy. Diese Fähigkeit kommt ab P3.

## 8. Erster praktischer Sprint

1. `dealforge` als **privates** neues GitHub-Repo anlegen und dieses MVP importieren; Altprojekt unverändert lassen.
2. `.env` lokal setzen, `npm test` und `npm start`, UI auf Desktop/Handy ansehen.
3. eBay OAuth-Schlüssel hinzufügen, reale `EBAY_DE`-Ergebnisse gegen das Original vergleichen, insbesondere Auktionen/Shipping und Zeitstempel.
4. Kleinanzeigen und Meta-Anbieter-Freigabe/Kostenbasis klären. Test-Credits besorgen; nur danach `probe --live` mit 3 Queries und Laufzeit-Stichproben.
5. Falsch-positive Treffer als Testfälle dokumentieren und die Original-GPU-Profilkonfiguration portieren.
6. Erst nach Go/No-Go P2/P3 (Worker, Push und schnelle Quellen) für echten Schnapper-Betrieb angehen.

### Quellen (Abruf 31.10.2026)

- https://github.com/illuuuuusion/gpu-search
- https://developer.ebay.com/api-docs/buy/buying-ig-landing.html
- https://kleinanzeigen-agent.de/dokumentation
- https://kleinanzeigen-agent.de/agb
- https://themen.kleinanzeigen.de/nutzungsbedingungen/
- https://hilfe-gewerblich.kleinanzeigen.de/artikel/schnittstellen
- https://about.fb.com/de/news/2021/04/so-gehen-wir-gegen-scraping-vor/
- https://apify.com/memo23/facebook-marketplace-scraper-ppe
