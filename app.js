/************ CONFIG ************/
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const ESP32_BASE    = "";                 // e.g. "http://192.168.4.1"
const PUSH_PERIOD   = 60_000;             // 60 s

/************ STATE ************/
let map, marker;
let shareRunId = 0;           // increments every start/stop to invalidate old work
let isSharing  = false;       // true only while the user opted in
let tickTimer  = null;        // next scheduled tick
let gpsWatchId = null;        // watchPosition id
let currentAbort = null;      // AbortController for in-flight fetches

/************ UI HELPERS ************/
const startBtn   = document.getElementById('startBtn');
const stopBtn    = document.getElementById('stopBtn');
const locStatus  = document.getElementById('locStatus');
function setStatus(msg){ locStatus.textContent = msg; console.log("[share]", msg); }

/************ NAV / TABS ************/
const tabGroups = { scd30: ['co2','temp','rh'], sps30: ['pm1','pm25','pm10'], mics:['gps'] };

function showSection(sectionId) {
  document.querySelectorAll("section").forEach(sec => sec.style.display = "none");
  const target = document.getElementById(sectionId);
  if (target) target.style.display = "block";
  document.querySelectorAll(".navlink").forEach(link => link.classList.remove("active"));
  const mapNames = { location:"Device Tracking", "sensor-overview":"Sensor Overview", hardware:"Hardware", enclosure:"Enclosure", deployment:"Deployment" };
  const txt = mapNames[sectionId] || "";
  [...document.querySelectorAll(".navlink")].forEach(l => { if (l.textContent.includes(txt)) l.classList.add("active"); });
}

function hideAllTabs(){ document.querySelectorAll('.tabcontent').forEach(el => el.style.display = 'none'); }
function showTab(id, el){
  hideAllTabs();
  document.getElementById(id).style.display = 'block';
  document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('sensorSelect').value = 'none';
}
function handleSensorSelect(sensor){
  hideAllTabs();
  if (sensor in tabGroups) {
    tabGroups[sensor].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; });
    document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
  }
}
window.showSection = showSection;
window.showTab = showTab;
window.handleSensorSelect = handleSensorSelect;

/************ MAP ************/
function initMap() {
  map = L.map('map').setView([53.3498, -6.2603], 12); // Dublin default
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
}
function updateMap(lat, lon, accuracy) {
  if (!map) return;
  if (!marker) marker = L.marker([lat, lon]).addTo(map);
  marker.setLatLng([lat, lon]);
  marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy||0)} m`);
  if (map.getZoom() < 14) map.setView([lat, lon], 14, { animate: true });
}

/************ THINGSPEAK READ (for “Latest” labels) ************/
async function fetchThingSpeakData() {
  try {
    const res = await fetch(`https://api.thingspeak.com/channels/${TS_CHANNEL_ID}/feeds.json?results=1`, { cache: "no-store" });
    const data = await res.json();
    if (!data || !data.feeds || !data.feeds.length) return;
    const f = data.feeds[0];
    const toNum = v => (v==null || v==="") ? NaN : parseFloat(v);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('co2val',  isNaN(toNum(f.field4)) ? "—" : toNum(f.field4).toFixed(1));
    set('pm25val', isNaN(toNum(f.field2)) ? "—" : toNum(f.field2).toFixed(1));
    set('pm10val', isNaN(toNum(f.field3)) ? "—" : toNum(f.field3).toFixed(1));
    set('pm1val',  isNaN(toNum(f.field1)) ? "—" : toNum(f.field1).toFixed(1));
    set('tempval', isNaN(toNum(f.field5)) ? "—" : toNum(f.field5).toFixed(1));
    set('humval',  isNaN(toNum(f.field6)) ? "—" : toNum(f.field6).toFixed(1));
    const latEl = document.getElementById('latDisp'); if (latEl) latEl.textContent = f.field7 ?? "—";
    const lonEl = document.getElementById('lonDisp'); if (lonEl) lonEl.textContent = f.field8 ?? "—";
  } catch (e) {
    console.warn("ThingSpeak read failed:", e);
  }
}

/************ UTIL ************/
function sameOriginUrl(path) {
  if (!ESP32_BASE) return path.startsWith("/") ? path : `/${path}`;
  return `${ESP32_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
function isHttpsPage() { return location.protocol === "https:"; }
function isHttpTarget(url) {
  try { return new URL(url, location.href).protocol === "http:"; } catch { return false; }
}

/************ SENSORS + GPS + UPLOAD ************/
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

async function getESP32Readings(signal) {
  const url = sameOriginUrl("/sensors");
  if (isHttpsPage() && isHttpTarget(url)) {
    throw new Error("Blocked: page is HTTPS but ESP32 is HTTP. Host on ESP32 (HTTP) or use a HTTPS proxy.");
  }
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`/sensors HTTP ${res.status}`);
  return res.json();
}

function getBrowserLocationOnce() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      err => reject(new Error(`GPS error: ${err.message || err.code}`)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

async function sendToThingSpeak(payload, signal) {
  const params = new URLSearchParams({ api_key: TS_WRITE_KEY });
  Object.entries(payload).forEach(([k,v]) => {
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(+v)) params.set(k, String(v));
  });
  const url = `https://api.thingspeak.com/update?${params.toString()}`;
  const res = await fetch(url, { method: "GET", signal });
  const text = (await res.text()).trim();
  if (text === "0") throw new Error("ThingSpeak rejected update (rate limit or bad key/fields).");
  return text; // entryId
}

/**
 * Single upload cycle guarded by run id and abort signal.
 */
async function oneShotCycle(myRunId) {
  // Bail early if the session is no longer active
  if (!isSharing || myRunId !== shareRunId) return;

  // New abort controller for *this* cycle
  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();
  const { signal } = currentAbort;

  const ts = {};

  // 1) Sensors (optional)
  try {
    const r = await getESP32Readings(signal);
    Object.assign(ts, mapReadingsToThingSpeak(r));
  } catch (e) {
    setStatus(`⚠️ Sensor read skipped: ${e.message}`);
  }

  // 2) GPS (optional)
  try {
    const coords = await getBrowserLocationOnce();
    ts.field7 = coords.latitude;
    ts.field8 = coords.longitude;
    updateMap(coords.latitude, coords.longitude, coords.accuracy);

    // Optional: tell ESP32 location (best-effort)
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

  // If user stopped while we were working, do not send
  if (!isSharing || myRunId !== shareRunId) return;

  // 3) Make sure there's something to send
  if (!("field7" in ts) && Object.keys(ts).length === 0) {
    throw new Error("Nothing to send (no sensors and no GPS).");
  }

  // 4) Push to ThingSpeak
  const entryId = await sendToThingSpeak(ts, signal);
  return entryId;
}

/************ START/STOP ************/
async function startLocation() {
  if (isSharing) return;
  isSharing = true;
  shareRunId++;                 // new run id
  const myRunId = shareRunId;   // capture
  startBtn.disabled = true;
  stopBtn.disabled  = false;

  // Live map updates during sharing
  if ('geolocation' in navigator && gpsWatchId === null) {
    gpsWatchId = navigator.geolocation.watchPosition(
      pos => updateMap(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  setStatus("Starting… (first reading)");
  try {
    const entryId = await oneShotCycle(myRunId);
    if (isSharing && myRunId === shareRunId) {
      setStatus(`✅ Sent entry ${entryId}. Next in ${PUSH_PERIOD/1000}s.`);
    }
  } catch (e) {
    setStatus(`❌ First send failed: ${e.message}`);
    // Stop immediately on failure to avoid half-broken runs
    stopLocation();
    return;
  }

  // Use a self-scheduling timeout to avoid overlapping cycles
  const scheduleNext = () => {
    if (!isSharing || myRunId !== shareRunId) return;
    tickTimer = setTimeout(async () => {
      try {
        const entryId = await oneShotCycle(myRunId);
        if (isSharing && myRunId === shareRunId) {
          setStatus(`✅ Sent entry ${entryId} at ${new Date().toLocaleTimeString()}`);
        }
      } catch (e) {
        if (isSharing && myRunId === shareRunId) {
          setStatus(`⚠️ Send failed: ${e.message} — retrying in ${PUSH_PERIOD/1000}s`);
        }
      } finally {
        scheduleNext();
      }
    }, PUSH_PERIOD);
  };
  scheduleNext();
}

function stopLocation() {
  if (!isSharing) return;
  isSharing = false;
  shareRunId++;                 // invalidate any in-flight work

  // Clear timers and live watch
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }

  // Abort current fetches (sensor / ThingSpeak)
  if (currentAbort) { try { currentAbort.abort(); } catch {} finally { currentAbort = null; } }

  startBtn.disabled = false;
  stopBtn.disabled  = true;
  setStatus("Location sharing stopped. No further uploads will occur.");
}

/************ WIRE BUTTONS ************/
startBtn.addEventListener('click', startLocation);
stopBtn .addEventListener('click', stopLocation);

/************ INIT ************/
document.addEventListener("DOMContentLoaded", () => {
  showSection('sensor-overview');
  const firstTabBtn = document.querySelector(".tablink");
  if (firstTabBtn) showTab('co2', firstTabBtn);
  initMap();
  fetchThingSpeakData();
  // Refresh “Latest” labels periodically (read-only; harmless)
  setInterval(fetchThingSpeakData, 80_000);
});
