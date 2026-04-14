# CicloAnts — Navigazione Ciclistica a Feromoni

## Idea di fondo
Simulare la **stigmergia delle formiche** (Ant Colony Optimization) applicata alla mobilità ciclistica urbana.  
Ogni ciclista che percorre un tratto lascia un "feromone digitale". Le tracce più frequentate diventano più brillanti. Chi naviga vede i percorsi dove si è accumulata saggezza collettiva — non necessariamente la strada più corta, ma quella **realmente ciclabile**: rampe abusive, corsie contromano sicure, scorciatoie sui marciapiedi, strade a bassa velocità.

---

## User Review Required

> [!IMPORTANT]
> Scelta architetturale critica: **app puramente frontend (demo locale)** vs **app con backend** (dati condivisi tra utenti reali)?
> - **Solo frontend**: tutto in localStorage + simulazione, funziona offline, zero infrastruttura, perfetta per demo/MVP
> - **Con backend**: Supabase / Firebase Realtime DB per sincronizzare i feromoni tra utenti reali — richiede account e ~1 ora extra
> 
> **Proposta:** parto con frontend puro con simulazione convincente, e progetto il codice pronto per l'upgrade al backend.

> [!WARNING]
> Per il routing su mappa reale ho bisogno di un'API esterna. Opzioni:
> - **OSRM** (OpenStreetMap Routing Machine) — gratuito, open source, API pubblica
> - **Leaflet Routing Machine** con OSRM — integrazione pronta
> - Routing personalizzato pesato dai feromoni richiede logica custom sopra OSRM

---

## Meccanica dei Feromoni (ACO adattato)

### Deposito
Ogni segmento di percorso riceve feromone proporzionale a:
- `τ_ij += Q / L_k` — dose base inversamente proporzionale alla lunghezza del tratto
- **Bonus qualità**: +50% se il tratto è stato votato "ottimo" dall'utente (modalità freeride)
- **Bonus temporale**: depositi recenti valgono di più (decay esponenziale)

### Evaporazione
`τ_ij(t) = τ_ij(t−1) × (1 − ρ)` con `ρ = 0.02/ora`
→ un percorso non usato per ~3 giorni dimezza il suo valore

### Routing pesato
Il "costo" di un segmento percepito dal navigatore:
```
costo_effettivo = distanza_fisica / (1 + α × τ_ij)
```
Con `α` regolabile: 0 = ignora feromoni, 1 = massima preferenza per i tratti popolari

### Heatmap visiva
I feromoni vengono visualizzati come **heatmap colorata** sovrapposta alla mappa:
- 🔵 Azzurro → pochi passaggi (feromone debole)
- 🟢 Verde → percorso discretamente usato
- 🟠 Arancio → percorso molto popolare
- 🔴 Rosso acceso → **tratto d'élite**, saggezza collettiva massima

---

## Stack Tecnologico

| Layer | Tecnologia | Motivo |
|---|---|---|
| Mappa | **Leaflet.js 1.9** | Open source, leggero, perfetto per cycling |
| Tiles | **OpenStreetMap** (Stadia Maps cycling layer) | Ottimizzato per bici, mostra piste ciclabili |
| Routing | **OSRM** (API pubblica `router.project-osrm.org`) | Gratuito, profilo "bike" disponibile |
| Heatmap | **Leaflet.heat** | Plugin heatmap nativo per Leaflet |
| Storage | **localStorage** + JSON serialization | MVP senza backend |
| UI | HTML + Vanilla CSS + animazioni CSS | Premium design, nessuna dipendenza |

---

## Proposed Changes

### [NEW] App principale

#### [NEW] index.html
Struttura:
- Header con brand "🐜 CicloAnts"
- Pannello laterale sinistro (sidebar): ricerca punti A→B, impostazioni feromoni (slider α), legenda
- Mappa a pieno schermo (Leaflet)
- Floating toolbar: "Inizia a pedalare" (registra traccia), "Simula 50 formiche", "Pulisci feromoni"
- Modal bottom-sheet su mobile: dettagli tratto toccato

#### [NEW] style.css
Design system:
- **Palette**: sfondo `#0a1628` (notte), accent `#00e5ff` (cyan elettrico), pheromone `#ff6b35` → `#ff0055`
- **Font**: Space Grotesk (Google Fonts) — tecnico ma umano
- **Glassmorphism** per sidebar e cards
- Animazioni: feromoni che "pulsano" nei tratti caldi, cursore formica animato
- Layout: Sidebar 380px fisso + mappa fluid, responsive su mobile con bottom drawer

#### [NEW] app.js
Moduli:
1. **MapManager** — inizializzazione Leaflet, tiles, layer gestione
2. **PheromoneEngine** — deposito, evaporazione, serializzazione
3. **RoutingEngine** — chiamate OSRM, decodifica geometrie, applicazione peso feromoni
4. **SimulationEngine** — genera N "formiche virtuali" che camminano tra punti casuali per pre-popolare la mappa (demo wow)
5. **TrackingEngine** — geolocalizzazione GPS, registra traccia utente in tempo reale
6. **UIController** — gestione sidebar, ricerca geocoding (Nominatim), pannello risultati

---

## Flusso Utente

```
[Apri app] → mappa con heatmap feromoni esistenti (simulati)
     ↓
[Cerca A→B] → OSRM calcola varianti di percorso
     ↓
[CicloAnts sceglie] → percorso con massimo feromone accumulato
     ↓
[Pedala] → GPS registra tratta → feromoni depositati al ritorno
     ↓
[Vota il tratto] → bonus feromone (+50%) se eccellente
     ↓
[Tutti vedono] → heatmap aggiornata, percorso migliora nel tempo
```

---

## Features MVP (v1)

- [x] Mappa Leaflet con layer ciclabile Stadia Maps
- [x] Heatmap feromoni con Leaflet.heat
- [x] Simulazione "50 formiche" per pre-popolare la mappa su una città dimostrativa (Roma)
- [x] Routing A→B con OSRM profilo bike
- [x] Selezione percorso pesato dai feromoni (tra 3 alternative)
- [x] Tracciamento GPS real-time con deposito feromoni
- [x] Controllo "intensità feromoni" (slider α)
- [x] Evaporazione automatica feromoni vecchi
- [x] Stato persistente in localStorage
- [x] UX mobile-friendly

## Features v2 (post-MVP)
- [x] Backend Supabase per sync multi-utente reale
- [x] Segnalazione POI (rampe, corsie sicure, marker custom)
- [ ] Export GPX del percorso consigliato
- [ ] Storico personale pedalate

---

## Verification Plan

### Automated
- App si avvia senza errori console
- OSRM API risponde con geometria valida

### Manual (Browser)
1. Aprire app → heatmap visibile sulla mappa
2. Cliccare "Simula 50 formiche" → animazione + addensamento feromoni
3. Cercare "Colosseo → Trastevere" → percorso visualizzato, preferisce tratti caldi
4. Slider α a 0 → percorso cambia (solo distanza, ignora feromoni)
5. "Inizia a pedalare" → punto GPS visualizzato, traccia si disegna
