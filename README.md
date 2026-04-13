# 🐜 CicloAnts — Navigazione Ciclistica a Feromoni

> **Idea originale:** Riprodurre il meccanismo dell'intelligenza collettiva delle formiche (Ant Colony Optimization) applicato alla navigazione urbana per ciclisti. I percorsi migliori non sono i più corti — sono quelli dove i ciclisti hanno scoperto qualcosa di speciale: rampe abusive, scorciatoie sicure, marciapiedi tranquilli. La saggezza emerge dal basso.

🟢 **Live demo:** [barfly83.github.io/cicloants](https://barfly83.github.io/cicloants/)

---

## Struttura del progetto

```
app bici/
├── index.html      # Struttura HTML completa
├── style.css       # Design system light — alta leggibilità in bici
├── app.js          # Logica ACO: 7 classi, ~1650 righe
└── README.md       # Questo file
```

---

## Algoritmo — Come funziona

### Ispirazione biologica
Le formiche (Dorigo, 1992) trovano il percorso ottimale senza un coordinatore centrale:
1. Esplorano casualmente
2. Lasciano feromoni sulla traiettoria
3. Le traiettorie con più feromoni attraggono più formiche
4. Il percorso ottimale emerge per rinforzo positivo

### Adattamento per i ciclisti
| Elemento biologico | Elemento digitale |
|---|---|
| Formica | Ciclista (reale o simulato) |
| Feromone chimico | Punto GPS con intensità |
| Evaporazione | Decay esponenziale (ρ = 2%/ora) |
| Biforcazione del percorso | Scelta tra 3 alternative OSRM |
| Traiettoria d'élite | Heatmap rosso/arancio |

### Formula del routing
```
score = (1 − α) × score_distanza + α × score_feromoni
```
- `α = 0` → percorso più corto (ignora storia collettiva)
- `α = 1` → massima fiducia nella saggezza collettiva

---

## Architettura del codice

### `PheromoneEngine`
- Deposita feromoni lungo array di punti `{lat, lng}`
- Fonde punti vicini (`< 33m`) per complessità lineare
- Evaporazione: `τ(t) = τ(t-1) × (1 − ρ)^Δhours`
- Persistenza locale in `localStorage` (cap 3000 punti)
- **Sincronizzazione globale via Supabase** (vedi backend)
- Calcola densità locale per scoring percorsi

### `RoutingEngine`
- Chiama **OSRM** (`router.project-osrm.org`) profilo `bike`
- Geometria GeoJSON, fino a 3 alternative
- Geocodifica indirizzi via **Nominatim** (senza restrizioni geografiche)
- `rankRoutes(routes, alpha)` → ordinamento pesato

### `MapManager`
- **Leaflet 1.9.4** + tile **CartoDB Positron** (tema chiaro, leggibile alla luce solare)
- **Leaflet.heat** per heatmap feromoni in tempo reale
- Animazione formiche lungo il percorso (`requestAnimationFrame`)
- Gestione marker A/B, track GPS, cerchio accuratezza GPS
- Navigazione turn-by-turn con pannello istruzioni

### `SimulationEngine`
- Genera `N` coppie casuali tra i 18 landmark di Roma
- Chiama OSRM per ciascuna con delay `600ms`
- Deposita feromoni e anima la formica sulla mappa

### `TrackingEngine`
- `navigator.geolocation.watchPosition` (alta precisione)
- WakeLock per impedire standby dello schermo durante la pedalata
- Al stop: assottiglia punti (1/3) e deposita feromoni

### `SupabaseSync`
- Sincronizzazione real-time dei feromoni tra tutti gli utenti connessi
- Deposit push: i nuovi feromoni vengono inviati al backend condiviso
- Pull on start: carica i feromoni globali al primo avvio
- Subscription live: aggiornamenti in tempo reale via WebSocket

### `UIController`
- Autocomplete Nominatim con debounce 420ms (geocodifica globale)
- Slider α con badge in tempo reale
- Click mappa per impostare A→B in sequenza
- Toast notifications non bloccanti
- Mobile-ready con sidebar a drawer
- Navigazione turn-by-turn con frecce direzionali e progress bar

---

## Dipendenze esterne (CDN, no install)

| Libreria | Versione | Uso |
|---|---|---|
| Leaflet.js | 1.9.4 | Mappa interattiva |
| Leaflet.heat | 0.2.0 | Heatmap feromoni |
| Supabase JS | 2.x | Backend condiviso real-time |
| Google Fonts | Space Grotesk | Typography |
| OSRM Public API | — | Routing bici |
| Nominatim OSM | — | Geocodifica |

---

## Come avviare (sviluppo locale)

```bash
# Dalla cartella del progetto:
python3 -m http.server 8765
# → apri http://localhost:8765
```

Oppure apri direttamente `index.html` in Chromium.

---

## Funzionalità implementate

### v1 — Base
- [x] Heatmap feromoni con gradiente blu→verde→arancio→rosso
- [x] Simulazione 20 formiche su Roma (landmark reali)
- [x] Animazione formica animata sul percorso
- [x] Routing A→B con OSRM profilo bike
- [x] Selezione percorso pesata feromoni (slider α)
- [x] Visualizzazione 3 percorsi alternativi (sfumati)
- [x] Route cards con punteggio, distanza, tempo, % feromoni
- [x] Autocomplete Nominatim per indirizzi
- [x] Click su mappa per impostare A/B
- [x] Tracking GPS real-time con traccia arancione
- [x] Evaporazione feromoni (2%/ora) con persistenza localStorage
- [x] Statistiche live (feromoni, formiche, km)
- [x] Toast notifications
- [x] Layout responsive (mobile sidebar drawer)
- [x] Reset completo mappa

### v2 — Backend & Navigazione
- [x] **Backend condiviso Supabase** — feromoni sincronizzati tra tutti gli utenti in real-time
- [x] **Navigazione turn-by-turn** — istruzioni passo-passo con frecce direzionali, ETA, progress bar
- [x] **Pulsante "Localizzami"** — centra la mappa sulla posizione GPS con cerchio di accuratezza
- [x] **Geocodifica globale** — ricerca indirizzi in tutto il mondo (non solo Roma)
- [x] **WakeLock** — schermo sempre acceso durante la registrazione GPS

### v3 — Tema chiaro
- [x] **Tema light** — design chiaro ottimizzato per leggibilità in piena luce solare
- [x] **Tile CartoDB Positron** — mappa chiara al posto del precedente tema scuro
- [x] **Contrasti elevati** — testo inchiostro scuro, accenti blu solido, bottoni vivaci
- [x] **FAB touch-friendly** — pulsanti 52×52px ottimizzati per uso con guanti o in movimento

---

## Idee per versioni future (v4+)

- [ ] **POI segnalazioni**: punta sulla mappa → "rampa abusiva", "marciapiede sicuro", "corsia contromano"
- [ ] **Export GPX** del percorso consigliato
- [ ] **Profilo utente**: storico pedalate e feromoni depositati
- [ ] **Modalità offline** con Service Worker e tile caching
- [ ] **Notifica "tratto hot"**: vibrazione quando si avvicina a un nodo ad alto feromone
- [ ] **Heat decay visivo**: feromoni che pulsano in base all'età
- [ ] **Integrazione Strava**: importa tracce storiche per popolare feromoni
- [ ] **PWA**: installabile come app su Android/iPhone

---

## Log delle sessioni di lavoro

### 2026-04-13 — v3: Tema chiaro
**Obiettivo:** Alta leggibilità in bici all'aperto  
**Modifiche:**
- `style.css` — completo redesign light (bianco/grigio, testo inchiostro, accenti blu solido)
- `app.js` — tile CartoDB `dark_all` → `light_all` (Positron); colori percorso adattati

### 2026-04-09 — v2: Backend + GPS + Navigazione
**Obiettivo:** Sincronizzazione multi-utente e navigazione reale  
**Modifiche:**
- `app.js` — `SupabaseSync` per feromoni globali real-time
- `app.js` — navigazione turn-by-turn (`NavigationEngine`)
- `app.js` — pulsante "Localizzami" con cerchio accuratezza GPS
- `app.js` — geocodifica rimossa restrizione geografica Roma

### 2026-04-09 — v1: Sessione inaugurale
**Obiettivo:** Build completo dell'app da zero  
**Output:**
- `index.html` — struttura + CDN
- `style.css` — design system completo
- `app.js` — 7 classi, algoritmo ACO

**Decisioni prese:**
- Stack: HTML + Vanilla CSS + JS vanilla (no framework, massima leggerezza)
- Routing: OSRM pubblico profilo `bike` (gratuito, max 3 alternative)
- Storage: localStorage (MVP senza backend)
- Città demo: Roma (18 landmark)
- Evaporazione: ρ = 0.02/ora (dimezza in ~35 ore, sparisce in ~3 giorni)
- Alpha default: 0.7 (preferisce feromoni ma non ignora la distanza)

**Note tecniche:**
- OSRM restituisce coordinate in formato `[lng, lat]` → inversione manuale
- Fusione punti feromone entro 33m per evitare esplosione array
- Cap localStorage a 3000 punti per evitare quota exceeded
- Animazione formica via `requestAnimationFrame` (nessuna dipendenza esterna)

---

*Aggiornato automaticamente · CicloAnts v3.0*
