/************ CONFIG ************/
const ESP32_BASE    = "";          // if hosting this page elsewhere, set to "http://<esp32-ip>"
const TS_CHANNEL_ID = "2960675";   // for read-only UI updates
const PUSH_PERIOD   = 60_000;      // GPS send cadence (matches ESP32 ThingSpeak cadence)
const READ_PERIOD   = 60_000;      // UI “Latest” read cadence

/************ STATE ************/
let map, marker;
let isSharing   = false;
let runId       = 0;
let tickTimer   = null;
let gpsWatchId  = null;

/************ ELEMENTS ************/
const startBtn  = document.getElementById('startBtn');
const stopBtn   = document.getElementById('stopBtn');
const locStatus = document.getElementById('locStatus');
const setStatus = (m) => { locStatus.textContent = m; console.log("[share]", m); };

/************ NAV / TABS (exposed for onclick in HTML) ************/
const tabGroups = { scd30:['co2','temp','rh'], sps30:['pm1','pm25','pm10'], mics:['gps'] };

window.showSection = function showSection(sectionId){
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
    tabGroups[sensor].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; });
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

/************ READ (UI labels only; safe anytime) ************/
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

/************ GPS send to ESP32 ************/
function getBrowserLocationOnce() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      err => reject(new Error(`GPS error: ${err.message || err.code}`)),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

async function sendLocationToESP() {
  // Called each PUSH tick while sharing
  try {
    const coords = await getBrowserLocationOnce();
    updateMap(coords.latitude, coords.longitude, coords.accuracy);

    const locUrl = sameOriginUrl("/location");
    // avoid HTTPS->HTTP mixed content block
    if (!(isHttpsPage() && isHttpTarget(locUrl))) {
      await fetch(locUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: coords.latitude, lon: coords.longitude })
      });
    }
  } catch (e) {
    setStatus(`⚠️ No GPS: ${e.message}`);
  }
}

/************ START / STOP: this is where we call the new endpoints ************/
/************ START / STOP ************/
async function startUploads() {
  if (isSharing) return;
  isSharing = true;
  runId += 1;
  const myRun = runId;

  startBtn.disabled = true;
  stopBtn.disabled  = false;

  try {
    await fetch(sameOriginUrl("/startUploads"), { method: "POST" });
  } catch (e) {
    setStatus("Couldn’t reach device to start uploads.");
  }

  setStatus("Starting… (first reading)");
  await sendLocationToESP(); // seed ESP with lat/lon right away

  if ('geolocation' in navigator && gpsWatchId === null) {
    gpsWatchId = navigator.geolocation.watchPosition(
      pos => updateMap(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  const scheduleNext = () => {
    if (!isSharing || myRun !== runId) return;
    tickTimer = setTimeout(async () => {
      await sendLocationToESP();
      scheduleNext();
    }, PUSH_PERIOD);
  };
  scheduleNext();
}

async function stopUploads() {
  if (!isSharing) return;
  isSharing = false;
  runId += 1;

  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }

  startBtn.disabled = false;
  stopBtn.disabled  = true;

  try {
    await fetch(sameOriginUrl("/stopUploads"),  { method: "POST" });
    await fetch(sameOriginUrl("/stopLocation"), { method: "POST" }); // be explicit
  } catch (e) {
    // non-fatal; we’re already stopped locally
  }

  setStatus("Location sharing stopped. No further uploads will occur.");
}

/************ INIT ************/
document.addEventListener("DOMContentLoaded", async () => {
  showSection('sensor-overview');
  const firstTabBtn = document.querySelector(".tablink");
  if (firstTabBtn) showTab('co2', firstTabBtn);
  initMap();
  fetchThingSpeakData();
  setInterval(fetchThingSpeakData, READ_PERIOD);

  // OPTIONAL: sync button state with ESP if the page reloads mid‑run
  try {
    const r = await fetch(sameOriginUrl("/status"));
    const s = await r.json(); // { uploadsEnabled: bool }
    if (s.uploadsEnabled) {
      // reflect running state without re-posting start
      isSharing = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      setStatus("Sharing already active (restored).");
      // resume watch + GPS tick loop
      if ('geolocation' in navigator && gpsWatchId === null) {
        gpsWatchId = navigator.geolocation.watchPosition(
          pos => updateMap(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
          () => {},
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );
      }
      // kick a send so ESP gets fresh lat/lon
      await sendLocationToESP();
      const scheduleNext = () => {
        if (!isSharing) return;
        tickTimer = setTimeout(async () => {
          await sendLocationToESP();
          scheduleNext();
        }, PUSH_PERIOD);
      };
      scheduleNext();
    }
  } catch {}
});
