import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, getDocs, doc, updateDoc,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, w3wApiKey } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let drones = [];   // {id, model, serial, batteries: [{id, name, serial, cycles, lastUsed, retired}]}
let flights = [];  // cached, newest first

// ---------- Auth guard ----------
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  document.getElementById("whoami").textContent = user.email;
  loadDrones().then(() => {
    loadFlights();
  });
});

document.getElementById("logoutLink").addEventListener("click", () => signOut(auth));

// ---------- Nav ----------
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
});
document.getElementById("gotoNew").addEventListener("click", () => showView("new"));

function showView(view) {
  document.querySelectorAll(".nav-item").forEach((i) => i.classList.toggle("active", i.dataset.view === view));
  ["new", "log", "batteries"].forEach((v) => {
    document.getElementById("view-" + v).classList.toggle("hidden", v !== view);
  });
}

// ---------- Drones & Batteries ----------
async function loadDrones() {
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
  sel.addEventListener("change", updateDroneDependentFields);
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
        </div>
        <div class="card-meta">${activeCount} ${activeCount === 1 ? "battery" : "batteries"} assigned</div>
      </div>
      <div class="battery-grid"></div>
    `;
    card.querySelector(".card-title").textContent = drone.model;
    card.querySelector(".card-meta").textContent =
      `Aircraft serial: ${drone.serial || "—"}${drone.controllerSerial ? " · Controller: " + drone.controllerSerial : ""}`;

    const grid = card.querySelector(".battery-grid");
    drone.batteries.forEach((b) => {
      const tile = document.createElement("div");
      tile.className = "battery-tile";
      tile.innerHTML = `
        <div class="battery-tile-head">
          <div class="battery-name"></div>
          <div class="dot${b.retired ? " retired" : ""}"></div>
        </div>
        <div class="page-sub" style="margin-top:0;"></div>
        <div class="page-sub" style="margin-top:0;">Cycles: ${b.cycles || 0}</div>
        <div class="page-sub" style="margin-top:0;">Last used: ${b.lastUsed || "—"}</div>
      `;
      tile.querySelector(".battery-name").textContent = b.name;
      tile.querySelector(".page-sub").textContent = b.serial ? "Serial: " + b.serial : "";
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
  await addDoc(collection(db, "drones"), { model, serial, controllerSerial });
  await loadDrones();
}
document.getElementById("addDrone").addEventListener("click", addDrone);

async function addBattery(droneId) {
  const name = prompt("Battery label (e.g. Battery 1):");
  if (!name) return;
  const serial = prompt("Battery serial number (optional):") || "";
  await addDoc(collection(db, "drones", droneId, "batteries"), {
    name, serial, cycles: 0, lastUsed: null, retired: false
  });
  await loadDrones();
}

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
  if (mins < 0) mins += 24 * 60; // crossed midnight
  document.getElementById("f_duration").value = mins + " min";
}
document.getElementById("f_start").addEventListener("input", calcDuration);
document.getElementById("f_end").addEventListener("input", calcDuration);

// ---------- what3words + weather autofill ----------
async function w3wToCoords(words) {
  const clean = words.replace(/^\/+/, "");
  if (!w3wApiKey || w3wApiKey.startsWith("YOUR_")) return null;
  try {
    const res = await fetch(
      `https://api.what3words.com/v3/convert-to-coordinates?words=${encodeURIComponent(clean)}&key=${w3wApiKey}`
    );
    const data = await res.json();
    if (data.coordinates) return data.coordinates; // {lat, lng}
  } catch (e) { /* ignore */ }
  return null;
}

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
    const desc = weatherCodeToText(code);
    return `Wind ${wind}km/h, ${desc}`;
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

  await addDoc(collection(db, "flights"), {
    date, start, end, durationMins,
    droneId, droneModel: drone.model, droneSerial: drone.serial,
    batteryId: battery ? battery.id : null, batteryName: battery ? battery.name : "",
    location, weather, notes,
    createdAt: serverTimestamp()
  });

  // Update the battery's cycle count and last-used date.
  if (battery) {
    await updateDoc(doc(db, "drones", droneId, "batteries", battery.id), {
      cycles: (battery.cycles || 0) + 1,
      lastUsed: date
    });
  }

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
  renderLog();
}

function renderLog() {
  const rows = document.getElementById("log_rows");
  rows.innerHTML = "";
  let totalMins = 0;
  flights.forEach((f) => {
    totalMins += f.durationMins || 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
    `;
    const cells = tr.querySelectorAll("td");
    cells[0].textContent = formatDate(f.date);
    cells[1].textContent = f.droneModel || "";
    cells[2].textContent = f.batteryName || "";
    cells[3].textContent = (f.durationMins || 0) + "m";
    cells[4].textContent = f.location || "";
    cells[5].textContent = f.weather || "";
    cells[6].textContent = f.notes || "";
    rows.appendChild(tr);
  });

  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const cumText = `${hrs}h ${mins}m`;
  document.getElementById("log_summary").textContent =
    `${flights.length} flight${flights.length === 1 ? "" : "s"} logged · ${cumText} cumulative`;
  document.getElementById("cumulativeHours").textContent = `Cumulative hours: ${cumText}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

// ---------- CSV export ----------
document.getElementById("exportCsv").addEventListener("click", () => {
  const header = ["Date", "Drone", "Serial", "Battery", "Start", "End", "Duration (min)", "Location", "Weather", "Notes"];
  const lines = [header.join(",")];
  flights.forEach((f) => {
    const row = [
      f.date, f.droneModel, f.droneSerial, f.batteryName, f.start, f.end,
      f.durationMins, f.location, f.weather, (f.notes || "").replace(/,/g, ";")
    ];
    lines.push(row.map((v) => `"${(v ?? "").toString().replace(/"/g, '""')}"`).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "flight-log.csv";
  a.click();
  URL.revokeObjectURL(url);
});
