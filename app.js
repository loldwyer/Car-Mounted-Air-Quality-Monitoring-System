/************ CONFIG ************/
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const ESP32_BASE    = "";                 // e.g. "http://192.168.4.1"
const PUSH_PERIOD   = 60_000;             // 60 s
const READ_PERIOD   = 60_000;             // UI refresh (read-only)

/************ STATE ************/
let map, marker;
let isSharing   = false;  // true only while the user opted in
let runId       = 0;      // increments on each start/stop; old work is ignored
let tickTimer   = null;   // next scheduled tick
let gpsWatchId  = null;   // watchPosition id
let abortCtl    = null;   // AbortController for in-flight fetches

// Cross-tab coordination: only one tab allowed to upload at a time
const bc = new BroadcastChannel("aq_share");
bc.onmessage = (ev) => {
  if (ev.data?.type === "share-state" && ev.data.runId !== runId) {
    // Some other tab changed state
    if (ev.data.isSharing && isSharing) {
      // Another tab started; we yield
      stopUploads("Another tab is now sharing; stopping this tab.");
    }
  }
};
function broadcastState() {
  bc.postMessage({ type: "share-state", isSharing, runId, ts: Date.now() });
}

/************ UI ELEMENTS ************/
const startBtn   = document.getElementById('startBtn');
const stopBtn    = document.getElementById('stopBtn');
const locStatus  = document.getElementById('locStatus');
function setStatus(msg){ locStatus.textContent = msg; console.log("[share]", msg); }

/************ NAV / TABS (exposed globally for HTML onclick) ************/
const tabGroups = { scd30: ['co2','temp','rh'], sps30: ['pm1','pm25','pm10'], mics:['gps'] };

window.showSection = function showSection(sectionId) {
  document.querySelectorAll("section").forEach(sec => sec.style.display = "none");
  const target = document.getElementById(sectionId);
  if (target) target.style.display = "block";
  document.querySelectorAll(".navlink").forEach(link => link.classList.remove("active"));
  const mapNames = { location:"Device Tracking", "sensor-overview":"Sensor Overview", hardware:"Hardware", enclosure:"Enclosure", deployment:"Deployment" };
  const txt = mapNames[sectionId] || "";
  [...document.querySelectorAll(".navlink")].forEach(l => { if (l.textContent.includes(txt)) l.classList.add("active"); });
};

window.showTab = function showTab(id, el){
  document.querySelectorAll('.tabcontent').forEach(el => el.style.display = 'none');
  const panel = document.getElementById(id);
  if (panel) panel.style.display = 'block';
  document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
  if (el) el.classList.add('active');
  const sel = document.getElementById('sensorSelect'); if (sel) sel.value = 'none';
};

window.handleSensorSelect = function handleSensorSelect(sensor){
  document.querySelectorAll('.tabcontent').forEach(el => el.style.display = 'none');
  if (sensor in tabGroups) {
    tabGroups[sensor].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'block';
    });
    document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
  }
};

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

/************ READ (UI labels) ************/
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

/************ HELPERS ************/
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
  // HARD GATE: never send if not sharing right now
  if (!isSharing) throw new Error("Not sharing; upload suppressed.");

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

async function uploadTick(myRunId) {
  // If user stopped or different run, bail immediately
  if (!isSharing || myRunId !== runId) return;

  // Abort any previous in-flight operations
  if (abortCtl) try { abortCtl.abort(); } catch {} finally {}
  abortCtl = new AbortController();
  const { signal } = abortCtl;

  const ts = {};

  // 1) Sensors
  try {
    const r = await getESP32Readings(signal);
    Object.assign(ts, mapReadingsToThingSpeak(r));
  } catch (e) {
    setStatus(`⚠️ Sensor read skipped: ${e.message}`);
  }

  // 2) GPS
  try {
    const coords = await getBrowserLocationOnce();
    ts.field7 = coords.latitude;
    ts.field8 = coords.longitude;
    updateMap(coords.latitude, coords.longitude, coords.accuracy);

    // Optional: tell ESP32 location (best-effort; local only)
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

  // 3) If stopped mid-way, do NOT upload
  if (!isSharing || myRunId !== runId) return;

  // 4) Ensure we actually have something to send
  if (!("field7" in ts) && Object.keys(ts).length === 0) {
    throw new Error("Nothing to send (no sensors and no GPS).");
  }

  // 5) Upload
  const entryId = await sendToThingSpeak(ts, signal);

  // 6) Update UI labels immediately
  fetchThingSpeakData().catch(()=>{});

  return entryId;
}

/************ SCHEDULER ************/
function scheduleNext(myRunId) {
  if (!isSharing || myRunId !== runId) return;
  tickTimer = setTimeout(async () => {
    try {
      const id = await uploadTick(myRunId);
      if (isSharing && myRunId === runId) {
        setStatus(`✅ Sent entry ${id} at ${new Date().toLocaleTimeString()}`);
      }
    } catch (e) {
      if (isSharing && myRunId === runId) {
        setStatus(`⚠️ Send failed: ${e.message}`);
      }
    } finally {
      scheduleNext(myRunId);
    }
  }, PUSH_PERIOD);
}

/************ START / STOP ************/
async function startUploads() {
  if (isSharing) return;
  isSharing = true;
  runId += 1;
  const myRunId = runId;

  startBtn.disabled = true;
  stopBtn.disabled  = false;
  broadcastState();

  // Watch GPS while sharing
  if ('geolocation' in navigator && gpsWatchId === null) {
    gpsWatchId = navigator.geolocation.watchPosition(
      pos => updateMap(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  setStatus("Starting… (first reading)");
  try {
    const id = await uploadTick(myRunId);
    if (isSharing && myRunId === runId) {
      setStatus(`✅ Sent entry ${id}. Next in ${PUSH_PERIOD/1000}s.`);
    }
  } catch (e) {
    setStatus(`❌ First send failed: ${e.message}`);
    stopUploads(); // abort the session if the first send fails
    return;
  }

  scheduleNext(myRunId);
}

function stopUploads(reason = "Location sharing stopped.") {
  if (!isSharing) return;
  isSharing = false;
  runId += 1; // invalidate any in-flight work

  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
  if (abortCtl) { try { abortCtl.abort(); } catch {} finally { abortCtl = null; } }

  startBtn.disabled = false;
  stopBtn.disabled  = true;
  setStatus(reason);
  broadcastState();
}

/************ WIRE BUTTONS ************/
startBtn.addEventListener('click', startUploads);
stopBtn .addEventListener('click', () => stopUploads());

/************ INIT ************/
document.addEventListener("DOMContentLoaded", () => {
  showSection('sensor-overview');
  const firstTabBtn = document.querySelector(".tablink");
  if (firstTabBtn) showTab('co2', firstTabBtn);
  initMap();
  fetchThingSpeakData();
  setInterval(fetchThingSpeakData, READ_PERIOD); // read-only
});
