/* =========================================================
 * Car-Mounted Air Quality Dashboard — app.js
 * - Hooks "Share my location" / "Stop sharing" to ESP32:
 *     POST /startUploads, /stopUploads, /location, /stopLocation
 * - Streams browser GPS to ESP32 while sharing is active
 * - Shows Leaflet map + latest sensor numbers from /sensors
 * - Exposes showSection/showTab/handleSensorSelect for HTML
 * ========================================================= */

/* ====== CONFIG ====== */
/**
 * Set your ESP32 base URL (printed on Serial as "ESP32 IP address").
 * You can also override at runtime with:
 *   - URL param: ?esp=http://192.168.1.123
 *   - or persisted in localStorage: localStorage.setItem('esp32_base', 'http://192.168.1.123')
 */
const DEFAULT_ESP32_BASE = 'http://192.168.1.123';

function getESP32Base() {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get('esp');
  if (fromQuery) {
    localStorage.setItem('esp32_base', fromQuery);
    return fromQuery.replace(/\/+$/, '');
  }
  const fromStorage = localStorage.getItem('esp32_base');
  return (fromStorage || DEFAULT_ESP32_BASE).replace(/\/+$/, '');
}
let ESP32_BASE = getESP32Base();

/* ====== DOM ====== */
const startBtn   = document.getElementById('startBtn');
const stopBtn    = document.getElementById('stopBtn');
const locStatus  = document.getElementById('locStatus');
const mapEl      = document.getElementById('map');

// Sensor value spans (if present)
const co2Span  = document.getElementById('co2val');
const pm25Span = document.getElementById('pm25val');
const pm10Span = document.getElementById('pm10val');
const pm1Span  = document.getElementById('pm1val');
const tempSpan = document.getElementById('tempval');
const humSpan  = document.getElementById('humval');
const latDisp  = document.getElementById('latDisp');
const lonDisp  = document.getElementById('lonDisp');

/* ====== SECTION NAV ====== */
function showSection(id) {
  document.querySelectorAll('section').forEach(sec => {
    sec.style.display = (sec.id === id) ? 'block' : 'none';
  });
  // update topnav highlight
  document.querySelectorAll('.topnav a.navlink').forEach(a => {
    const isMe = a.getAttribute('onclick')?.includes(`'${id}'`);
    a.classList.toggle('active', !!isMe);
  });
}
window.showSection = showSection;

/* ====== TABS ====== */
function showTab(id, btnEl) {
  document.querySelectorAll('.tabcontent').forEach(el => el.style.display = 'none');
  const target = document.getElementById(id);
  if (target) target.style.display = 'block';
  document.querySelectorAll('.tablink').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
}
window.showTab = showTab;

/* Optional: filter group by sensor (you can extend as needed) */
function handleSensorSelect(value) {
  // Minimal UX: jump to a sensible tab for the chosen sensor
  const map = {
    scd30: 'co2',
    sps30: 'pm25',
    mics: 'gps' // or another tab if you later show NO2
  };
  const tabId = map[value];
  if (tabId) {
    const btn = document.querySelector(`.tablink[onclick*="${tabId}"]`);
    showTab(tabId, btn);
  }
}
window.handleSensorSelect = handleSensorSelect;

/* ====== MAP ====== */
let map, marker;
(function initMap() {
  if (!mapEl) return;
  const defaultLatLng = [53.3498, -6.2603]; // Dublin default
  map = L.map('map').setView(defaultLatLng, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
})();

/* ====== HTTP HELPERS ====== */
async function post(path, data) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${ESP32_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : '',
      signal: controller.signal
    });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function getJSON(path) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${ESP32_BASE}${path}`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/* ====== GEO / UPLOAD CONTROL ====== */
let watchId = null;

async function startSharing() {
  // Kick off uploads on the ESP32
  try {
    await post('/startUploads');
  } catch (e) {
    console.error('POST /startUploads failed:', e);
    toast('Could not reach ESP32 (/startUploads). Check ESP32_BASE or Wi‑Fi.');
  }

  // Start geolocation stream
  if (!navigator.geolocation) {
    locStatus.textContent = 'Geolocation not supported by this browser.';
    return;
  }

  startBtn.disabled = true;
  stopBtn.disabled = false;
  locStatus.textContent = 'Sharing location… ESP32 will upload every 60s while active.';

  watchId = navigator.geolocation.watchPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;

    // Update map + marker
    if (map) {
      if (!marker) {
        marker = L.marker([latitude, longitude]).addTo(map);
      } else {
        marker.setLatLng([latitude, longitude]);
      }
      map.setView([latitude, longitude], map.getZoom());
    }

    // Update GPS readout (tab)
    if (latDisp) latDisp.textContent = latitude.toFixed(6);
    if (lonDisp) lonDisp.textContent = longitude.toFixed(6);

    // Send to ESP32 (/location)
    try {
      await post('/location', { lat: latitude, lon: longitude });
    } catch (e) {
      console.warn('POST /location failed:', e);
    }
  }, (err) => {
    console.warn('Geolocation error:', err);
    locStatus.textContent = 'Unable to get location. Check browser permissions.';
  }, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 10000
  });
}

async function stopSharing() {
  // Stop browser GPS
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  // Tell ESP32 to stop using GPS and stop ThingSpeak uploads
  try { await post('/stopLocation'); } catch (e) { console.warn(e); }
  try { await post('/stopUploads');  } catch (e) { console.warn(e); }

  // Reset UI
  locStatus.textContent = 'Location not shared.';
  startBtn.disabled = false;
  stopBtn.disabled = true;

  // Clear map marker but keep the map
  if (marker) {
    try { map.removeLayer(marker); } catch {}
    marker = null;
  }
  if (latDisp) latDisp.textContent = '—';
  if (lonDisp) lonDisp.textContent = '—';
}

/* ====== SENSOR OVERVIEW NUMBERS ====== */
async function refreshLatest() {
  try {
    const j = await getJSON('/sensors');
    if (j.co2        != null && co2Span)  co2Span.textContent  = Number(j.co2).toFixed(1);
    if (j.pm25       != null && pm25Span) pm25Span.textContent = Number(j.pm25).toFixed(1);
    if (j.pm10       != null && pm10Span) pm10Span.textContent = Number(j.pm10).toFixed(1);
    if (j.pm1        != null && pm1Span)  pm1Span.textContent  = Number(j.pm1).toFixed(1);
    if (j.temperature!= null && tempSpan) tempSpan.textContent = Number(j.temperature).toFixed(1);
    if (j.humidity   != null && humSpan)  humSpan.textContent  = Number(j.humidity).toFixed(1);
  } catch (e) {
    // silent fail is fine; avoid console spam
  }
}

/* ====== TOAST (tiny helper) ====== */
function toast(msg, ms = 3500) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '24px';
    el.style.transform = 'translateX(-50%)';
    el.style.padding = '10px 14px';
    el.style.borderRadius = '10px';
    el.style.background = 'rgba(0,0,0,0.8)';
    el.style.color = '#fff';
    el.style.font = '14px system-ui, sans-serif';
    el.style.zIndex = '9999';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, ms);
}

/* ====== BOOTSTRAP ====== */
function onReady() {
  // Default section & tab
  showSection('sensor-overview');
  const firstTabBtn = document.querySelector('.tablink');
  if (firstTabBtn) firstTabBtn.click();

  // Button hooks
  if (startBtn) startBtn.addEventListener('click', startSharing);
  if (stopBtn)  stopBtn.addEventListener('click',  stopSharing);

  // Quick connectivity ping (optional)
  getJSON('/ping')
    .then(() => console.log(`ESP32 reachable at ${ESP32_BASE}`))
    .catch(() => toast('ESP32 not reachable. Set correct IP via ?esp=http://x.x.x.x'));

  // Periodic sensor refresh
  refreshLatest();
  setInterval(refreshLatest, 5000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady);
} else {
  onReady();
}
