/* ================================================================
   CICLOANTS — app.js
   Ant Colony Optimization per navigazione ciclistica urbana
   ================================================================

   Algoritmo ispirato all'ACO (Dorigo, 1992):
   - Ogni ciclista deposita feromoni sul percorso
   - I feromoni evaporano nel tempo (ρ = 0.02/ora)
   - Il router sceglie tra alternative pesando feromoni × distanza
   - La saggezza emerge dal basso: nessun algoritmo centrale

   Architettura:
     PheromoneEngine  — deposito, evaporazione, persistenza
     RoutingEngine    — OSRM bike, geocoding Nominatim
     MapManager       — Leaflet, heatmap, layer gestione
     SimulationEngine — formiche virtuali su Roma
     TrackingEngine   — GPS real-time
     UIController     — input, eventi, notifiche
     CicloAnts        — orchestratore principale
   ================================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────────
   CONFIGURAZIONE
   ──────────────────────────────────────────────────────────────── */
const CONFIG = Object.freeze({
  OSRM_BASE:          'https://router.project-osrm.org/route/v1/bike',
  NOMINATIM_BASE:     'https://nominatim.openstreetmap.org',

  // Feromoni
  EVAPORATION_RATE:   0.02,     // frazione per ora
  DEPOSIT_BASE:       120,      // intensità base per punto depositato
  QUALITY_BONUS:      1.5,      // moltiplicatore per traccia segnalata "ottima"
  SEARCH_RADIUS:      0.0008,   // gradi (~88m) per calcolo densità
  MERGE_RADIUS:       0.0003,   // gradi (~33m) per fusione punti vicini
  MAX_PHEROMONES:     3000,     // cap per localStorage

  // Mappa
  DEFAULT_VIEW:       { lat: 41.8968, lng: 12.4820, zoom: 14 },
  HEATMAP_RADIUS:     28,
  HEATMAP_BLUR:       18,

  // Simulazione
  SIM_PAIRS:          20,       // coppie di "formiche" da simulare
  SIM_DELAY_MS:       600,      // pausa tra una formica e l'altra

  // UI
  GEOCODE_DEBOUNCE:   420,      // ms debounce per autocomplete
  TOAST_DEFAULT_MS:   3200,
  MIN_TRACK_KM:       0.05,
});

/* ────────────────────────────────────────────────────────────────
   SUPABASE — Credenziali backend condiviso
   ──────────────────────────────────────────────────────────────── */
const SUPABASE_URL  = 'https://uuevijifdoyqgoxigmgc.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1ZXZpamlmZG95cWdveGlnbWdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODE2NjAsImV4cCI6MjA5MTI1NzY2MH0.YUS36i1sLhtfOZgGhZX8RnL-S83f2h-BS4uIwsiHpgI';

/* ────────────────────────────────────────────────────────────────
   LANDMARKS DI ROMA (punti di partenza per la simulazione)
   ──────────────────────────────────────────────────────────────── */
const ROME_LANDMARKS = [
  { name: 'Colosseo',          lat: 41.8902, lng: 12.4922 },
  { name: 'Trastevere',        lat: 41.8856, lng: 12.4667 },
  { name: 'Prati / Vaticano',  lat: 41.9011, lng: 12.4594 },
  { name: 'Testaccio',         lat: 41.8758, lng: 12.4761 },
  { name: 'Campo de Fiori',    lat: 41.8954, lng: 12.4722 },
  { name: 'Termini',           lat: 41.9009, lng: 12.5005 },
  { name: 'Pigneto',           lat: 41.8878, lng: 12.5337 },
  { name: 'Ostiense',          lat: 41.8681, lng: 12.4836 },
  { name: 'San Giovanni',      lat: 41.8857, lng: 12.5053 },
  { name: 'Parioli',           lat: 41.9211, lng: 12.5015 },
  { name: 'Garbatella',        lat: 41.8595, lng: 12.4934 },
  { name: 'Piazza Navona',     lat: 41.8992, lng: 12.4731 },
  { name: 'Pantheon',          lat: 41.8986, lng: 12.4769 },
  { name: 'Aventino',          lat: 41.8822, lng: 12.4794 },
  { name: 'Piramide',          lat: 41.8742, lng: 12.4796 },
  { name: 'Borghese / Pincio', lat: 41.9142, lng: 12.4875 },
  { name: 'Piazza del Popolo', lat: 41.9115, lng: 12.4768 },
  { name: 'EUR',               lat: 41.8268, lng: 12.4693 },
];

/* ────────────────────────────────────────────────────────────────
   UTILITY FUNCTIONS
   ──────────────────────────────────────────────────────────────── */

/** Pausa asincrona */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Distanza Haversine in km tra due punti {lat,lng} */
function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinDLng * sinDLng;
  return R * 2 * Math.asin(Math.sqrt(h));
}

/** Formatta metri/km */
function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** Formatta secondi → min o h min */
function fmtTime(s) {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m} min`;
}

/** Formatta data breve locale */
function fmtDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Assegna colore in base al punteggio pheromone normalizzato [0-1] */
function pheroColor(norm) {
  if (norm > 0.75) return '#ff0055';
  if (norm > 0.50) return '#ffaa00';
  if (norm > 0.25) return '#00ff88';
  return '#00ccff';
}

/* ================================================================
   PHEROMONE ENGINE
   Cuore dell'algoritmo ACO — gestisce il deposito, l'evaporazione
   e la persistenza del "profumo collettivo" dei ciclisti.
   ================================================================ */
class PheromoneEngine {
  constructor() {
    /** @type {Array<{lat:number, lng:number, intensity:number, ts:number}>} */
    this.pts = [];
    this.lastEvap = Date.now();
    this.totalKm  = 0;
    this._load();
  }

  /* ── Deposito ────────────────────────────────────────────────── */
  /**
   * Deposita feromoni lungo un percorso.
   * @param {{lat:number,lng:number}[]} points
   * @param {number} quality  1.0 = normale, 1.5 = ottimo
   */
  deposit(points, quality = 1.0) {
    if (!points?.length) return [];

    const dose   = (CONFIG.DEPOSIT_BASE * quality) / Math.sqrt(points.length);
    const newPts = []; // punti genuinamente nuovi (non fusi) → inviati a Supabase

    for (const { lat, lng } of points) {
      // Cerca un punto vicino da fondere
      let merged = false;
      for (const p of this.pts) {
        if (Math.hypot(p.lat - lat, p.lng - lng) < CONFIG.MERGE_RADIUS) {
          p.intensity += dose;
          p.ts = Date.now();
          merged = true;
          break;
        }
      }
      if (!merged) {
        const np = { lat, lng, intensity: dose, ts: Date.now() };
        this.pts.push(np);
        newPts.push(np);
      }
    }

    // Aggiorna km totali tracciati (approssimativo)
    for (let i = 1; i < points.length; i++) {
      this.totalKm += haversine(points[i - 1], points[i]);
    }

    this._trim();
    this._save();
    return newPts;  // ◄ array (non più contatore) → usato da SupabaseSync
  }

  /* ── Evaporazione ────────────────────────────────────────────── */
  /**
   * Applica evaporazione esponenziale.
   * Rimuove feromoni sotto la soglia.
   */
  evaporate() {
    const now = Date.now();
    const hoursElapsed = (now - this.lastEvap) / 3_600_000;
    if (hoursElapsed < 0.005) return; // meno di 18s, salta

    const factor = Math.pow(1 - CONFIG.EVAPORATION_RATE, hoursElapsed);
    this.pts = this.pts
      .map(p => ({ ...p, intensity: p.intensity * factor }))
      .filter(p => p.intensity > 0.5);

    this.lastEvap = now;
    this._save();
  }

  /* ── Score di un percorso ──────────────────────────────────────── */
  /**
   * Calcola la densità media di feromoni lungo un array di punti.
   * @param {{lat:number,lng:number}[]} points
   * @returns {number}
   */
  scorePath(points) {
    if (!this.pts.length || !points.length) return 0;
    let total = 0;
    const sample = points.length > 60
      ? points.filter((_, i) => i % Math.floor(points.length / 60) === 0)
      : points;
    for (const pt of sample) total += this._density(pt);
    return total / sample.length;
  }

  /** Densità feromoni in un singolo punto */
  _density({ lat, lng }) {
    let d = 0;
    for (const p of this.pts) {
      const dist = Math.hypot(p.lat - lat, p.lng - lng);
      if (dist < CONFIG.SEARCH_RADIUS) {
        d += p.intensity * (1 - dist / CONFIG.SEARCH_RADIUS);
      }
    }
    return d;
  }

  /* ── Heatmap data ─────────────────────────────────────────────── */
  /**
   * Ritorna array [[lat, lng, normIntensity]] per L.heatLayer.
   */
  getHeatmapData() {
    if (!this.pts.length) return [];
    const maxI = Math.max(...this.pts.map(p => p.intensity));
    if (maxI === 0) return [];
    return this.pts.map(p => [p.lat, p.lng, p.intensity / maxI]);
  }

  /* ── Statistiche ──────────────────────────────────────────────── */
  get count() { return this.pts.length; }
  get kmRegistered() { return Math.round(this.totalKm * 10) / 10; }

  /* ── Reset ────────────────────────────────────────────────────── */
  clear() {
    this.pts = [];
    this.totalKm = 0;
    this.lastEvap = Date.now();
    this._save();
  }

  /* ── Persistenza ──────────────────────────────────────────────── */
  _save() {
    try {
      localStorage.setItem('cicloants_v2', JSON.stringify({
        pts:      this.pts,
        lastEvap: this.lastEvap,
        totalKm:  this.totalKm,
      }));
    } catch (_) {
      // localStorage pieno: taglia i più vecchi
      this.pts.sort((a, b) => b.ts - a.ts);
      this.pts = this.pts.slice(0, Math.floor(CONFIG.MAX_PHEROMONES * 0.7));
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem('cicloants_v2');
      if (!raw) return;
      const d = JSON.parse(raw);
      this.pts      = Array.isArray(d.pts) ? d.pts : [];
      this.lastEvap = d.lastEvap || Date.now();
      this.totalKm  = d.totalKm  || 0;
    } catch (_) {
      this.pts = [];
    }
  }

  _trim() {
    if (this.pts.length > CONFIG.MAX_PHEROMONES) {
      // Rimuovi i più deboli
      this.pts.sort((a, b) => b.intensity - a.intensity);
      this.pts = this.pts.slice(0, CONFIG.MAX_PHEROMONES);
    }
  }
}

/* ================================================================
   ROUTING ENGINE
   Interfaccia con OSRM (profilo bike) e Nominatim per geocodifica.
   Implementa la selezione del percorso pesata dai feromoni.
   ================================================================ */
class RoutingEngine {
  constructor(phero) {
    this.phero = phero;
  }

  /**
   * Richiede percorsi alternativi da OSRM.
   * @param {{lat,lng}} from
   * @param {{lat,lng}} to
   * @returns {Promise<RouteResult[]>}
   */
  async fetchRoutes(from, to) {
    const coord = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
    const url = `${CONFIG.OSRM_BASE}/${coord(from)};${coord(to)}`
      + `?overview=full&geometries=geojson&alternatives=3&steps=true`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error('Nessun percorso ciclabile trovato tra questi punti');
    }

    return data.routes.map((r, idx) => ({
      idx,
      points:   r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      distance: r.distance,   // metri
      duration: r.duration,   // secondi
      pheroScore: 0,          // calcolato dopo
      steps:      parseOSRMSteps(r),
    }));
  }

  /**
   * Ordina le varianti di percorso in base al punteggio combinato
   * distanza + feromoni controllato da alpha.
   * @param {RouteResult[]} routes
   * @param {number} alpha  [0-1]
   */
  rankRoutes(routes, alpha) {
    if (!routes.length) return [];

    // Calcola punteggi feromoni
    routes.forEach(r => {
      r.pheroScore = this.phero.scorePath(r.points);
    });

    const maxDist  = Math.max(...routes.map(r => r.distance));
    const minDist  = Math.min(...routes.map(r => r.distance));
    const maxPhero = Math.max(...routes.map(r => r.pheroScore));

    return routes
      .map(r => {
        // Normalizza: 1 = il migliore
        const dScore = (maxDist > minDist)
          ? 1 - (r.distance - minDist) / (maxDist - minDist)
          : 1;
        const pScore = maxPhero > 0 ? r.pheroScore / maxPhero : 0;
        return { ...r, dScore, pScore, score: (1 - alpha) * dScore + alpha * pScore };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Geocodifica un indirizzo via Nominatim (limitata a Roma).
   * @param {string} query
   */
  async geocode(query) {
    const params = new URLSearchParams({
      q:        query,
      format:   'json',
      limit:    '5',
    });
    const resp = await fetch(
      `${CONFIG.NOMINATIM_BASE}/search?${params}`,
      { headers: { 'Accept-Language': 'it,en' }, signal: AbortSignal.timeout(8000) }
    );
    return resp.json();
  }

  /**
   * Reverse geocодifica coordinate → indirizzo leggibile.
   * @param {{lat:number,lng:number}} pt
   */
  async reverseGeocode({ lat, lng }) {
    const params = new URLSearchParams({
      lat:    lat.toFixed(6),
      lon:    lng.toFixed(6),
      format: 'json',
      zoom:   '16',
    });
    const resp = await fetch(
      `${CONFIG.NOMINATIM_BASE}/reverse?${params}`,
      { headers: { 'Accept-Language': 'it,en' }, signal: AbortSignal.timeout(8000) }
    );
    const data = await resp.json();
    return data?.display_name?.split(',').slice(0, 2).join(', ') || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

/* ================================================================
   MAP MANAGER
   Gestisce Leaflet: heatmap, layer percorsi, marker, track.
   ================================================================ */
class MapManager {
  constructor() {
    this.map         = null;
    this.heatLayer   = null;
    this.routeLayers = [];
    this.markerA     = null;
    this.markerB     = null;
    this.trackLayer  = null;
    this.posMarker   = null;
    this.accuracyCircle = null;  // cerchio blu accuratezza GPS
  }

  init() {
    const { lat, lng, zoom } = CONFIG.DEFAULT_VIEW;

    this.map = L.map('map', {
      center:      [lat, lng],
      zoom,
      zoomControl: false,
      preferCanvas: true,
    });

    // Light tile — CartoDB Positron (CARTO, no API key needed)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com">CARTO</a>',
      subdomains:  'abcd',
      maxZoom:     20,
    }).addTo(this.map);

    // Zoom control in basso a destra (fuori dalla sidebar)
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // Heatmap layer vuoto
    this.heatLayer = L.heatLayer([], {
      radius:  CONFIG.HEATMAP_RADIUS,
      blur:    CONFIG.HEATMAP_BLUR,
      maxZoom: 18,
      max:     1.0,
      gradient: {
        0.00: '#1a44ff',
        0.25: '#00ccff',
        0.50: '#00ff88',
        0.75: '#ffaa00',
        1.00: '#ff0055',
      },
    }).addTo(this.map);
  }

  /**
   * Chiede la posizione GPS e centra la mappa sull'utente.
   * @param {function({lat,lng}):void} onLocated   callback con la posizione trovata
   * @param {function(string):void}   onError      callback con messaggio d'errore
   */
  locateUser(onLocated, onError) {
    if (!navigator.geolocation) {
      onError?.('Geolocalizzazione non supportata dal browser');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        this.map.setView([pt.lat, pt.lng], 15, { animate: true });
        this.updateAccuracyCircle(pt, pos.coords.accuracy);
        onLocated?.(pt);
      },
      err => {
        const msgs = {
          1: 'Permesso GPS negato. Abilita la posizione nelle impostazioni del browser.',
          2: 'GPS non disponibile. Verifica che la posizione sia attiva sul dispositivo.',
          3: 'Timeout GPS. Vai all\'aperto e riprova.',
        };
        onError?.(msgs[err.code] || `Errore GPS (codice ${err.code})`);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  }

  /* ── Heatmap ─────────────────────────────────────────────────── */
  updateHeatmap(data) {
    this.heatLayer.setLatLngs(data);
  }

  /* ── Route drawing ───────────────────────────────────────────── */
  drawRoute(points, { color = '#005cc5', weight = 5, opacity = 0.90, dash = null } = {}) {
    const ll = points.map(({ lat, lng }) => [lat, lng]);
    const layer = L.polyline(ll, {
      color, weight, opacity,
      dashArray: dash,
      lineCap:   'round',
      lineJoin:  'round',
    }).addTo(this.map);
    this.routeLayers.push(layer);
    return layer;
  }

  clearRoutes() {
    this.routeLayers.forEach(l => this.map.removeLayer(l));
    this.routeLayers = [];
  }

  fitRoute(points, padding = 70) {
    const bounds = L.latLngBounds(points.map(({ lat, lng }) => [lat, lng]));
    this.map.fitBounds(bounds, { paddingTopLeft: [padding, padding], paddingBottomRight: [padding + 20, padding] });
  }

  /* ── Markers ─────────────────────────────────────────────────── */
  setMarker(type, { lat, lng }) {
    const isA = type === 'A';
    const cls  = isA ? 'marker-a' : 'marker-b';
    const label = isA ? 'A' : 'B';

    const icon = L.divIcon({
      className: '',
      html:      `<div class="map-marker ${cls}" aria-label="Punto ${label}">${label}</div>`,
      iconSize:  [32, 32],
      iconAnchor:[16, 16],
    });

    if (isA) {
      if (this.markerA) this.map.removeLayer(this.markerA);
      this.markerA = L.marker([lat, lng], { icon, title: 'Partenza' }).addTo(this.map);
    } else {
      if (this.markerB) this.map.removeLayer(this.markerB);
      this.markerB = L.marker([lat, lng], { icon, title: 'Arrivo' }).addTo(this.map);
    }
  }

  clearMarkers() {
    if (this.markerA) { this.map.removeLayer(this.markerA); this.markerA = null; }
    if (this.markerB) { this.map.removeLayer(this.markerB); this.markerB = null; }
  }

  /* ── Ant animation trail ─────────────────────────────────────── */
  drawAntTrail(points, color = '#aa44ff') {
    const ll  = points.map(({ lat, lng }) => [lat, lng]);
    const grp = L.layerGroup().addTo(this.map);

    // Linea tratteggiata dell'ant
    const line = L.polyline(ll, {
      color, weight: 2, opacity: 0.7, dashArray: '6 4',
    });
    grp.addLayer(line);

    // Formica animata sul percorso
    if (ll.length > 1) {
      const antIcon = L.divIcon({
        className:  '',
        html:       `<div style="font-size:18px;filter:drop-shadow(0 0 6px ${color})">🐜</div>`,
        iconSize:   [20, 20],
        iconAnchor: [10, 10],
      });
      const antMarker = L.marker(ll[0], { icon: antIcon }).addTo(this.map);
      grp.addLayer(antMarker);

      // Anima l'ant lungo la polyline
      this._animateAnt(antMarker, ll, 1800);
    }

    // Fade out dopo 3.5s
    setTimeout(() => {
      let op = 0.7;
      const fade = setInterval(() => {
        op -= 0.07;
        if (op <= 0) {
          clearInterval(fade);
          this.map.removeLayer(grp);
        } else {
          line.setStyle({ opacity: op });
        }
      }, 60);
    }, 3000);
  }

  _animateAnt(marker, ll, durationMs) {
    const start = performance.now();
    const totalPts = ll.length;

    const step = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / durationMs, 1);
      const idx = Math.floor(progress * (totalPts - 1));
      marker.setLatLng(ll[idx]);
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ── GPS Track ───────────────────────────────────────────────── */
  startTrack() {
    if (this.trackLayer) this.map.removeLayer(this.trackLayer);
    this.trackLayer = L.polyline([], {
      color:   '#ff6b35',
      weight:  5,
      opacity: 0.95,
    }).addTo(this.map);
  }

  addTrackPoint({ lat, lng }) {
    this.trackLayer?.addLatLng([lat, lng]);
  }

  updatePosMarker({ lat, lng }) {
    if (this.posMarker) {
      this.posMarker.setLatLng([lat, lng]);
    } else {
      const icon = L.divIcon({
        className: '',
        html:      `<div class="pos-marker">🚴</div>`,
        iconSize:  [32, 32],
        iconAnchor:[16, 16],
      });
      this.posMarker = L.marker([lat, lng], { icon }).addTo(this.map);
    }
    this.map.panTo([lat, lng], { animate: true, duration: 0.5 });
  }

  clearTrack() {
    if (this.trackLayer) { this.map.removeLayer(this.trackLayer); this.trackLayer = null; }
    if (this.posMarker)  { this.map.removeLayer(this.posMarker);  this.posMarker  = null; }
    this.clearAccuracyCircle();
  }

  /* ── Cerchio accuratezza GPS ─────────────────────────────────── */

  updateAccuracyCircle({ lat, lng }, accuracyM) {
    if (this.accuracyCircle) {
      this.accuracyCircle.setLatLng([lat, lng]);
      this.accuracyCircle.setRadius(accuracyM);
    } else {
      this.accuracyCircle = L.circle([lat, lng], {
        radius:      accuracyM,
        color:       '#005cc5',
        fillColor:   '#005cc5',
        fillOpacity: 0.10,
        weight:      1.5,
        dashArray:   '5 5',
      }).addTo(this.map);
    }
  }

  clearAccuracyCircle() {
    if (this.accuracyCircle) {
      this.map.removeLayer(this.accuracyCircle);
      this.accuracyCircle = null;
    }
  }
}

/* ================================================================
   SIMULATION ENGINE
   Genera coppie casuali di landmark e simula formiche che
   percorrono Roma depositando feromoni. Effetto visivo + dati.
   ================================================================ */
class SimulationEngine {
  constructor(phero, routing, mapMgr) {
    this.phero   = phero;
    this.routing = routing;
    this.map     = mapMgr;
    this.active  = false;
    this.count   = 0;
  }

  /**
   * Avvia la simulazione.
   * @param {(done:number, total:number)=>void} onProgress
   * @param {()=>void} onDone
   */
  async run(onProgress, onDone) {
    if (this.active) return;
    this.active = true;
    this.count  = 0;

    const pairs  = this._buildPairs(CONFIG.SIM_PAIRS);
    const colors = ['#aa44ff','#ff0055','#ffaa00','#00ff88','#00ccff','#ff6b35'];

    for (let i = 0; i < pairs.length; i++) {
      if (!this.active) break;

      const [from, to] = pairs[i];
      const color = colors[i % colors.length];

      try {
        const routes = await this.routing.fetchRoutes(from, to);
        if (routes?.length) {
          const route = routes[0];
          this.map.drawAntTrail(route.points, color);
          this.phero.deposit(route.points, 1.0);
          this.count++;
          onProgress?.(this.count, pairs.length);
        }
      } catch (e) {
        // Alcune coppie potrebbero fallire (nessun percorso) — ignora
        console.debug('Ant route skip:', e.message);
      }

      await sleep(CONFIG.SIM_DELAY_MS);
    }

    this.active = false;
    onDone?.();
  }

  stop() { this.active = false; }

  _buildPairs(n) {
    const pairs = [];
    const lm = ROME_LANDMARKS;
    while (pairs.length < n) {
      const a = lm[Math.floor(Math.random() * lm.length)];
      const b = lm[Math.floor(Math.random() * lm.length)];
      if (a !== b) pairs.push([a, b]);
    }
    return pairs;
  }
}

/* ================================================================
   TRACKING ENGINE
   Registra la posizione GPS in tempo reale e deposita feromoni
   al termine della pedalata.
   ================================================================ */
class TrackingEngine {
  constructor(phero, mapMgr) {
    this.phero    = phero;
    this.map      = mapMgr;
    this.watchId  = null;
    this.pts      = [];
    this.tracking = false;
    this._wakeLock = null;  // impedisce lo standby durante il tracciamento
  }

  /** Avvia il tracciamento GPS. Lancia eccezione se GPS non disponibile. */
  start(onUpdate, onPosition, onError) {
    if (!navigator.geolocation) throw new Error('Geolocalizzazione non supportata dal browser');

    this.pts      = [];
    this.startedAt = Date.now();
    this.tracking = true;
    this.map.startTrack();
    this._firstFix = false;
    this._acquireWakeLock();

    this.watchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const pt = { lat, lng };
        this.pts.push(pt);
        this.map.addTrackPoint(pt);
        this.map.updatePosMarker(pt);
        this.map.updateAccuracyCircle(pt, accuracy);
        onPosition?.(pt);
        onUpdate?.(this._distKm(), Math.round(accuracy));
        this._firstFix = true;
      },
      err => {
        // Mostra errore all'utente (non solo console)
        const msgs = {
          1: 'Permesso GPS negato. Abilita la posizione nelle impostazioni del browser.',
          2: 'GPS non disponibile. Verifica che la posizione sia attiva sul dispositivo.',
          3: 'Timeout GPS. Il segnale è debole — vai all\'aperto e riprova.',
        };
        const msg = msgs[err.code] || `Errore GPS (codice ${err.code})`;
        console.warn('GPS error', err.code, err.message);
        onError?.(msg);
      },
      {
        enableHighAccuracy: true,
        timeout:            30000,  // 30s per cold-start GPS
        maximumAge:         0,      // sempre fix fresco
      }
    );
  }

  /** Ferma il tracciamento, deposita feromoni e ritorna metadati traccia. */
  stop() {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.tracking = false;
    this._releaseWakeLock();

    const endedAt = Date.now();
    const km = this._distKm();
    const durationSec = Math.max(1, Math.round((endedAt - (this.startedAt || endedAt)) / 1000));
    const avgSpeedKmh = durationSec > 0 ? (km / durationSec) * 3600 : 0;

    if (this.pts.length > 3) {
      // Assottiglia i punti (1 ogni 3) prima di depositare
      const thinned = this.pts.filter((_, i) => i % 3 === 0);
      this.phero.deposit(thinned, 1.0);
    }

    this.map.clearTrack(); // include clearAccuracyCircle()
    return {
      km,
      startedAt: this.startedAt || endedAt,
      endedAt,
      durationSec,
      avgSpeedKmh: Math.round(avgSpeedKmh * 100) / 100,
      pointsCount: this.pts.length,
    };
  }

  _distKm() {
    let d = 0;
    for (let i = 1; i < this.pts.length; i++) d += haversine(this.pts[i - 1], this.pts[i]);
    return Math.round(d * 100) / 100;
  }

  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator)
        this._wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {}
  }

  _releaseWakeLock() {
    this._wakeLock?.release().catch(() => {});
    this._wakeLock = null;
  }
}

/* ================================================================
   UI CONTROLLER
   Gestisce tutti gli elementi DOM, eventi, ricerche, notifiche.
   ================================================================ */
class UIController {
  constructor(app) {
    this.app         = app;
    this.locA        = null; // {lat,lng,label}
    this.locB        = null;
    this._debounces  = {};
    this._clickState = 'A'; // prossimo click sulla mappa imposta A o B
    this._lastRoutes = [];  // cached dopo ogni calcolo, usati per la navigazione
  }

  init() {
    this._bindSearch('start', 'input-start', 'suggestions-start', loc => {
      this.locA = loc;
      this.app.map.setMarker('A', loc);
      this._clickState = 'B';
    });

    this._bindSearch('end', 'input-end', 'suggestions-end', loc => {
      this.locB = loc;
      this.app.map.setMarker('B', loc);
      this._clickState = 'A';
    });

    // Swap
    document.getElementById('btn-swap').addEventListener('click', () => {
      [this.locA, this.locB] = [this.locB, this.locA];
      const iA = document.getElementById('input-start');
      const iB = document.getElementById('input-end');
      [iA.value, iB.value] = [iB.value, iA.value];
      if (this.locA) this.app.map.setMarker('A', this.locA);
      if (this.locB) this.app.map.setMarker('B', this.locB);
    });

    // Route
    document.getElementById('btn-route').addEventListener('click', () => this._planRoute());

    // Alpha slider
    const slider = document.getElementById('slider-alpha');
    slider.addEventListener('input', () => {
      this.app.alpha = parseFloat(slider.value);
      document.getElementById('alpha-value').textContent = `α = ${slider.value}`;
    });

    // Simulate
    document.getElementById('btn-simulate').addEventListener('click', () => this._runSimulation());

    // Locate
    document.getElementById('btn-locate').addEventListener('click', () => this._locateUser());

    // Track
    document.getElementById('btn-track').addEventListener('click', () => {
      this.app.track.tracking ? this._stopTracking() : this._startTracking();
    });

    // Stop tracking bar button
    document.getElementById('btn-stop-track').addEventListener('click', () => this._stopTracking());

    // Clear
    document.getElementById('btn-clear').addEventListener('click', () => this._clearAll());

    // Sidebar toggle (mobile)
    document.getElementById('btn-sidebar-toggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });

    // Click sulla mappa per impostare A/B
    this.app.map.map.on('click', e => this._onMapClick(e));

    // Stop navigazione
    document.getElementById('btn-stop-nav')?.addEventListener('click', () => this._stopNavigation());

    // Auth
    document.getElementById('btn-signup')?.addEventListener('click', () => this._signUp());
    document.getElementById('btn-signin')?.addEventListener('click', () => this._signIn());
    document.getElementById('btn-signout')?.addEventListener('click', () => this._signOut());
    window.addEventListener('cicloants-auth-changed', () => this.renderAuthState());

    // Chiudi suggestions se si clicca fuori
    document.addEventListener('click', e => {
      document.querySelectorAll('.suggestions-dropdown').forEach(el => {
        if (!el.contains(e.target)) el.style.display = 'none';
      });
    });
  }

  renderAuthState() {
    const user = this.app.auth?.user || null;
    const guest = document.getElementById('auth-guest-panel');
    const authed = document.getElementById('auth-user-panel');
    const profileSection = document.getElementById('section-profile');
    const leaderboardSection = document.getElementById('section-leaderboard');
    const userNameEl = document.getElementById('auth-user-name');

    if (!guest || !authed || !profileSection || !leaderboardSection || !userNameEl) return;

    if (user) {
      guest.style.display = 'none';
      authed.style.display = 'block';
      profileSection.style.display = 'block';
      leaderboardSection.style.display = 'block';
      userNameEl.textContent = user.user_metadata?.display_name || user.email || 'utente';
    } else {
      guest.style.display = 'block';
      authed.style.display = 'none';
      profileSection.style.display = 'none';
      leaderboardSection.style.display = 'none';
    }
  }

  async _signUp() {
    const name = (document.getElementById('auth-name')?.value || '').trim();
    const email = (document.getElementById('auth-email')?.value || '').trim();
    const password = (document.getElementById('auth-password')?.value || '').trim();
    if (!name || !email || password.length < 6) {
      this.toast('Compila nome, email e password (min 6 caratteri).', 'warning');
      return;
    }
    try {
      await this.app.auth.signUp(email, password, name);
      this.toast('Registrazione inviata. Controlla email se richiesta conferma.', 'success', 4200);
    } catch (err) {
      this.toast(`Registrazione fallita: ${err.message}`, 'error', 4500);
    }
  }

  async _signIn() {
    const email = (document.getElementById('auth-email')?.value || '').trim();
    const password = (document.getElementById('auth-password')?.value || '').trim();
    if (!email || !password) {
      this.toast('Inserisci email e password per il login.', 'warning');
      return;
    }
    try {
      await this.app.auth.signIn(email, password);
      await this.app.refreshUserPanels();
      this.toast('Login effettuato.', 'success');
    } catch (err) {
      this.toast(`Login fallito: ${err.message}`, 'error', 4500);
    }
  }

  async _signOut() {
    try {
      await this.app.auth.signOut();
      this.renderAuthState();
      this.app.resetUserPanels();
      this.toast('Logout effettuato.', 'info');
    } catch (err) {
      this.toast(`Logout fallito: ${err.message}`, 'error', 4000);
    }
  }

  /* ── Map click ────────────────────────────────────────────────── */
  _onMapClick(e) {
    const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
    const label = `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`;

    if (this._clickState === 'A') {
      this.locA = pt;
      document.getElementById('input-start').value = label;
      this.app.map.setMarker('A', pt);
      this._clickState = 'B';
      this.toast('Partenza impostata. Ora clicca sulla destinazione.', 'info', 2200);
    } else {
      this.locB = pt;
      document.getElementById('input-end').value = label;
      this.app.map.setMarker('B', pt);
      this._clickState = 'A';
      // Calcola automaticamente il percorso
      this._planRoute();
    }
  }

  /* ── Autocomplete ──────────────────────────────────────────────── */
  _bindSearch(key, inputId, suggestId, onSelect) {
    const input = document.getElementById(inputId);
    const drop  = document.getElementById(suggestId);

    input.addEventListener('input', () => {
      clearTimeout(this._debounces[key]);
      const q = input.value.trim();
      if (q.length < 3) { drop.style.display = 'none'; return; }

      this._debounces[key] = setTimeout(async () => {
        try {
          const results = await this.app.routing.geocode(q + ', Roma');
          if (!results.length) { drop.style.display = 'none'; return; }

          drop.innerHTML = results.slice(0, 5).map(r => {
            const short = r.display_name.split(',').slice(0, 2).join(', ');
            return `
              <div class="suggestion-item" tabindex="0"
                data-lat="${r.lat}" data-lng="${r.lon}">
                <span class="sug-icon">📍</span>
                <span class="sug-text">${short}</span>
              </div>`;
          }).join('');
          drop.style.display = 'block';

          drop.querySelectorAll('.suggestion-item').forEach(el => {
            const select = () => {
              onSelect({ lat: parseFloat(el.dataset.lat), lng: parseFloat(el.dataset.lng) });
              input.value = el.querySelector('.sug-text').textContent;
              drop.style.display = 'none';
            };
            el.addEventListener('click', select);
            el.addEventListener('keydown', ev => { if (ev.key === 'Enter') select(); });
          });
        } catch (_) { drop.style.display = 'none'; }
      }, CONFIG.GEOCODE_DEBOUNCE);
    });
  }

  /* ── Route planning ───────────────────────────────────────────── */
  async _planRoute() {
    if (!this.locA || !this.locB) {
      this.toast('Imposta prima partenza e destinazione (o clicca sulla mappa).', 'warning');
      return;
    }

    const btn = document.getElementById('btn-route');
    btn.disabled = true;
    btn.querySelector('span:last-child').textContent = 'Calcolo in corso…';

    try {
      const routes  = await this.app.routing.fetchRoutes(this.locA, this.locB);
      const ranked  = this.app.routing.rankRoutes(routes, this.app.alpha);
      this._lastRoutes = ranked;
      const best    = ranked[0];

      this.app.map.clearRoutes();

      // Disegna alternative (sfumate)
      ranked.slice(1).forEach(r => {
        this.app.map.drawRoute(r.points, {
          color: '#94aec8', weight: 3, opacity: 0.70, dash: '8 5',
        });
      });

      // Percorso migliore: blu intenso
      this.app.map.drawRoute(best.points, {
        color: '#005cc5', weight: 6, opacity: 0.95,
      });

      this.app.map.fitRoute(best.points);
      this._renderRouteCards(ranked);

      const pheroMsg = best.pheroScore > 0
        ? `Feromone ${Math.round(best.pScore * 100)}%  ·  `
        : 'Tratto vergine  ·  ';
      this.toast(`🐜 ${pheroMsg}${fmtDist(best.distance)}  ·  ${fmtTime(best.duration)}`, 'success', 4000);

    } catch (err) {
      this.toast(`Errore routing: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span:last-child').textContent = 'Trova percorso formiche';
    }
  }

  /* ── Route cards ──────────────────────────────────────────────── */
  _renderRouteCards(ranked) {
    const labels = ['🥇 Ottimale','🥈 Alternativa','🥉 Opzione'];
    const section = document.getElementById('section-results');
    const cards   = document.getElementById('route-cards');

    cards.innerHTML = ranked.map((r, i) => {
      const pct     = Math.round(r.score  * 100);
      const pheroPct = Math.round((r.pScore || 0) * 100);
      const color   = pheroColor(r.pScore || 0);

      return `
        <div class="route-card ${i === 0 ? 'route-card-best' : ''} fade-in"
             style="animation-delay:${i * 0.08}s">
          <div class="route-card-header">
            <span class="route-label">${labels[i] || `Percorso ${i+1}`}</span>
            <span class="route-score">${pct}%</span>
          </div>
          <div class="route-card-stats">
            <div class="route-stat">
              <span class="route-stat-icon">📏</span>
              <span>${fmtDist(r.distance)}</span>
            </div>
            <div class="route-stat">
              <span class="route-stat-icon">⏱</span>
              <span>${fmtTime(r.duration)}</span>
            </div>
            <div class="route-stat" style="color:${color}">
              <span class="route-stat-icon">🐜</span>
              <span>${pheroPct > 0 ? `${pheroPct}% feromoni` : 'Nessun feromone'}</span>
            </div>
          </div>
          <div class="phero-bar-wrap">
            <div class="phero-bar-fill" style="width:${pheroPct}%"></div>
          </div>
          ${i === 0 ? '<button class="btn-nav-start" id="btn-start-nav">🧭 Avvia Navigazione</button>' : ''}
        </div>`;
    }).join('');

    section.style.display = 'block';
    document.getElementById('btn-start-nav')?.addEventListener('click', () => {
      this._startNavigation(this._lastRoutes[0]);
    });
  }

  /* ── Simulation ───────────────────────────────────────────────── */
  async _runSimulation() {
    const btn = document.getElementById('btn-simulate');

    if (this.app.sim.active) {
      this.app.sim.stop();
      btn.innerHTML = `<span class="fab-icon">🐜</span><span class="fab-label">Simula formiche</span>`;
      btn.classList.remove('loading');
      return;
    }

    btn.innerHTML = `<span class="fab-icon">⏹</span><span class="fab-label">Stop simulazione</span>`;
    btn.classList.add('loading');
    this.toast(`🐜 ${CONFIG.SIM_PAIRS} formiche virtuali esplorano Roma…`, 'info', 4000);

    await this.app.sim.run(
      (done, total) => {
        this.app._syncStats();
        document.getElementById('stat-ants').textContent = done;
        this.toast(`🐜 Formica ${done}/${total} ha depositato feromoni`, 'info', 700);
      },
      () => {
        btn.innerHTML = `<span class="fab-icon">🐜</span><span class="fab-label">Simula formiche</span>`;
        btn.classList.remove('loading');
        this.app._syncStats();
        this.toast(`✅ Simulazione completa! Mappa aggiornata con ${this.app.phero.count} feromoni.`, 'success', 4500);
      }
    );
  }

  /* ── Locate user ──────────────────────────────────────────────── */
  _locateUser() {
    const btn = document.getElementById('btn-locate');
    btn.classList.add('locating');
    btn.querySelector('.fab-icon').textContent = '⌛';
    this.toast('📍 Ricerca posizione GPS…', 'info', 2500);

    this.app.map.locateUser(
      async pt => {
        btn.classList.remove('locating');
        btn.querySelector('.fab-icon').textContent = '📍';
        // Prova reverse-geocoding per un toast carino
        try {
          const addr = await this.app.routing.reverseGeocode(pt);
          this.toast(`📍 Sei qui: ${addr}`, 'success', 3500);
        } catch (_) {
          this.toast(`📍 Posizione trovata (${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)})`, 'success', 3000);
        }
      },
      msg => {
        btn.classList.remove('locating');
        btn.querySelector('.fab-icon').textContent = '📍';
        this.toast(msg, 'error', 5000);
      }
    );
  }

  /* ── Tracking ─────────────────────────────────────────────────── */
  _startTracking() {
    try {
      this.app.track.start(
        km => {
          document.getElementById('tracking-distance').textContent = `${km} km`;
        },
        null,
        msg => this.toast(msg, 'error', 5000)   // ◄ onError ora propagato
      );
      document.getElementById('btn-track').innerHTML =
        `<span class="fab-icon">⏹</span><span class="fab-label">Salva & Stop</span>`;
      document.getElementById('btn-track').classList.add('recording');
      document.getElementById('tracking-bar').style.display = 'flex';
      this.toast('🚴 GPS attivato. Pedala e lascia feromoni!', 'success');
    } catch (err) {
      this.toast(`GPS non disponibile: ${err.message}`, 'error', 4000);
    }
  }

  _stopTracking() {
    const summary = this.app.track.stop();
    const km = summary.km;

    document.getElementById('btn-track').innerHTML =
      `<span class="fab-icon">🚴</span><span class="fab-label">Pedala!</span>`;
    document.getElementById('btn-track').classList.remove('recording');
    document.getElementById('tracking-bar').style.display = 'none';
    const trackingLabel = document.getElementById('tracking-label');
    if (trackingLabel) trackingLabel.textContent = '🔴 Registrazione attiva';

    this.app._syncStats();
    const curKm = parseFloat(document.getElementById('stat-km').textContent || '0');
    document.getElementById('stat-km').textContent = Math.round((curKm + km) * 10) / 10;

    this.toast(km > CONFIG.MIN_TRACK_KM
      ? `✅ ${km} km registrati! I tuoi feromoni aiuteranno altri ciclisti 🐜`
      : '✅ Traccia salvata (troppo breve per feromoni significativi).', 'success', 4000);

    this.app.persistTrack(summary).catch(err => {
      this.toast(`Salvataggio cloud traccia fallito: ${err.message}`, 'warning', 4500);
    });
  }

  /* ── Clear ────────────────────────────────────────────────────── */
  _clearAll() {
    if (!confirm('Cancellare tutti i feromoni dalla mappa?')) return;
    this.app.phero.clear();
    this.app.map.clearRoutes();
    this.app.map.clearMarkers();
    this.app.map.clearTrack();
    this.app.map.updateHeatmap([]);
    this.locA = null;
    this.locB = null;
    this._clickState = 'A';
    document.getElementById('input-start').value = '';
    document.getElementById('input-end').value   = '';
    document.getElementById('section-results').style.display = 'none';
    this.app._syncStats();
    this.toast('🧹 Mappa azzerata. I ciclisti ripartono da zero.', 'info');
  }

  /* ── Navigation turn-by-turn ──────────────────────────────────── */

  _startNavigation(route) {
    if (!route?.steps?.length) {
      this.toast('Nessuna istruzione di navigazione disponibile per questo percorso.', 'warning');
      return;
    }

    // Passa sidebar in modalità navigazione
    document.getElementById('section-results').style.display = 'none';
    document.getElementById('section-nav').style.display    = 'block';

    // Inizializza NavigationEngine
    this.app.nav = new NavigationEngine(route)
      .onStep((step, idx, total) => {
        this._updateNavDisplay(step, idx, total);
      })
      .onArrive(() => {
        const arrow = document.getElementById('nav-arrow');
        arrow.textContent = '🏁';
        arrow.dataset.dir = 'arrive';
        document.getElementById('nav-instruction').textContent = '🏁 Sei arrivato!';
        document.getElementById('nav-progress-fill').style.width = '100%';
        setTimeout(() => this._stopNavigation(), 6000);
      })
      .onUpdate(({ distToTurn, distRemaining, timeRemaining }) => {
        document.getElementById('nav-dist').textContent           = fmtDist(distToTurn);
        document.getElementById('nav-remaining-dist').textContent = fmtDist(distRemaining);
        document.getElementById('nav-remaining-time').textContent = fmtTime(timeRemaining);
        const pct = Math.round((1 - distRemaining / (this.app.nav?.totalDist || 1)) * 100);
        document.getElementById('nav-progress-fill').style.width =
          `${Math.max(0, Math.min(100, pct))}%`;
      });

    // Mostra prima istruzione immediata
    const first = route.steps[0];
    if (first) {
      this._updateNavDisplay(first, 0, route.steps.length);
      document.getElementById('nav-dist').textContent           = fmtDist(first.distance);
      document.getElementById('nav-remaining-dist').textContent = fmtDist(route.distance);
      document.getElementById('nav-remaining-time').textContent = fmtTime(route.duration);
    }

    // Avvia GPS con callback doppia (traccia + navigazione)
    try {
      this.app.track.start(
        km => { document.getElementById('tracking-distance').textContent = `${km} km`; },
        pos => { this.app.nav?.update(pos); }
      );
      document.getElementById('tracking-bar').style.display = 'flex';
      document.getElementById('btn-track').innerHTML =
        `<span class="fab-icon">⬛</span><span class="fab-label">Stop GPS</span>`;
      document.getElementById('btn-track').classList.add('recording');
      this.toast('🧭 Navigazione avviata! 🔊 Guida vocale attiva.', 'success', 4000);
    } catch (err) {
      this.toast(`GPS non disponibile: ${err.message}`, 'error');
      this._stopNavigation();
    }
  }

  _stopNavigation() {
    this.app.nav?.stop();
    this.app.nav = null;
    if (this.app.track.tracking) this._stopTracking();
    document.getElementById('section-nav').style.display    = 'none';
    document.getElementById('section-results').style.display = 'block';
    this.toast('🧭 Navigazione terminata.', 'info', 2000);
  }

  _updateNavDisplay(step, idx, total) {
    const arrow = document.getElementById('nav-arrow');
    arrow.dataset.dir = step.arrowDir;
    if (step.type === 'arrive') {
      arrow.textContent = '🏁';
    } else if (step.type === 'roundabout' || step.type === 'rotary') {
      arrow.textContent = '🔄';
    } else {
      arrow.textContent = '⬆';
    }
    document.getElementById('nav-instruction').textContent = step.instruction;
    document.getElementById('nav-street').textContent      = step.street || '';
    document.getElementById('nav-step-count').textContent  = `Step ${idx + 1} / ${total}`;

    // Lista prossime step
    const steps     = this.app.nav?.steps || [];
    const nextSteps = steps.slice(idx + 1, idx + 4);
    document.getElementById('nav-steps-list').innerHTML = nextSteps.map(s => `
      <div class="nav-step-item">
        <span class="nav-step-arrow" data-dir="${s.arrowDir}">⬆</span>
        <span class="nav-step-text">${s.instruction}</span>
        <span class="nav-step-dist">${fmtDist(s.distance)}</span>
      </div>`).join('');
  }

  /* ── Toast notifications ──────────────────────────────────────── */
  toast(msg, type = 'info', ms = CONFIG.TOAST_DEFAULT_MS) {
    const c  = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    c.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-visible')));
    setTimeout(() => {
      el.classList.remove('toast-visible');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }
}

/* ================================================================
   NAVIGAZIONE TURN-BY-TURN — Helpers + NavigationEngine
   ================================================================ */

/** Converte legs/steps OSRM nel formato interno CicloAnts. */
function parseOSRMSteps(osrmRoute) {
  const result = [];
  for (const leg of (osrmRoute.legs || [])) {
    for (const s of (leg.steps || [])) {
      const [lng, lat] = s.maneuver.location;
      result.push({
        type:        s.maneuver.type,
        modifier:    s.maneuver.modifier || 'straight',
        maneuverLoc: { lat, lng },
        street:      s.name || '',
        distance:    s.distance,
        duration:    s.duration,
        instruction: itInstruction(s.maneuver.type, s.maneuver.modifier, s.name, s.maneuver.exit),
        arrowDir:    arrowDir(s.maneuver.type, s.maneuver.modifier),
      });
    }
  }
  return result;
}

/** Istruzione vocale in italiano. */
function itInstruction(type, modifier, street, exit) {
  const on = street ? ` su ${street}` : '';
  const modMap = {
    'left':         'a sinistra',
    'right':        'a destra',
    'straight':     'dritto',
    'slight left':  'leggermente a sinistra',
    'slight right': 'leggermente a destra',
    'sharp left':   'nettamente a sinistra',
    'sharp right':  'nettamente a destra',
    'uturn':        '— inversione a U',
  };
  const mod = modMap[modifier] || '';
  switch (type) {
    case 'depart':       return `Parti${on}`;
    case 'arrive':       return 'Sei arrivato!';
    case 'turn':         return `Gira ${mod}${on}`;
    case 'new name':     return `Continua${on}`;
    case 'merge':        return `Immettiti${on}`;
    case 'on ramp':      return `Prendi la rampa${on}`;
    case 'off ramp':     return `Esci dalla rampa${on}`;
    case 'fork':         return `Al bivio, tieni ${mod}`;
    case 'end of road':  return `Gira ${mod}${on}`;
    case 'roundabout':
    case 'rotary':       return exit ? `Rotonda: ${exit}ª uscita${on}` : `Rotonda${on}`;
    case 'continue':     return `Continua ${mod}${on}`;
    default:             return `Continua${on}`;
  }
}

/** Direzione freccia per CSS transform. */
function arrowDir(type, modifier) {
  if (type === 'arrive')                           return 'arrive';
  if (type === 'depart')                           return 'straight';
  if (type === 'roundabout' || type === 'rotary')  return 'roundabout';
  return modifier || 'straight';
}

/* ================================================================
   NAVIGATION ENGINE
   Turn-by-turn: segue GPS, avvisa le svolte con voce italiana,
   avanza automaticamente tra le step OSRM.
   ================================================================ */
class NavigationEngine {
  constructor(route) {
    this.steps      = route.steps || [];
    this.totalDist  = route.distance;
    this.totalDur   = route.duration;
    this.currentIdx = 0;
    this._announced = false;
    this._wakeLock  = null;
    this._onStep    = null;
    this._onArrive  = null;
    this._onUpdate  = null;
    this._acquireWakeLock();
  }

  onStep(fn)   { this._onStep   = fn; return this; }
  onArrive(fn) { this._onArrive = fn; return this; }
  onUpdate(fn) { this._onUpdate = fn; return this; }

  /** Chiamato ad ogni fix GPS. */
  update(userPos) {
    if (!this.steps.length || this.currentIdx >= this.steps.length) return;
    const step  = this.steps[this.currentIdx];
    const distM = haversine(userPos, step.maneuverLoc) * 1000;

    // Avviso vocale di avvicinamento (60 m)
    if (distM < 60 && !this._announced && this.currentIdx < this.steps.length - 1) {
      this._announced = true;
      const next   = this.steps[this.currentIdx + 1];
      const prefix = distM > 20 ? `Tra ${Math.round(distM / 10) * 10} metri, ` : '';
      if (next) this._speak(`${prefix}${next.instruction}`);
    }

    // Avanzamento step (< 15 m dalla maneuver)
    if (distM < 15) { this._advance(); return; }

    // Notifica aggiornamento UI
    this._onUpdate?.({
      step, stepIdx: this.currentIdx, totalSteps: this.steps.length,
      distToTurn:    distM,
      distRemaining: this._sum('distance'),
      timeRemaining: this._sum('duration'),
    });
  }

  currentStep() { return this.steps[this.currentIdx] || null; }

  stop() {
    window.speechSynthesis?.cancel();
    this._releaseWakeLock();
  }

  /* ── private ─────────────────────────────────────────────────── */

  _advance() {
    this.currentIdx++;
    this._announced = false;
    if (this.currentIdx >= this.steps.length) {
      this._speak('Sei arrivato a destinazione!');
      this._onArrive?.();
      this._releaseWakeLock();
      return;
    }
    const step = this.steps[this.currentIdx];
    if (step.type !== 'arrive') this._speak(step.instruction);
    this._onStep?.(step, this.currentIdx, this.steps.length);
  }

  _sum(field) {
    let v = 0;
    for (let i = this.currentIdx; i < this.steps.length; i++) v += this.steps[i][field];
    return v;
  }

  _speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang  = 'it-IT';
    u.rate  = 1.05;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }

  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator)
        this._wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {}
  }

  _releaseWakeLock() {
    this._wakeLock?.release().catch(() => {});
    this._wakeLock = null;
  }
}

/* ================================================================
   SUPABASE SYNC
   Sincronizza i feromoni condivisi tra tutti gli utenti.
   - loadAll(): carica dal DB all'avvio, applica evaporazione
   - push(newPts): invia nuovi punti (debounced 2s)
   - subscribeRealtime(): riceve in tempo reale gli inserimenti altrui
   ================================================================ */
class SupabaseSync {
  constructor(phero, onRemoteUpdate) {
    this.phero          = phero;
    this.onRemoteUpdate = onRemoteUpdate;
    this._pushing       = false;
    this._pushQueue     = [];
    this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  }

  /** Carica tutti i feromoni dal DB, applica evaporazione, sostituisce ls. */
  async loadAll() {
    const { data, error } = await this.client
      .from('pheromones')
      .select('lat,lng,intensity,ts')
      .order('intensity', { ascending: false })
      .limit(3000);

    if (error) throw new Error(`Supabase load: ${error.message}`);
    if (!data?.length) return 0;

    const now   = Date.now();
    const fresh = data
      .map(p => {
        const hours  = (now - new Date(p.ts).getTime()) / 3_600_000;
        const factor = Math.pow(1 - CONFIG.EVAPORATION_RATE, Math.max(0, hours));
        return { lat: p.lat, lng: p.lng, intensity: p.intensity * factor, ts: now };
      })
      .filter(p => p.intensity > 0.5);

    // Sostituisce i punti locali con quelli autentici del DB
    this.phero.pts = fresh;
    this.phero._save();
    return fresh.length;
  }

  /** Invia i nuovi punti a Supabase (in batch, con rounding a 6 decimali). */
  async push(points) {
    if (!points?.length) return;
    this._pushing = true;
    try {
      const rows = points.slice(0, 300).map(p => ({
        lat:       parseFloat(p.lat.toFixed(6)),
        lng:       parseFloat(p.lng.toFixed(6)),
        intensity: Math.round(p.intensity),
      }));
      const { error } = await this.client.from('pheromones').insert(rows);
      if (error) console.warn('Supabase push error:', error.message);
      else {
        // Cleanup asincrono: rimuovi feromoni troppo deboli
        this.client.from('pheromones').delete().lt('intensity', 1).then(() => {});
      }
    } finally {
      this._pushing = false;
    }
  }

  /** Subscription realtime: ogni INSERT altrui aggiorna la heatmap locale. */
  subscribeRealtime() {
    this.client
      .channel('pheromones_live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'pheromones' },
        payload => {
          if (this._pushing) return; // ignora echo dei propri push
          const p = payload.new;
          // Deposito silente (quality 0 → no write-back a Supabase)
          this.phero.deposit([{ lat: p.lat, lng: p.lng }], p.intensity / CONFIG.DEPOSIT_BASE);
          this.onRemoteUpdate?.();
        }
      )
      .subscribe();
  }
}

/* ================================================================
   USER DOMAIN SERVICES
   ================================================================ */
class AuthEngine {
  constructor(client) {
    this.client = client;
    this.user = null;
  }

  async init() {
    const { data } = await this.client.auth.getSession();
    this.user = data?.session?.user || null;
    this.client.auth.onAuthStateChange((_evt, session) => {
      this.user = session?.user || null;
      window.dispatchEvent(new CustomEvent('cicloants-auth-changed', { detail: this.user }));
    });
    return this.user;
  }

  async signUp(email, password, displayName) {
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: redirectTo,
      },
    });
    if (error) throw error;
    if (data?.user) {
      await this.client.from('profiles').upsert(
        { id: data.user.id, display_name: displayName },
        { onConflict: 'id' }
      );
    }
    return data;
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data?.user || null;
    return data;
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
    this.user = null;
  }
}

class TrackRepository {
  constructor(client) {
    this.client = client;
  }

  async saveTrack(userId, track) {
    const row = {
      user_id: userId,
      started_at: new Date(track.startedAt).toISOString(),
      ended_at: new Date(track.endedAt).toISOString(),
      distance_km: Number(track.km.toFixed(2)),
      duration_sec: track.durationSec,
      avg_speed_kmh: Number(track.avgSpeedKmh.toFixed(2)),
    };
    const { error } = await this.client.from('tracks').insert(row);
    if (error) throw error;
  }
}

class StatsService {
  constructor(client) {
    this.client = client;
  }

  async personalStats(userId) {
    const { data, error } = await this.client
      .from('tracks')
      .select('distance_km,duration_sec,ended_at')
      .eq('user_id', userId)
      .order('ended_at', { ascending: false });
    if (error) throw error;
    const rows = data || [];
    const totalKm = rows.reduce((s, r) => s + Number(r.distance_km || 0), 0);
    const totalTimeSec = rows.reduce((s, r) => s + Number(r.duration_sec || 0), 0);
    return {
      totalKm: Math.round(totalKm * 100) / 100,
      totalTracks: rows.length,
      totalTimeSec,
      lastRideAt: rows[0]?.ended_at || null,
    };
  }
}

class LeaderboardService {
  constructor(client) {
    this.client = client;
  }

  async top(limit = 15) {
    const { data, error } = await this.client
      .from('leaderboard_km')
      .select('user_id,display_name,total_km,total_tracks')
      .order('total_km', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
}

/* ================================================================
   CICLOANTS — Orchestratore principale
   ================================================================ */
class CicloAnts {
  constructor() {
    this.alpha   = 0.7;
    this.phero   = new PheromoneEngine();
    this.map     = new MapManager();
    this.routing = new RoutingEngine(this.phero);
    this.sim     = new SimulationEngine(this.phero, this.routing, this.map);
    this.track   = new TrackingEngine(this.phero, this.map);
    this.ui      = new UIController(this);
    this.nav     = null;  // NavigationEngine — attivo solo durante la navigazione
    this.sync    = null;  // SupabaseSync — backend condiviso
    this._syncDebounce = null;
    this.sbClient = typeof window.supabase !== 'undefined'
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON)
      : null;
    this.auth = this.sbClient ? new AuthEngine(this.sbClient) : null;
    this.tracks = this.sbClient ? new TrackRepository(this.sbClient) : null;
    this.stats = this.sbClient ? new StatsService(this.sbClient) : null;
    this.leaderboard = this.sbClient ? new LeaderboardService(this.sbClient) : null;
  }

  async init() {
    // Inizializza mappa
    this.map.init();

    // Inizializza UI
    this.ui.init();
    this.ui.renderAuthState();

    // Evaporazione feromoni salvati + aggiornamento heatmap
    this.phero.evaporate();
    this._syncStats();
    this._refreshHeatmap();

    // Connessione Supabase (se disponibile)
    this._initSupabase();
    if (this.auth) {
      await this.auth.init();
      window.addEventListener('cicloants-auth-changed', () => {
        this.refreshUserPanels().catch(() => {});
      });
      this.ui.renderAuthState();
      await this.refreshUserPanels();
    }

    // Evaporazione periodica ogni 5 minuti
    setInterval(() => {
      this.phero.evaporate();
      this._refreshHeatmap();
      this._syncStats();
    }, 5 * 60 * 1000);

    // Auto-localizzazione silenziosa all'avvio (centra la mappa sulla posizione reale)
    this._autoLocateOnStart();

    // Welcome toast
    setTimeout(() => {
      const n = this.phero.count;
      if (n > 0) {
        this.ui.toast(
          `🐜 Benvenuto! Ci sono ${n} feromoni attivi nella memoria collettiva.`,
          'success', 4500
        );
      } else {
        this.ui.toast(
          '🐜 Benvenuto! Clicca 📍 per centrarsi sulla tua posizione, poi A→B per navigare.',
          'info', 5500
        );
      }
    }, 800);
  }

  /**
   * Tenta di centrare la mappa sulla posizione GPS dell'utente all'avvio.
   * Silenziosa: nessun toast di errore se il permesso non è ancora concesso.
   */
  _autoLocateOnStart() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => {
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        this.map.map.setView([pt.lat, pt.lng], 15, { animate: true });
        this.map.updateAccuracyCircle(pt, pos.coords.accuracy);
        // Aggiorna pulsante localizza per mostrare che abbiamo la posizione
        const btn = document.getElementById('btn-locate');
        if (btn) btn.style.boxShadow = '0 0 0 3px rgba(0,229,255,0.4)';
      },
      () => { /* silenzioso all'avvio — l'utente può cliccare 📍 manualmente */ },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /** Avvia connessione Supabase, carica feromoni condivisi, subscribe realtime. */
  async _initSupabase() {
    const syncEl = document.getElementById('stat-sync');
    if (typeof window.supabase === 'undefined') {
      if (syncEl) syncEl.textContent = 'offline';
      return;
    }
    try {
      if (syncEl) syncEl.textContent = '...';
      this.sync = new SupabaseSync(this.phero, () => {
        this._refreshHeatmap();
        this._syncStats();
      });
      this.sync.client = this.sbClient || this.sync.client;
      const n = await this.sync.loadAll();
      this.sync.subscribeRealtime();
      this._refreshHeatmap();
      this._syncStats();
      if (syncEl) syncEl.textContent = '🟢';
      this.ui.toast(`📡 Backend connesso — ${n} feromoni dalla community!`, 'success', 4000);
    } catch (err) {
      console.warn('Supabase init failed:', err.message);
      if (syncEl) syncEl.textContent = '🔴';
      this.ui.toast('Backend offline — feromoni solo locali.', 'warning', 3000);
    }
  }

  /** Aggiorna heatmap Leaflet dai feromoni correnti */
  _refreshHeatmap() {
    this.map.updateHeatmap(this.phero.getHeatmapData());
  }

  /** Sincronizza le statistiche nell'header */
  _syncStats() {
    document.getElementById('stat-pheromones').textContent = this.phero.count.toLocaleString('it');
    document.getElementById('stat-km').textContent = this.phero.kmRegistered;
  }

  async persistTrack(summary) {
    if (!this.auth?.user || !this.tracks) return;
    if (!summary || summary.km < CONFIG.MIN_TRACK_KM) return;
    await this.tracks.saveTrack(this.auth.user.id, summary);
    await this.refreshUserPanels();
  }

  async refreshUserPanels() {
    this.ui.renderAuthState();
    if (!this.auth?.user || !this.stats || !this.leaderboard) return;

    const [personal, board] = await Promise.all([
      this.stats.personalStats(this.auth.user.id),
      this.leaderboard.top(15),
    ]);

    const km = document.getElementById('profile-total-km');
    const tracks = document.getElementById('profile-total-tracks');
    const time = document.getElementById('profile-total-time');
    const last = document.getElementById('profile-last-ride');
    if (km) km.textContent = personal.totalKm.toFixed(1);
    if (tracks) tracks.textContent = String(personal.totalTracks);
    if (time) time.textContent = fmtTime(personal.totalTimeSec);
    if (last) last.textContent = fmtDate(personal.lastRideAt);

    const list = document.getElementById('leaderboard-list');
    if (!list) return;
    list.innerHTML = board.map((row, idx) => `
      <div class="leaderboard-item ${row.user_id === this.auth.user.id ? 'leaderboard-item-me' : ''}">
        <span class="leaderboard-rank">${idx + 1}</span>
        <span class="leaderboard-name">${row.display_name || 'utente'}</span>
        <span class="leaderboard-km">${Number(row.total_km || 0).toFixed(1)} km</span>
      </div>
    `).join('') || '<p class="hint-text">Nessun dato classifica disponibile.</p>';
  }

  resetUserPanels() {
    const km = document.getElementById('profile-total-km');
    const tracks = document.getElementById('profile-total-tracks');
    const time = document.getElementById('profile-total-time');
    const last = document.getElementById('profile-last-ride');
    const board = document.getElementById('leaderboard-list');
    if (km) km.textContent = '0.0';
    if (tracks) tracks.textContent = '0';
    if (time) time.textContent = '0 min';
    if (last) last.textContent = '-';
    if (board) board.innerHTML = '';
  }
}

/* ================================================================
   BOOTSTRAP
   Intercetta il deposito feromoni per aggiornare heatmap in
   tempo reale senza accoppiamento diretto tra Engine e Map.
   ================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const app = new CicloAnts();

  // Patch: aggiorna heatmap + push Supabase dopo ogni deposit()
  const _origDeposit = PheromoneEngine.prototype.deposit;
  PheromoneEngine.prototype.deposit = function (...args) {
    const newPts = _origDeposit.apply(this, args); // ora ritorna array
    // Aggiorna heatmap locale
    if (app.map.heatLayer) {
      app._refreshHeatmap();
      app._syncStats();
    }
    // Push a Supabase con debounce 2s (evita flooding)
    if (Array.isArray(newPts) && newPts.length && app.sync) {
      clearTimeout(app._syncDebounce);
      app._syncDebounce = setTimeout(() => app.sync.push(newPts), 2000);
    }
    return newPts;
  };

  app.init().catch(err => console.error('CicloAnts init error:', err));
});
