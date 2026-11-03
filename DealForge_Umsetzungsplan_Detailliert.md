# DealForge – Konkreter MVP- und Umsetzungsplan

> **Version 2.0 · 31. Oktober 2026**  
> Ausgangsrepository: [`illuuuuusion/gpu-search`](https://github.com/illuuuuusion/gpu-search)  
> Vorgeschlagenes neues Repository: `illuuuuusion/dealforge`  
> Ziel: Persönliche, gehostete WebApp zum Entdecken von günstigen, sehr frischen und reparaturwürdigen Hardware-Angeboten aus eBay, Kleinanzeigen und – nur bei zulässigem Datenzugang – Facebook Marketplace. **Kein Discord-Bot.**

## Stand und Grundregel (03.11.2026)

**Server erst am Ende.** Alles wird lokal entwickelt und getestet (`docker compose`, `pnpm test`, CI). Jeder Schritt, der einen dauerhaft laufenden Server oder eine öffentliche HTTPS-Adresse braucht, ist in der Schlussphase **P7 – Server-Inbetriebnahme und Live-Abnahme** gebündelt: 24/7-Dauerläufe, 24–72h-Frische-Benchmarks, eingehende Webhooks, Push bei geschlossenem Browser/auf Mobilgeräten, TLS, Backups/Restore auf dem Host, Latenz-SLOs und die mobile Beta. Vorher wird lokal nur so weit gemessen, wie es ohne Server aussagekräftig ist; solche Werte gelten als „lokal, nicht durchgehend“.

| Phase | Status |
|---|---|
| P0 Provider/Freigabe | eBay `GO LIMITED` (DF-001/002/005/006 erledigt); Kleinanzeigen `NO GO`, Facebook nur Import – Freigabe offen (DF-003/004) |
| P1 Korrektheit/Domain | erledigt (Versand, Stale Matches, 49 Profile, Buckets, Auktionen, Zubehörfilter, 69 Fixtures, CI) |
| P2 Backend/Pipeline | erledigt bis auf den Dauerlauf (→ P7) |
| P3 Schnapper-Engine | lokal erledigt (DF-301, 303–308); DF-302 Webhooks wartet auf einen Provider mit Webhooks und `GO`; Geräte-Push-Tests in P7 |
| P4 Repair Lab | lokal erledigt (DF-401–407): Fehlerklassen, Konflikte/Warnungen, eigene Kostenannahmen, Worst/Base/Best-Szenarien, Reparaturprojekte mit tatsächlicher Marge, Statistik ab 5 eigenen Projekten |
| P5 Marktwert/Ranking | lokal erledigt (DF-501–506): Angebots-Marktwerte je Modell inkl. VRAM-Variante, Zustand und Quelle; P25/P50/P75 mit IQR-Ausreißerfilter, Mindeststichprobe 20 (einstellbar); Wochenverlauf, Preisänderungen, Fehltreffer-Feedback, einstellbare Ranking-Gewichte mit sichtbarer Aufschlüsselung |
| P6 | offen, lokal |
| P7 Server | offen, ganz am Ende |

## 0. Verbindliche Leitentscheidungen

### Produktziel

DealForge ist **keine reine Preisvergleichsseite**. Die App verfolgt drei getrennte Nutzerabsichten:

1. **Deal** – Preis liegt unter einer selbst gesetzten Kaufgrenze oder einem später empirisch ermittelten Marktwert.
2. **Schnapper** – Ein neues Inserat, das unmittelbar geprüft werden sollte. Der Nutzen hängt von *Entdeckungs- und Benachrichtigungsgeschwindigkeit* ab, nicht bloß von einem hohen Preis-Score.
3. **Repair** – Defekte oder ungetestete Ware, die für ein Reparaturprojekt interessant sein könnte. Defektmerkmale dürfen nicht pauschal als Ausschlusskriterium wirken.

Die drei Typen sind **Tags, keine gegenseitig ausschließenden Kategorien**: Eine defekte RTX 4070 Super kann zugleich `SCHNAPPER`, `DEAL` und `REPAIR` sein. Jeder Tag bekommt eine eigene Begründung.

### Entscheidungen zur Umsetzung

| Thema | Entscheidung | Warum |
|---|---|---|
| Repository | Neues privates Repo `dealforge`; `gpu-search` bleibt unverändert | Klare Produktgrenze zu Discord und Valorant |
| Ausgangspunkt | Bestehenden DealForge-MVP als **Prototyp**, nicht als bereits produktionsfertige App verwenden | Aktuell Single-User, Node-HTTP, SQLite, keine echten Drittanbieter-Livetests |
| Sprache | Durchgängig TypeScript nach Stabilisierung | Wiederverwendung der Typen und Tests aus `gpu-search` |
| Oberfläche | React + Vite + TypeScript als **empfohlene Zielmigration**; responsive PWA | Keine Discord-UI, schnelle Listen und eigene Interaktionen |
| API | Fastify + Zod, getrennte API- und Worker-Prozesse | Typisierte HTTP-Schnittstellen, saubere Fehlerbehandlung |
| Datenbank | Bestehende SQLite im Prototyp; ab produktivem Mehrprozessbetrieb PostgreSQL | Historie, konkurrierende Worker, Transaktionen, Indexierung |
| Queue | BullMQ/Redis **erst ab P2** | Zu Beginn nicht unnötig überbauen |
| Backend-Hosting | Dauerhaft laufender Container/VPS + HTTPS | Schnelle Polls und eingehende Webhooks brauchen zuverlässige Prozesse |
| eBay | Offizielle Browse API mit OAuth | Erster realer und bevorzugter Provider |
| Kleinanzeigen | Adapter für geprüften Drittanbieter oder andere ausdrücklich erlaubte Datenquelle | Technische Funktion und Nutzungsrechte getrennt verifizieren |
| Facebook Marketplace | Zunächst manueller JSON-Import; Live-Anbindung erst nach technischer und rechtlicher Freigabe | Keine frei verfügbare, allgemeine offizielle Such-API für private fremde Marketplace-Angebote als Grundlage einplanen |
| Alerts | In-App zuerst, danach serverseitiges Web Push (Service Worker/VAPID) | Funktioniert ohne Discord und bei geeigneter Geräte-/Browserkonfiguration auch ohne geöffnete Seite |
| Kaufautomatisierung | **Nicht Bestandteil des MVP** | Kein Auto-Buying, kein Auto-Messaging, keine Captcha-Umgehung |

**Wichtige Grenze:** Die verfügbaren offiziellen Schnittstellen für gewerbliche Inseratsverwaltung sind nicht automatisch Such-APIs für Käufer. Drittanbieter-APIs sind nicht allein deshalb rechtlich zulässig, weil sie einen REST-Endpunkt anbieten. Die Nutzungsrechte müssen vor Aktivierung geklärt werden.

## 1. Ist-Zustand: konkret geprüft

### 1.1 Bereits im DealForge-MVP v0.1 enthalten

Der ZIP-Prototyp enthält tatsächlich folgende Dateien und Funktionen:

| Code | Bestehende Datei | Ist-Funktion | Für Produktbetrieb noch offen |
|---|---|---|---|
| `D-01` | `src/server.js` | HTTP-Server, Sessions, Watchlist-CRUD, Scan, Import | Validierung, Rollen/Session-Härtung, Pagination, getrennte Prozesse |
| `D-02` | `src/providers.js` | eBay OAuth + Suche; Kleinanzeigen-Agent-REST; Facebook-Normalisierung | Live-Key-Test, Retry/429, Provider-Vertrag, Zeitstempel-/Feldvalidierung |
| `D-03` | `src/db.js` | SQLite/WAL, Inserats-Upsert, Matches, Preisverlauf, Source Runs | Schema-Migrationssystem, Stale-Match-Bereinigung, mehr Instanzen |
| `D-04` | `src/scoring.js` | Zustandsklassifikation, Kaufgrenzen, Repair-Score, Priorität | Versandunsicherheit, robustes Modell-/VRAM-Matching, Marktwerte |
| `D-05` | `public/index.html`, `app.js`, `styles.css` | Responsive Dashboard und Filter | PWA, mobile Push-UX, ausgebaute Watchlist-Formulare |
| `D-06` | `scripts/probe.js` | Dry Run / expliziter Live-Test für Kleinanzeigen und Apify | Mehrtägige Benchmarks, Laufkosten, Testkontingente, Actor-Schema |
| `D-07` | `tests/*.test.js` | 14 lokale Unit-/Persistenztests | API-Vertrags-/Load-/End-to-End-Tests |
| `D-08` | `Dockerfile`, `compose.yaml` | Lokaler Container-Betrieb | HTTPS, Backups, Healthcheck, Secret-/Release-Prozess |

**Nachprüfung am 31.10.2026:** `npm test` mit Node `v22.16.0` ergibt **14 Tests, 14 bestanden**. Das belegt lokale Regeln und Datenbankoperationen, **nicht** die Funktion der externen Live-Schnittstellen.

### 1.2 Bereits wertvolle Bausteine im ursprünglichen `gpu-search`

Diese Module gezielt übernehmen, nicht das gesamte Repository forken:

| Aus `gpu-search` | Ziel in DealForge | Aufgabe |
|---|---|---|
| `src/domains/gpu/config/gpu-profiles.json` | `packages/domain/src/gpu/profiles/` | Vollständige Modelle, Aliase, negative Aliase, VRAM und Preisgrenzen übernehmen |
| `src/domains/gpu/config/searchBuckets.ts` | `packages/providers/src/ebay/queryPlanner.ts` | Fünf breite Such-Buckets statt ein Request pro GPU |
| `src/domains/gpu/domain/aliasMatcher.ts` | `packages/domain/src/gpu/matcher.ts` | Varianten sauber auseinanderhalten |
| `src/domains/gpu/domain/listingSignals.ts` | `packages/domain/src/listing/signals.ts` | Strukturierte Daten, Aspekte und Textquellen auswerten |
| `src/domains/gpu/domain/filterEngine.ts` | `packages/domain/src/listing/evaluate.ts` | Allgemeine Ausschlüsse von Defektbehandlung trennen |
| `src/domains/gpu/domain/repairabilityScore.ts` | `packages/domain/src/repair/heuristics.ts` | Vorhandene Defektsignale portieren und weiter testen |
| `src/domains/gpu/domain/dreamDealScore.ts` | `packages/domain/src/deals/scoring.ts` | Preis-/Feedback-Signale **als Teilkomponente** verwenden |
| `src/domains/gpu/infrastructure/ebay/client.ts` | `packages/providers/src/ebay/` | Pagination, OAuth, Retry-/Rate-Limits portieren |
| Relevante `*.test.ts` | `packages/domain/test/` | Regressionsfälle in neue Testsuite aufnehmen |

**Nicht übernehmen:** `src/integrations/discord/`, AI-Agent-Socket/Sidecar, Valorant-Modul, Reactions, Discord-spezifische Reminder, JSON-Scanner-State als langfristige Datenbank.

### 1.3 Konkrete Lücken und Bugs vor neuen Features

Diese Punkte erhalten höchste Priorität:

- `BUG-01` **Unbekannte Versandkosten:** `scoreListing()` addiert bei `shippingEur=null` derzeit faktisch 0. Die UI nennt die Kosten unbekannt, kann das Angebot aber trotzdem als Schnapper/Deal markieren. Fix: `known_total_eur` und `total_lower_bound_eur` unterscheiden; strenge Deal-Alerts nur bei bekanntem Total oder nach konfigurierbarer Nutzerentscheidung für „Abholung/Versand unbekannt“.
- `BUG-02` **Veraltete Matches:** Bei Aktualisierung eines Inserats werden bestehende `matches` nicht vollständig neu berechnet/entfernt. Fix: Für veränderte Inserate Matches transaktional neu ermitteln; alte unzutreffende Matches löschen.
- `BUG-03` **Nicht portierte eBay-Auktionen:** Die aktuelle eBay-Prototypabfrage ist `q` + `sort=newlyListed` ohne explizite Auktionserweiterung. Der offizielle Browse-Endpunkt liefert standardmäßig vor allem Listings mit Sofortkauf-Option. Fix: eigenständige Auktions-Query/Filter und Restzeitlogik.
- `BUG-04` **Modelle/Varianten:** Ein einfacher Token-Matcher deckt keine komplexen Alias-, VRAM- und Board-Varianten ab. Fix: bewährtes Modellmatching aus `gpu-search` portieren.
- `BUG-05` **Datenfrische:** Quelle kann einen veralteten oder fehlenden Publikationszeitpunkt liefern. Fix: `published_at`, `first_seen_at`, `fetched_at` separat speichern und UI-Basis kennzeichnen.
- `BUG-06` **Session-/Sicherheits-Review:** Der lokale Single-User-Server ist nicht als gehärtete öffentliche Auth-Plattform freigegeben. Fix: dedizierte Auth-Lösung, CSRF/Origin, Header, sichere Cookies, Rate-Limits, Secrets, Security-Test vor Internetfreigabe.

## 2. Nutzerabläufe, die der MVP wirklich können muss

### Use Case A – Neuer Schnapper

1. Nutzer erstellt Watchlist „RTX 4070 Super, intakt, maximal 450 €, alle freigegebenen Quellen“.
2. Worker plant zulässige Suchabfragen oder empfängt einen autorisierten Provider-Webhook.
3. Ein Inserat wird übernommen, als RTX 4070 Super (nicht 4070 Ti) klassifiziert und mit `first_seen_at` gespeichert.
4. Preis + bekannte Kosten werden geprüft; keine Daten werden hinzuerfunden.
5. `SCHNAPPER` entsteht aus **neu entdeckt + Suchtreffer + günstiger Preis**, nicht zwingend aus einem bereits errechneten Marktwert.
6. Ein Alert wird dedupliziert und im Feed angezeigt, später per Web Push versendet.
7. Nutzer öffnet die **Originalanzeige**, markiert „interessant“, „kontaktiert“, „gekauft“ oder „ignorieren“.

**Akzeptanz:** Eine Neuentdeckung erzeugt höchstens einen `SCHNAPPER`-Erstalert pro Nutzer und Inserat/Watchlist, auch wenn Worker erneut zustellen. Die Anzeige nennt, ob die Zeit vom Marktplatz oder von DealForge stammt.

### Use Case B – Reparaturkandidat

1. Watchlist erlaubt `DEFECT`, `UNKNOWN` oder beide Zustände.
2. Listing lautet beispielsweise „RTX 3080, kein Bild, Lüfter drehen, ungeöffnet“.
3. Das Gerät wird **nicht ausgeschlossen**, sondern erhält erkannte Symptom-Signale.
4. UI zeigt Reparaturrisiko, Defekt-Begründungen, Kaufpreis, Reservebudget und eine konservative Beispielrechnung.
5. Verkäuferangaben wie „ungetestet“ oder „kein Bild“ werden nicht mit einer tatsächlichen Fehlerdiagnose verwechselt.
6. Nutzer speichert das Inserat ins „Repair Lab“ und trägt später reale Reparaturkosten/Ergebnis ein.

**Akzeptanz:** Wasserschäden, fehlender Chip und wiederholte Reparaturversuche reduzieren die Bewertung deutlich. Ohne bekannte Wiederverkaufswerte/Erfolgschancen wird **kein sicherer Gewinn** behauptet.

### Use Case C – Preisänderung/erneut interessant

1. Bekanntes Listing wird erneut geholt.
2. Original-ID ist dieselbe, Preis oder Versand hat sich geändert.
3. Preisbeobachtung wird nur bei tatsächlicher Änderung geschrieben.
4. Regeln werden erneut geprüft. Unterhalb der Kaufgrenze kann ein **neuer `PRICE_DROP`-Alert** entstehen – mit eigener Dedupe-Regel.
5. Feed zeigt „-40 € seit erstem Fund“ mit Zeitstempel und neuer Bewertung.

**Akzeptanz:** Kein Duplikat-Inserat; Alert-Historie bleibt nachvollziehbar; Preis- und Versandänderung werden unterschieden.

## 3. Geplante UI – konkrete Seiten und Komponenten

### 3.1 Navigation

| Ansicht | Inhalt | MVP-Priorität |
|---|---|---|
| `/` Dashboard | Wichtigste neue Treffer, Quellenstatus, Zeit seit letztem Scan, Alerts heute | P1 |
| `/deals` Feed | Tabs **Alle / Schnapper / Deals / Repair / Preisstürze**; Filter nach Quelle, Modell, Zustand, Preis, Alter, Relevanz | P1/P3 |
| `/watchlists` Watchlists | Erstellen, bearbeiten, kopieren, pausieren; Quellen, Modell, VRAM, Umkreis, Maximalpreise | P1 |
| `/listing/:id` Detail | Text, Bilder/Quelle, Preisverlauf, erkannte Merkmale, Score-Begründung, Aktionen und Originallink | P3 |
| `/repair` Repair Lab | Reparaturkandidaten, Risiko, Kostenrechner, tatsächliches Ergebnis | P4 |
| `/market` Preisanalysen | Verteilung/Quantile je Modell, Zustand und Quelle; Datenmenge sichtbar | P5 |
| `/settings/providers` Provider | Freigabe, Status, letzte Abfragen, Kosten, Budget, Token-Status (ohne Token im Browser) | P0/P2 |
| `/settings/notifications` Alerts | Web-Push-Abo, Lautstärke, wichtige Suchprofile, Quiet Hours, Test-Alert | P3 |
| `/settings/system` Betrieb | Fehler, Queue-Rückstand, Health, Export/Backups | P6/P7 |

### 3.2 Inseratskarte – Pflichtfelder

- Bild (wenn vorhanden), Titel, Quelle, Modell/VRAM, verlinkte Originalanzeige.
- Preis, Versand explizit als `x €` **oder** `unbekannt`; tatsächlicher/unterer Gesamtpreis entsprechend markiert.
- Status `intakt | defekt | ungetestet | unklar`.
- Abzeichen getrennt: `SCHNAPPER`, `DEAL`, `REPAIR`, `PRICE_DROP`.
- `veröffentlicht vor x` nur bei belastbarem Quellzeitstempel, sonst `erstmals gesehen vor x`.
- **Warum gefunden?** Maximal drei konkrete Gründe: z. B. „28 % unter deiner Kaufgrenze“, „vor 4 min neu entdeckt“, „kein Bild; Lüfter drehen; bereits geöffnet: nein“.
- Aktionen: **Original öffnen**, **Speichern**, **Ignorieren**, **Als Fehltreffer melden**, **Kontaktiert**, **Gekauft**.

**Performance-Ziel:** Mobile Ansicht bis 390 px Breite ohne horizontales Scrollen; erste 50 Karten flüssig, später Pagination/virtuelle Liste. Dark Mode optional, kein Blocker für Quellenvalidierung.

## 4. Domänenmodell und Datenregeln

### 4.1 Normalisierter Listing-Typ

```ts
type Source = 'ebay' | 'kleinanzeigen' | 'facebook';
type Health = 'WORKING' | 'DEFECT' | 'UNKNOWN' | 'EXCLUDED';
type OfferType = 'FIXED_PRICE' | 'AUCTION' | 'OTHER';

type NormalizedListing = {
  source: Source;
  externalId: string;
  sourceUrl: string;
  title: string;
  description?: string | null;
  imageUrls: string[];
  priceEur: number | null;
  shippingEur: number | null;
  feesEur: number | null;
  currency: 'EUR';
  publishedAt: string | null;
  fetchedAt: string;
  offerType: OfferType;
  auctionEndsAt?: string | null;
  bidCount?: number | null;
  conditionRaw?: string | null;
  attributes?: Record<string, string[]>;
  itemLocation?: { country?: string; region?: string; zipPrefix?: string };
  providerMetadata?: { adapter: string; schemaVersion: string };
};
```

**Invarianten:**

- `UNIQUE(source, external_id)`. Nie allein anhand von Titel/Preis Quellen zusammenlegen.
- `publishedAt` wird nie aus `fetchedAt` erfunden. Fehlende Werte bleiben `NULL`.
- `shippingEur=null` ist **nicht** `0`.
- Kaufgrenze, Verkäufer-Angebotspreis, geschätzter Marktwert und hypothetischer Reparaturgewinn sind **verschiedene** Größen.
- „Zu verschenken“ mit 0 € ist erlaubt; für normale Ware ist 0 € ein Datenqualitätsproblem.
- Rohdaten sparsam und zeitlich begrenzt speichern; nicht benötigte personenbezogene Verkäuferdetails verwerfen.
- Externe URLs serverseitig validieren; keine beliebigen URLs als Abrufziele zulassen.

### 4.2 PostgreSQL-Tabellen ab P2

| Tabelle | Zentrale Spalten | Indizes/Constraint |
|---|---|---|
| `users` | `id`, `email?`, `created_at`, `settings_json` | PK |
| `watchlists` | `id`, `user_id`, `name`, `enabled`, `model_key`, `health_targets`, `max_working_eur`, `max_defect_eur`, `repair_budget_eur` | `(user_id, enabled)` |
| `watchlist_sources` | `watchlist_id`, `source`, `query`, `region`, `radius_km`, `provider_filter_json` | UNIQUE(watchlist_id,source,query,region) |
| `provider_configs` | `source`, `adapter_name`, `enabled`, `approval_status`, `rate_policy`, `capabilities_json` | UNIQUE(source,adapter_name) |
| `source_runs` | `id`, `adapter_name`, `query_key`, `started_at`, `finished_at`, `status`, `http_status`, `fetched`, `inserted`, `credits`, `error_code` | `(adapter_name,started_at DESC)` |
| `listings` | `id`, `source`, `external_id`, `title`, `url`, `price_eur`, `shipping_eur`, `published_at`, `first_seen_at`, `last_seen_at`, `fetched_at`, `health`, `model_key` | UNIQUE(source,external_id), `(first_seen_at DESC)`, `(model_key,health)` |
| `listing_snapshots` | `id`, `listing_id`, `observed_at`, `price_eur`, `shipping_eur`, `title_hash`, `condition_hash`, `availability` | `(listing_id,observed_at DESC)` |
| `watchlist_matches` | `listing_id`, `watchlist_id`, `evaluation_version`, `assessment_json`, `matched_at` | UNIQUE(listing_id,watchlist_id) |
| `alerts` | `id`, `user_id`, `listing_id`, `watchlist_id`, `kind`, `dedupe_key`, `created_at`, `delivered_at`, `state`, `reason_json` | UNIQUE(user_id,dedupe_key) |
| `push_subscriptions` | `id`, `user_id`, `endpoint_ciphertext`, `keys_ciphertext`, `last_success_at` | UNIQUE(user_id, endpoint_hash) |
| `feedback` | `id`, `user_id`, `listing_id`, `label`, `reason`, `created_at` | `(user_id,created_at DESC)` |
| `repair_projects` | `id`, `user_id`, `listing_id`, `purchase_price`, `parts_cost`, `hours`, `outcome`, `resale_actual` | `(user_id,created_at DESC)` |
| `provider_daily_usage` | `provider`, `date`, `calls`, `credits`, `estimated_cost_eur` | UNIQUE(provider,date) |

**Hinweis:** `provider_configs` enthält **keine frei lesbaren API-Schlüssel**. Secrets in Secret Manager/Environment, nur Referenz und Status in der Datenbank. Migrationen versioniert (`drizzle` oder anderes migrationsfähiges Werkzeug), mit Rollback- und Backup-Strategie.

### 4.3 Bewertung als mehrere unabhängige Achsen

Nicht nur ein undurchsichtiger `100/100`-Score:

```text
MATCH:       Modell/VRAM/Variante korrekt?       -> true/false + Confidence
PRICE:       Kaufgrenze/Marktwert/All-in-Kosten  -> Prozent/Euro + Datenbasis
FRESHNESS:   Wann veröffentlicht / entdeckt?    -> Minuten + Quelle des Zeitstempels
REPAIR:      Defektsignale / Reparaturrisiken     -> heuristischer Wert + Gründe
RISK:        Fehlende Daten / Betrugsindikatoren  -> Warnungen, keine harte Schuldbehauptung
PRIORITY:    Welche Treffer sollte ich JETZT sehen? -> gewichtete Queue-Priorität
```

**Regel v1:**

- `DEAL`: Kaufgrenze bekannt, ausreichende Kosteninformationen, Preis mindestens Nutzer-Schwelle darunter. Ohne Marktwert nicht „x % unter Marktwert“ schreiben.
- `SCHNAPPER`: frischer Erstfund, passendes Modell, attraktive Kaufgrenze, Mindestdatenqualität. Gesonderte „Preis prüfen“-Kategorie für unbekannte Versandkosten.
- `REPAIR`: Zustand `DEFECT`/entsprechend erlaubtes `UNKNOWN`, innerhalb Defektbudget oder manuell gespeicherter Kandidat, kein eindeutiger Zubehör-Fehltreffer.
- `PRICE_DROP`: signifikante Senkung seit letzter Beobachtung, separate Schwelle und Alarm-Cooldown.
- `PRIORITY`: Mischung aus Frische, Preisvorteil, Nutzerpräferenz und Datenqualität; **nicht** automatisch sichere Reparaturwahrscheinlichkeit.

**Repair-Rechnung:**

```text
Investition = Kaufpreis + bekannte Versandkosten + Reparaturteile
            + kalkulatorische Arbeit + ggf. Rückversand/Diagnosekosten
Erlös netto = angenommener Verkaufspreis - Verkaufsgebühren - Versand beim Weiterverkauf
Marge im Erfolgsfall = Erlös netto - Investition
Erwartungswert = Erfolgswahrscheinlichkeit * Marge im Erfolgsfall
               + (1 - Erfolgswahrscheinlichkeit) * Verlust im Misserfolgsfall
```

Eine Erfolgswahrscheinlichkeit ist **nur** zu verwenden, wenn Nutzer oder belastbare eigene Daten sie hergeben. Anfangs drei Szenarien: `Worst Case`, `Basis (eigene Annahme)`, `Best Case`, jeweils beschriftet. Keine KI-Diagnose aus Titeltext behaupten.

## 5. API-Evaluation – zuerst überprüfen, dann Geld ausgeben

### 5.1 Prüfmatrix pro Plattform

| Plattform | Zugangskandidaten | Konkrete Tests | Verbindliche Entscheidung |
|---|---|---|---|
| eBay | Offizielle Browse API | OAuth, Deutschland, `newlyListed`, Suche mit `buyingOptions`/Auktionen, `itemOriginDate`, Pagination, Rate-Limits | GO nach erfolgreichen echten Such-/Auktions-Testfällen |
| Kleinanzeigen | Kleinanzeigen Agent; weitere Anbieter nur bei plausibler Dokumentation und Nutzungsrechten | Suche `q`, 100 Ergebnisse, Region, IDs, Frische, Kosten; optional **signierter** Webhook für Schnapper | GO nur bei **technischem Test + rechtlicher/vertraglicher Freigabe** |
| Facebook | Dokumentierte Drittanbieter-API oder Apify-Actor nur nach ausdrücklicher Freigabe; manueller Import als Fallback | DE-Suchtreffer, Item-IDs, Zugänglichkeit, Veröffentlichungszeit, Preis, 72h-Ausfälle, Kosten | Ohne belastbaren Zugang dauerhaft **NO GO für automatische Live-Suche** |

**Aktueller Status (03.11.2026):** eBay live geprobt (12/12 Calls, `GO LIMITED`, siehe ADR 001). Kleinanzeigen und Facebook ohne Nutzungsrechte-Freigabe, keine kostenpflichtigen Probes. Die 72h-Messung läuft erst auf dem Server (P7, `DF-704`). Keine Auskunft über tatsächlich garantierte Aktualität.

### 5.2 Aufruf-Verträge und besondere technische Grenzen

- eBay `GET /buy/browse/v1/item_summary/search`, OAuth Client Credentials; Quellen `itemOriginDate` und Sortierung `newlyListed` verwenden, aber Datenfrische separat messen. Standardresultate beinhalten nicht automatisch reine Auktionen – Auktionsfilter testen.
- Kleinanzeigen Agent dokumentiert `GET /api/v2/kleinanzeigen/search` mit `klaz_key`; `q`, `size`, `location_id`, `distance` und weitere Parameter. **Achtung:** Es sind unterschiedliche Produkte (Live-Suche, Historie, Webhooks) mit verschiedenen Credits und Tarifen. Das vorhandene Adapter-Mapping gegen **echte** Response-JSON validieren, nicht nur gegen eine angenommene Dokumentationsform.
- Kleinanzeigen Agent Webhooks: vor Aktivierung Signatur/HMAC, Timestamp/Replay-Schutz und Delivery-Dedupe implementieren. Auch 60s/30s/10s/3s-Angebote sind **Anbieterangaben**, keine nachgewiesene Gesamtlatenz von Veröffentlichung bis Nutzergerät.
- Apify: jeder Actor besitzt eigenes Input-/Output-Schema. `run-sync-get-dataset-items` ist technisch nutzbar, aber nicht automatisch ein Echtzeit-Feed. Für ausgedehnte oder langsam laufende Tests eher asynchrone Runs und Statusabfragen einsetzen. Harte Kostenlimits, Timeouts und Validierung vorsehen.
- Ein Drittanbieter macht ohne Erlaubnis gewonnene Daten nicht automatisch erlaubter. Niemals Captcha-/Login-Schutz umgehen, private Accounts automatisieren oder Anti-Bot-Mechanismen aushebeln.

### 5.3 Exakter Ablauf des Provider-Benchmarks

**P0.1 – Zugang und Legitimation**

- Öffentliche Dokumentation, zulässige Nutzungsarten, Retention, Weiterverarbeitung und Kündigungs-/Rate-Limits notieren.
- API-Key im Dashboard des jeweiligen Providers erstellen; nur serverseitig als Secret hinterlegen.
- Testbudget pro Provider setzen (z. B. vom Nutzer genehmigter Betrag; **kein automatischer kostenpflichtiger Test**).
- `provider_configs.approval_status` zunächst auf `PENDING`, Live-Scheduler bleibt deaktiviert.

**P0.2 – Smoke-Test je Provider**

- Drei Queries: `RTX 4070 Super`, `RTX 5080`, `Grafikkarte defekt`.
- Region Deutschland und mindestens eine gesonderte Umkreis-/Regionalkonfiguration, soweit der Anbieter dies unterstützt.
- Für jeden Treffer prüfen: `external_id`, `title`, `url`, `price`, `currency`, `published_at`, `image`, `shipping`, `condition`.
- Je Query mindestens zwei Wiederholungen; Duplikate und stabile IDs vergleichen.
- Fehlerpfade absichtlich simulieren: fehlender Token, `401/403`, leeres Ergebnis, `429`, Timeout, unvollständiges JSON, falsch gemappter Zustand.

**P0.3 – 24–72 Stunden Frische und Betrieb** (auf dem Server in P7, `DF-704`)

- Zulässige Query-Frequenz wählen und absolutem Tages-/Monatsbudget unterwerfen.
- `request_started_at`, `response_received_at`, `provider_published_at`, `dealforge_first_seen_at`, `alert_queued_at` und `alert_delivered_at` speichern.
- Mindestens 100 **manuell verifizierbare** gültige Treffer über die gesamten Tests anstreben; bei weniger Daten im Testbericht als „Stichprobe zu klein“ markieren.
- Eine kleine manuelle Referenzstichprobe neuer Anzeigen verwenden, um fehlende Treffer/Entdeckungslatenz zu beurteilen. Reine Provider-Timestamps beweisen keine vollständige Marktabdeckung.
- Ergebnis als signierten oder zumindest revisionsfähigen internen Benchmark-Bericht abspeichern: `docs/provider-evaluation/<provider>-YYYY-MM-DD.md`.

**P0.4 – Entscheidung mit harten Gates**

| Metrik | Ziel/Interpretation | Wenn verfehlt |
|---|---|---|
| Rechtliche/vertragliche Freigabe | Explizit geklärt | **NO GO**, auch bei sehr guter Technik |
| Treffervalidität | ≥95 % korrekte ID, Titel, URL und numerischer Preis | Schema/Normalisierung nacharbeiten |
| Laufstabilität | ≥95 % erfolgreiche Runs über Beobachtungszeit | Provider nicht für kritische Alerts zulassen |
| Dubletten | Gleiche Quelle/ID deterministisch deduplizierbar | Vor Livebetrieb fixen |
| Fehlende Veröffentlichungszeit | Quantifizieren und in UI darstellen | Keine behauptete Publikationslatenz |
| Schnapper-Latenz | Zielwert p95 ≤60 s **nur bei dafür geeignetem Provider und realem Ground Truth** | Als Standardquelle statt Realtime einstufen |
| Standard-Latenz | Zielwert p95 ≤5 min, abhängig von API und Kosten | Warnung/geringere Priorität |
| Preis/Kosten | Preis je 1.000 **brauchbare einmalige** Treffer und pro aktivem Suchfilter | Alternative / Limit / NO GO |
| Budget | Hartes Ausgabenlimit greift vor Überschreitung | Provider deaktiviert lassen |

**Ergebnisartefakte:** Provider-Scorecard (GO / GO LIMITED / NO GO), Probe-Log ohne Secrets, Test-JSON (personenbezogen bereinigt), Kostenprognose und Freigabeentscheidung.

### 5.4 Kleinanzeigen-Kostenbeispiel – nur als Planungsrechnung

Laut am 31.10.2026 abgerufener Anbieter-Dokumentation sind Webhooks nach Filter und Intervall bepreist: **60 Sekunden = 39 € netto/Monat**, **30 Sekunden = 79 €**, **10 Sekunden = 229 €**, **3 Sekunden = 749 €** – jeweils als Anbieterangabe, nicht als Empfehlung oder Garantie. Bei 5 unabhängig abgerechneten 60-s-Filtern wären das beispielsweise **195 € netto/Monat**. Vor Vertragsabschluss Preis aktuell prüfen und prüfen, ob breite Such-Buckets mehrere GPU-Profile innerhalb **eines** bezahlten Filters abdecken können. Die API-Suche hat eine separate Credit-Abrechnung. Bei vielen Queries kann regelmäßiges Polling teuer werden.

### 5.5 Facebook-Entscheidungsbaum

```text
Bietet ein Anbieter eine dokumentierte, erlaubte Marketplace-Suche für DE?
├─ Nein -> Nur manueller Import / vom Nutzer bereitgestellte zulässige Daten.
└─ Ja  -> Trial-Key und Nutzungsrechte prüfen.
          ├─ Keine Freigabe -> Live-Integration deaktivieren.
          └─ Freigabe -> 72h Probe + Schema-/Kosten-/Latenztests.
                         ├─ Test bestanden -> Adapter per Feature-Flag aktivieren.
                         └─ Test nicht bestanden -> Import-Fallback behalten.
```

## 6. Zielarchitektur und Repository-Struktur

### 6.1 Architektur – nach P2

```text
Browser / installierbare PWA
   ├── Dashboard, Watchlists, Deal-Feed, Repair Lab
   └── Service Worker (Web Push)
        │ HTTPS / Same-Origin / Auth
        ▼
Fastify API  ─────────────── PostgreSQL
   │                            │
   ├── REST / SSE                ├── Listen / Historie / Matches
   ├── Webhook Receiver          └── Alerts / Nutzerstatus
   └── Admin / Provider Status
         │
         ▼
Redis + BullMQ ───────────── Worker-Prozess
                             ├── Query Planner / Budgets
                             ├── Provider Adapters
                             ├── Normalisierung + Dedupe
                             ├── Modell-/Zustandsmatching
                             ├── Deal / Freshness / Repair Scores
                             └── Alert Dispatch / Push
```

### 6.2 Vorgeschlagene Verzeichnisstruktur

```text
dealforge/
  apps/
    web/                # React/Vite/PWA, Ansichten und UI
    api/                # Fastify, Auth, REST, Webhooks, SSE
    worker/             # BullMQ Worker und Scheduler
  packages/
    domain/             # Modell-/Defekterkennung, Scores, pure Funktionen
    providers/          # ProviderInterface, ebay, kleinanzeigen, facebook-import
    db/                 # Schema, Migrationen, Repository-Queries
    contracts/          # Zod Request/Response-Schemas, OpenAPI
    config/             # Environment-Validierung, Feature-Flags
  scripts/
    probes/             # Live-Probe explizit, Berichte
    migrate/            # SQLite -> PostgreSQL, Validierung
  docs/
    architecture/
    provider-evaluation/
    decisions/          # ADRs: technische Entscheidungen
    operations/         # Deployment/Restore/Incidents
  .github/workflows/    # CI und kontrollierter Deploy
  infra/                # Docker Compose, Reverse Proxy, Backup
```

**Migration ohne Big Bang:** Zuerst Fehler im vorhandenen Prototyp korrigieren und Provider evaluieren. Danach Domain-/Provider-Code schrittweise nach `packages/` ausgliedern und **erst dann** Web/API/Worker trennen. Der laufende MVP bleibt während P1 testbar.

### 6.3 Provider-Adapter-Vertrag

```ts
interface ProviderAdapter {
  readonly id: string;
  readonly capabilities: {
    search: boolean;
    auctions: boolean;
    webhooks: boolean;
    regions: boolean;
    publishedAt: boolean;
  };
  validateConfig(): Promise<{ ok: boolean; reason?: string }>;
  search(request: {
    query: string;
    region?: string;
    pageToken?: string;
    limit: number;
  }): Promise<{
    listings: NormalizedListing[];
    nextPageToken?: string;
    requestCost?: number;
    fetchedAt: string;
  }>;
}
```

Jede Quelle erhält **einen Adapter**, explizite Feature-Flags und eine klare Fehlerklasse (`AUTH`, `RATE_LIMIT`, `QUOTA`, `SCHEMA_CHANGE`, `NETWORK`, `TERMS_NOT_APPROVED`). Bei Fehlfunktion darf kein „Fallback-Scraping“ automatisch starten.

## 7. API-Vertrag (konkret implementierbare Endpunkte)

Alle Endpunkte außer Health/Auth nur authentifiziert. Zod-Validierung, konsistente Fehlerantwort `{ code, message, requestId }`. Preisfelder in Cent oder als valide EUR-Decimal festlegen; **nicht** Float-Vergleiche für Geld verwenden.

| Methode | Pfad | Zweck | Erfolg | Fehlerfälle |
|---|---|---|---|---|
| `GET` | `/api/v1/health/live` | Prozess erreichbar | `200` | `500` |
| `GET` | `/api/v1/health/ready` | DB/Queue/Worker erreichbar | `200` | `503` |
| `GET` | `/api/v1/watchlists` | Eigene Listen | `200` | `401` |
| `POST` | `/api/v1/watchlists` | Liste erstellen | `201` mit ID | `400`,`401` |
| `PATCH` | `/api/v1/watchlists/:id` | Regeln, Quellen, Aktivierung | `200` | `400`,`404` |
| `DELETE` | `/api/v1/watchlists/:id` | Liste deaktivieren/löschen | `204` | `404` |
| `GET` | `/api/v1/listings` | Paginiertes Feed; Cursor + Filter | `200` | `400` |
| `GET` | `/api/v1/listings/:id` | Inserat/Scoring/Verlauf | `200` | `404` |
| `PATCH` | `/api/v1/listings/:id/user-state` | `saved`, `dismissed`, `contacted`, `purchased` | `200` | `400`,`404` |
| `POST` | `/api/v1/listings/:id/feedback` | Fehltreffer/Qualitätsfeedback | `201` | `400` |
| `GET` | `/api/v1/alerts` | Ausgelöste Alerts, Status | `200` | `401` |
| `POST` | `/api/v1/push-subscriptions` | Browser Push-Abo | `201` | `400` |
| `DELETE` | `/api/v1/push-subscriptions/:id` | Abo entfernen | `204` | `404` |
| `GET` | `/api/v1/providers/status` | Betriebsstatus/Quoten | `200` | `401` |
| `POST` | `/api/v1/admin/scans` | Manuelle Abfrage mit Limit | `202` Job-ID | `409`,`429` |
| `POST` | `/api/v1/webhooks/:provider` | Signierter Provider-Webhook | `202` | `401`,`409` |
| `GET` | `/api/v1/events` | SSE für neue Treffer/Alerts | Stream | `401` |
| `POST` | `/api/v1/import/facebook` | Zulässige Nutzer-Importdaten | `202` | `400` |
| `GET` | `/api/v1/market/:modelKey` | Preisverteilung nur mit Statistikbasis | `200` | `404` |

**Beispiel `POST /api/v1/watchlists`:**

```json
{
  "name": "RTX 4070 Super Repair",
  "modelKey": "nvidia-rtx-4070-super-12gb",
  "sources": ["ebay", "kleinanzeigen"],
  "healthTargets": ["DEFECT", "UNKNOWN"],
  "maxWorkingEur": 450,
  "maxDefectEur": 125,
  "repairBudgetEur": 60,
  "minPriceDiscountPct": 12,
  "alerts": { "schnapper": true, "deal": true, "repair": true }
}
```

Der Server weist eine explizit nicht freigegebene Quelle mit einem verständlichen Hinweis zurück oder speichert sie als **deaktiviert**, ruft sie aber keinesfalls automatisch ab.

## 8. Arbeitspakete und Umsetzung in Abhängigkeiten

### Phase P0 – Anbieter, Freigabe, belastbare Anforderungen (3–5 Arbeitstage + ggf. 72h Benchmark)

**Ziel:** Keine Architektur um eine unbelegte Drittanbieterbehauptung bauen.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-001` | `docs/decisions/001-provider-policy.md` mit GO/NO-GO-Regeln anlegen | Jede Quelle: Zugang, Erlaubnis, Datenschutz, Limit, Alternativen |
| `DF-002` | eBay OAuth-Live-Test in DE mit 3 Queries und Auktionen durchführen | Mindestens je ein gültiger FIXED_PRICE- und AUCTION-Treffer; Original-Link stimmt |
| `DF-003` | Bestehenden Kleinanzeigen-Agent-Adapter gegen echte Suchdaten prüfen | Response-Schema dokumentiert, Fehlermodi, Kosten und Quoten erfasst |
| `DF-004` | Apify/alternativen Facebook-Provider recherchieren und einen expliziten Trial nur bei Freigabe testen | Actor-ID, Input-/Output-Schema, 72h-Messung oder dokumentiertes NO GO |
| `DF-005` | Benchmark-CLI um CSV/JSONL-Protokoll, p50/p95, Credit-Verbrauch erweitern | Standardisierter Bericht pro Quelle ohne Geheimnisse/Verkäuferdaten |
| `DF-006` | Provider-Status-/Budgettabelle in App anzeigen | Ungetestete Quelle bleibt sichtbar, aber ausgeschaltet |

**Definition of Done P0:** Für jede Quelle existiert ein dokumentierter Status `GO`, `GO LIMITED` oder `NO GO`. eBay mindestens einmal real getestet. Für alle Drittanbieter ist unabhängig davon klar dokumentiert, ob eine Nutzungsfreigabe vorliegt. Es ist **zulässig**, dass Kleinanzeigen/Facebook NO GO bleiben und der MVP nur mit eBay live geht.

### Phase P1 – Korrektheit und vollständige GPU-Domain (5–8 Arbeitstage)

**Ziel:** Bei günstigem oder defektem Angebot zuverlässig das **richtige Modell** erkennen und keine falschen Alerts produzieren.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-101` | `BUG-01`: unbekannte Versandkosten als unsicher behandeln; Einstellungen für Abholung | Null bleibt null, keine unbegründeten All-in-Deal-Alerts |
| `DF-102` | `BUG-02`: `matches` bei Preis-/Titel-/Zustandsänderung transaktional neu bestimmen | Inserat, das nicht mehr passt, verschwindet aus Watchlist-Feed |
| `DF-103` | Profile/Aliase/negative Aliase/VRAM aus `gpu-search` portieren | RTX 3060 8/12 GB, 4070/Super/Ti und 5060 Ti Varianten unterscheidbar |
| `DF-104` | Fünf breite eBay-Such-Buckets inkl. lokaler Profilzuordnung portieren | Weniger API-Calls als naives Profil-pro-Suche-Verfahren; Trefferäquivalenz dokumentiert |
| `DF-105` | eBay-Auktionen explizit suchen; Restzeit, Gebote, FIXED_PRICE/AUCTION unterscheiden | Auction-Only-Listings nicht systematisch übersehen |
| `DF-106` | Defekt-/Zubehör-/Komplett-PC-Signale aus Altprojekt integrieren | Zubehör und ganze PCs ausgeschlossen, sofern Watchlist nur Einzel-GPU will |
| `DF-107` | Score-Erklärungen und mögliche False Positives als Regressionstests aufnehmen | Mindestens 40 sorgfältig kuratierte GPU-Listing-Fixtures |
| `DF-108` | Bestehende Tests in CI, ESLint/Typecheck ergänzen; Secrets-Scan | Grün bei jedem PR; keine Schlüssel im Commit |

**Definition of Done P1:** 40 oder mehr konkrete Titel-/Defekt-Fixtures; keine bekannten Modellvarianten-Fehltreffer in der Testliste. Bei aktualisierten Inseraten entstehen keine veralteten Matches. Bestehende 14 Tests bleiben grün.

> **Randbedingung: Server erst am Ende (P7).** P2–P6 laufen vollständig lokal auf dem Entwicklungsrechner, nicht 24/7 und ohne öffentliche HTTPS-URL:
> - Alles muss lokal per `docker compose up` (App, Worker, PostgreSQL, Redis) startbar und per `pnpm test`/CI prüfbar sein; kein Schritt darf einen gehosteten Dienst voraussetzen.
> - Lokale Messungen sind erlaubt, aber als „lokal, nicht durchgehend“ zu kennzeichnen. Dauerläufe, das volle eBay-`GO` und Latenz-SLOs gehören zu P7.
> - Eingehende Provider-Webhooks brauchen eine öffentliche HTTPS-Adresse → bis P7 nur Polling; Webhook-Empfang wird erst gebaut, wenn ein Provider mit Webhooks ein `GO` hat.
> - Web Push wird lokal über `localhost` bei geöffnetem Browser getestet; Zustellung bei geschlossenem Browser und auf Mobilgeräten erst in P7.
> - Deployment-Artefakte (Compose, Reverse Proxy, Backup-Skripte) werden lokal vorbereitet und getestet, sodass P7 nur noch Bereitstellung und Abnahme ist.

### Phase P2 – Plattform-Backend, Datenpipeline und Dauerbetrieb (6–10 Arbeitstage)

**Ziel:** Mehrere Quellen zuverlässig beobachten, ohne Datenverlust und ohne Kostenexplosion.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-201` | TS-Monorepo mit `apps/api`, `apps/worker`, `apps/web`, `packages/*` aufbauen | `pnpm test`, `pnpm typecheck`, `pnpm build` funktionieren |
| `DF-202` | Zod-Contracts + Fastify `/api/v1` implementieren und bestehende UI umhängen | OpenAPI-Schema und API-Contract-Tests |
| `DF-203` | PostgreSQL + versionierte Migrationen; einmaliger Import aus SQLite | Watchlists, IDs, Historiensummen stimmen vor/nach Migration |
| `DF-204` | Worker/Scheduler mit BullMQ/Redis, Query-Key, Jobs und Prioritäten | Kein paralleler Doppel-Scan derselben Quelle/Query; Neustart überstanden |
| `DF-205` | Rate-Limit-/Timeout-/Retry mit exponentiellem Backoff und Jitter | `429` erzeugt Wartezeit, keinen hektischen Retry-Sturm |
| `DF-206` | Hard Budget Gate (Tag/Monat/Provider/Suchfilter) | Keine neuen externen Calls nach Budgeterschöpfung |
| `DF-207` | Adapter-Vertrag + schaltbare Feature-Flags + getrennte Probe-Umgebung | Providerfehler blockiert andere Provider nicht |
| `DF-208` | Beobachtungs- und Preis-Historie, `first_seen`/`published`/`fetched` festlegen | Replays erzeugen keine Doppel-Preissnapshots |
| `DF-209` | Monitoring: Queuelänge, letzter erfolgreicher Poll, Fehlerrate, Quota/Tag | Betreiber sieht Ausfall im Systemstatus |

**Definition of Done P2:** Worker-Reboot/Netzwerkfehler getestet; keine doppelten Alerts oder Datenbankfehler in den Integrationstests. Simulierte Quota-Überschreitung stoppt externe Calls zuverlässig. Der 24h-Staging-Dauerlauf mit echten Quellen ist nach P7 verschoben.

### Phase P3 – Schnapper-Engine und mobile Benachrichtigungen (5–7 Arbeitstage)

**Ziel:** Neue passende Angebote möglichst schnell beim Nutzer ankommen lassen.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-301` | Fast- und Standard-Watchlists definieren, Quellenfähigkeit berücksichtigen | Schnelle Quellen werden priorisiert; API-Limits bleiben bindend |
| `DF-302` | Eingehende Webhooks mit HMAC, Timestamp-Toleranz und Replay-Schutz – **erst wenn ein Provider mit Webhooks `GO` hat**, Live-Test in P7 | Ungültige Signatur -> `401`, doppelte Delivery -> kein neuer Treffer |
| `DF-303` | Ereignis `listing.detected` / `listing.changed` intern publizieren | Reproduzierbarer Event-Flow vom Adapter zum Alert |
| `DF-304` | Alert-Engine mit `dedupe_key`, Cooldown, Priorität | Wiederholte Jobs produzieren höchstens einen Erstalert |
| `DF-305` | VAPID/Service Worker + Push-Abo-Verwaltung, Opt-in im Browser | Test-Alert kommt lokal auf `localhost` an; Geräte-Tests in P7 |
| `DF-306` | SSE für Live-Feed, Reconnect, Cursor/Last-Event-ID | Neue Treffer erscheinen ohne manuelles Reload |
| `DF-307` | Zustellungslog: erstellt, versandt, zugestellt sofern belegbar, fehlgeschlagen | Keine falsche „zugestellt“-Anzeige ohne Bestätigung |
| `DF-308` | End-to-End-Latenz erfassen: Anbieter -> Worker -> Alert -> Push | Messpunkte gespeichert, p50/p95 abfragbar; aussagekräftige Werte erst in P7 |

**Definition of Done P3 (lokal):** Ein Test-Push kommt im lokalen Browser bei nicht aktivem Tab an. Wiederholte Jobs/Replays führen weder zu doppeltem Inserat noch zu doppeltem Erstalert. Gemessene Frische ist sichtbar; es wird **kein** 10-Sekunden-Versprechen ohne Provider-Nachweis gemacht. Webhooks, iOS-/PWA- und Geräte-Push werden in P7 abgenommen.

### Phase P4 – Repair Lab mit wirtschaftlicher Bewertung (5–8 Arbeitstage)

**Ziel:** Defektware als eigenständige Suchstrategie ernst nehmen.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-401` | Defektklassifikation: `NO_DISPLAY`, `ARTIFACTS`, `DRIVER_CRASH`, `NO_POWER`, `WATER_DAMAGE`, `BURN_DAMAGE`, `PARTS_MISSING`, `UNKNOWN` | Mehrfachsignale und Unsicherheit sichtbar |
| `DF-402` | Positiv-/Negativsignale, Konflikte, Confidence und Scores portieren/erweitern | „Kein Bild“ ist kein Reparaturversprechen; Wasserschaden wird gewarnt |
| `DF-403` | Reparaturbudget/Reparaturkosten pro Nutzer, Kategorie, Modell | Eingaben editierbar, getrennt von Handelspreis |
| `DF-404` | Szenariorechner: Worst/Base/Best inkl. Arbeit, Gebühren, Versand, Teile | Alle Annahmen und Risiken transparent |
| `DF-405` | Repair-Detailseite und Projektspeicherung | Aus Inserat wird ein persönlicher Reparaturfall |
| `DF-406` | Kaufdatum, Teile, Zeitaufwand, Reparaturergebnis und Verkauf erfassen | Tatsächliche Marge kann später berechnet werden |
| `DF-407` | Lernen aus Feedback erst nach genug eigenem Verlauf, nicht sofort KI-Spekulation | Kategorisierte Fehler-/Erfolgsstatistik mit Stichprobengröße |

**Definition of Done P4:** Reparaturkandidaten bleiben trotz Defektauffälligkeiten durchsuchbar. Nutzer kann ein echtes Reparaturprojekt samt Kosten dokumentieren. UI zeigt Profit nur als Szenario; keine erfundene Erfolgswahrscheinlichkeit.

### Phase P5 – Marktwert, Preisentwicklung, intelligente Priorisierung (5–8 Arbeitstage)

**Ziel:** Eigene Kaufgrenzen durch nachvollziehbare Marktbeobachtungen ergänzen.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-501` | Preisbeobachtungen je exakt erkanntem Modell + VRAM + Zustand + Quellentyp speichern | Vergleich RTX 3060 8GB vs. 12GB ist getrennt |
| `DF-502` | Robuste Median-/Quantilberechnung (z. B. P25/P50/P75), Ausreißerfilter | Keine einzelne 1-€-Fehlanzeige dominiert Marktwert |
| `DF-503` | Nicht verfügbare/schlecht vergleichbare Inserate kennzeichnen | Keine Behauptung „realer Verkaufspreis“ aus Angebotspreisen |
| `DF-504` | Mindeststichprobe (anfangs konfiguriert z. B. ≥20 gültige Beobachtungen) | Bei zu wenig Daten „keine verlässliche Schätzung“ |
| `DF-505` | Modellansicht mit Verlauf, Preisänderungen, Zustand und Quellenfilter | Datenbasis und Zeitfenster für jede Grafik ersichtlich |
| `DF-506` | Personalisiertes Feedback: Fehltreffer, Favoriten, Käufe, tatsächlicher Gewinn | Anpassbare Ranking-Gewichte ohne Black Box |

**Definition of Done P5:** Jeder angezeigte Marktwert benennt Datenfenster, Samplegröße und Berechnung. Angebotspreise werden nicht als tatsächlich erzielte Verkaufspreise ausgegeben.

### Phase P6 – Härtung und Betriebsvorbereitung, lokal (4–6 Arbeitstage)

**Ziel:** Alles, was der spätere Dauerbetrieb braucht, lokal fertig und getestet – ohne Server.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-601` | Login/Session gehärtet; optional OIDC/Passkey statt eigener Passwort-Logik | Keine offene API; Session-/CSRF-/Origin-Tests bestanden |
| `DF-602` | Reverse-Proxy-Konfiguration (z. B. Caddy) im Compose-Profil, Security Headers, sichere Cookies, CORS | Lokal mit selbstsigniertem/internem Zertifikat geprüft; Browser-Konsole ohne Mixed Content |
| `DF-603` | Verschlüsselte Secrets/Provider-Keys, Rotation, Redaction, Audit-Logs | Kein Key in Frontend/Logs/Git |
| `DF-604` | Backup-/Restore-Skripte (täglich, 7/30 Tage Retention) | Restore in leeres lokales Compose-Projekt erfolgreich, dokumentiert |
| `DF-605` | CI/CD: Tests, Build, Migration Dry Run, Image-Build; Deploy-Job vorbereitet, noch inaktiv | Fehlgeschlagener Build stoppt Release |
| `DF-606` | Alert-SLA/Monitoring, Provider-Störung sichtbar; Alarm bei Ausfällen | Quelle mit 24h Fehlerstatus fällt in Dashboard auf (per Test mit simulierten Läufen) |
| `DF-607` | DSGVO-/AGB-/Retention-Review, Impressum/Datenschutz je Betriebsform | Prüfentscheidung liegt vor P7 vor |

**Definition of Done P6:** `docker compose` mit Proxy-Profil startet lokal eine vollständige Installation; Backup und Restore sind lokal erprobt; die Release-Checkliste ist bis auf die Server-Punkte abgehakt.

### Phase P7 – Server-Inbetriebnahme und Live-Abnahme (3–5 Arbeitstage + 72h Messung)

**Ziel:** Erst jetzt wird auf einem Server ausgeführt und getestet. Voraussetzung: P6 abgeschlossen, Server/VPS verfügbar.

| Ticket | Konkrete Aufgabe | Ergebnis/Abnahme |
|---|---|---|
| `DF-701` | VPS bereitstellen, Domain, Compose-Stack mit Proxy deployen, TLS aktiv | `GET /api/v1/health/ready` über HTTPS grün |
| `DF-702` | Backups auf dem Host aktivieren, Restore-Test auf leerem Staging | Wiederherstellung dokumentiert, RPO/RTO festgelegt |
| `DF-703` | 24h+ Dauerlauf mit eBay (ehemals P2-DoD) | Keine doppelten Alerts/DB-Fehler, Budget hält |
| `DF-704` | eBay-Frische-Benchmark 24–72h mit manueller Referenzstichprobe | Bericht `docs/provider-evaluation/ebay-<datum>.md`; Entscheidung `GO` oder bleibt `GO LIMITED` |
| `DF-705` | Web Push auf echten Geräten (Android, Desktop, iOS-PWA) bei geschlossenem Browser | Test-Push kommt an; Abmelden stoppt weitere Pushs |
| `DF-706` | Webhook-Empfang live testen – nur falls ein Provider mit Webhooks `GO` hat | HMAC/Replay-Tests gegen echte Deliveries bestanden |
| `DF-707` | End-to-End-Latenz und SLOs aus Abschnitt 11.2 messen | p50/p95 je Quelle dokumentiert |
| `DF-708` | Mobile Beta mit echter Benutzung, mindestens 20 qualitative Fund-Feedbacks | Dokumentierte Fehltreffer und Korrekturen |

**Definition of Done P7:** Live-Installation mit HTTPS, funktionierenden Backups/Restore, Alerts, Push und transparentem Providerstatus. Für nicht freigegebene Quellen bleibt die Live-Abfrage deaktiviert.

## 9. Umsetzungstaktik – konkrete Reihenfolge und Abhängigkeiten

### 9.1 Empfohlener kritischer Pfad

```text
DF-001 Provider Policy
   ├─> DF-002 eBay Live Proof ─> DF-104 Query Planner ─> DF-105 Auctions
   ├─> DF-003 Kleinanzeigen Pilot (ggf. NO GO)
   └─> DF-004 Facebook Pilot (ggf. NO GO)

DF-101/102 Korrektheitsfixes ─> DF-103 Modellmatching ─> DF-107 Regressionen
                                                │
                                                ▼
DF-201/202 API/TS ─> DF-203 DB-Migration ─> DF-204 Worker
                                                │
                                                ▼
                             DF-303 Events ─> DF-304 Alerts ─> DF-305 Web Push
                                                │
                                                ▼
                                   P4 / P5 / P6 (alles lokal)
                                                │
                                                ▼
                          P7 Server: Deploy ─> Dauerlauf/Benchmark ─> Private Beta

P4 Repair Lab und P5 Marktwert dürfen parallel nach P2 beginnen,
sollten aber die Schnapper-Engine (P3) nicht verzögern. Kein Schritt vor P7 setzt einen Server voraus.
```

### 9.2 Vorgeschlagene Sprints

| Sprint | Umfang | Ergebnis am Sprintende |
|---|---|---|
| **Sprint 0 (Woche 1)** | P0 plus `BUG-01` und `BUG-02` | Go/No-Go der Quellen, korrekte Versand-/Matchlogik |
| **Sprint 1 (Woche 2)** | P1 übrige Tickets | Modell-/VRAM-/Auktionssupport mit Fixtures |
| **Sprint 2–3 (Woche 3–4)** | P2 | Stabiler API-/DB-/Worker-Unterbau mit Messung |
| **Sprint 4 (Woche 5)** | P3 | Live-Schnapper-Feed und Web Push (lokal) |
| **Sprint 5 (Woche 6)** | P4 | Repair Lab mit Szenariorechner |
| **Sprint 6 (Woche 7)** | P5 | Preisverläufe und belastbar bezeichnete Statistik |
| **Sprint 7 (Woche 8)** | P6 | Lokal gehärtete, deploybare Installation |
| **Sprint 8 (Woche 9)** | P7 | Gehostete, abgesicherte Private Beta mit Live-Abnahme |

**Zeitansatz:** ungefähr **8–10 Wochen** für eine erfahrene Person bei fokussierter Entwicklung *und* verfügbaren Zugangsdaten; Realismusreserve einplanen. Die P0-Benchmarkzeit und externe Freigaben können die Dauer verlängern. Einige Pakete dürfen entfallen oder parallelisiert werden, wenn der Nutzer zunächst nur eBay benötigt.

### 9.3 Minimaler schneller Weg zu echtem Nutzen

Wer möglichst schnell reale Schnapper statt einer großen Architektur haben möchte, kann bewusst reduzieren:

1. Live-eBay mit einer sicheren Single-User-App abnehmen (P0).
2. Modellmatching, unbekannte Versandkosten, Preis-/Match-Neuberechnung und Auktionen korrigieren (P1).
3. Stabilen Worker + PostgreSQL nur so weit bauen, wie für 24/7-Betrieb nötig (P2 Kern).
4. Server-Push und Alert-Dedupe aktivieren (P3, lokal).
5. Repair Lab und Charts nur im nötigen Umfang (P4/P5 Kern).
6. **Zum Schluss** Härtung lokal (P6) und Server-Inbetriebnahme (P7).

So wird das wichtigste Alleinstellungsmerkmal – rechtzeitig passende, auch defekte Angebote sehen – nicht von Designpolitur blockiert.

## 10. Testplan mit ausformulierten Fällen

### 10.1 Domain-Fixtures

| Test-ID | Inserat/Regel | Erwartung |
|---|---|---|
| `T-01` | RTX 4070 Super, Preis 330 € + 6,99 €, Budget 450 € | Modell passt, Deal-Bewertung erklärbar |
| `T-02` | RTX 4070 Ti, Watchlist RTX 4070 | Kein Match |
| `T-03` | RTX 3060 8GB, Watchlist RTX 3060 12GB | Kein Match |
| `T-04` | RTX 3080 „nur Lüfter“, 30 € | Als Zubehör ausgeschlossen |
| `T-05` | „Gaming PC mit RTX 4070 Super“, GPU-only Watchlist | Kein GPU-Einzelangebot |
| `T-06` | RTX 3080 „kein Bild, Lüfter drehen, ungeöffnet“ | `DEFECT`, positive Reparatursignale |
| `T-07` | RTX 3080 „Wasserschaden, PCB gebrochen“ | `DEFECT`, hohes Risiko |
| `T-08` | „ungetestet“ ohne Symptome | `UNKNOWN`; nicht als intakt behaupten |
| `T-09` | Preis 300 €, Versand unbekannt, Kaufgrenze 310 € | Kein sicherer All-in-Deal; Unsicherheit sichtbar |
| `T-10` | Erstfund vor 2 Min., Quellzeitstempel fehlt | „erstmals gesehen“, nicht „veröffentlicht“ |
| `T-11` | Derselbe eBay-Artikel bei 3 Scanläufen | Ein Listing, ein Erstalert |
| `T-12` | Bekannter Artikel senkt Preis von 400 auf 350 € | Preisverlauf und ggf. genau ein `PRICE_DROP` |
| `T-13` | Ursprüngliche RTX 4070, Titeländerung zu Komplett-PC | Alter Match verschwindet |
| `T-14` | Ein Provider `429`, anderer liefert 20 Treffer | Anderer läuft weiter, fehlerhafte Quelle gebremst |
| `T-15` | Gefälschter Webhook ohne gültige HMAC | `401`, kein Listing angelegt |
| `T-16` | Dieselbe Webhook-Delivery wiederholt | Kein doppelter Alert |
| `T-17` | API-Budget vor Request erschöpft | Null neue Requests, Warnung im UI |
| `T-18` | Defektes Gerät bei positiver Marge im Best Case, negativ im Worst Case | Beide Szenarien sichtbar, keine sichere Gewinnzusage |
| `T-19` | Facebook-Import mit fremder Domain oder ungültigem Preis | Datensatz abgelehnt |
| `T-20` | Nutzer löscht Watchlist | Keine künftigen Alerts daraus; Listings/Historie gemäß Retention erhalten |

### 10.2 Integrations- und Betriebsprüfungen

- **Provider-Contract-Test:** Jedes echte/gespeicherte Provider-JSON wird zu einem typisierten `NormalizedListing` normalisiert oder dokumentiert verworfen.
- **Replay-Test:** Identische Fixture-Batches fünfmal ingestieren -> ein Listing, ein Preisbeobachtungs-Eintrag für unveränderten Preis, ein Erstalert.
- **Restart-Test:** Worker während laufender Queue beenden und neustarten -> keine verlorenen Jobs/Double Sends.
- **Migrations-Test:** SQLite-Export in Postgres -> Zeilenanzahlen + ausgewählte Hashes/Vergleichswerte stimmen.
- **Push-Test:** Opt-in, Browser geschlossen/Tab inaktiv, Service Worker aktiv; danach Abo abmelden -> keine weiteren Pushs.
- **Security-Test:** nicht autorisierte API-Requests, manipulierte Sessions, CSRF, übergroße Payloads, URL-Missbrauch, Secrets in Fehlerlogs.
- **Last-Test:** z. B. 100 gespeicherte Watchlists, 100.000 historische Listings als *synthetischer* Datensatz; Feed-Cursor und Worker-Queue bleiben nutzbar.
- **Restore-Test:** Datenbank aus letztem Backup auf leeres Staging wiederherstellen und Health/Watchlists/Preisverlauf prüfen.

## 11. Betrieb, Kosten und SLOs

### 11.1 Kennzahlen im eigenen System

- `provider_request_duration_ms` – HTTP-Laufzeit je Quelle (p50/p95).
- `provider_run_success_ratio` – Anteil erfolgreich abgeschlossener Provider-Abfragen.
- `provider_429_total`, `provider_quota_blocked_total` – Drosselung/Budgetstopps.
- `listing_ingest_lag_ms` – **nur** bei verlässlichem `published_at` relative Entdeckungsverzögerung.
- `listing_new_count`, `listing_update_count`, `listing_reject_count` – Datenqualität.
- `alert_queue_lag_ms`, `alert_dispatch_failure_total` – Zeit und Zuverlässigkeit nach Erkennung.
- `false_positive_feedback_ratio` – manuell markierte Fehltreffer; keine unkritische Qualitätsbehauptung.
- `provider_cost_eur_per_1000_unique_usable_listings` – reale Wirtschaftlichkeit der Quelle.

### 11.2 Betriebliches Zielniveau (Vorschlag)

| Kennzahl | Startziel | Bedeutung |
|---|---|---|
| Eigene Ingest- und Ranking-Verarbeitung | p95 ≤5 s nach Provider-Eingang | Beeinflussbar; synthetisch/real messbar |
| Web-Push-Aufgabe in Queue | p95 ≤10 s bis Übergabe an Push-Dienst | **Keine Garantie** für Gerätedarstellung |
| Provider-Störung sichtbar | ≤5 min nach wiederholten Fehlern | Dashboard zeigt Problem |
| Tages-/Monatsbudget | 100 % harte Sperre vor weiterem Kostenanfall | Keine unkontrollierten API-Ausgaben |
| Web/API Verfügbarkeit | zunächst 99 % monatlich als internes Ziel | Abhängig vom Hosting |
| Datenverlust nach Recovery | durch Backup-Intervall begrenzt | RPO/RTO erst nach Restore-Test festlegen |

### 11.3 Kostenkategorien

1. Server/Container/Datenträger, Backups, Domain/HTTPS.
2. Datenbank, Redis, Monitoring, E-Mail optional.
3. Provider-Credits **und** möglicherweise separate Webhook-Abos pro Filter.
4. Unregelmäßige Mehrkosten durch Testläufe, Pagination, Fehlläufe.

**Kein pauschales monatliches Gesamtbudget versprechen.** Vor Freigabe wird pro Quelle die Anzahl Such-Buckets × Abfragehäufigkeit × Kosten pro Call/Filter gerechnet. Der „Cost Guard“ muss im Backend vor jedem kostenpflichtigen Request liegen.

## 12. Deployment- und Sicherheitskonzept

### Persönliche Testinstanz

- Demo-Modus aktiv, Scheduler aus, nur `127.0.0.1`.
- `APP_PASSWORD`, `SESSION_SECRET`, `APP_ORIGIN` bei abweichendem Betrieb setzen.
- Lokale SQLite-Datei und Testdaten nicht als produktive historische Marktstatistik behandeln.

### Gehostete private Instanz

- Domain + Reverse Proxy mit HTTPS, private Anmeldung; API über gleiche Origin.
- API und Worker als getrennte dauerhaft laufende Container; Datenbank mit Backups.
- Secret-Dateien/Umgebungsvariablen; `*.env` außerhalb Git; sensible Logs redigieren.
- Wartungs-/Migrationsfenster und Rollback-Plan.
- Webhooks nur HTTPS, HMAC/Replay-Prüfung und Rate-Limits.
- Externe Quellen ausschließlich über aktivierte, zugelassene Adapter.
- Images und URLs nicht ungeprüft serverseitig herunterladen (SSRF-/Dateirisiken vermeiden).
- Kein öffentliches Teilen/Redistribution privater Anzeigeninhalte ohne geklärte Berechtigung.

### Mindest-Release-Checkliste

- [ ] `npm/pnpm test`, Typecheck und Build erfolgreich.
- [ ] Kein Secret im Commit, Browser-Bundle oder Log.
- [ ] Quellstatus/ToS-Entscheidung dokumentiert.
- [ ] Migrationen/Backup mit Restore getestet.
- [ ] `GET /health/ready` grün; Quellenstatus korrekt.
- [ ] Mindestens ein echter eBay-Live-Durchlauf validiert.
- [ ] Dedupe-, Preisänderungs- und Webhook-Replay-Test bestanden.
- [ ] Warnung bei unbekannten Kosten und unbestätigter Reparierbarkeit korrekt.
- [ ] Push nur nach Nutzerfreigabe.
- [ ] Dokumentierter Rollback auf vorheriges Release möglich.

## 13. Definition eines erfolgreichen MVP und einer erfolgreichen Beta

### MVP „für tägliche private Nutzung“

- Nutzer kann mindestens eine Watchlist anlegen und auf eine freigegebene Quelle anwenden.
- Ein echtes eBay-GPU-Angebot wird erfasst, dedupliziert, korrekt bewertet und verlinkt.
- Schnapper-, Deal- und Repair-Tags sind einzeln erklärbar.
- Unbekannte Versandkosten und unzuverlässige Zeitstempel werden offen angezeigt.
- Ein Defektangebot wird als Repair-Fall behandelt; Risiken sind sichtbar.
- Quellen-/Scannerfehler sind erkennbar, nicht stillschweigend verborgen.
- Die App benötigt **keinen** Discord-Account und sendet **keine** Discord-Nachrichten.

### Private Beta „für 24/7-Betrieb“

- Über mehrere Tage läuft ein abgesicherter Worker mit aktivem Budgetlimit.
- Die Alert-Pipeline ist idempotent und liefert Test-Web-Push.
- Live-Quellen haben jeweils dokumentierte GO-Freigaben; gesperrte Quellen bleiben aus.
- DB-Backups und ein Restore wurden erfolgreich getestet.
- Mehrfach ausgeführte Jobs verursachen weder Dubletten noch unkontrollierte Kosten.
- Frische und Trefferqualität werden per Dashboard/Report messbar gemacht.

## 14. Erste 10 GitHub-Issues zum sofortigen Anlegen

Diese Prioritäten sollten **vor** dem Ausbauen des Designsystems umgesetzt werden:

| Reihenfolge | Issue | Priorität | Aufwand grob |
|---|---|---|---|
| 1 | `DF-001` Provider-Freigabe/GO-NO-GO dokumentieren | Blocker | 0,5–1 d |
| 2 | `DF-101` Unbekannte Versandkosten korrekt behandeln | Blocker | 0,5–1 d |
| 3 | `DF-102` Stale Matches bei Listing-Updates löschen | Blocker | 0,5–1 d |
| 4 | `DF-002` eBay OAuth + reale Sofortkauf-/Auktions-Probe | Blocker | 1 d |
| 5 | `DF-003` Kleinanzeigen-Agent-Live-Schema und Nutzungsrechte prüfen | Blocker für diese Quelle | 1–2 d + Wartezeit |
| 6 | `DF-103` GPU-Profile/VRAM/Alias-Matching portieren | Hoch | 1–2 d |
| 7 | `DF-104` eBay Bucket Planner portieren | Hoch | 1–2 d |
| 8 | `DF-105` Auction-Only-Suche und Endzeit ergänzen | Hoch | 1 d |
| 9 | `DF-005` Provider-Probe-Berichte und Quota-Kontrolle | Hoch | 1–2 d |
| 10 | `DF-107` ≥40 Regression-Fixtures inkl. Repair/False Positives | Hoch | 1–2 d |

**Issue-Vorlage für jedes Ticket:**

```md
## Ziel
Ein Satz: Welches Nutzer-/Betriebsproblem wird behoben?

## Scope
- [ ] Konkrete Codeänderung
- [ ] Test/Fixture
- [ ] Dokumentation/Monitoring

## Akzeptanzkriterien
- Gegeben ... Wenn ... Dann ...
- Kein unerwarteter API-Aufruf / keine doppelten Alerts
- Der relevante Test läuft in CI

## Abhängigkeiten
DF-... oder keine

## Nicht Teil dieses Tickets
...
```

## 15. Nächste konkrete Entwicklerbefehle

Lokal (bis einschließlich P6 genügt das):

```bash
docker compose up -d postgres redis
pnpm install
pnpm lint && pnpm typecheck && pnpm build && pnpm test
docker compose up --build -d
# http://127.0.0.1:3000
```

**Echte API-Probes nur nach Key-, Kosten- und Nutzungsfreigabe**, niemals automatisiert als Teil der normalen CI:

```bash
# Prüft nur, ob Probe-Skript verfügbar ist – kein API-Aufruf.
pnpm probe kleinanzeigen
pnpm probe facebook

# Erst nach expliziter Freigabe:
KLAZ_API_KEY='...' PROBE_QUERY='RTX 4070 Super' pnpm probe kleinanzeigen --live
```

Im neuen Repo zuerst `docs/decisions/001-provider-policy.md`, die ersten 10 Issues und CI anlegen. Den alten Discord-Bot unverändert belassen; später kann er archiviert werden, sobald DealForge die zentralen Suchfunktionen tatsächlich abgelöst hat.

---

## Quellen und Prüfstatus (Stand 31.10.2026)

**Quellcode:**
- [`illuuuuusion/gpu-search`](https://github.com/illuuuuusion/gpu-search), besonders README und `src/domains/gpu/`.
- Bereitgestellter DealForge-Prototyp `dealforge-mvp.zip` (Dateien in Abschnitt 1 geprüft, lokale Tests ausgeführt).

**Öffentliche technische und vertragliche Dokumentation:**
- [eBay Browse API](https://developer.ebay.com/develop/api/buy) – OAuth, Suche, Sortierung, Auktionsfilter.
- [eBay Browse Release Notes](https://www.developer.ebay.com/develop/api/browse-api/release-notes) – `itemOriginDate`.
- [Kleinanzeigen Agent API-Dokumentation](https://kleinanzeigen-agent.de/dokumentation) – Suchparameter, Credit-Abrechnung, Webhook-Intervalle und Signaturheader.
- [Kleinanzeigen Nutzungsbedingungen](https://themen.kleinanzeigen.de/nutzungsbedingungen/) – Zustimmung zu Crawlern/Scrapern.
- [Apify Actor API](https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-post) – technische Actor-Aufrufe, keine pauschale Freigabe für Marketplace-Daten.

**Explizit nicht geprüft:** echte Produktions-API-Keys, Drittanbieter-Verträge, durchlaufende 72h-Benchmarks, reale Benachrichtigung auf Nutzergerät, rechtliche Einzelfallprüfung. Diese offenen Punkte sind bewusst als Go/No-Go-Gates im Plan enthalten.
