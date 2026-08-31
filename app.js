const SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const RX_CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";
const TX_CHAR_UUID = "19b10002-e8f2-537e-4f6c-d104768a1214";

// Firmware defaults — must match AP_SSID/AP_PASSWORD and the WebSocket port in RADIOv2.ino
const WIFI_WS_URL = "ws://192.168.4.1:81/";
const SERIAL_BAUD = 115200;

let txCharacteristic = null;
let rxCharacteristic = null;
let bluetoothDevice  = null;
let selfNodeId        = null;
let selfLatLon         = null; // { lat, lon } — last known own position

// ─── Active transport state ────────────────────────────────────────────────
// 'ble' | 'wifi' | 'serial' | null — set by the transport picker before Connect
let activeTransport = null;

let wsSocket = null;

let serialPort   = null;
let serialWriter = null;
let serialReader = null;
let serialReadLoopActive = false;

// ─── Write queue — prevents concurrent writes on any transport from dropping ──
let writeQueue = Promise.resolve();

// Unread message tracking state
let unreadCount = 0;
let isChatOpen = false;

// Directed (non-broadcast) chat messages awaiting a CHATOK/CHATFAIL reply.
// The firmware only tracks one outstanding ack at a time, so in practice
// this stays short — but a small FIFO queue per target keeps it correct
// even if a couple of sends land close together.
let pendingDirectedMsgs = [];

function resolvePendingDirected(node, status) {
    const idx = pendingDirectedMsgs.findIndex(m => m.target === node);
    if (idx === -1) return;
    const [msg] = pendingDirectedMsgs.splice(idx, 1);
    msg.el.dataset.status = status;
    updateMsgStatusLine(msg.el);
}

function toggleChatDrawer() {
    const drawer = document.getElementById('chatDrawer');
    isChatOpen = !isChatOpen;
    drawer.classList.toggle('open', isChatOpen);

    if (isChatOpen) {
        unreadCount = 0;
        updateUnreadBadge();
    }
}

function updateUnreadBadge() {
    const badge = document.getElementById('unreadBadge');
    if (unreadCount > 0) {
        badge.textContent = unreadCount;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// Intercept incoming bubbles to update the unread badge if drawer is closed
const originalInsertBubble = insertBubble;
insertBubble = function(direction, sender, text, meta) {
    const el = originalInsertBubble(direction, sender, text, meta);
    if (!isChatOpen && direction === 'received') {
        unreadCount++;
        updateUnreadBadge();
    }
    return el;
};

// Ensure map recalculates size when window or orientation changes
window.addEventListener('resize', () => {
    if (map) {
        map.invalidateSize();
    }
});

function transportWrite(text) {
    writeQueue = writeQueue.then(async () => {
        if (activeTransport === 'ble') {
            await rxCharacteristic.writeValueWithoutResponse(encoder.encode(text));
        } else if (activeTransport === 'wifi') {
            if (!wsSocket || wsSocket.readyState !== WebSocket.OPEN) {
                throw new Error('WebSocket not open');
            }
            wsSocket.send(text);
        } else if (activeTransport === 'serial') {
            if (!serialWriter) throw new Error('Serial port not open');
            await serialWriter.write(encoder.encode(text + '\n'));
        } else {
            throw new Error('No transport connected');
        }
    }).catch(e => {
        console.error(`${activeTransport || 'transport'} write failed:`, e);
        // Reset the queue itself to a resolved state so one failed write
        // doesn't permanently wedge every future send behind a rejected promise.
        writeQueue = Promise.resolve();
        throw e; // re-throw so callers (e.g. sendMessage) know the write did NOT go out
    });
    return writeQueue;
}

const chatWindow   = document.getElementById('chatWindow');
const targetInput  = document.getElementById('targetId');
const messageInput = document.getElementById('messageInput');
const sendBtn      = document.getElementById('sendBtn');
const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const nodeTitle    = document.getElementById('nodeTitle');
const skylancer    = document.getElementById('skylancer');
const connectBtn   = document.getElementById('connectBtn');
const mapNodeCount = document.getElementById('mapNodeCount');
const nodeNameBadge     = document.getElementById('nodeNameBadge');
const nodeNameBadgeText = document.getElementById('nodeNameBadgeText');
const dayNightToggle    = document.getElementById('dayNightToggle');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

// ─── Grid Reference (UTM / Indian UGRS) ──────────────────────────────────────
function latLonToUTM(lat, lon, forceZone) {
    const a  = 6378137.0;
    const f  = 1 / 298.257223563;
    const k0 = 0.9996;
    const e2 = f * (2 - f);
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    const ep2 = e2 / (1 - e2);

    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;

    let zone = forceZone || (Math.floor((lon + 180) / 6) + 1);
    if (!forceZone) {
        if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
        if (lat >= 72 && lat < 84) {
            if (lon >= 0 && lon < 9)       zone = 31;
            else if (lon >= 9 && lon < 21) zone = 33;
            else if (lon >= 21 && lon < 33) zone = 35;
            else if (lon >= 33 && lon < 42) zone = 37;
        }
    }

    const lonOrigin    = (zone - 1) * 6 - 180 + 3;
    const lonOriginRad = lonOrigin * Math.PI / 180;

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const tanLat = Math.tan(latRad);

    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const T = tanLat * tanLat;
    const C = ep2 * cosLat * cosLat;
    const A = cosLat * (lonRad - lonOriginRad);

    const M = a * (
        (1 - e2/4 - 3*e4/64 - 5*e6/256) * latRad
        - (3*e2/8 + 3*e4/32 + 45*e6/1024) * Math.sin(2*latRad)
        + (15*e4/256 + 45*e6/1024) * Math.sin(4*latRad)
        - (35*e6/3072) * Math.sin(6*latRad)
    );

    let easting = k0 * N * (
        A + (1 - T + C) * Math.pow(A, 3) / 6
        + (5 - 18*T + T*T + 72*C - 58*ep2) * Math.pow(A, 5) / 120
    ) + 500000;

    let northing = k0 * (
        M + N * tanLat * (
            A*A/2 + (5 - T + 9*C + 4*C*C) * Math.pow(A, 4) / 24
            + (61 - 58*T + T*T + 600*C - 330*ep2) * Math.pow(A, 6) / 720
        )
    );

    if (lat < 0) northing += 10000000;

    const bandLetters = "CDEFGHJKLMNPQRSTUVWX";
    let band = 'Z';
    if (lat >= -80 && lat < 84) {
        band = bandLetters[Math.min(Math.floor((lat + 80) / 8), bandLetters.length - 1)];
    }

    return {
        zone, band,
        easting: Math.round(easting),
        northing: Math.round(northing),
        hemisphere: lat >= 0 ? 'N' : 'S'
    };
}

function utmToLatLon(zone, easting, northing, hemisphere) {
    const a  = 6378137.0;
    const f  = 1 / 298.257223563;
    const k0 = 0.9996;
    const e2 = f * (2 - f);
    const ep2 = e2 / (1 - e2);
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

    const x = easting - 500000;
    const y = hemisphere === 'S' ? northing - 10000000 : northing;

    const M  = y / k0;
    const mu = M / (a * (1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256));

    const phi1 = mu
        + (3*e1/2 - 27*Math.pow(e1,3)/32) * Math.sin(2*mu)
        + (21*e1*e1/16 - 55*Math.pow(e1,4)/32) * Math.sin(4*mu)
        + (151*Math.pow(e1,3)/96) * Math.sin(6*mu)
        + (1097*Math.pow(e1,4)/512) * Math.sin(8*mu);

    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = Math.tan(phi1);

    const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
    const T1 = tanPhi1 * tanPhi1;
    const C1 = ep2 * cosPhi1 * cosPhi1;
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
    const D  = x / (N1 * k0);

    const lat = phi1 - (N1 * tanPhi1 / R1) * (
        D*D/2
        - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * Math.pow(D,4) / 24
        + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * Math.pow(D,6) / 720
    );

    let lonOffset = (D
        - (1 + 2*T1 + C1) * Math.pow(D,3) / 6
        + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * Math.pow(D,5) / 120
    ) / cosPhi1;

    const lonOrigin = (zone - 1) * 6 - 180 + 3;
    const lonDeg = lonOrigin + lonOffset * 180 / Math.PI;
    const latDeg = lat * 180 / Math.PI;

    return [latDeg, lonDeg];
}

function formatGridRef(lat, lon) {
    const u = latLonToUTM(lat, lon);
    const e = String(u.easting).padStart(6, '0');
    const n = String(u.northing).padStart(7, '0');
    return `${u.zone}${u.band} ${e}mE ${n}mN`;
}

messageInput.addEventListener('keyup', e => { if (e.key === 'Enter') sendMessage(); });

// ─── Map state ──────────────────────────────────────────────────────────────
let map        = null;
let selfMarker = null;
const nodeMarkers = {};   // { nodeId: { marker, lat, lon, lastSeen } }

// ─── Tac waypoints (formerly "landmarks") ───────────────────────────────────
const waypointMarkers = {};
let waypoints = [];
try {
    const stored = localStorage.getItem('tacWaypoints');
    if (stored !== null) {
        waypoints = JSON.parse(stored);
    } else {
        // One-time migration from the old "landmarks" naming/key so existing
        // saved pins aren't lost when upgrading.
        waypoints = JSON.parse(localStorage.getItem('tacLandmarks') || '[]');
        if (waypoints.length) {
            try { localStorage.setItem('tacWaypoints', JSON.stringify(waypoints)); } catch (e) {}
        }
    }
} catch (e) { waypoints = []; }

// ─── UTM grid overlay ──────────────────────────────────────────────────────
let gridLinesLayer  = null;
let gridLabelsLayer = null;
let gridRedrawTimer = null;

const HISAR_CENTER = [29.1492, 75.7217];
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ─── Phone GPS state ──────────────────────────────────────────────────────────
let gpsWatchId     = null;
let lastBeaconSent = 0;
const BEACON_INTERVAL_MS = 30000;

const BLANK_TILE_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const LocalFolderTileLayer = L.TileLayer.extend({
    initialize: function (dirHandle, options) {
        this._dirHandle = dirHandle;
        L.setOptions(this, Object.assign({ errorTileUrl: BLANK_TILE_DATA_URL }, options));
    },
    createTile: function (coords, done) {
        const img = document.createElement('img');
        img.alt = '';
        this._readLocalTile(coords).then(url => {
            if (!url) { done(new Error('tile not present locally'), img); return; }
            img.onload  = () => done(null, img);
            img.onerror = () => done(new Error('tile decode failed'), img);
            img.src = url;
        });
        return img;
    },
    _readLocalTile: async function (coords) {
        try {
            const zDir = await this._dirHandle.getDirectoryHandle(String(coords.z));
            const xDir = await zDir.getDirectoryHandle(String(coords.x));
            const fileHandle = await xDir.getFileHandle(`${coords.y}.png`);
            const file = await fileHandle.getFile();
            return URL.createObjectURL(file);
        } catch (e) {
            return null;
        }
    }
});

let onlineTileLayer  = null;
let currentBaseLayer = null;
let rootDirHandle     = null;
let activePackHandle  = null;

// ─── Map setup ────────────────────────────────────────────────────────────────
function initMap() {
    map = L.map('map', {
        center: HISAR_CENTER,
        zoom: 13,
        zoomControl: true,
        attributionControl: true,
    });

    onlineTileLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        subdomains: 'abc',
        minZoom: 10,
        maxZoom: 17,
        attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)'
    });
    currentBaseLayer = onlineTileLayer;
    currentBaseLayer.addTo(map);

    gridLinesLayer  = L.layerGroup().addTo(map);
    gridLabelsLayer = L.layerGroup().addTo(map);

    map.on('dblclick', e => {
        const label = window.prompt('Waypoint label:', '');
        if (label === null) return;
        addWaypoint(e.latlng.lat, e.latlng.lng, label.trim() || 'WAYPOINT');
    });

    waypoints.forEach(wp => renderWaypoint(wp));

    map.on('moveend zoomend', scheduleGridRedraw);
    map.whenReady(() => drawUTMGrid());

    setInterval(refreshStaleMarkers, 60 * 1000);
    restoreTilesFolder();
}

function scheduleGridRedraw() {
    clearTimeout(gridRedrawTimer);
    gridRedrawTimer = setTimeout(drawUTMGrid, 120);
}

function drawUTMGrid() {
    if (!map || !gridLinesLayer) return;
    gridLinesLayer.clearLayers();
    gridLabelsLayer.clearLayers();

    const zoom = map.getZoom();
    let spacing;
    if (zoom >= 16)      spacing = 250;
    else if (zoom >= 14) spacing = 1000;
    else if (zoom >= 12) spacing = 5000;
    else if (zoom >= 10) spacing = 10000;
    else                 spacing = 25000;

    const bounds = map.getBounds();
    const center = map.getCenter();
    const zoneRef = latLonToUTM(center.lat, center.lng);
    const zone = zoneRef.zone;
    const hemisphere = zoneRef.hemisphere;

    const corners = [
        latLonToUTM(bounds.getSouth(), bounds.getWest(), zone),
        latLonToUTM(bounds.getSouth(), bounds.getEast(), zone),
        latLonToUTM(bounds.getNorth(), bounds.getWest(), zone),
        latLonToUTM(bounds.getNorth(), bounds.getEast(), zone),
    ];
    const eastings  = corners.map(c => c.easting);
    const northings = corners.map(c => c.northing);
    let minE = Math.min(...eastings)   - spacing;
    let maxE = Math.max(...eastings)   + spacing;
    let minN = Math.min(...northings)  - spacing;
    let maxN = Math.max(...northings)  + spacing;

    while ((maxE - minE) / spacing > 24) spacing *= 2;

    const startE = Math.floor(minE / spacing) * spacing;
    const endE   = Math.ceil(maxE / spacing) * spacing;
    const startN = Math.floor(minN / spacing) * spacing;
    const endN   = Math.ceil(maxN / spacing) * spacing;

    const gridLabel = v => String(Math.round(v / spacing) % 100).padStart(2, '0');
    const SAMPLES = 6;

    for (let e = startE; e <= endE; e += spacing) {
        const pts = [];
        for (let i = 0; i <= SAMPLES; i++) {
            const n = startN + (endN - startN) * (i / SAMPLES);
            pts.push(utmToLatLon(zone, e, n, hemisphere));
        }
        L.polyline(pts, { className: 'utm-grid-line', weight: 1, interactive: false }).addTo(gridLinesLayer);

        const labelPt = utmToLatLon(zone, e, startN, hemisphere);
        L.marker(labelPt, {
            icon: L.divIcon({ className: 'utm-grid-label', html: gridLabel(e), iconSize: [22, 12] }),
            interactive: false, keyboard: false
        }).addTo(gridLabelsLayer);
    }

    for (let n = startN; n <= endN; n += spacing) {
        const pts = [];
        for (let i = 0; i <= SAMPLES; i++) {
            const e = startE + (endE - startE) * (i / SAMPLES);
            pts.push(utmToLatLon(zone, e, n, hemisphere));
        }
        L.polyline(pts, { className: 'utm-grid-line', weight: 1, interactive: false }).addTo(gridLinesLayer);

        const labelPt = utmToLatLon(zone, startE, n, hemisphere);
        L.marker(labelPt, {
            icon: L.divIcon({ className: 'utm-grid-label utm-grid-label-n', html: gridLabel(n), iconSize: [22, 12] }),
            interactive: false, keyboard: false
        }).addTo(gridLabelsLayer);
    }
}

// Adding a waypoint always transmits it over the active link (mirrors enemy
// contact reporting) so every node on the mesh sees it. Pass
// { fromRemote: true } when rendering a waypoint that arrived over the
// mesh from another node, so we don't re-transmit it back out.
function addWaypoint(lat, lon, label, opts = {}) {
    const wp = { id: opts.id || ('wp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)), lat, lon, label };
    waypoints.push(wp);
    persistWaypoints();
    renderWaypoint(wp);
    if (!opts.fromRemote) {
        transmitWaypoint(label, lat, lon);
    }
    return wp;
}

function removeWaypoint(id) {
    waypoints = waypoints.filter(w => w.id !== id);
    persistWaypoints();
    if (waypointMarkers[id]) {
        map.removeLayer(waypointMarkers[id]);
        delete waypointMarkers[id];
    }
}

function persistWaypoints() {
    try { localStorage.setItem('tacWaypoints', JSON.stringify(waypoints)); } catch (e) {}
}

function renderWaypoint(wp) {
    const marker = L.marker([wp.lat, wp.lon], { icon: getNodeIcon('waypoint') })
        .bindTooltip(nodeTooltipHtml(wp.label, wp.lat, wp.lon), { permanent: true, direction: 'top', offset: [0, -6], className: 'node-name-tooltip' })
        .bindPopup(`
            <div class="popup-node-id">${wp.label}</div>
            <div class="popup-coords">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</div>
            <div class="grid-ref-row">GR ${formatGridRef(wp.lat, wp.lon)}</div>
            <button onclick="removeWaypoint('${wp.id}')" style="margin-top:6px;font-size:10px;cursor:pointer;">Remove</button>
        `)
        .addTo(map);
    waypointMarkers[wp.id] = marker;
}

function transmitWaypoint(label, lat, lon) {
    const safeLabel = (label || 'WAYPOINT').replace(/[|:]/g, ' ').slice(0, 40);
    const payload = `WAYPOINTSPOT:${safeLabel}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
    transportWrite(payload).catch(e => console.error('Waypoint broadcast failed:', e));
    insertAlert(`🔵 WAYPOINT transmitted: ${safeLabel} @ ${lat.toFixed(5)}, ${lon.toFixed(5)} (GR ${formatGridRef(lat, lon)})`);
}

// ─── Enemy contact reporting ────────────────────────────────────────────────
const enemyMarkers = {};
let enemyMethod = 'bearing';

function destinationPoint(lat, lon, bearingDeg, distanceMeters) {
    const R = 6371000;
    const brng = bearingDeg * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;
    const dR = distanceMeters / R;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng)
    );
    const lon2 = lon1 + Math.atan2(
        Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
        Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );

    return [lat2 * 180 / Math.PI, ((lon2 * 180 / Math.PI) + 540) % 360 - 180];
}

function bandHemisphere(band) {
    const bandLetters = "CDEFGHJKLMNPQRSTUVWX";
    const idx = bandLetters.indexOf(band.toUpperCase());
    return (idx >= 0 && idx < 10) ? 'S' : 'N';
}

function openEnemyPanel() {
    document.getElementById('enemyPanel').classList.add('open');
    setEnemyMethod('bearing');
}

function closeEnemyPanel() {
    document.getElementById('enemyPanel').classList.remove('open');
}

function setEnemyMethod(method) {
    enemyMethod = method;
    document.querySelectorAll('.enemy-method-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.method === method);
    });
    document.getElementById('methodBearing').style.display  = method === 'bearing'  ? 'block' : 'none';
    document.getElementById('methodGrid').style.display     = method === 'grid'     ? 'block' : 'none';
    document.getElementById('methodLatLong').style.display  = method === 'latlong'  ? 'block' : 'none';
}

function submitEnemyReport() {
    const name = (document.getElementById('enemyName').value || '').trim() || 'UNKNOWN CONTACT';
    let lat, lon;

    if (enemyMethod === 'bearing') {
        if (!selfLatLon) {
            insertAlert('SYSTEM: No GPS fix yet — bearing & range needs your own position first.');
            return;
        }
        const bearing = parseFloat(document.getElementById('enemyBearing').value);
        const range   = parseFloat(document.getElementById('enemyRange').value);
        if (isNaN(bearing) || isNaN(range) || bearing < 0 || bearing > 360 || range < 0) {
            insertAlert('SYSTEM: Enter a valid bearing (0–360°) and range (m).');
            return;
        }
        [lat, lon] = destinationPoint(selfLatLon.lat, selfLatLon.lon, bearing, range);

    } else if (enemyMethod === 'grid') {
        const zoneStr = (document.getElementById('enemyZone').value || '').trim().toUpperCase();
        const m = zoneStr.match(/^(\d{1,2})\s*([A-Z])$/);
        if (!m) {
            insertAlert('SYSTEM: Enter grid zone like "43R".');
            return;
        }
        const easting  = parseFloat(document.getElementById('enemyEasting').value);
        const northing = parseFloat(document.getElementById('enemyNorthing').value);
        if (isNaN(easting) || isNaN(northing)) {
            insertAlert('SYSTEM: Enter valid easting/northing (m).');
            return;
        }
        const zone = parseInt(m[1], 10);
        const hemisphere = bandHemisphere(m[2]);
        [lat, lon] = utmToLatLon(zone, easting, northing, hemisphere);

    } else {
        lat = parseFloat(document.getElementById('enemyLat').value);
        lon = parseFloat(document.getElementById('enemyLon').value);
        if (isNaN(lat) || isNaN(lon)) {
            insertAlert('SYSTEM: Enter valid latitude and longitude.');
            return;
        }
    }

    plotEnemyMarker(name, lat, lon, Date.now());
    transmitEnemyReport(name, lat, lon);
    closeEnemyPanel();

    document.getElementById('enemyName').value = '';
    document.getElementById('enemyBearing').value = '';
    document.getElementById('enemyRange').value = '';
    document.getElementById('enemyZone').value = '';
    document.getElementById('enemyEasting').value = '';
    document.getElementById('enemyNorthing').value = '';
    document.getElementById('enemyLat').value = '';
    document.getElementById('enemyLon').value = '';
}

// Enemy contacts can't be removed the instant they're reported — a wrong
// tap shouldn't erase a live contact. The Remove button only appears in the
// popup once STALE_THRESHOLD_MS (5 minutes) has passed since the report.
function enemyPopupHtml(id, name, lat, lon, ts) {
    const remainingMs = STALE_THRESHOLD_MS - (Date.now() - ts);
    const removalRow = remainingMs <= 0
        ? `<button onclick="removeEnemyMarker('${id}')" style="margin-top:6px;font-size:10px;cursor:pointer;">Remove</button>`
        : `<div class="popup-lastseen">Removable in ${Math.max(1, Math.ceil(remainingMs / 60000))}m</div>`;
    return `
        <div class="popup-node-id" style="color:var(--node-enemy);">⚠ ${name}</div>
        <div class="popup-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
        <div class="grid-ref-row">GR ${formatGridRef(lat, lon)}</div>
        <div class="popup-lastseen">Reported: ${formatLastSeen(ts)}</div>
        ${removalRow}
    `;
}

function plotEnemyMarker(name, lat, lon, ts) {
    const id = 'en_' + ts + '_' + Math.random().toString(36).slice(2, 6);
    const marker = L.marker([lat, lon], { icon: getNodeIcon('enemy'), zIndexOffset: 900 })
        .bindTooltip(nodeTooltipHtml(name, lat, lon), { permanent: true, direction: 'top', offset: [0, -8], className: 'node-name-tooltip enemy-tooltip' })
        .bindPopup(enemyPopupHtml(id, name, lat, lon, ts))
        .addTo(map);
    // Recompute the popup (so "Removable in Xm" counts down / the Remove
    // button appears once eligible) every time it's opened, rather than
    // running a global timer for markers nobody is looking at.
    marker.on('popupopen', () => marker.setPopupContent(enemyPopupHtml(id, name, lat, lon, ts)));
    enemyMarkers[id] = { marker, name, lat, lon, ts };
    return id;
}

function removeEnemyMarker(id) {
    const rec = enemyMarkers[id];
    if (!rec) return;
    if (Date.now() - rec.ts < STALE_THRESHOLD_MS) {
        insertAlert('SYSTEM: Enemy contacts can only be removed 5 minutes after they were reported.');
        return;
    }
    map.removeLayer(rec.marker);
    delete enemyMarkers[id];
}

function transmitEnemyReport(name, lat, lon) {
    const safeName = name.replace(/[|:]/g, ' ').slice(0, 40);
    const payload = `ENEMYSPOT:${safeName}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
    transportWrite(payload).catch(e => console.error('Enemy report send failed:', e));
    insertAlert(`🔴 ENEMY CONTACT transmitted: ${safeName} @ ${lat.toFixed(5)}, ${lon.toFixed(5)} (GR ${formatGridRef(lat, lon)})`);
}

// ─── Waypoint broadcast panel (precise bearing/grid/lat-long entry) ────────
// Same three input methods as the enemy contact panel. Submitting here goes
// through addWaypoint(), which both plots the pin locally and transmits it
// over the mesh so every node sees it — the double-click quick-add on the
// map does the same.
let waypointMethod = 'bearing';

function openWaypointPanel() {
    document.getElementById('waypointPanel').classList.add('open');
    setWaypointMethod('bearing');
}

function closeWaypointPanel() {
    document.getElementById('waypointPanel').classList.remove('open');
}

function setWaypointMethod(method) {
    waypointMethod = method;
    document.querySelectorAll('#waypointPanel .enemy-method-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.method === method);
    });
    document.getElementById('wpMethodBearing').style.display  = method === 'bearing'  ? 'block' : 'none';
    document.getElementById('wpMethodGrid').style.display     = method === 'grid'     ? 'block' : 'none';
    document.getElementById('wpMethodLatLong').style.display  = method === 'latlong'  ? 'block' : 'none';
}

function submitWaypointReport() {
    const label = (document.getElementById('waypointName').value || '').trim() || 'WAYPOINT';
    let lat, lon;

    if (waypointMethod === 'bearing') {
        if (!selfLatLon) {
            insertAlert('SYSTEM: No GPS fix yet — bearing & range needs your own position first.');
            return;
        }
        const bearing = parseFloat(document.getElementById('waypointBearing').value);
        const range   = parseFloat(document.getElementById('waypointRange').value);
        if (isNaN(bearing) || isNaN(range) || bearing < 0 || bearing > 360 || range < 0) {
            insertAlert('SYSTEM: Enter a valid bearing (0–360°) and range (m).');
            return;
        }
        [lat, lon] = destinationPoint(selfLatLon.lat, selfLatLon.lon, bearing, range);

    } else if (waypointMethod === 'grid') {
        const zoneStr = (document.getElementById('waypointZone').value || '').trim().toUpperCase();
        const m = zoneStr.match(/^(\d{1,2})\s*([A-Z])$/);
        if (!m) {
            insertAlert('SYSTEM: Enter grid zone like "43R".');
            return;
        }
        const easting  = parseFloat(document.getElementById('waypointEasting').value);
        const northing = parseFloat(document.getElementById('waypointNorthing').value);
        if (isNaN(easting) || isNaN(northing)) {
            insertAlert('SYSTEM: Enter valid easting/northing (m).');
            return;
        }
        const zone = parseInt(m[1], 10);
        const hemisphere = bandHemisphere(m[2]);
        [lat, lon] = utmToLatLon(zone, easting, northing, hemisphere);

    } else {
        lat = parseFloat(document.getElementById('waypointLat').value);
        lon = parseFloat(document.getElementById('waypointLon').value);
        if (isNaN(lat) || isNaN(lon)) {
            insertAlert('SYSTEM: Enter valid latitude and longitude.');
            return;
        }
    }

    addWaypoint(lat, lon, label);
    closeWaypointPanel();

    document.getElementById('waypointName').value = '';
    document.getElementById('waypointBearing').value = '';
    document.getElementById('waypointRange').value = '';
    document.getElementById('waypointZone').value = '';
    document.getElementById('waypointEasting').value = '';
    document.getElementById('waypointNorthing').value = '';
    document.getElementById('waypointLat').value = '';
    document.getElementById('waypointLon').value = '';
}

// ─── Offline map preload ────────────────────────────────────────────────────
const TILE_CACHE_NAME = 'mesh-tile-cache-v1';
let offlineDownloading = false;
let offlineDownloadCancelled = false;

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        insertAlert('SYSTEM: This browser can\'t cache tiles for offline use.');
        return;
    }
    navigator.serviceWorker.register('sw.js', { scope: './' })
        .then(() => insertAlert('SYSTEM: Offline map caching ready.'))
        .catch(err => insertAlert('SYSTEM: Offline caching unavailable — ' + err.message));
}

function lon2tileX(lon, z) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, z));
}
function lat2tileY(lat, z) {
    const rad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
}

function buildTileUrl(z, x, y) {
    const subdomains = ['a', 'b', 'c'];
    const s = subdomains[Math.abs(x + y) % subdomains.length];
    return `https://${s}.tile.opentopomap.org/${z}/${x}/${y}.png`;
}

function collectTileList(bounds, zMin, zMax) {
    const list = [];
    for (let z = zMin; z <= zMax; z++) {
        const xMin = lon2tileX(bounds.getWest(), z);
        const xMax = lon2tileX(bounds.getEast(), z);
        const yMin = lat2tileY(bounds.getNorth(), z);
        const yMax = lat2tileY(bounds.getSouth(), z);
        for (let x = xMin; x <= xMax; x++) {
            for (let y = yMin; y <= yMax; y++) {
                list.push({ z, x, y });
            }
        }
    }
    return list;
}

function populateOfflineZoomOptions() {
    const minSel = document.getElementById('offlineZoomMin');
    const maxSel = document.getElementById('offlineZoomMax');
    if (!minSel || minSel.options.length) return;
    for (let z = 10; z <= 17; z++) {
        minSel.add(new Option(z, z));
        maxSel.add(new Option(z, z));
    }
}

function openOfflinePanel() {
    populateOfflineZoomOptions();
    const zoom = map ? map.getZoom() : 13;
    document.getElementById('offlineZoomMin').value = Math.max(10, zoom - 1);
    document.getElementById('offlineZoomMax').value = Math.min(17, zoom + 1);
    document.getElementById('offlinePanel').classList.add('open');
    updateCacheCountDisplay();
}

function closeOfflinePanel() {
    if (offlineDownloading) offlineDownloadCancelled = true;
    document.getElementById('offlinePanel').classList.remove('open');
}

async function startOfflineDownload() {
    if (offlineDownloading || !map) return;

    const zMin = parseInt(document.getElementById('offlineZoomMin').value, 10);
    const zMax = parseInt(document.getElementById('offlineZoomMax').value, 10);
    if (zMin > zMax) {
        insertAlert('SYSTEM: Zoom "from" must be ≤ zoom "to".');
        return;
    }

    const bounds = map.getBounds().pad(0.3);
    const tiles = collectTileList(bounds, zMin, zMax);

    if (tiles.length > 1200) {
        const proceed = window.confirm(
            `This will download roughly ${tiles.length} tiles and may take a while / use significant data. Continue?`
        );
        if (!proceed) return;
    }

    offlineDownloading = true;
    offlineDownloadCancelled = false;

    const progressWrap = document.getElementById('offlineProgressWrap');
    const fill = document.getElementById('offlineProgressFill');
    const text = document.getElementById('offlineProgressText');
    progressWrap.style.display = 'block';
    fill.style.width = '0%';

    const cache = await caches.open(TILE_CACHE_NAME);
    let done = 0;
    let failed = 0;
    let idx = 0;
    const CONCURRENCY = 6;

    async function worker() {
        while (idx < tiles.length) {
            if (offlineDownloadCancelled) return;
            const t = tiles[idx++];
            const url = buildTileUrl(t.z, t.x, t.y);
            try {
                const existing = await cache.match(url);
                if (!existing) {
                    const response = await fetch(url, { mode: 'no-cors' });
                    await cache.put(url, response);
                }
            } catch (e) {
                failed++;
            }
            done++;
            const pct = Math.round((done / tiles.length) * 100);
            fill.style.width = pct + '%';
            text.textContent = `${done} / ${tiles.length} tiles cached` + (failed ? ` (${failed} failed)` : '');
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    offlineDownloading = false;
    if (offlineDownloadCancelled) {
        insertAlert('SYSTEM: Offline download cancelled.');
    } else {
        insertAlert(`SYSTEM: Offline area cached — ${done - failed}/${tiles.length} tiles (zoom ${zMin}–${zMax}).`);
    }
    updateCacheCountDisplay();
}

async function updateCacheCountDisplay() {
    const el = document.getElementById('offlineCacheCount');
    if (!el || !('caches' in window)) return;
    try {
        const cache = await caches.open(TILE_CACHE_NAME);
        const keys = await cache.keys();
        el.textContent = `${keys.length} tile${keys.length !== 1 ? 's' : ''} cached`;
    } catch (e) {
        el.textContent = '— tiles cached';
    }
}

async function clearOfflineCache() {
    const ok = window.confirm('Remove all offline-cached map tiles from this device?');
    if (!ok) return;
    try {
        await caches.delete(TILE_CACHE_NAME);
        insertAlert('SYSTEM: Offline tile cache cleared.');
    } catch (e) {}
    updateCacheCountDisplay();
}

// ─── Local tiles folder ───────────────────────────────────────────
const HANDLE_DB_NAME  = 'tacMeshHandles';
const HANDLE_STORE    = 'handles';

function openHandleDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(HANDLE_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function saveRootDirHandle(handle) {
    try {
        const db = await openHandleDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readwrite');
            tx.objectStore(HANDLE_STORE).put(handle, 'rootDir');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {}
}

async function loadRootDirHandle() {
    try {
        const db = await openHandleDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readonly');
            const req = tx.objectStore(HANDLE_STORE).get('rootDir');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror   = () => reject(req.error);
        });
    } catch (e) { return null; }
}

function fsApiSupported() {
    return 'showDirectoryPicker' in window;
}

async function chooseTilesFolder() {
    if (!fsApiSupported()) {
        insertAlert('SYSTEM: This browser can\'t browse a local folder (use Chrome or Edge).');
        return;
    }
    try {
        rootDirHandle = await window.showDirectoryPicker({ id: 'tacMeshTiles', mode: 'read' });
        await saveRootDirHandle(rootDirHandle);
        document.getElementById('folderStatusText').textContent = `Folder: ${rootDirHandle.name}`;
        await refreshPackList();
        insertAlert(`SYSTEM: Tiles folder "${rootDirHandle.name}" selected.`);
    } catch (e) {
        if (e.name !== 'AbortError') insertAlert('SYSTEM: Folder selection failed — ' + e.message);
    }
}

async function restoreTilesFolder() {
    const noteEl = document.getElementById('fsApiNote');
    if (!fsApiSupported()) {
        if (noteEl) noteEl.textContent = 'Local folder browsing needs Chrome or Edge (desktop or Android).';
        return;
    }
    const saved = await loadRootDirHandle();
    if (!saved) return;
    try {
        const perm = await saved.queryPermission({ mode: 'read' });
        if (perm === 'granted') {
            rootDirHandle = saved;
            const statusEl = document.getElementById('folderStatusText');
            if (statusEl) statusEl.textContent = `Folder: ${rootDirHandle.name}`;
            refreshPackList();
        } else {
            if (noteEl) noteEl.textContent = `Previously used "${saved.name}" — tap Choose Folder to reconnect.`;
        }
    } catch (e) {}
}

async function refreshPackList() {
    const select = document.getElementById('localPackSelect');
    if (!select || !rootDirHandle) return;
    select.innerHTML = '<option value="">— select a pack —</option>';
    try {
        for await (const [name, handle] of rootDirHandle.entries()) {
            if (handle.kind === 'directory') select.add(new Option(name, name));
        }
    } catch (e) {
        insertAlert('SYSTEM: Could not read tiles folder — ' + e.message);
    }
}

async function loadSelectedPack() {
    const select = document.getElementById('localPackSelect');
    const name = select && select.value;
    if (!name || !rootDirHandle) {
        insertAlert('SYSTEM: Choose a folder and a pack first.');
        return;
    }
    try {
        activePackHandle = await rootDirHandle.getDirectoryHandle(name);
        if (currentBaseLayer) map.removeLayer(currentBaseLayer);
        currentBaseLayer = new LocalFolderTileLayer(activePackHandle, { minZoom: 5, maxZoom: 19 });
        currentBaseLayer.addTo(map);
        document.getElementById('mapSourceBadge').textContent = `Source: ${name} (local)`;
        insertAlert(`SYSTEM: Now viewing local tile pack "${name}".`);
    } catch (e) {
        insertAlert('SYSTEM: Could not load pack — ' + e.message);
    }
}

function switchToOnlineTiles() {
    if (!onlineTileLayer) return;
    if (currentBaseLayer && currentBaseLayer !== onlineTileLayer) map.removeLayer(currentBaseLayer);
    currentBaseLayer = onlineTileLayer;
    if (!map.hasLayer(currentBaseLayer)) currentBaseLayer.addTo(map);
    document.getElementById('mapSourceBadge').textContent = 'Source: Online';
    insertAlert('SYSTEM: Switched to online contour map.');
}

// ─── Day / Night mode ────────────────────────────────────────────────────────
function toggleDayNight() {
    const day = dayNightToggle.checked;
    document.body.classList.toggle('day-mode', day);
    try { localStorage.setItem('tacDayMode', day ? '1' : '0'); } catch (e) {}
}

function restoreDayNightPref() {
    let day = false;
    try { day = localStorage.getItem('tacDayMode') === '1'; } catch (e) {}
    dayNightToggle.checked = day;
    document.body.classList.toggle('day-mode', day);
}

/**
 * Creates color-coded map icons for Leaflet using custom-dot-icon CSS class
 * @param {'self'|'peer'|'stale'|'waypoint'|'enemy'} type 
 */
function getNodeIcon(type) {
    return L.divIcon({
        className: 'custom-dot-icon',
        html: `<div class="marker-pin ${type}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
    });
}

function formatLastSeen(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000)   return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
}

function popupHtml(nodeId, lat, lon, lastSeen) {
    return `
        <div class="popup-node-id">${nodeId}</div>
        <div class="popup-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
        <div class="grid-ref-row">GR ${formatGridRef(lat, lon)}</div>
        <div class="popup-lastseen">Last seen: ${formatLastSeen(lastSeen)}</div>
    `;
}

function nodeTooltipHtml(label, lat, lon) {
    return `<div class="tooltip-name">${label}</div><div class="tooltip-gr">${formatGridRef(lat, lon)}</div>`;
}

function updateNodeOnMap(nodeId, lat, lon) {
    const now = Date.now();
    const isSelf = nodeId === selfNodeId;

    if (isSelf) {
        if (!selfMarker) {
            selfMarker = L.marker([lat, lon], { icon: getNodeIcon('self'), zIndexOffset: 1000 })
                .bindPopup(popupHtml(nodeId + ' (You)', lat, lon, now))
                .bindTooltip(nodeTooltipHtml(nodeId, lat, lon), { permanent: true, direction: 'top', offset: [0, -8], className: 'node-name-tooltip' })
                .addTo(map);
        } else {
            selfMarker.setLatLng([lat, lon]);
            selfMarker.setIcon(getNodeIcon('self'));
            selfMarker.setPopupContent(popupHtml(nodeId + ' (You)', lat, lon, now));
            selfMarker.setTooltipContent(nodeTooltipHtml(nodeId, lat, lon));
        }
        map.panTo([lat, lon], { animate: true, duration: 0.5 });

    } else {
        if (!nodeMarkers[nodeId]) {
            const marker = L.marker([lat, lon], { icon: getNodeIcon('peer') })
                .bindPopup(popupHtml(nodeId, lat, lon, now))
                .bindTooltip(nodeTooltipHtml(nodeId, lat, lon), { permanent: true, direction: 'top', offset: [0, -7], className: 'node-name-tooltip' })
                .addTo(map);
            nodeMarkers[nodeId] = { marker, lat, lon, lastSeen: now };
            refreshTargetDropdown();
        } else {
            nodeMarkers[nodeId].marker.setLatLng([lat, lon]);
            nodeMarkers[nodeId].marker.setIcon(getNodeIcon('peer'));
            nodeMarkers[nodeId].marker.setTooltipContent(nodeTooltipHtml(nodeId, lat, lon));
            nodeMarkers[nodeId].marker.setPopupContent(popupHtml(nodeId, lat, lon, now));
            nodeMarkers[nodeId].lat = lat;
            nodeMarkers[nodeId].lon = lon;
            nodeMarkers[nodeId].lastSeen = now;
        }
    }

    updateNodeCountBadge();
}

function refreshStaleMarkers() {
    const now = Date.now();
    for (const [nodeId, info] of Object.entries(nodeMarkers)) {
        const stale = (now - info.lastSeen) > STALE_THRESHOLD_MS;
        info.marker.setIcon(getNodeIcon(stale ? 'stale' : 'peer'));
        info.marker.setTooltipContent(nodeTooltipHtml(stale ? `${nodeId} · STALE` : nodeId, info.lat, info.lon));
        info.marker.setPopupContent(popupHtml(nodeId, info.lat, info.lon, info.lastSeen));
    }
}

// Rebuilds the "Target" dropdown: Broadcast (All) plus every node currently
// known on the map (i.e. every peer we've heard a GPS beacon from). Keeps
// the user's current selection if that node is still known, otherwise
// falls back to Broadcast.
function refreshTargetDropdown() {
    if (!targetInput || targetInput.tagName !== 'SELECT') return;

    const prevValue = targetInput.value || 'FFFF';
    const ids = Object.keys(nodeMarkers).sort();

    targetInput.innerHTML =
        '<option value="FFFF">📡 Broadcast (All)</option>' +
        ids.map(id => `<option value="${id}">${id}</option>`).join('');

    targetInput.value = (prevValue === 'FFFF' || ids.includes(prevValue)) ? prevValue : 'FFFF';
}

function updateNodeCountBadge() {
    const total = Object.keys(nodeMarkers).length + (selfMarker ? 1 : 0);
    mapNodeCount.textContent = `${total} node${total !== 1 ? 's' : ''}`;
}

// ─── Phone GPS ────────────────────────────────────────────────────────────────
function startPhoneGPS() {
    if (!navigator.geolocation) {
        insertAlert("SYSTEM: Geolocation not supported on this device.");
        return;
    }
    insertAlert("SYSTEM: Requesting GPS permission...");

    gpsWatchId = navigator.geolocation.watchPosition(
        onGPSSuccess,
        onGPSError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
}

function stopPhoneGPS() {
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
}

function onGPSSuccess(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const acc = Math.round(position.coords.accuracy);

    selfLatLon = { lat, lon };
    if (selfNodeId) updateNodeOnMap(selfNodeId, lat, lon);

    const now = Date.now();
    if (rxCharacteristic && selfNodeId && (now - lastBeaconSent > BEACON_INTERVAL_MS)) {
        lastBeaconSent = now;
        sendGPSBeacon(lat, lon);
        insertAlert(`📍 Position broadcast: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${acc}m) — GR ${formatGridRef(lat, lon)}`);
    }
}

function onGPSError(err) {
    const reasons = {
        1: "Permission denied — enable Location in browser settings.",
        2: "Position unavailable — move to open sky.",
        3: "GPS timeout — retrying..."
    };
    insertAlert("GPS: " + (reasons[err.code] || err.message));
}

async function sendGPSBeacon(lat, lon) {
    try {
        await transportWrite(`GPSPOS:${lat.toFixed(6)},${lon.toFixed(6)}`);
    } catch(e) {
        console.error("GPS beacon send failed:", e);
    }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function insertAlert(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `<span>${text}</span>`;
    chatWindow.appendChild(el);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Icon shown inline in a sent bubble for its current delivery status.
function statusIcon(status) {
    switch (status) {
        case 'broadcast': return '📡';
        case 'pending':   return '🕓';
        case 'delivered': return '✅';
        case 'failed':    return '⚠️';
        default:          return '';
    }
}

// Human-readable line shown when a sent bubble is clicked/tapped.
function msgStatusText(meta) {
    if (meta.mode === 'broadcast') {
        return '📡 Broadcast — sent to all nodes in range (no delivery confirmation)';
    }
    if (meta.status === 'delivered') return `✅ Delivered to ${meta.target}`;
    if (meta.status === 'failed')    return `⚠️ Not delivered to ${meta.target} — no response after retries`;
    return `🕓 Sending to ${meta.target} — awaiting confirmation…`;
}

// Refreshes a sent bubble's inline icon + hidden status line from its current
// dataset (called on send, and again whenever a CHATOK/CHATFAIL arrives).
function updateMsgStatusLine(el) {
    const meta = { target: el.dataset.target, mode: el.dataset.mode, status: el.dataset.status };
    const iconEl = el.querySelector('.msg-status-icon');
    if (iconEl) iconEl.textContent = statusIcon(meta.status);

    const lineEl = el.querySelector('.msg-status-line');
    if (lineEl) {
        lineEl.textContent = msgStatusText(meta);
        lineEl.className = `msg-status-line ${meta.status}`;
    }
}

function toggleMsgStatus(el) {
    const lineEl = el.querySelector('.msg-status-line');
    if (lineEl) lineEl.style.display = lineEl.style.display === 'none' ? 'block' : 'none';
}

// `meta` (sent messages only): { target: '4-char node id or FFFF',
//   mode: 'broadcast' | 'direct', status: 'broadcast' | 'pending' | 'delivered' | 'failed' }
// Returns the created row element so the caller can update its status later.
function insertBubble(direction, sender, text, meta) {
    const el = document.createElement('div');
    el.className = `msg-row ${direction}`;
    const senderTag = direction === 'received' ? `<span class="sender-id">${sender}</span>` : '';

    if (direction === 'sent' && meta) {
        el.dataset.target = meta.target;
        el.dataset.mode = meta.mode;
        el.dataset.status = meta.status;
        el.classList.add('clickable');
        el.innerHTML =
            `<div class="bubble">${senderTag}${escapeHtml(text)}<span class="msg-status-icon"></span></div>` +
            `<div class="msg-status-line" style="display:none;"></div>`;
        el.querySelector('.bubble').addEventListener('click', () => toggleMsgStatus(el));
        updateMsgStatusLine(el);
    } else {
        el.innerHTML = `<div class="bubble">${senderTag}${escapeHtml(text)}</div>`;
    }

    chatWindow.appendChild(el);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return el;
}

function setConnected(online) {
    statusDot.className  = online ? 'status-dot online' : 'status-dot';
    statusText.innerText = online ? 'Secure Link Active' : 'Disconnected';
    targetInput.disabled  = !online;
    messageInput.disabled = !online;
    sendBtn.disabled      = !online;
    connectBtn.disabled   = online;
    connectBtn.innerText  = online ? 'Online' : 'Connect';
}

function getSelectedTransport() {
    const el = document.getElementById('transportSelect');
    return el ? el.value : 'ble';
}

async function connectTransport() {
    const choice = getSelectedTransport();
    if (choice === 'serial')      return connectSerial();
    else if (choice === 'wifi')   return connectWiFi();
    else                          return connectBluetooth();
}

function disconnectAllTransports() {
    if (activeTransport === 'ble' && bluetoothDevice?.gatt?.connected) {
        bluetoothDevice.gatt.disconnect();
    }
    if (activeTransport === 'wifi' && wsSocket) {
        wsSocket.close();
        wsSocket = null;
    }
    if (activeTransport === 'serial' && serialPort) {
        serialReadLoopActive = false;
        serialWriter?.releaseLock();
        serialPort.close().catch(() => {});
        serialPort = null;
        serialWriter = null;
    }
    activeTransport = null;
}

// ─── USB Serial Connect ───────────────────────────────────────────────────────
async function connectSerial() {
    if (!('serial' in navigator)) {
        insertAlert('SYSTEM ERROR: Web Serial not supported in this browser. Use Chrome on desktop.');
        return;
    }
    try {
        disconnectAllTransports();
        insertAlert('Requesting USB serial device…');

        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: SERIAL_BAUD });
        serialWriter = serialPort.writable.getWriter();
        activeTransport = 'serial';

        insertAlert('SYSTEM: USB Serial link open.');
        setConnected(true);

        serialReadLoopActive = true;
        (async () => {
            const textDecoderStream = new TextDecoderStream();
            const readableClosed = serialPort.readable.pipeTo(textDecoderStream.writable).catch(() => {});
            serialReader = textDecoderStream.readable.getReader();
            try {
                while (serialReadLoopActive) {
                    const { value, done } = await serialReader.read();
                    if (done) break;
                    if (value) processSerialChunk(value);
                }
            } catch (e) {
                console.error('Serial read loop ended:', e);
            } finally {
                serialReader?.releaseLock();
                await readableClosed;
                if (activeTransport === 'serial') {
                    setConnected(false);
                    stopPhoneGPS();
                    insertAlert('SYSTEM: Serial connection lost. Click Connect to reconnect.');
                }
            }
        })();

        await transportWrite('PING');
        setTimeout(startPhoneGPS, 1000);

    } catch (err) {
        insertAlert('SYSTEM ERROR: ' + err.message);
    }
}

// ─── WiFi Connect ─────────────────────────────────────────────────────────────
async function connectWiFi() {
    try {
        disconnectAllTransports();
        insertAlert(`Connecting to node over WiFi (${WIFI_WS_URL})…`);

        await new Promise((resolve, reject) => {
            wsSocket = new WebSocket(WIFI_WS_URL);
            wsSocket.onopen = () => resolve();
            wsSocket.onerror = () => reject(new Error('WebSocket connection failed — joined the node\'s WiFi network yet?'));
            wsSocket.onmessage = handleIncomingDataWiFi;
            wsSocket.onclose = () => {
                if (activeTransport === 'wifi') {
                    setConnected(false);
                    stopPhoneGPS();
                    insertAlert('SYSTEM: WiFi connection lost. Click Connect to reconnect.');
                }
            };
        });

        activeTransport = 'wifi';
        setConnected(true);
        insertAlert('SYSTEM: WiFi Link Established.');

        await transportWrite('PING');
        setTimeout(startPhoneGPS, 1000);

    } catch (err) {
        insertAlert('SYSTEM ERROR: ' + err.message);
    }
}

// ─── BLE Connect ──────────────────────────────────────────────────────────────
async function connectBluetooth() {
    try {
        disconnectAllTransports();
        insertAlert('Scanning for VyomsutraV1…');

        bluetoothDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'VyomsutraV1' }],
            optionalServices: [SERVICE_UUID]
        });

        bluetoothDevice.addEventListener('gattserverdisconnected', () => {
            if (activeTransport === 'ble') {
                stopPhoneGPS();
                setConnected(false);
                insertAlert('SYSTEM: Connection lost. Click Connect to reconnect.');
            }
        });

        insertAlert('Hardware found. Linking services…');
        const server  = await bluetoothDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);

        rxCharacteristic = await service.getCharacteristic(RX_CHAR_UUID);
        txCharacteristic = await service.getCharacteristic(TX_CHAR_UUID);

        await txCharacteristic.startNotifications();
        txCharacteristic.addEventListener('characteristicvaluechanged', handleIncomingDataBLE);

        activeTransport = 'ble';
        setConnected(true);
        insertAlert('SYSTEM: Secure Radio Link Established.');

        await transportWrite('PING');
        setTimeout(startPhoneGPS, 1000);

    } catch (err) {
        insertAlert('SYSTEM ERROR: ' + err.message);
    }
}

// ─── Incoming data handler ────────────────────────────────────────────────────
function processIncomingLine(raw) {
    if (!raw) return;

    if (raw.startsWith('INFO:Your Node ID is ')) {
        const id = raw.slice('INFO:Your Node ID is '.length);
        selfNodeId = id;
        nodeTitle.innerText = `CodeSign ${id} `;
        document.getElementById('nodeIdValue').innerText = id;
        document.getElementById('nodeIdBanner').style.display = 'flex';
        nodeNameBadgeText.innerText = id;
        nodeNameBadge.classList.add('has-id');
        insertAlert(`Node ID confirmed: ${id}`);
        return;
    }

    if (raw.startsWith('BEACON:')) {
        const parts = raw.slice('BEACON:'.length).split(',');
        if (parts.length === 3) {
            const [nodeId, latStr, lonStr] = parts;
            const lat = parseFloat(latStr);
            const lon = parseFloat(lonStr);
            if (!isNaN(lat) && !isNaN(lon)) {
                updateNodeOnMap(nodeId.trim(), lat, lon);
                insertAlert(`📍 Position update: ${nodeId.trim()} @ ${lat.toFixed(4)}, ${lon.toFixed(4)} — GR ${formatGridRef(lat, lon)}`);
            }
        }
        return;
    }

    if (raw.startsWith('SELFPOS:')) {
        const parts = raw.slice('SELFPOS:'.length).split(',');
        if (parts.length === 2 && selfNodeId) {
            const lat = parseFloat(parts[0]);
            const lon = parseFloat(parts[1]);
            if (!isNaN(lat) && !isNaN(lon)) {
                selfLatLon = { lat, lon };
                updateNodeOnMap(selfNodeId, lat, lon);
            }
        }
        return;
    }

    if (raw.startsWith('WAYPOINT:')) {
        const parts = raw.slice('WAYPOINT:'.length).split('|');
        if (parts.length === 3) {
            const [label, latStr, lonStr] = parts;
            const lat = parseFloat(latStr);
            const lon = parseFloat(lonStr);
            if (!isNaN(lat) && !isNaN(lon)) {
                const cleanLabel = label.trim() || 'WAYPOINT';
                addWaypoint(lat, lon, cleanLabel, { fromRemote: true });
                insertAlert(`🔵 Waypoint received: ${cleanLabel} @ ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
            }
        }
        return;
    }

    if (raw.startsWith('ENEMY:')) {
        const parts = raw.slice('ENEMY:'.length).split('|');
        if (parts.length === 3) {
            const [name, latStr, lonStr] = parts;
            const lat = parseFloat(latStr);
            const lon = parseFloat(lonStr);
            if (!isNaN(lat) && !isNaN(lon)) {
                plotEnemyMarker(name.trim() || 'UNKNOWN CONTACT', lat, lon, Date.now());
                insertAlert(`🔴 ENEMY CONTACT reported: ${name.trim()} @ ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
            }
        }
        return;
    }

    // Chat delivery confirmation / failure — sent by the firmware once a
    // directed chat message's ack either arrives or the retry budget runs
    // out. Must be handled before the generic "sender:text" fallback below,
    // or these would misrender as a chat bubble from a sender literally
    // named "CHATOK"/"CHATFAIL".
    if (raw.startsWith('CHATOK:')) {
        const node = raw.slice('CHATOK:'.length);
        insertAlert(`✅ Delivered to ${node}`);
        resolvePendingDirected(node, 'delivered');
        return;
    }

    if (raw.startsWith('CHATFAIL:')) {
        const node = raw.slice('CHATFAIL:'.length);
        insertAlert(`⚠️ Message to ${node} not delivered — no ack after retries.`);
        resolvePendingDirected(node, 'failed');
        return;
    }

    const sep = raw.indexOf(':');
    if (sep !== -1) {
        insertBubble('received', raw.slice(0, sep), raw.slice(sep + 1));
    } else {
        insertAlert(raw);
    }
}

function handleIncomingDataBLE(event) {
    processIncomingLine(decoder.decode(event.target.value));
}

function handleIncomingDataWiFi(event) {
    processIncomingLine(typeof event.data === 'string' ? event.data : '');
}

let serialLineBuffer = '';
function processSerialChunk(chunkText) {
    serialLineBuffer += chunkText;
    let idx;
    while ((idx = serialLineBuffer.indexOf('\n')) !== -1) {
        const line = serialLineBuffer.slice(0, idx).replace(/\r$/, '');
        serialLineBuffer = serialLineBuffer.slice(idx + 1);
        if (line.startsWith('APP:')) {
            processIncomingLine(line.slice(4));
        }
    }
}

// ─── Send message ─────────────────────────────────────────────────────────────
async function sendMessage() {
    // targetInput is now a <select>: "FFFF" (Broadcast) or a known 4-char
    // node id, so this is always well-formed — no more silent no-op from an
    // empty/incomplete hand-typed target.
    const target  = (targetInput.value || 'FFFF').toUpperCase();
    const message = messageInput.value;

    if (message.length === 0) return;

    if (!activeTransport) {
        insertAlert('⚠️ Not connected — click Connect before sending.');
        return;
    }

    const isBroadcast = target === 'FFFF';

    try {
        await transportWrite(`${target}:${message}`);

        const bubbleEl = insertBubble('sent', 'You', message, {
            target,
            mode: isBroadcast ? 'broadcast' : 'direct',
            status: isBroadcast ? 'broadcast' : 'pending'
        });

        if (!isBroadcast) {
            pendingDirectedMsgs.push({ target, el: bubbleEl });
        }

        messageInput.value = '';
    } catch (err) {
        insertAlert('Transmission Fault: ' + err.message);
    }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
restoreDayNightPref();
registerServiceWorker();
initMap();