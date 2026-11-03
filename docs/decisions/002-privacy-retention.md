# ADR 002 – Datenschutz, Aufbewahrung und Pflichtangaben je Betriebsform

**Status:** angenommen · **Datum:** 03.11.2026 · **Ticket:** DF-607

> Technische und organisatorische Prüfentscheidung des Projekts, **keine Rechtsberatung**. Sobald DealForge gewerblich (regelmäßiger An- und Verkauf mit Gewinnabsicht) oder für weitere Personen betrieben wird, sind die markierten Punkte fachlich prüfen zu lassen.

## Kontext

P7 bringt DealForge auf einen Server. Vorher muss feststehen, welche personenbezogenen Daten anfallen, wie lange sie bleiben und welche Pflichtangaben (Impressum, Datenschutzerklärung) je Betriebsform nötig sind. Die Nutzungsbedingungen der Quellen regelt [ADR 001](001-provider-policy.md).

## Datenbestand

DealForge ist eine Single-User-App: ein App-Passwort, keine Benutzerkonten. Die Normalisierung übernimmt von den Quellen **keine** Verkäufernamen, Kontaktdaten, Standorte oder Profil-Links. Bilder werden nicht gespeichert, nur ihre URL.

| Daten | Personenbezug | Zweck | Aufbewahrung |
|---|---|---|---|
| Inserate: Titel, Beschreibung, URL, Bild-URL, Preise, Zeitstempel, Bewertung | Nur zufällig: Freitext kann Namen, Telefonnummern oder Orte enthalten | Feed, Alerts, Marktwerte (Fenster bis 365 Tage) | Bis 400 Tage nach dem letzten Sehen; Ausnahme: gemerkt, kontaktiert, gekauft oder Teil eines Reparaturprojekts |
| Preis-Snapshots, Treffer, Alerts, Fehltreffer-Feedback | Wie das Inserat | Verlauf, Statistik | Werden mit dem Inserat gelöscht |
| Audit-Log: Zeit, Methode, Pfad, Status, IP, User-Agent | Ja (IP-Adresse) | Sicherheit: Anmeldeversuche, Änderungen nachvollziehen | 90 Tage |
| Sessions: Token-Hash, User-Agent | Gering | Anmeldung | Bis Ablauf (7 Tage) oder Abmeldung |
| Push-Abos: Endpoint beim Push-Dienst, Schlüssel, User-Agent | Gering (Gerätekennung beim Push-Dienst) | Web Push | Bis zur Abmeldung oder bis der Push-Dienst das Abo als abgelaufen meldet (404/410) |
| Zustellungslog, Provider-Läufe, Abfragezähler, behobene Störungen | Nein | Betrieb, Budget, Latenz | 90 Tage |
| Suchprofile, Reparaturprojekte, Einstellungen | Eigene Daten des Nutzers | Kernfunktion | Bis der Nutzer sie löscht |
| Backups (vollständige Datenbank) | Wie oben | Wiederherstellung | Täglich 7 Tage, Sonntags-Backup 30 Tage. Gelöschte Daten verschwinden spätestens nach 30 Tagen aus den Backups |

Die Fristen setzt die API stündlich durch (`purgeExpired`, `packages/db/src/ops.ts`), die Backup-Fristen `scripts/backup.sh`. Eine einzelne Löschanfrage zu einem Inserat (z. B. eines Verkäufers) wird mit `DELETE FROM listings WHERE source = … AND external_id = …` erfüllt. Danach ist das Inserat nur noch bis zum Ablauf der Backups vorhanden.

## Entscheidung je Betriebsform

| Betriebsform | DSGVO | Impressum | Datenschutzerklärung | Weiteres |
|---|---|---|---|---|
| **A – lokal**, eigener Rechner, nur der Betreiber | Ausschließlich persönliche Tätigkeit (Art. 2 Abs. 2 lit. c DSGVO) | Nein: kein angebotener digitaler Dienst | Nein | – |
| **B – gehostete private Instanz** (P7), passwortgeschützt, nur der Betreiber | Wie A, solange die Nutzung privat ist | Nein: nicht öffentlich angeboten, Login für alle Inhalte | Nein | Hoster und Push-Dienste sehen technisch IP- und Gerätedaten; Server mit Standort in der EU wählen |
| **B′ – wie B, aber gewerblicher Weiterverkauf** | Gilt ⚠ (zufällige personenbezogene Daten in Inseraten, Audit-IPs); Grundlage: berechtigtes Interesse (Art. 6 Abs. 1 lit. f), Datenminimierung wie oben | Für die App nein (nicht öffentlich); für den Verkauf gelten die Pflichten der Verkaufsplattform | Nein, keine Betroffenen nutzen die App | ⚠ Verzeichnis von Verarbeitungstätigkeiten (Art. 30) und Auftragsverarbeitungsvertrag mit dem Hoster (Art. 28) prüfen |
| **C – Zugang für weitere Personen** (z. B. Beta mit Freunden) | Gilt | ⚠ Ja, sobald geschäftsmäßig angeboten (§ 5 DDG) | Ja (Art. 13 DSGVO): IP/Audit, Sessions, Push, Hoster, Push-Dienste als Empfänger | **Nicht freigegeben.** Erst mit echter Mehrbenutzerfähigkeit (eigene Konten, getrennte Daten), Impressum, Datenschutzerklärung und AV-Vertrag |

**Ergebnis:** P7 (DF-701 bis DF-708) läuft als Betriebsform B. Die mobile Beta (DF-708) bedeutet **Nutzung durch den Betreiber selbst** auf mehreren Geräten. Weitere Personen bekommen keinen Zugang (Betriebsform C ist nicht freigegeben).

## Quellen, Nutzungsbedingungen und Inhalte

- Live nur Quellen mit GO laut ADR 001 (derzeit eBay `GO LIMITED`). Kleinanzeigen und Facebook bleiben ohne Freigabe aus.
- Inserate werden nicht weitergegeben, nicht veröffentlicht und nicht gesammelt exportiert. Links führen zur Quelle.
- ⚠ Offener Prüfpunkt vor dem 24/7-Betrieb (DF-703): Was die eBay API License Agreement und die Developer-Richtlinien über Speicherdauer und Aktualität von eBay-Inhalten sagen, ist für die Marktwert-Historie (bis 365 Tage, Löschung nach 400 Tagen ohne Sichtung) zu prüfen. Bei strengeren Vorgaben wird `RETENTION_DAYS.listings` für eBay verkürzt.
- Bilder lädt der Browser direkt bei der Quelle (`referrerpolicy=no-referrer`). Der Server lädt keine fremden URLs herunter (kein SSRF-Risiko). Push geht nur an bekannte Push-Dienste.

## Konsequenzen

- Retention ist Code und wird getestet (`DF-607`-Test in `packages/db/test/db.test.ts`).
- Wechselt die Betriebsform zu B′ oder C, wird dieses ADR vor dem Wechsel aktualisiert. C setzt zusätzlich Entwicklungsarbeit voraus (Mehrbenutzerbetrieb).
- Secrets und Logs: siehe README „Betrieb“. Provider-Schlüssel stehen nie in der Datenbank und damit nie in Backups. Datenbank-Secrets sind mit `SECRETS_KEY` verschlüsselt.
