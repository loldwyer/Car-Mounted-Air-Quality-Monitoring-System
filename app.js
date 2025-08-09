
  // ---------- CONFIG ----------
  const TS_CHANNEL_ID = "2960675";
  const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI"; // your key
  // If this page is hosted elsewhere (HTTPS) and ESP32 is HTTP on hotspot, set its base URL:
  // const ESP32_BASE = "http://192.168.4.1";  // example captive portal IP
  const ESP32_BASE    = "";
  const PUSH_PERIOD   = 80_000; // ms

  // ---------- TABS / NAV ----------
  const tabGroups = {
    scd30: ['co2', 'temp', 'rh'],
    sps30: ['pm1', 'pm25', 'pm10'],
    mics:  [] // MiCS is not GPS
  };

  function showTab(id, el) {
    hideAllTabs();
    const tab = document.getElementById(id);
    if (tab) tab.style.display = 'block';
    document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById('sensorSelect').value = 'none';

    if (id === 'gps') ensureMapInit();
  }

  function handleSensorSelect(sensor) {
    hideAllTabs();
    if (sensor in tabGroups) {
      tabGroups[sensor].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'block';
      });
      document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
    }
  }

  function hideAllTabs() {
    document.querySelectorAll('.tabcontent').forEach(el => el.style.display = 'none');
  }

  function showSection(sectionId) {
    document.querySelectorAll("section").forEach(sec => sec.style.display = "none");
    const target = document.getElementById(sectionId);
    if (target) target.style.display = "block";
    document.querySelectorAll(".navlink").forEach(link => link.classList.remove("active"));
    const mapTxt = {
      location: "Device Tracking",
      "sensor-overview": "Sensor Overview",
      hardware: "Hardware",
      enclosure: "Enclosure",
      deployment: "Deployment"
    };
    const txt = mapTxt[sectionId] || "";
    [...document.querySelectorAll(".navlink")].forEach(l => {
      if (l.textContent.includes(txt)) l.classList.add("active");
    });
  }

  // ---------- ThingSpeak read (for “Latest” numbers) ----------
  async function fetchThingSpeakData() {
    try {
      const res = await fetch(`https://api.thingspeak.com/channels/${TS_CHANNEL_ID}/feeds.json?results=1`);
      const data = await res.json();
      if (!data || !data.feeds || !data.feeds.length) return;
      const f = data.feeds[0];
      const toNum = v => (v==null || v==="") ? NaN : parseFloat(v);
      if (document.getElementById('co2val'))   document.getElementById('co2val').textContent   = isNaN(toNum(f.field4)) ? "—" : toNum(f.field4).toFixed(1);
      if (document.getElementById('pm25val'))  document.getElementById('pm25val').textContent  = isNaN(toNum(f.field2)) ? "—" : toNum(f.field2).toFixed(1);
      if (document.getElementById('pm10val'))  document.getElementById('pm10val').textContent  = isNaN(toNum(f.field3)) ? "—" : toNum(f.field3).toFixed(1);
      if (document.getElementById('pm1val'))   document.getElementById('pm1val').textContent   = isNaN(toNum(f.field1)) ? "—" : toNum(f.field1).toFixed(1);
      if (document.getElementById('tempval'))  document.getElementById('tempval').textContent  = isNaN(toNum(f.field5)) ? "—" : toNum(f.field5).toFixed(1);
      if (document.getElementById('humval'))   document.getElementById('humval').textContent   = isNaN(toNum(f.field6)) ? "—" : toNum(f.field6).toFixed(1);
      if (document.getElementById('latDisp'))  document.getElementById('latDisp').textContent  = f.field7 ?? "—";
      if (document.getElementById('lonDisp'))  document.getElementById('lonDisp').textContent  = f.field8 ?? "—";
    } catch (e) {
      console.error("ThingSpeak fetch failed:", e);
    }
  }

  // ---------- Leaflet map (lazy init) ----------
  let mapLeaflet = null;
  let marker = null;

  function ensureMapInit() {
    if (mapLeaflet) return;
    const mapEl = document.getElementById('map');
    if (!mapEl) return;
    mapLeaflet = L.map('map').setView([53.3498, -6.2603], 12); // Dublin default
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(mapLeaflet);
  }

  function updateMap(lat, lon, accuracy) {
    if (!mapLeaflet) return;
    if (!marker) {
      marker = L.marker([lat, lon]).addTo(mapLeaflet);
    } else {
      marker.setLatLng([lat, lon]);
    }
    marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy||0)} m`);
    if (mapLeaflet.getZoom() < 14) mapLeaflet.setView([lat, lon], 14, { animate: true });
  }

  // ---------- Helpers ----------
  function sameOriginUrl(path) {
    if (!ESP32_BASE) return path.startsWith("/") ? path : `/${path}`;
    return `${ESP32_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  }
  function isHttpsPage() { return location.protocol === "https:"; }
  function isHttpTarget(url) {
    try { return new URL(url, location.href).protocol === "http:"; } catch { return false; }
  }

  // ---------- ESP32 + GPS + ThingSpeak upload ----------
  function mapReadingsToThingSpeak(r) {
    return {
      field1: r?.pm1,
      field2: r?.pm25,
      field3: r?.pm10,
      field4: r?.co2,
      field5: r?.temperature,
      field6: r?.humidity
    };
  }

  async function getESP32Readings() {
    const url = sameOriginUrl("/sensors");
    if (isHttpsPage() && isHttpTarget(url)) {
      throw new Error("Blocked: page is HTTPS but ESP32 is HTTP. Host on ESP32 (HTTP) or use a HTTPS proxy.");
    }
    let res;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (e) {
      throw new Error(`/sensors fetch failed (network/CORS): ${e.message}`);
    }
    if (!res.ok) throw new Error(`/sensors HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new Error("/sensors returned non-JSON"); }
  }

  async function sendToThingSpeak(payload) {
    const params = new URLSearchParams({ api_key: TS_WRITE_KEY });
    Object.entries(payload).forEach(([k,v]) => {
      if (v !== undefined && v !== null && v !== "" && Number.isFinite(+v)) params.set(k, String(v));
    });
    const url = `https://api.thingspeak.com/update?${params.toString()}`;
    let res, text;
    try {
      res = await fetch(url, { method: "GET" });
      text = (await res.text()).trim();
    } catch (e) {
      throw new Error(`ThingSpeak fetch failed: ${e.message}`);
    }
    if (text === "0") throw new Error("ThingSpeak rejected update (rate limit or bad key/fields).");
    return text; // entryId
  }

  // Throttled push loop driven by phone GPS updates
  let gpsWatchId = null;
  let lastPush = 0;

  async function handlePosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords || {};
    if (latitude == null || longitude == null) return;
    document.getElementById('latDisp').textContent = latitude.toFixed(6);
    document.getElementById('lonDisp').textContent = longitude.toFixed(6);
    updateMap(latitude, longitude, accuracy);

    const now = Date.now();
    if (now - lastPush < PUSH_PERIOD) return; // throttle
    lastPush = now;

    const status = (msg) => { const el = document.getElementById('gpsStatus'); if (el) el.textContent = msg; };

    const payload = { field7: latitude, field8: longitude };
    try {
      // try to include ESP32 readings if reachable on hotspot
      try {
        const r = await getESP32Readings();
        Object.assign(payload, mapReadingsToThingSpeak(r));
      } catch (e) {
        status(`GPS ok; sensors unavailable (${e.message})`);
      }
      const entry = await sendToThingSpeak(payload);
      status(`Pushed entry #${entry}`);
    } catch (e) {
      const el = document.getElementById('gpsStatus');
      if (el) el.textContent = `Push failed: ${e.message}`;
    }

    // optional: tell ESP32 your latest location (best-effort)
    const locUrl = sameOriginUrl("/location");
    if (!(isHttpsPage() && isHttpTarget(locUrl))) {
      fetch(locUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: latitude, lon: longitude })
      }).catch(()=>{});
    }
  }

  function startGpsTest() {
    ensureMapInit();
    const status = document.getElementById('gpsStatus');
    if (!('geolocation' in navigator)) {
      status.textContent = "Geolocation not supported on this device.";
      return;
    }
    if (gpsWatchId != null) {
      status.textContent = "Already running.";
      return;
    }
    status.textContent = "Starting… allow location access.";
    gpsWatchId = navigator.geolocation.watchPosition(
      handlePosition,
      err => { status.textContent = `GPS error: ${err.message || err.code}`; },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  }

  // ---------- init ----------
  document.addEventListener("DOMContentLoaded", () => {
    showSection('sensor-overview');
    showTab('co2', document.querySelector(".tablink"));

    fetchThingSpeakData();
    setInterval(fetchThingSpeakData, 30000);

    // wire the Start Test button
    const btn = document.getElementById('startGpsBtn');
    if (btn) btn.addEventListener('click', startGpsTest);
  });
