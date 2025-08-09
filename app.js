/* ====== CONFIG ====== */
// Use your ESP32's IP printed on Serial monitor (or mDNS if set up).
// Example: 'http://192.168.1.123'  or  'http://esp32.local'
const ESP32_BASE = 'http://192.168.1.123';

/* ====== UI / SECTIONS ====== */
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const locStatus = document.getElementById('locStatus');

function showSection(id) {
  document.querySelectorAll('section').forEach(s => s.style.display = (s.id === id ? 'block' : 'none'));
  document.querySelectorAll('.topnav a').forEach(a => a.classList.toggle('active', a.getAttribute('onclick').includes(`'${id}'`)));
}
// default
showSection('sensor-overview');

/* ====== MAP ====== */
let map, marker;
(function initMap(){
  map = L.map('map').setView([53.3498, -6.2603], 12); // Dublin-ish default
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
})();

/* ====== HELPERS ====== */
const post = (path, data) =>
  fetch(`${ESP32_BASE}${path}`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: data ? JSON.stringify(data) : ''
  });

/* ====== GEO/UPLOAD CONTROL ====== */
let watchId = null;

async function startSharing() {
  // 1) Tell ESP32 to begin ThingSpeak uploads
  try {
    await post('/startUploads');
  } catch(e) {
    console.error('startUploads failed:', e);
  }

  // 2) Start watching browser location and stream to ESP32
  if (!navigator.geolocation) {
    locStatus.textContent = 'Geolocation not supported by this browser.';
    return;
  }

  locStatus.textContent = 'Sharing location… and uploading to ThingSpeak every 60s.';
  startBtn.disabled = true;
  stopBtn.disabled = false;

  watchId = navigator.geolocation.watchPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    // Update map
    if (!marker) {
      marker = L.marker([latitude, longitude]).addTo(map);
    } else {
      marker.setLatLng([latitude, longitude]);
    }
    map.setView([latitude, longitude], map.getZoom());

    // Send to ESP32 -> /location
    try {
      await post('/location', { lat: latitude, lon: longitude });
    } catch (e) {
      console.error('POST /location failed:', e);
    }
  }, (err) => {
    console.warn('Geolocation error:', err);
    locStatus.textContent = 'Unable to get location. Check permissions.';
  }, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 10000
  });
}

async function stopSharing() {
  // Stop browser GPS streaming
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  // Tell ESP32 to stop using GPS & stop uploads
  try { await post('/stopLocation'); } catch(e) { console.error(e); }
  try { await post('/stopUploads'); }  catch(e) { console.error(e); }

  locStatus.textContent = 'Location not shared.';
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

/* ====== BUTTON HOOKS ====== */
startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', stopSharing);

/* ====== TABS (optional minimal handlers) ====== */
function showTab(id, btn) {
  document.querySelectorAll('.tabcontent').forEach(el => el.style.display = 'none');
  document.getElementById(id).style.display = 'block';
  document.querySelectorAll('.tablink').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
window.showTab = showTab;     // expose for inline onclick in HTML
window.showSection = showSection;

// Default open the first tab if you like
const firstTabBtn = document.querySelector('.tablink');
if (firstTabBtn) firstTabBtn.click();

/* ====== SENSOR OVERVIEW NUMBERS (optional: pull from ESP32 /sensors) ====== */
async function refreshLatest() {
  try {
    const r = await fetch(`${ESP32_BASE}/sensors`);
    if (!r.ok) return;
    const j = await r.json();

    if (j.co2 !== undefined)  document.getElementById('co2val').textContent  = j.co2.toFixed(1);
    if (j.pm25 !== undefined) document.getElementById('pm25val').textContent = j.pm25.toFixed(1);
    if (j.pm10 !== undefined) document.getElementById('pm10val').textContent = j.pm10.toFixed(1);
    if (j.pm1 !== undefined)  document.getElementById('pm1val').textContent  = j.pm1.toFixed(1);
    if (j.temperature !== undefined) document.getElementById('tempval').textContent = j.temperature.toFixed(1);
    if (j.humidity !== undefined)    document.getElementById('humval').textContent  = j.humidity.toFixed(1);
  } catch (e) {
    // silent fail is fine for now
  }
}
setInterval(refreshLatest, 5000);
refreshLatest();
