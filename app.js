// ---------- CONFIG ----------
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI"; // your key
// If you host this page ON the ESP32 (recommended), leave empty for same‑origin.
// If hosted elsewhere, set to http://ESP_IP and make sure ESP32 sends CORS headers.
const ESP32_BASE    = ""; // e.g., "http://10.58.145.187"

// Cadence for uploads & dashboard refresh
const PUSH_PERIOD   = 60_000; // 60s (you said it's stable now)
const JITTER_MS     = 2_000;  // small random jitter to avoid crowding
const READ_PERIOD   = 60_000; // refresh charts/labels every 60s

// Map your ESP32 JSON to ThingSpeak fields
// Expected JSON from /sensors: { co2, pm1, pm25, pm10, humidity, temperature }
function mapReadingsToThingSpeak(r) {
  return {
    field1: r?.pm1,
    field2: r?.pm25,
    field3: r?.pm10,
    field4: r?.co2,
    field5: r?.temperature,
    field6: r?.humidity
    // field7/8 added from geolocation
  };
}

// ---------- TABS / NAV ----------
const tabGroups = {
  scd30: ['co2', 'temp', 'rh'],
  sps30: ['pm1', 'pm25', 'pm10'],
  mics:  ['gps'] // repurpose tab for GPS
};

function showTab(id, el) {
  hideAllTabs();
  document.getElementById(id).style.display = 'block';
  document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('sensorSelect').value = 'none';
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
  const map = {
    location: "Device Tracking",
    "sensor-overview": "Sensor Overview",
    hardware: "Hardware",
    enclosure: "Enclosure",
    deployment: "Deployment"
  };
  const txt = map[sectionId] || "";
  [...document.querySelectorAll(".navlink")].forEach(l => {
    if (l.textContent.includes(txt)) l.classList.add("active");
  });
}

// ---------- ThingSpeak read (for “Latest” numbers) ----------
async function fetchThingSpeakData() {
  try {
    const res = await fetch(`https://api.thingspeak.com/channels/${TS_CHANNEL_ID}/feeds.json?results=1`, { cache: "no-store" });
    const data = await res.json();
    if (!data || !data.feeds || !data.feeds.length) return;
    const f = data.feeds[0];
    const toNum = v => (v==null || v==="") ? NaN : parseFloat(v);
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('co2val',  isNaN(toNum(f.field4)) ? "—" : toNum(f.field4).toFixed(1));
    set('pm25val', isNaN(toNum(f.field2)) ? "—" : toNum(f.field2).toFixed(1));
    set('pm10val', isNaN(toNum(f.field3)) ? "—" : toNum(f.field3).toFixed(1));
    set('pm1val',  isNaN(toNum(f.field1)) ? "—" : toNum(f.field1).toFixed(1));
    set('tempval', isNaN(toNum(f.field5)) ? "—" : toNum(f.field5).toFixed(1));
    set('humval',  isNaN(toNum(f.field6)) ? "—" : toNum(f.field6).toFixed(1));
    set('latDisp', f.field7 ?? "—");
    set('lonDisp', f.field8 ?? "—");
  } catch (e) {
    console.error("ThingSpeak fetch failed:", e);
  }
}

// ---------- Leaflet map ----------
const map = L.map('map').setView([53.3498, -6.2603], 12); // Dublin default
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap'
}).addTo(map);
let marker = null;

function updateMap(lat, lon, accuracy) {
  if (!marker) {
    marker = L.marker([lat, lon]).addTo(map);
  } else {
    marker.setLatLng([lat, lon]);
  }
  marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy||0)} m`);
  if (map.getZoom() < 14) map.setView([lat, lon], 14, { animate: true });
}

// ---------- Diagnostics helpers ----------
function sameOriginUrl(path) {
  if (!ESP32_BASE) return path.startsWith("/") ? path : `/${path}`;
  return `${ESP32_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
function isHttpsPage() { return location.protocol === "https:"; }
function isHttpTarget(url) {
  try { return new URL(url, location.href).protocol === "http:"; } catch { return false; }
}

// ---------- ESP32 + GPS + ThingSpeak upload ----------
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
  try { return await res.json(); } catch { throw new Error("/sensors returned non‑JSON"); }
}

function getBrowserLocationOnce() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      err => reject(new Error(`GPS error: ${err.message || err.code}`)),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 } // shorter timeout to avoid blocking
    );
  });
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

async function oneShotCycle(updateMapCb, setStatus) {
  const ts = {};

  // 1) Sensors (skip if it fails; still send GPS)
  try {
    const r = await getESP32Readings();
    Object.assign(ts, mapReadingsToThingSpeak(r));
  } catch (e) {
    setStatus(`⚠️ Sensor read skipped: ${e.message}`);
  }

  // 2) GPS
  try {
    const coords = await getBrowserLocationOnce();
    ts.field7 = coords.latitude;
    ts.field8 = coords.longitude;
    updateMapCb(coords.latitude, coords.longitude, coords.accuracy);

    // optional: tell ESP32 location
    const locUrl = sameOriginUrl("/location");
    if (!(isHttpsPage() && isHttpTarget(locUrl))) {
      fetch(locUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: coords.latitude, lon: coords.longitude })
      }).catch(()=>{});
    }
  } catch (e) {
    setStatus(`⚠️ No GPS: ${e.message}`);
  }

  // 3) Make sure there's something to send
  if (!("field7" in ts) && Object.keys(ts).length === 0) {
    throw new Error("Nothing to send (no sensors and no GPS).");
  }

  // 4) Push to ThingSpeak
  const entryId = await sendToThingSpeak(ts);

  // 5) Pull latest immediately so the dashboard reflects the new row
  fetchThingSpeakData().catch(()=>{});

  return entryId;
}

// ---------- Start/Stop handlers with hard gating ----------
let nextTimeout = null;
let isSharing  = false;
let running    = false;
let watchId    = null;

const startBtn  = document.getElementById('startBtn');
const stopBtn   = document.getElementById('stopBtn');
const locStatus = document.getElementById('locStatus');
function setStatus(msg){ locStatus.textContent = msg; console.log("[share]", msg); }

function scheduleNext(baseDelayMs) {
  if (!isSharing) return; // don't schedule if sharing is off
  const jitter = Math.floor(Math.random() * JITTER_MS);
  const delay  = Math.max(5_000, baseDelayMs + jitter);
  nextTimeout  = setTimeout(runUploadOnce, delay);
}

async function runUploadOnce() {
  if (!isSharing) return;           // guard: do nothing if user stopped
  if (running) {                    // should not happen, but be safe
    scheduleNext(PUSH_PERIOD);
    return;
  }
  running = true;
  try {
    const entryId = await oneShotCycle(updateMap, setStatus);
    setStatus(`Sent entry ${entryId} at ${new Date().toLocaleTimeString()}`);
    scheduleNext(PUSH_PERIOD);      // schedule the next tick only if still sharing
  } catch (e) {
    setStatus(`⚠Send failed: ${e.message} — backing off 20s`);
    scheduleNext(20_000);
  } finally {
    running = false;
  }
}

async function startLocation() {
  if (isSharing) return;
  isSharing = true;
  startBtn.disabled = true;
  stopBtn.disabled  = false;

  setStatus("Starting… (first reading)");
  // Kick off immediately; subsequent runs are self-scheduled.
  runUploadOnce();

  // keep map live while sharing
  if ('geolocation' in navigator) {
    watchId = navigator.geolocation.watchPosition(
      pos => updateMap(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }
}

function stopLocation() {
  if (!isSharing) return;
  isSharing = false;
  if (nextTimeout) { clearTimeout(nextTimeout); nextTimeout = null; }
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  setStatus("Location sharing stopped.");

  // notify ESP32 (optional)
  const stopUrl = sameOriginUrl("/stopLocation");
  if (!(isHttpsPage() && isHttpTarget(stopUrl))) {
    fetch(stopUrl, { method: "POST" }).catch(()=>{});
  }
}

// ---------- init ----------
document.addEventListener("DOMContentLoaded", () => {
  showSection('sensor-overview');
  showTab('co2', document.querySelector(".tablink"));
  fetchThingSpeakData();
  setInterval(fetchThingSpeakData, READ_PERIOD); // UI refresh independent of sharing

  // wire up buttons
  document.getElementById('startBtn').addEventListener('click', startLocation);
  document.getElementById('stopBtn').addEventListener('click', stopLocation);
});
