import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, getDocs, doc, updateDoc,
  query, orderBy, serverTimestamp, where, limit,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, w3wApiKey } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Offline support: reads and writes work with no signal, queued locally
// (IndexedDB) and synced automatically once you're back online. Falls back
// to a normal online-only connection if the browser doesn't support it
// (e.g. private/incognito mode on some browsers).
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  db = getFirestore(app);
}

let currentUser = null;
let drones = [];   // {id, model, serial, controllerSerial, cumulativeMins, cycles, controllerCumulativeMins, controllerCycles, batteries:[...]}
let flights = [];  // cached, newest first
let logFiltered = [];
let lastCheck = null; // the most recently completed pre-flight check, for "Copy Last Check"
let checkComplete = false;

const PROP_POSITIONS = ["Front Left", "Front Right", "Back Left", "Back Right"];
const ARM_POSITIONS = ["Front Left", "Front Right", "Back Left", "Back Right"];

const HAZARD_CATEGORIES = [
  {
    title: "Airborne & Airspace",
    items: [
      "Low-flying aircraft (SAR helicopters, air ambulances, military routes, private airstrips)",
      "Controlled airspace / Flight Restriction Zone nearby",
      "Temporary restriction active (NOTAM — air display, emergency ops, VIP security)",
      "Birds & wildlife (nesting or territorial birds of prey)"
    ]
  },
  {
    title: "Ground & Physical Obstacles",
    items: [
      "Overhead cables (power lines, telephone wires, guy-wires)",
      "Tall structures/trees (pylons, masts, turbines, overhanging or dead branches)",
      "Poor takeoff/landing surface (loose gravel, dry soil, tall grass, uneven/sloped ground)",
      "Water bodies nearby (ponds, rivers, flooded ground)"
    ]
  },
  {
    title: "Signal & Environmental Interference",
    items: [
      "EMI risk (substations, cell towers, large metal structures, solar arrays)",
      "Local wind effects (turbulence/wind shear near tree lines, ridges, buildings)",
      "Thermal variation risk (heat haze, hot exhaust vents affecting thermal optics)"
    ]
  },
  {
    title: "People & Mobile Hazards",
    items: [
      "Uninvolved people (walkers, farmworkers, visitors within buffer zone)",
      "Vehicles & machinery (tractors, vans, nearby roads)",
      "Livestock & animals (risk of spooking, or handler safety)"
    ]
  }
];

// ---------- Auth guard ----------
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  document.getElementById("whoami").textContent = user.email;
  loadDrones().then(() => loadFlights());
});

document.getElementById("logoutLink").addEventListener("click", () => signOut(auth));

// ---------- Online/offline status ----------
function updateConnStatus() {
  const el = document.getElementById("connStatus");
  if (navigator.onLine) {
    el.textContent = "Online";
    el.classList.remove("offline");
  } else {
    el.textContent = "Offline — saving locally";
    el.classList.add("offline");
  }
}
window.addEventListener("online", updateConnStatus);
window.addEventListener("offline", updateConnStatus);
updateConnStatus();

// ---------- Nav ----------
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
});
document.getElementById("gotoNew").addEventListener("click", () => showView("new"));
document.getElementById("dash_gotoNew").addEventListener("click", () => showView("new"));

function showView(view) {
  document.querySelectorAll(".nav-item").forEach((i) => i.classList.toggle("active", i.dataset.view === view));
  ["dashboard", "new", "log", "batteries"].forEach((v) => {
    document.getElementById("view-" + v).classList.toggle("hidden", v !== view);
  });
  if (view === "new") resetPreflightCheck();
}

// ---------- One-time seed of your drone/battery details ----------
async function seedInitialDataIfEmpty() {
  const existing = await getDocs(collection(db, "drones"));
  if (!existing.empty) return;

  const droneRef = await addDoc(collection(db, "drones"), {
    model: "DJI Mini 2 SE",
    serial: "1581F8PJC237L001MM23",
    controllerSerial: "8QKXN7F002028Z",
    cumulativeMins: 0, cycles: 0,
    controllerCumulativeMins: 0, controllerCycles: 0
  });

  const seedBatteries = [
    { name: "Battery 1", serial: "DA906FZ" },
    { name: "Battery 2", serial: "DA906VF" },
    { name: "Battery 3", serial: "DA904H9" }
  ];
  for (const b of seedBatteries) {
    await addDoc(collection(db, "drones", droneRef.id, "batteries"), {
      ...b, cumulativeMins: 0, cycles: 0, lastUsed: null, retired: false
    });
  }
}

// ---------- Drones & Batteries ----------
async function loadDrones() {
  await seedInitialDataIfEmpty();
  const snap = await getDocs(query(collection(db, "drones"), orderBy("model")));
  drones = [];
  for (const d of snap.docs) {
    const data = d.data();
    const batSnap = await getDocs(collection(db, "drones", d.id, "batteries"));
    const batteries = batSnap.docs.map((b) => ({ id: b.id, ...b.data() }));
    drones.push({ id: d.id, ...data, batteries });
  }
  renderDroneSelect();
  renderBatteryCards();
  renderDashboard();
}

function renderDroneSelect() {
  const sel = document.getElementById("f_drone");
  sel.innerHTML = "";
  drones.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.model;
    sel.appendChild(opt);
  });
  sel.onchange = updateDroneDependentFields;
  updateDroneDependentFields();
}

function updateDroneDependentFields() {
  const droneId = document.getElementById("f_drone").value;
  const drone = drones.find((d) => d.id === droneId);
  document.getElementById("f_serial").value = drone ? drone.serial : "";
  const batSel = document.getElementById("f_battery");
  batSel.innerHTML = "";
  if (drone) {
    drone.batteries.filter((b) => !b.retired).forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name + (b.serial ? " (" + b.serial + ")" : "");
      batSel.appendChild(opt);
    });
  }
}

function fmtHours(mins) {
  mins = mins || 0;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function renderBatteryCards() {
  const wrap = document.getElementById("drone_cards");
  wrap.innerHTML = "";
  drones.forEach((drone) => {
    const card = document.createElement("div");
    card.className = "card";

    const activeCount = drone.batteries.filter((b) => !b.retired).length;
    card.innerHTML = `
      <div class="card-header">
        <div>
          <div class="card-title"></div>
          <div class="card-meta"></div>
          <div class="card-meta">Airframe: ${fmtHours(drone.cumulativeMins)} · ${drone.cycles || 0} cycles &middot; Controller: ${fmtHours(drone.controllerCumulativeMins)} · ${drone.controllerCycles || 0} charge cycles</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <div class="card-meta">${activeCount} ${activeCount === 1 ? "battery" : "batteries"} assigned</div>
          <button class="btn secondary small" data-edit-drone type="button">Edit Drone</button>
        </div>
      </div>
      <div class="battery-grid"></div>
    `;
    card.querySelector(".card-title").textContent = drone.model;
    card.querySelectorAll(".card-meta")[0].textContent =
      `Aircraft serial: ${drone.serial || "—"}${drone.controllerSerial ? " · Controller: " + drone.controllerSerial : ""}`;
    card.querySelector("[data-edit-drone]").addEventListener("click", () => editDrone(drone));

    const grid = card.querySelector(".battery-grid");
    drone.batteries.forEach((b) => {
      const tile = document.createElement("div");
      tile.className = "battery-tile";
      tile.style.cursor = "pointer";
      tile.title = "Click to edit this battery";
      tile.innerHTML = `
        <div class="battery-tile-head">
          <div class="battery-name"></div>
          <div class="dot${b.retired ? " retired" : ""}"></div>
        </div>
        <div class="page-sub" style="margin-top:0;"></div>
        <div class="page-sub" style="margin-top:0;">${fmtHours(b.cumulativeMins)}</div>
        <div class="page-sub" style="margin-top:0;">Cycles: ${b.cycles || 0}</div>
        <div class="page-sub" style="margin-top:0;">Last used: ${b.lastUsed || "—"}</div>
      `;
      tile.querySelector(".battery-name").textContent = b.name;
      tile.querySelector(".page-sub").textContent = b.serial ? "Serial: " + b.serial : "";
      tile.addEventListener("click", () => editBattery(drone.id, b));
      grid.appendChild(tile);
    });

    const addTile = document.createElement("div");
    addTile.className = "tile-add";
    addTile.textContent = "+ Add Battery";
    addTile.addEventListener("click", () => addBattery(drone.id));
    grid.appendChild(addTile);

    wrap.appendChild(card);
  });

  const addDroneTile = document.createElement("div");
  addDroneTile.className = "tile-add";
  addDroneTile.style.padding = "20px";
  addDroneTile.textContent = "+ Add Another Drone";
  addDroneTile.addEventListener("click", addDrone);
  wrap.appendChild(addDroneTile);
}

async function addDrone() {
  const model = prompt("Drone make and model (e.g. DJI Mini 2 SE):");
  if (!model) return;
  const serial = prompt("Aircraft serial number:") || "";
  const controllerSerial = prompt("Controller serial number (optional):") || "";
  const startHrs = parseFloat(prompt("Airframe hours already flown before starting this log (e.g. 4.5). Leave blank for 0:", "0")) || 0;
  const startCycles = parseInt(prompt("Airframe flight cycles already flown before starting this log. Leave blank for 0:", "0")) || 0;
  const ctrlStartHrs = parseFloat(prompt("Controller hours already used before starting this log. Leave blank for 0:", "0")) || 0;
  const ctrlStartCycles = parseInt(prompt("Controller charge cycles so far. Leave blank for 0:", "0")) || 0;

  await addDoc(collection(db, "drones"), {
    model, serial, controllerSerial,
    cumulativeMins: Math.round(startHrs * 60), cycles: startCycles,
    controllerCumulativeMins: Math.round(ctrlStartHrs * 60), controllerCycles: ctrlStartCycles
  });
  await loadDrones();
}
document.getElementById("addDrone").addEventListener("click", addDrone);

async function addBattery(droneId) {
  const name = prompt("Battery label (e.g. Battery 1):");
  if (!name) return;
  const serial = prompt("Battery serial number (optional):") || "";
  const startHrs = parseFloat(prompt("Hours already flown on this battery before starting this log. Leave blank for 0:", "0")) || 0;
  const startCycles = parseInt(prompt("Charge cycles already on this battery. Leave blank for 0:", "0")) || 0;

  await addDoc(collection(db, "drones", droneId, "batteries"), {
    name, serial,
    cumulativeMins: Math.round(startHrs * 60), cycles: startCycles,
    lastUsed: null, retired: false
  });
  await loadDrones();
}

async function editBattery(droneId, battery) {
  const name = prompt("Battery label:", battery.name);
  if (name === null) return; // cancelled
  const serial = prompt("Battery serial number:", battery.serial || "") || "";
  const currentHrs = (battery.cumulativeMins || 0) / 60;
  const newHrsInput = prompt("Total hours flown on this battery (edit if it's wrong):", currentHrs.toFixed(2));
  if (newHrsInput === null) return;
  const newCyclesInput = prompt("Total charge cycles on this battery (edit if it's wrong):", String(battery.cycles || 0));
  if (newCyclesInput === null) return;
  const retired = confirm("Mark this battery as retired? OK = retired, Cancel = still active.");

  await updateDoc(doc(db, "drones", droneId, "batteries", battery.id), {
    name, serial,
    cumulativeMins: Math.round((parseFloat(newHrsInput) || 0) * 60),
    cycles: parseInt(newCyclesInput) || 0,
    retired
  });
  await loadDrones();
}

async function editDrone(drone) {
  const model = prompt("Drone make and model:", drone.model);
  if (model === null) return;
  const serial = prompt("Aircraft serial number:", drone.serial || "") || "";
  const controllerSerial = prompt("Controller serial number:", drone.controllerSerial || "") || "";
  const currentHrs = (drone.cumulativeMins || 0) / 60;
  const newHrs = prompt("Total airframe hours (edit if it's wrong):", currentHrs.toFixed(2));
  if (newHrs === null) return;
  const newCycles = prompt("Total airframe cycles:", String(drone.cycles || 0));
  if (newCycles === null) return;
  const ctrlHrs = ((drone.controllerCumulativeMins || 0) / 60);
  const newCtrlHrs = prompt("Total controller hours:", ctrlHrs.toFixed(2));
  if (newCtrlHrs === null) return;
  const newCtrlCycles = prompt("Total controller charge cycles:", String(drone.controllerCycles || 0));
  if (newCtrlCycles === null) return;

  await updateDoc(doc(db, "drones", drone.id), {
    model, serial, controllerSerial,
    cumulativeMins: Math.round((parseFloat(newHrs) || 0) * 60),
    cycles: parseInt(newCycles) || 0,
    controllerCumulativeMins: Math.round((parseFloat(newCtrlHrs) || 0) * 60),
    controllerCycles: parseInt(newCtrlCycles) || 0
  });
  await loadDrones();
}

// ---------- Dashboard ----------
function renderDashboard() {
  const wrap = document.getElementById("dash_drones");
  wrap.innerHTML = "";
  let totalMins = 0;

  drones.forEach((drone) => {
    totalMins += drone.cumulativeMins || 0;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">
        <div>
          <div class="card-title"></div>
          <div class="card-meta">Airframe: ${fmtHours(drone.cumulativeMins)} &middot; ${drone.cycles || 0} cycles</div>
          <div class="card-meta">Controller: ${fmtHours(drone.controllerCumulativeMins)} &middot; ${drone.controllerCycles || 0} charge cycles</div>
        </div>
      </div>
      <div class="battery-grid"></div>
    `;
    card.querySelector(".card-title").textContent = drone.model;
    const grid = card.querySelector(".battery-grid");
    drone.batteries.forEach((b) => {
      const tile = document.createElement("div");
      tile.className = "battery-tile";
      tile.innerHTML = `
        <div class="battery-tile-head"><div class="battery-name"></div></div>
        <div class="page-sub" style="margin-top:0;">${fmtHours(b.cumulativeMins)}</div>
        <div class="page-sub" style="margin-top:0;">${b.cycles || 0} charge cycles</div>
      `;
      tile.querySelector(".battery-name").textContent = b.name;
      grid.appendChild(tile);
    });
    wrap.appendChild(card);
  });

  document.getElementById("dash_totals").textContent =
    `${drones.length} drone${drones.length === 1 ? "" : "s"} · ${flights.length} flight${flights.length === 1 ? "" : "s"} logged · ${fmtHours(totalMins)} total airframe time`;

  const recentRows = document.getElementById("dash_recent");
  recentRows.innerHTML = "";
  flights.slice(0, 5).forEach((f) => {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td></td><td></td><td></td><td></td>";
    const c = tr.querySelectorAll("td");
    c[0].textContent = formatDate(f.date);
    c[1].textContent = f.droneModel || "";
    c[2].textContent = (f.durationMins || 0) + "m";
    c[3].textContent = f.location || "";
    recentRows.appendChild(tr);
  });
}

// ---------- Pre-flight check ----------
function buildQuadGrid(containerId, positions, prefix) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  positions.forEach((pos, i) => {
    const tile = document.createElement("div");
    tile.className = "quad-tile";
    const id = `${prefix}_${i}`;
    tile.innerHTML = `
      <label><input type="checkbox" id="${id}_ok"> ${pos}</label>
      <input type="text" id="${id}_note" placeholder="Notes (optional)">
    `;
    el.appendChild(tile);
  });
}
buildQuadGrid("pf_props", PROP_POSITIONS, "prop");
buildQuadGrid("pf_arms", ARM_POSITIONS, "arm");

function buildHazardCategories() {
  const wrap = document.getElementById("pf_hazard_categories");
  wrap.innerHTML = "";
  HAZARD_CATEGORIES.forEach((cat, ci) => {
    const div = document.createElement("div");
    div.className = "hazard-category";
    const title = document.createElement("div");
    title.className = "hazard-category-title";
    title.textContent = cat.title;
    div.appendChild(title);
    cat.items.forEach((item, ii) => {
      const label = document.createElement("label");
      label.className = "hazard-item";
      label.innerHTML = `<input type="checkbox" data-hazard="${ci}_${ii}"> <span></span>`;
      label.querySelector("span").textContent = item;
      div.appendChild(label);
    });
    wrap.appendChild(div);
  });
}
buildHazardCategories();

document.getElementById("pf_night_flag").addEventListener("change", (e) => {
  document.getElementById("pf_night_row").classList.toggle("hidden", !e.target.checked);
});

document.getElementById("pf_site_clear").addEventListener("change", (e) => {
  document.querySelectorAll('[data-hazard]').forEach((cb) => { cb.checked = false; cb.disabled = e.target.checked; });
  document.getElementById("pf_hazard_other").disabled = e.target.checked;
});

function collectPreflightData() {
  const props = PROP_POSITIONS.map((pos, i) => ({
    position: pos,
    ok: document.getElementById(`prop_${i}_ok`).checked,
    note: document.getElementById(`prop_${i}_note`).value.trim()
  }));
  const arms = ARM_POSITIONS.map((pos, i) => ({
    position: pos,
    ok: document.getElementById(`arm_${i}_ok`).checked,
    note: document.getElementById(`arm_${i}_note`).value.trim()
  }));
  const hazards = [];
  document.querySelectorAll('[data-hazard]').forEach((cb) => {
    if (cb.checked) {
      const [ci, ii] = cb.dataset.hazard.split("_").map(Number);
      hazards.push(HAZARD_CATEGORIES[ci].items[ii]);
    }
  });
  return {
    props, arms,
    gimbalOk: document.getElementById("pf_gimbal").checked,
    gimbalNote: document.getElementById("pf_gimbal_note").value.trim(),
    nightFlight: document.getElementById("pf_night_flag").checked,
    nightOk: document.getElementById("pf_night").checked,
    nightNote: document.getElementById("pf_night_note").value.trim(),
    landingOk: document.getElementById("pf_landing").checked,
    landingNote: document.getElementById("pf_landing_note").value.trim(),
    siteClear: document.getElementById("pf_site_clear").checked,
    hazards,
    hazardOther: document.getElementById("pf_hazard_other").value.trim(),
    completedAt: new Date().toISOString(),
    skipped: false
  };
}

function applyPreflightData(data) {
  data.props.forEach((p, i) => {
    document.getElementById(`prop_${i}_ok`).checked = !!p.ok;
    document.getElementById(`prop_${i}_note`).value = p.note || "";
  });
  data.arms.forEach((a, i) => {
    document.getElementById(`arm_${i}_ok`).checked = !!a.ok;
    document.getElementById(`arm_${i}_note`).value = a.note || "";
  });
  document.getElementById("pf_gimbal").checked = !!data.gimbalOk;
  document.getElementById("pf_gimbal_note").value = data.gimbalNote || "";
  document.getElementById("pf_landing").checked = !!data.landingOk;
  document.getElementById("pf_landing_note").value = data.landingNote || "";
  document.querySelectorAll('[data-hazard]').forEach((cb) => { cb.checked = false; });
  (data.hazards || []).forEach((text) => {
    HAZARD_CATEGORIES.forEach((cat, ci) => {
      const ii = cat.items.indexOf(text);
      if (ii !== -1) {
        const cb = document.querySelector(`[data-hazard="${ci}_${ii}"]`);
        if (cb) cb.checked = true;
      }
    });
  });
  document.getElementById("pf_hazard_other").value = data.hazardOther || "";
}

function resetPreflightCheck() {
  checkComplete = false;
  document.getElementById("flight_fields").disabled = true;
  document.getElementById("preflight_status").textContent = "Not completed";
  document.getElementById("preflight_card").classList.remove("hidden");
}

document.getElementById("pf_complete").addEventListener("click", () => {
  checkComplete = true;
  document.getElementById("flight_fields").disabled = false;
  document.getElementById("preflight_status").textContent = "Completed ✓";
});

document.getElementById("pf_skip").addEventListener("click", () => {
  if (!confirm("Skip the pre-flight check for this flight? This isn't recommended.")) return;
  checkComplete = true;
  document.getElementById("flight_fields").disabled = false;
  document.getElementById("preflight_status").textContent = "Skipped";
});

document.getElementById("pf_copyLast").addEventListener("click", () => {
  if (!lastCheck) { alert("No previous check to copy yet."); return; }
  applyPreflightData(lastCheck);
});

// ---------- New Flight form ----------
const todayStr = () => new Date().toISOString().slice(0, 10);
document.getElementById("f_date").value = todayStr();

function calcDuration() {
  const start = document.getElementById("f_start").value;
  const end = document.getElementById("f_end").value;
  if (!start || !end) { document.getElementById("f_duration").value = ""; return; }
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  document.getElementById("f_duration").value = mins + " min";
}
document.getElementById("f_start").addEventListener("input", calcDuration);
document.getElementById("f_end").addEventListener("input", calcDuration);

// ---------- Location-aware hazard prefill ----------
async function checkPreviousLocation() {
  const words = document.getElementById("f_w3w").value.trim();
  const noteEl = document.getElementById("pf_hazard_prefill_note");
  noteEl.textContent = "";
  if (!words) return;
  const match = flights.find((f) => f.location && f.location.toLowerCase() === words.toLowerCase() && f.preflight);
  if (match) {
    applyPreflightData(match.preflight);
    noteEl.textContent = `— prefilled from your check at this location on ${formatDate(match.date)}, confirm still accurate`;
  }
}
document.getElementById("f_w3w").addEventListener("change", checkPreviousLocation);

// ---------- what3words + weather autofill ----------
async function w3wToCoords(words) {
  const clean = words.replace(/^\/+/, "");
  if (!w3wApiKey || w3wApiKey.startsWith("YOUR_")) return null;
  try {
    const res = await fetch(
      `https://api.what3words.com/v3/convert-to-coordinates?words=${encodeURIComponent(clean)}&key=${w3wApiKey}`
    );
    const data = await res.json();
    if (data.coordinates) return data.coordinates;
  } catch (e) { /* ignore */ }
  return null;
}

async function coordsToW3w(lat, lng) {
  if (!w3wApiKey || w3wApiKey.startsWith("YOUR_")) return null;
  try {
    const res = await fetch(
      `https://api.what3words.com/v3/convert-to-3wa?coordinates=${lat},${lng}&key=${w3wApiKey}`
    );
    const data = await res.json();
    if (data.words) return data.words;
  } catch (e) { /* ignore */ }
  return null;
}

document.getElementById("useMyLocation").addEventListener("click", () => {
  const errorEl = document.getElementById("f_error");
  errorEl.textContent = "";

  if (!("geolocation" in navigator)) {
    errorEl.textContent = "Your browser doesn't support location access.";
    return;
  }
  if (!w3wApiKey || w3wApiKey.startsWith("YOUR_")) {
    errorEl.textContent = "Add a what3words API key in firebase-config.js to use this button.";
    return;
  }

  const btn = document.getElementById("useMyLocation");
  const originalLabel = btn.textContent;
  btn.textContent = "Locating…";
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const words = await coordsToW3w(latitude, longitude);
      btn.textContent = originalLabel;
      btn.disabled = false;
      if (!words) {
        errorEl.textContent = "Couldn't convert your location to a what3words address — check your API key or connection.";
        return;
      }
      document.getElementById("f_w3w").value = "///" + words;
      // Reuse the same logic as typing/pasting a location: pulls in any
      // previous hazard notes for this exact spot, and fetches weather.
      checkPreviousLocation();
      refreshWeather();
    },
    (err) => {
      btn.textContent = originalLabel;
      btn.disabled = false;
      errorEl.textContent = err.code === err.PERMISSION_DENIED
        ? "Location access was denied — enable it for this site in your browser/phone settings to use this button."
        : "Couldn't get your location — try again.";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

async function fetchWeather(lat, lng, dateStr, timeStr) {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&hourly=temperature_2m,windspeed_10m,weathercode&start_date=${dateStr}&end_date=${dateStr}&timezone=auto`
    );
    const data = await res.json();
    if (!data.hourly) return null;
    const targetHour = (timeStr || "12:00").split(":")[0].padStart(2, "0");
    const idx = data.hourly.time.findIndex((t) => t.endsWith(`T${targetHour}:00`));
    const i = idx === -1 ? 0 : idx;
    const wind = Math.round(data.hourly.windspeed_10m[i]);
    const code = data.hourly.weathercode[i];
    return `Wind ${wind}km/h, ${weatherCodeToText(code)}`;
  } catch (e) {
    return null;
  }
}

function weatherCodeToText(code) {
  if (code === 0) return "Clear";
  if ([1, 2, 3].includes(code)) return "Partly cloudy";
  if ([45, 48].includes(code)) return "Fog";
  if (code >= 51 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code >= 95) return "Thunderstorm";
  return "Overcast";
}

async function refreshWeather() {
  const words = document.getElementById("f_w3w").value.trim();
  const date = document.getElementById("f_date").value;
  const time = document.getElementById("f_start").value;
  if (!words) return;
  const coords = await w3wToCoords(words);
  if (!coords) {
    document.getElementById("f_error").textContent =
      "Couldn't resolve that what3words address — check your API key in firebase-config.js, or type conditions manually.";
    return;
  }
  document.getElementById("f_error").textContent = "";
  const summary = await fetchWeather(coords.lat, coords.lng, date, time);
  if (summary) document.getElementById("f_weather").value = summary;
}
document.getElementById("refreshWeather").addEventListener("click", refreshWeather);
document.getElementById("f_w3w").addEventListener("change", refreshWeather);

// ---------- Save flight ----------
document.getElementById("saveFlight").addEventListener("click", async () => {
  const errorEl = document.getElementById("f_error");
  errorEl.textContent = "";

  if (!checkComplete) {
    errorEl.textContent = "Complete (or explicitly skip) the pre-flight check first.";
    return;
  }

  const droneId = document.getElementById("f_drone").value;
  const batteryId = document.getElementById("f_battery").value;
  const drone = drones.find((d) => d.id === droneId);
  const battery = drone ? drone.batteries.find((b) => b.id === batteryId) : null;

  const date = document.getElementById("f_date").value;
  const start = document.getElementById("f_start").value;
  const end = document.getElementById("f_end").value;
  const location = document.getElementById("f_w3w").value.trim();
  const weather = document.getElementById("f_weather").value.trim();
  const notes = document.getElementById("f_notes").value.trim();
  const durationText = document.getElementById("f_duration").value;

  if (!drone || !date || !start || !end) {
    errorEl.textContent = "Drone, date, start and end time are required.";
    return;
  }

  const durationMins = parseInt(durationText) || 0;
  const preflight = document.getElementById("preflight_status").textContent === "Skipped"
    ? { skipped: true }
    : collectPreflightData();

  await addDoc(collection(db, "flights"), {
    date, start, end, durationMins,
    droneId, droneModel: drone.model, droneSerial: drone.serial,
    batteryId: battery ? battery.id : null, batteryName: battery ? battery.name : "",
    location, weather, notes, preflight,
    createdAt: serverTimestamp()
  });

  // Update battery running totals.
  if (battery) {
    await updateDoc(doc(db, "drones", droneId, "batteries", battery.id), {
      cumulativeMins: (battery.cumulativeMins || 0) + durationMins,
      cycles: (battery.cycles || 0) + 1,
      lastUsed: date
    });
  }

  // Update drone airframe + controller running totals.
  await updateDoc(doc(db, "drones", droneId), {
    cumulativeMins: (drone.cumulativeMins || 0) + durationMins,
    cycles: (drone.cycles || 0) + 1,
    controllerCumulativeMins: (drone.controllerCumulativeMins || 0) + durationMins,
    controllerCycles: (drone.controllerCycles || 0) + 1
  });

  // Reset the form for the next entry.
  document.getElementById("f_start").value = "";
  document.getElementById("f_end").value = "";
  document.getElementById("f_duration").value = "";
  document.getElementById("f_notes").value = "";
  document.getElementById("f_date").value = todayStr();

  await loadDrones();
  await loadFlights();
  showView("log");
});

// ---------- Flight log ----------
async function loadFlights() {
  const snap = await getDocs(query(collection(db, "flights"), orderBy("date", "desc")));
  flights = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (flights.length && flights[0].preflight && !flights[0].preflight.skipped) {
    lastCheck = flights[0].preflight;
  }
  setRange("all");
  renderDashboard();
}

function setRange(kind) {
  const from = document.getElementById("range_from");
  const to = document.getElementById("range_to");
  const today = new Date();
  const toStr = today.toISOString().slice(0, 10);
  if (kind === "all") {
    from.value = ""; to.value = "";
  } else if (kind === "30" || kind === "90") {
    const d = new Date(today); d.setDate(d.getDate() - parseInt(kind));
    from.value = d.toISOString().slice(0, 10); to.value = toStr;
  } else if (kind === "year") {
    from.value = `${today.getFullYear()}-01-01`; to.value = toStr;
  }
  applyFilter();
}

document.querySelectorAll("[data-range]").forEach((btn) => {
  btn.addEventListener("click", () => setRange(btn.dataset.range));
});
document.getElementById("range_from").addEventListener("change", applyFilter);
document.getElementById("range_to").addEventListener("change", applyFilter);

function applyFilter() {
  const from = document.getElementById("range_from").value;
  const to = document.getElementById("range_to").value;
  logFiltered = flights.filter((f) => {
    if (from && f.date < from) return false;
    if (to && f.date > to) return false;
    return true;
  });
  renderLog();
}

function renderLog() {
  const rows = document.getElementById("log_rows");
  rows.innerHTML = "";
  let totalMins = 0;
  logFiltered.forEach((f) => {
    totalMins += f.durationMins || 0;
    const tr = document.createElement("tr");
    tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>";
    const cells = tr.querySelectorAll("td");
    cells[0].textContent = formatDate(f.date);
    cells[1].textContent = f.droneModel || "";
    cells[2].textContent = f.batteryName || "";
    cells[3].textContent = (f.durationMins || 0) + "m";
    cells[4].textContent = f.location || "";
    cells[5].textContent = f.weather || "";
    cells[6].textContent = f.preflight ? (f.preflight.skipped ? "Skipped" : "✓") : "—";
    cells[7].textContent = f.notes || "";
    rows.appendChild(tr);
  });

  document.getElementById("log_summary").textContent =
    `${logFiltered.length} flight${logFiltered.length === 1 ? "" : "s"} shown · ${fmtHours(totalMins)} in range`;
}

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

// ---------- CSV export (respects the current date-range filter) ----------
document.getElementById("exportCsv").addEventListener("click", () => {
  const header = ["Date", "Drone", "Serial", "Battery", "Start", "End", "Duration (min)", "Location", "Weather", "Pre-flight check", "Notes"];
  const lines = [header.join(",")];
  logFiltered.forEach((f) => {
    const row = [
      f.date, f.droneModel, f.droneSerial, f.batteryName, f.start, f.end,
      f.durationMins, f.location, f.weather,
      f.preflight ? (f.preflight.skipped ? "Skipped" : "Completed") : "—",
      (f.notes || "").replace(/,/g, ";")
    ];
    lines.push(row.map((v) => `"${(v ?? "").toString().replace(/"/g, '""')}"`).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const from = document.getElementById("range_from").value || "all";
  const to = document.getElementById("range_to").value || "present";
  a.download = `flight-log_${from}_to_${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
