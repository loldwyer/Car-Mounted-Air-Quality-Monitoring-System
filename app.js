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
    set
