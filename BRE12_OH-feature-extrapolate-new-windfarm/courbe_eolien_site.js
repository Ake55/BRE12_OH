#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const EDGES = Array.from({ length: 61 }, (_, i) => i * 0.5);
const CENTERS = EDGES.slice(0, -1).map((v) => v + 0.25);
const HOUR_MS = 3_600_000;
const MS_TO_KMH = 3.6;
const METERS_PER_TILE_EQUATOR = 40_075_016.686 / 256;
const SOURCES = {
  eox2016: {
    url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
    zmax: 14,
    attribution: "Sentinel-2 cloudless - s2maps.eu by EOX IT Services GmbH (Copernicus Sentinel data 2016) - CC BY 4.0",
  },
  eox2024: {
    url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
    zmax: 14,
    attribution: "Sentinel-2 cloudless - s2maps.eu by EOX IT Services GmbH (Copernicus Sentinel data 2024) - CC BY-NC-SA 4.0",
  },
  esri: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    zmax: 17,
    attribution: "Tiles (c) Esri - Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
};

class MissingDataError extends Error {}

function parseArgs(argv) {
  const opts = {
    farms: "farms_reference.json",
    dataDir: "data",
    start: "2016-01-01",
    end: "2025-12-31",
    model: "",
    regimeThreshold: 0.9,
    radiusKm: 200,
    satelliteSource: "eox2016",
    tileCache: ".cache_tuiles",
    windCache: ".cache_vent",
    vOk: 8,
    stopThreshold: 0.01,
    minHours: 30,
    outDir: "sortie_site_js",
    satellite: true,
    selftest: false,
  };
  const names = {
    "--lat": "lat", "--lon": "lon", "--n": "n", "--mw": "mw",
    "--farms": "farms", "--data-dir": "dataDir", "--start": "start",
    "--end": "end", "--model": "model", "--seuil-regime": "regimeThreshold",
    "--rayon-km": "radiusKm", "--source-sat": "satelliteSource",
    "--cache-tuiles": "tileCache", "--cache": "windCache",
    "--v-ok": "vOk", "--seuil-arret": "stopThreshold",
    "--min-heures": "minHours", "--outdir": "outDir",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--selftest") opts.selftest = true;
    else if (arg === "--sans-satellite") opts.satellite = false;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (names[arg]) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      const key = names[arg];
      const value = argv[++i];
      opts[key] = ["lat", "lon", "n", "mw", "regimeThreshold", "radiusKm", "vOk", "stopThreshold", "minHours"].includes(key)
        ? Number(value) : value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function usage() {
  return `Usage:
  node courbe_eolien_site.js --lat 48.5 --lon -4.9 --n 60 --mw 15 [options]

Options:
  --farms FILE             Reference farm JSON (default farms_reference.json)
  --data-dir DIR           Production and wind CSV directory (default data)
  --start YYYY-MM-DD       Site weather start date (default 2016-01-01)
  --end YYYY-MM-DD         Site weather end date (default 2025-12-31)
  --model NAME             Optional Open-Meteo model (omit to use API default)
  --outdir DIR             Output directory (default sortie_site_js)
  --min-heures N           Minimum observations per wind bin (default 30)
  --seuil-regime N         Established-operation threshold; 0 disables it
  --v-ok N                 Apparent-availability threshold in m/s (default 8)
  --sans-satellite         Skip satellite tiles
  --rayon-km N             Satellite radius, 0 < N <= 500 (default 200)
  --source-sat NAME        eox2016, eox2024, or esri
  --cache DIR              Weather cache directory (default .cache_vent)
  --cache-tuiles DIR       Satellite tile cache directory
  --selftest               Run synthetic calculation tests without network`;
}

function csvRows(text, delimiter = ",") {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.length === 0) quoted = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((v) => v !== "")) rows.push(row);
      row = []; field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((v) => v !== "")) rows.push(row);
  }
  if (!rows.length) throw new MissingDataError("CSV file is empty");
  const headers = rows.shift().map((v) => v.trim());
  return rows.map((values) => Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()])));
}

function normalizeName(name) {
  return name.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function loadFarms(file) {
  const farms = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(farms) || farms.length < 2) throw new MissingDataError("Farm reference JSON must contain at least two farms");
  for (const farm of farms) {
    for (const key of ["name", "column", "lat", "lon", "n_turbines", "mw_per_turbine"]) {
      if (farm[key] === undefined || farm[key] === null) throw new MissingDataError(`Missing ${key} for farm ${farm.name ?? "?"}`);
    }
    farm.lat = Number(farm.lat);
    farm.lon = Number(farm.lon);
    farm.pnom = Number(farm.n_turbines) * Number(farm.mw_per_turbine);
    if (!Number.isFinite(farm.pnom) || farm.pnom <= 0) throw new MissingDataError(`Invalid rated capacity for ${farm.name}`);
  }
  return farms;
}

function csvFiles(dataDir, filter = () => true) {
  return fs.readdirSync(dataDir).filter((name) => name.endsWith(".csv") && filter(name))
    .map((name) => path.join(dataDir, name));
}

function farmFileIndex(files, suffix = "") {
  return new Map(files.map((file) => {
    const base = path.basename(file).replace(/\.csv$/i, "").replace(new RegExp(`${suffix}$`, "i"), "");
    return [normalizeName(base), file];
  }));
}

function findFarmFile(index, farm, dataDir, kind, suffixFallback = false) {
  const names = [farm.name, farm.column].map(normalizeName);
  let found = [...new Set(names.map((n) => index.get(n)).filter(Boolean))];
  if (!found.length && suffixFallback) {
    const suffixes = [farm.name, farm.column].filter((n) => n.includes("-"))
      .map((n) => normalizeName(n.split("-").at(-1)));
    found = [...new Set(suffixes.map((n) => index.get(n)).filter(Boolean))];
  }
  if (found.length !== 1) {
    const available = fs.readdirSync(dataDir).filter((f) => f.endsWith(".csv")).join(", ") || "no CSV files";
    throw new MissingDataError(`${kind} file for ${farm.name} missing or ambiguous in ${dataDir} (${available})`);
  }
  return found[0];
}

function parseTimestamp(value, file) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new MissingDataError(`Invalid date in ${file}: ${value}`);
  return time;
}

function loadProduction(dataDir, farms) {
  const index = farmFileIndex(csvFiles(dataDir, (f) => !f.endsWith("_hourly_data.csv")));
  const result = new Map();
  for (const farm of farms) {
    const file = findFarmFile(index, farm, dataDir, "Production");
    const rows = csvRows(fs.readFileSync(file, "utf8"), ";");
    if (!rows.length) throw new MissingDataError(`No production data in ${file}`);
    const headers = Object.keys(rows[0]);
    const timeCol = ["timestamp_utc", "timestamp"].find((h) => headers.includes(h));
    const productionCol = ["production_totale_mw", "production_mw"].find((h) => headers.includes(h));
    if (!timeCol || !productionCol) throw new MissingDataError(`${file} needs timestamp_utc/timestamp and production_totale_mw/production_mw columns`);
    const hourly = new Map();
    for (const row of rows) {
      const t = parseTimestamp(row[timeCol], file);
      const value = Number(row[productionCol]);
      if (!Number.isFinite(value)) throw new MissingDataError(`Invalid production value in ${file} at ${row[timeCol]}`);
      if (hourly.has(t)) throw new MissingDataError(`Duplicate timestamps in ${file}`);
      const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
      const entry = hourly.get(hour) ?? { sum: 0, count: 0 };
      entry.sum += Math.max(0, value);
      entry.count += 1;
      hourly.set(hour, entry);
    }
    result.set(farm.name, new Map([...hourly].map(([t, v]) => [t, v.sum / v.count / farm.pnom])));
  }
  return result;
}

function loadReferenceWind(dataDir, farms) {
  const index = farmFileIndex(csvFiles(dataDir, (f) => f.endsWith("_hourly_data.csv")), "_hourly_data");
  const result = new Map();
  for (const farm of farms) {
    const file = findFarmFile(index, farm, dataDir, "Hourly wind", true);
    const rows = csvRows(fs.readFileSync(file, "utf8"));
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const timeCol = ["date", "timestamp_utc", "timestamp"].find((h) => headers.includes(h));
    const windCol = ["hourly_wind_speed_100m", "wind_speed_100m"].find((h) => headers.includes(h));
    if (!timeCol || !windCol) throw new MissingDataError(`${file} needs date/timestamp and hourly_wind_speed_100m columns`);
    const values = new Map();
    for (const row of rows) {
      const t = parseTimestamp(row[timeCol], file);
      const value = Number(row[windCol]);
      if (!Number.isFinite(value)) throw new MissingDataError(`Invalid wind speed in ${file} at ${row[timeCol]}`);
      if (values.has(t)) throw new MissingDataError(`Duplicate timestamps in ${file}`);
      values.set(t, value / 3.6);
    }
    const meanHourly = new Map();
    for (const [t, v] of values) if (values.has(t + HOUR_MS)) meanHourly.set(t, (v + values.get(t + HOUR_MS)) / 2);
    result.set(farm.name, meanHourly);
  }
  return result;
}

async function getSiteWind(opts) {
  fs.mkdirSync(opts.windCache, { recursive: true });
  const model = opts.model || "None";
  const key = crypto.createHash("md5").update(`${opts.lat.toFixed(4)}|${opts.lon.toFixed(4)}|${opts.start}|${opts.end}|${model}`).digest("hex").slice(0, 12);
  const cache = path.join(opts.windCache, `vent100_${key}.csv`);
  let values;
  if (fs.existsSync(cache)) {
    const rows = csvRows(fs.readFileSync(cache, "utf8"));
    const first = rows[0] ?? {};
    const headers = Object.keys(first);
    const timeCol = headers[0];
    const windCol = headers.includes("v100") ? "v100" : headers.at(-1);
    values = new Map(rows.map((r) => [parseTimestamp(r[timeCol], cache), Number(r[windCol])]).filter(([, v]) => Number.isFinite(v)));
  } else {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", opts.lat);
    url.searchParams.set("longitude", opts.lon);
    url.searchParams.set("start_date", opts.start);
    url.searchParams.set("end_date", opts.end);
    url.searchParams.set("hourly", "wind_speed_100m");
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("timezone", "UTC");
    if (opts.model) url.searchParams.set("models", opts.model);
    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": "courbe-eolien-site-js/1.0 (educational)" } });
    } catch (error) {
      if (!opts.model) throw error;
      console.error(`Warning: request with models=${opts.model} failed (${error.message}); retrying without models`);
      url.searchParams.delete("models");
      response = await fetch(url, { headers: { "User-Agent": "courbe-eolien-site-js/1.0 (educational)" } });
    }
    if (!response.ok && opts.model) {
      console.error(`Warning: request with models=${opts.model} was rejected (${response.status}); retrying without models`);
      url.searchParams.delete("models");
      response = await fetch(url, { headers: { "User-Agent": "courbe-eolien-site-js/1.0 (educational)" } });
    }
    if (!response.ok) throw new MissingDataError(`Open-Meteo request failed: HTTP ${response.status} ${await response.text()}`);
    const data = await response.json();
    if (!data.hourly?.time || !data.hourly?.wind_speed_100m || data.hourly.time.length !== data.hourly.wind_speed_100m.length) {
      throw new MissingDataError("Open-Meteo response did not contain aligned hourly wind_speed_100m values");
    }
    values = new Map(data.hourly.time.map((t, i) => [parseTimestamp(`${t}Z`, "Open-Meteo response"), Number(data.hourly.wind_speed_100m[i])]));
    fs.writeFileSync(cache, `,v100\n${[...values].map(([t, v]) => `${new Date(t).toISOString()},${v}`).join("\n")}\n`);
    console.error(`Open-Meteo returned ${values.size} hourly observations`);
  }
  const hourlyMean = new Map();
  for (const [t, v] of values) if (values.has(t + HOUR_MS)) hourlyMean.set(t, (v + values.get(t + HOUR_MS)) / 2);
  return hourlyMean;
}

function pairData(cf, wind, lag = 0) {
  const pairs = [];
  for (const [t, cfValue] of cf) {
    const v = wind.get(t + lag * HOUR_MS);
    if (Number.isFinite(v) && Number.isFinite(cfValue)) pairs.push({ t, cf: cfValue, v });
  }
  return pairs.sort((a, b) => a.t - b.t);
}

function rank(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j += 1;
    const average = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) ranks[sorted[k].i] = average;
    i = j;
  }
  return ranks;
}

function correlation(a, b) {
  if (a.length < 2 || b.length !== a.length) return NaN;
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.reduce((s, x) => s + x, 0) / b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - meanA, y = b[i] - meanB;
    cov += x * y; va += x * x; vb += y * y;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : NaN;
}

function spearman(pairs) {
  return correlation(rank(pairs.map((d) => d.cf)), rank(pairs.map((d) => d.v)));
}

function bestLag(productions, winds) {
  const scores = new Map();
  for (let lag = -3; lag <= 3; lag += 1) {
    const correlations = [...productions.keys()].map((name) => spearman(pairData(productions.get(name), winds.get(name), lag)))
      .filter(Number.isFinite);
    scores.set(lag, correlations.length ? correlations.reduce((a, b) => a + b, 0) / correlations.length : NaN);
  }
  const valid = [...scores].filter(([, score]) => Number.isFinite(score));
  if (!valid.length) throw new MissingDataError("Could not determine production/wind time shift from overlapping data");
  valid.sort((a, b) => b[1] - a[1]);
  return { lag: valid[0][0], scores };
}

function quantile(values, q) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

function establishedStart(data, threshold) {
  const byMonth = new Map();
  for (const d of data) if (d.v >= 12) {
    const date = new Date(d.t);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(d.cf);
  }
  const months = [...byMonth].sort((a, b) => a[0].localeCompare(b[0]))
    .filter(([, cfs]) => cfs.length >= 10)
    .map(([key, cfs]) => ({ key, q75: quantile(cfs, 0.75) }));
  for (let i = 0; i + 1 < months.length; i += 1) {
    const [y1, m1] = months[i].key.split("-").map(Number);
    const [y2, m2] = months[i + 1].key.split("-").map(Number);
    const consecutive = y1 * 12 + m1 + 1 === y2 * 12 + m2;
    if (consecutive && months[i].q75 >= threshold && months[i + 1].q75 >= threshold) {
      return Date.UTC(y1, m1 - 1, 1);
    }
  }
  return null;
}

function curveForFarm(data, minHours) {
  const bins = Array.from({ length: CENTERS.length }, () => []);
  for (const d of data) {
    const bin = Math.floor(d.v / 0.5);
    if (bin >= 0 && bin < bins.length) bins[bin].push(d.cf);
  }
  const counts = bins.map((values) => values.length);
  const medians = bins.map((values) => values.length >= minHours ? quantile(values, 0.5) : NaN);
  return { counts, medians };
}

function combineCurves(curves) {
  const total = CENTERS.map((_, i) => curves.reduce((sum, c) => sum + (Number.isFinite(c.medians[i]) ? c.counts[i] : 0), 0));
  const mean = CENTERS.map((_, i) => {
    if (!total[i]) return NaN;
    return curves.reduce((sum, c) => sum + (Number.isFinite(c.medians[i]) ? c.medians[i] * c.counts[i] : 0), 0) / total[i];
  });
  const valid = mean.map(Number.isFinite).map((ok, i) => ok ? i : -1).filter((i) => i >= 0);
  if (valid.length < 5) throw new MissingDataError("Too few populated wind-speed bins to construct a curve");
  const first = valid[0], last = valid.at(-1);
  const full = CENTERS.map((_, i) => {
    if (i < first) return mean[first];
    if (i >= last) return mean[last];
    let lo = first;
    while (lo + 1 < valid.length && valid[lo + 1] < i) lo += 1;
    const a = valid[lo], b = valid[lo + 1];
    return mean[a] + (mean[b] - mean[a]) * (i - a) / (b - a);
  });
  const curve = full.map((_, i) => {
    const values = full.slice(Math.max(0, i - 1), Math.min(full.length, i + 2));
    return Math.max(0, Math.min(1, values.reduce((a, b) => a + b, 0) / values.length));
  });
  const min = CENTERS.map((_, i) => {
    const vals = curves.map((c) => c.medians[i]).filter(Number.isFinite);
    return vals.length ? Math.min(...vals) : curve[i];
  });
  const max = CENTERS.map((_, i) => {
    const vals = curves.map((c) => c.medians[i]).filter(Number.isFinite);
    return vals.length ? Math.max(...vals) : curve[i];
  });
  return { curve, counts: total, min, max, vmin: CENTERS[first], vmax: CENTERS[last] };
}

function predict(wind, curve) {
  if (wind <= CENTERS[0]) return curve[0];
  if (wind >= CENTERS.at(-1)) return curve.at(-1);
  const i = Math.floor((wind - CENTERS[0]) / 0.5);
  const fraction = (wind - CENTERS[i]) / (CENTERS[i + 1] - CENTERS[i]);
  return curve[i] + (curve[i + 1] - curve[i]) * fraction;
}

function calibrate(dataByFarm, curve) {
  let observed = 0, predicted = 0;
  for (const data of dataByFarm.values()) for (const d of data) {
    observed += d.cf;
    predicted += predict(d.v, curve);
  }
  if (predicted <= 0) throw new MissingDataError("Cannot calculate energy calibration factor");
  return observed / predicted;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function analyze(farms, productions, winds, siteWind, opts, lag) {
  const allPairs = new Map(farms.map((f) => [f.name, pairData(productions.get(f.name), winds.get(f.name), lag)]));
  const windows = [];
  const data = new Map();
  for (const farm of farms) {
    const pairs = allPairs.get(farm.name);
    const start = opts.regimeThreshold <= 0 ? (pairs[0]?.t ?? null) : establishedStart(pairs, opts.regimeThreshold);
    const selected = pairs.filter((d) => start !== null && d.t >= start);
    if (selected.length) data.set(farm.name, selected);
    windows.push({
      farm: farm.name,
      start: start === null ? "never reached" : new Date(start).toISOString().slice(0, 10),
      used: selected.length,
      total: pairs.length,
    });
  }
  if (data.size < 2) throw new MissingDataError("Fewer than two farms have established operation; lower --seuil-regime or check data");
  const base = combineCurves([...data.values()].map((d) => curveForFarm(d, opts.minHours)));
  const energyCalibration = calibrate(data, base.curve);
  const ref = [];
  for (const [name, pairs] of data) {
    const highWind = pairs.filter((d) => d.v >= opts.vOk && d.v <= 25);
    const timeAvailability = highWind.length ? 1 - highWind.filter((d) => d.cf < opts.stopThreshold).length / highWind.length : NaN;
    ref.push({
      farm: name, hours: pairs.length, meanWind: mean(pairs.map((d) => d.v)),
      observedCf: mean(pairs.map((d) => d.cf)),
      rawModelCf: mean(pairs.map((d) => predict(d.v, base.curve))),
      timeAvailability, energyCalibration: calibrate(new Map([[name, pairs]]), base.curve),
    });
  }
  const timeAvailability = ref.reduce((sum, f) => sum + f.timeAvailability * f.hours, 0) / ref.reduce((sum, f) => sum + f.hours, 0);
  const site = [...siteWind].sort((a, b) => a[0] - b[0]).map(([t, v]) => {
    const gross = opts.n * opts.mw * predict(v, base.curve);
    return { t, wind: v, gross, net: Math.min(gross * energyCalibration, opts.n * opts.mw) };
  });
  if (!site.length) throw new MissingDataError("No site wind data available for the selected dates");
  const rated = opts.n * opts.mw;
  const grossCf = mean(site.map((d) => d.gross / rated));
  const netCf = mean(site.map((d) => d.net / rated));
  const validation = [];
  for (const name of data.keys()) {
    const training = new Map([...data].filter(([farm]) => farm !== name));
    const trainingCurve = combineCurves([...training.values()].map((d) => curveForFarm(d, opts.minHours)));
    const factor = calibrate(training, trainingCurve.curve);
    const test = data.get(name);
    const predicted = test.map((d) => predict(d.v, trainingCurve.curve) * factor);
    const observed = test.map((d) => d.cf);
    validation.push({
      farm: name, hours: test.length, observed: mean(observed), predicted: mean(predicted),
      biasPoints: 100 * (mean(predicted) - mean(observed)),
      correlation: correlation(observed, predicted),
      rmsePct: 100 * Math.sqrt(mean(observed.map((v, i) => (v - predicted[i]) ** 2))),
    });
  }
  const sensitivity = [];
  for (const removed of data.keys()) {
    const training = new Map([...data].filter(([farm]) => farm !== removed));
    const model = combineCurves([...training.values()].map((d) => curveForFarm(d, opts.minHours)));
    const factor = calibrate(training, model.curve);
    const predicted = site.map((d) => predict(d.wind, model.curve));
    const minBin = CENTERS.findIndex((_, i) => model.counts[i] > 0);
    const maxBin = model.vmax;
    const fcNet = mean(predicted.map((v) => Math.min(v * factor, 1)));
    sensitivity.push({
      removed, farms: training.size, min: CENTERS[minBin], max: maxBin,
      outsidePct: 100 * site.filter((d) => d.wind < CENTERS[minBin] || d.wind > maxBin).length / site.length,
      calibrationPct: 100 * factor, grossCfPct: 100 * mean(predicted),
      netCfPct: 100 * fcNet, changePoints: 100 * (fcNet - netCf),
    });
  }
  const below = site.filter((d) => d.wind < base.vmin);
  const above = site.filter((d) => d.wind > base.vmax);
  const outside = site.filter((d) => d.wind < base.vmin || d.wind > base.vmax);
  const predictedTotal = site.reduce((s, d) => s + predict(d.wind, base.curve), 0);
  const annual = new Map();
  for (const d of site) {
    const year = new Date(d.t).getUTCFullYear();
    const acc = annual.get(year) ?? { sum: 0, count: 0 };
    acc.sum += d.net / rated; acc.count += 1; annual.set(year, acc);
  }
  const coverage = farms.map((farm) => {
    const wind = winds.get(farm.name), production = productions.get(farm.name);
    const missing = [...wind.keys()].filter((t) => !production.has(t)).sort((a, b) => a - b);
    const byYear = new Map();
    for (const t of wind.keys()) {
      const year = new Date(t).getUTCFullYear();
      const acc = byYear.get(year) ?? { expected: 0, present: 0 };
      acc.expected += 1; if (production.has(t)) acc.present += 1;
      byYear.set(year, acc);
    }
    const periods = [];
    for (const t of missing) {
      const last = periods.at(-1);
      if (last && t === last.end) { last.end += HOUR_MS; last.hours += 1; }
      else periods.push({ start: t, end: t + HOUR_MS, hours: 1 });
    }
    const gaps = periods.slice().sort((a, b) => b.hours - a.hours).slice(0, 3)
      .map((p) => `${new Date(p.start).toISOString().slice(0, 16).replace("T", " ")}–${new Date(p.end).toISOString().slice(0, 16).replace("T", " ")} (${p.hours} hours)`);
    return {
      farm: farm.name, expected: wind.size, present: wind.size - missing.length,
      missing: missing.length, coveragePct: wind.size ? 100 * (wind.size - missing.length) / wind.size : NaN,
      missingPeriods: periods.length, longestGap: Math.max(0, ...periods.map((p) => p.hours)),
      gaps: gaps.join("; ") || "none", byYear: [...byYear].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({
        farm: farm.name, year, expected: v.expected, present: v.present, coveragePct: 100 * v.present / v.expected,
      })),
    };
  });
  return {
    ...base, rated, energyCalibration, timeAvailability, ref, windows, site, grossCf, netCf,
    validation, sensitivity, belowPct: 100 * below.length / site.length,
    abovePct: 100 * above.length / site.length,
    outsideEnergyPct: predictedTotal ? 100 * outside.reduce((s, d) => s + predict(d.wind, base.curve), 0) / predictedTotal : NaN,
    netCfNoHighExtrapolation: mean(site.map((d) => Math.min((d.wind > base.vmax ? 0 : predict(d.wind, base.curve)) * energyCalibration, 1))),
    annual: [...annual].sort((a, b) => a[0] - b[0]).map(([year, v]) => [year, v.sum / v.count]),
    coverage, coverageByYear: coverage.flatMap((v) => v.byYear), lag,
  };
}

function warnings(farms, opts, res) {
  const out = [];
  const low = Math.min(...farms.map((f) => f.mw_per_turbine));
  const high = Math.max(...farms.map((f) => f.mw_per_turbine));
  if (opts.mw < 0.75 * low || opts.mw > 1.25 * high) out.push(`Unit rated power ${opts.mw} MW is outside the reference range (${low}-${high} MW); treat the result as an order-of-magnitude estimate.`);
  if (res.abovePct > 1) out.push(`${res.abovePct.toFixed(1)}% of site hours exceed validated wind range up to ${(res.vmax * MS_TO_KMH).toFixed(1)} km/h; the curve assumes a plateau.`);
  if (res.belowPct > 1) out.push(`${res.belowPct.toFixed(1)}% of site hours are below the validated range starting at ${(res.vmin * MS_TO_KMH).toFixed(1)} km/h.`);
  if (res.energyCalibration > 1) out.push(`Energy calibration is ${(100 * res.energyCalibration).toFixed(1)}%; it is not technical availability.`);
  const maxBias = Math.max(...res.validation.map((v) => Math.abs(v.biasPoints)));
  if (maxBias > 3) out.push(`Leave-one-farm-out capacity-factor bias reaches ${maxBias.toFixed(1)} percentage points.`);
  return out;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[,"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, headers, rows) {
  fs.writeFileSync(file, `${headers.join(",")}\n${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`);
}

function format(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function renderTable(headers, rows) {
  if (!rows.length) return "(none)";
  const values = [headers, ...rows.map((r) => r.map((v) => String(v)))];
  const widths = headers.map((_, i) => Math.max(...values.map((r) => r[i].length)));
  return values.map((r, idx) => r.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

function makeReport(opts, res, warns) {
  const lines = [
    `SITE: ${opts.n} x ${opts.mw} MW = ${res.rated.toFixed(0)} MW | selected production/wind time shift: ${res.lag >= 0 ? "+" : ""}${res.lag} h`,
    `CAPACITY FACTOR: gross ${(100 * res.grossCf).toFixed(1)}% net ${(100 * res.netCf).toFixed(1)}% | mean net energy ${(res.site.reduce((s, d) => s + d.net, 0) / res.site.length * 8766 / 1000).toFixed(0)} GWh/year`,
    `APPARENT TIME AVAILABILITY: ${(100 * res.timeAvailability).toFixed(1)}% (wind ${(opts.vOk * MS_TO_KMH).toFixed(1)}–${(25 * MS_TO_KMH).toFixed(1)} km/h, production below ${(100 * opts.stopThreshold).toFixed(1)}% of rated capacity)`,
    `ENERGY CALIBRATION FACTOR: ${(100 * res.energyCalibration).toFixed(1)}% (observed/modelled reference production; not technical availability)`,
    "",
    "ESTABLISHED-OPERATION PERIOD USED PER FARM (ramp-up excluded):",
    renderTable(["Farm", "Established start", "Hours used", "Total hours", "Share used %"], res.windows.map((v) => [v.farm, v.start, v.used, v.total, format(v.total ? 100 * v.used / v.total : NaN, 1)])),
    "",
    "REFERENCE FARMS:",
    renderTable(["Farm", "Hours", "Mean wind km/h", "Observed CF", "Raw model CF", "Apparent availability", "Energy calibration"], res.ref.map((v) => [v.farm, v.hours, format(v.meanWind * MS_TO_KMH), format(v.observedCf), format(v.rawModelCf), format(v.timeAvailability), format(v.energyCalibration)])),
    "",
    "LEAVE-ONE-FARM-OUT VALIDATION:",
    renderTable(["Farm", "Hours", "Observed CF", "Predicted CF", "Bias points", "Hourly correlation", "Hourly RMSE % Pnom"], res.validation.map((v) => [v.farm, v.hours, format(v.observed), format(v.predicted), format(v.biasPoints, 2), format(v.correlation), format(v.rmsePct, 2)])),
    "",
    "REFERENCE SENSITIVITY (each farm removed in turn):",
    renderTable(["Farm removed", "Training farms", "Validated min km/h", "Validated max km/h", "Site hours outside %", "Calibration %", "Gross CF %", "Net CF %", "Net CF change points"], res.sensitivity.map((v) => [v.removed, v.farms, format(v.min * MS_TO_KMH, 2), format(v.max * MS_TO_KMH, 2), format(v.outsidePct, 2), format(v.calibrationPct, 2), format(v.grossCfPct, 2), format(v.netCfPct, 2), format(v.changePoints, 2)])),
    "",
    `VALIDATED REFERENCE WIND-SPEED RANGE: ${(res.vmin * MS_TO_KMH).toFixed(2)}–${(res.vmax * MS_TO_KMH).toFixed(2)} km/h`,
    `Site hours below range: ${res.belowPct.toFixed(2)}%; above range: ${res.abovePct.toFixed(2)}%.`,
    `Modelled energy outside the range: ${format(res.outsideEnergyPct, 2)}%.`,
    `Sensitivity only: net capacity factor would be ${(100 * res.netCfNoHighExtrapolation).toFixed(1)}% if power were zero above ${(res.vmax * MS_TO_KMH).toFixed(2)} km/h.`,
    "",
    "PRODUCTION DATA COVERAGE (expected hours = hours in reference wind file):",
    renderTable(["Farm", "Expected wind hours", "Production hours", "Missing hours", "Coverage %", "Missing periods", "Longest gap h"], res.coverage.map((v) => [v.farm, v.expected, v.present, v.missing, format(v.coveragePct, 2), v.missingPeriods, v.longestGap])),
    "",
    "COVERAGE BY YEAR:",
    renderTable(["Farm", "Year", "Production hours", "Expected wind hours", "Coverage %"], res.coverageByYear.map((v) => [v.farm, v.year, v.present, v.expected, format(v.coveragePct, 2)])),
    "",
    "LONGEST CONTINUOUS GAPS (up to 3 per farm):",
    ...res.coverage.map((v) => `${v.farm}: ${v.gaps}`),
    "",
    "SITE NET CAPACITY FACTOR BY YEAR:",
    renderTable(["Year", "Net capacity factor %"], res.annual.map(([year, cf]) => [year, format(100 * cf, 1)])),
    "",
    ...(warns.length ? ["WARNINGS:", ...warns.map((w) => ` - ${w}`), ""] : []),
    "ASSUMPTIONS AND ESTIMATION ACCURACY:",
    "- ERA5/Open-Meteo hourly wind at 100 m is reported in km/h and averaged between the hour's endpoints; hourly production is aligned to this interval.",
    `- The reference curve uses ${(0.5 * MS_TO_KMH).toFixed(1)} km/h bins, farm-level median capacity factors, a 30-observation default minimum, hour weighting, interpolation and three-bin smoothing.`,
    `- Established-operation filtering uses the 75th percentile of capacity factor above ${(12 * MS_TO_KMH).toFixed(1)} km/h; two consecutive qualifying months with at least 10 observations each are required (default threshold 0.90).`,
    "- Above the validated wind range the curve is held at its final value; high-wind storm shutdown is not modelled.",
    "- Apparent time availability and the energy calibration factor absorb data gaps, outages and model bias; neither is measured technical availability.",
    "- Leave-one-farm-out validation and reference sensitivity describe transfer uncertainty. Reference validation biases of several capacity-factor points are plausible; do not interpret decimal precision as forecast accuracy.",
    "- ERA5 has roughly 31 km grid spacing and can have hourly wind errors of several km/h or more offshore. Reference turbine hub heights are near 100 m; shear to higher hubs is not corrected.",
    "- Wake losses and curtailment are implicit in reference production. Negative reference production is clipped to zero; individual farm datasets are not jointly filtered.",
    "- Satellite imagery locates the site only; it does not show individual turbines. EOX/Esri attribution and licensing are included on the figure; eox2024 is non-commercial/share-alike.",
  ];
  return `${lines.join("\n")}\n`;
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

function svgLine(x1, y1, x2, y2, color = "#bbb", width = 1, dash = "") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function chartSvg(opts, res, satellite) {
  const width = 1600, height = 1200, plotY = 150, plotH = 340;
  const panels = [{ x: 70, w: 450 }, { x: 585, w: 430 }, { x: 1080, w: 450 }];
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="white"/>`,
    `<style>text{font-family:Arial,sans-serif;fill:#222}.small{font-size:12px}.axis{font-size:13px}.title{font-size:18px;font-weight:bold}</style>`,
    `<text x="${width / 2}" y="32" text-anchor="middle" font-size="22" font-weight="bold">${xmlEscape(`Site (${opts.lat.toFixed(3)}°N, ${opts.lon.toFixed(3)}°E) — net CF ${(100 * res.netCf).toFixed(1)}% — ${(res.site.reduce((s, d) => s + d.net, 0) / res.site.length * 8766 / 1000).toFixed(0)} GWh/year — ERA5 + ${res.ref.length} reference farms`)}</text>`];
  const p0 = panels[0], xWind = (v) => p0.x + (v / (30 * MS_TO_KMH)) * p0.w, yPower = (p) => plotY + plotH - (p / res.rated) * plotH;
  out.push(`<text class="title" x="${p0.x + p0.w / 2}" y="88" text-anchor="middle">Site power curve (${res.rated.toFixed(0)} MW)</text>`);
  for (let v = 0; v <= 30 * MS_TO_KMH; v += 18) {
    out.push(svgLine(xWind(v), plotY, xWind(v), plotY + plotH, "#e5e5e5"));
    out.push(`<text class="small" x="${xWind(v)}" y="${plotY + plotH + 20}" text-anchor="middle">${v}</text>`);
  }
  for (let p = 0; p <= 1; p += 0.2) {
    out.push(svgLine(p0.x, yPower(p * res.rated), p0.x + p0.w, yPower(p * res.rated), "#e5e5e5"));
    out.push(`<text class="small" x="${p0.x - 8}" y="${yPower(p * res.rated) + 4}" text-anchor="end">${(p * res.rated).toFixed(0)}</text>`);
  }
  const area = res.curve.map((_, i) => `${xWind(CENTERS[i] * MS_TO_KMH)},${yPower(res.rated * res.max[i])}`).join(" ") + " " +
    res.curve.map((_, j) => res.curve.length - j - 1).map((i) => `${xWind(CENTERS[i] * MS_TO_KMH)},${yPower(res.rated * res.min[i])}`).join(" ");
  out.push(`<polygon points="${area}" fill="#9ecae1" opacity=".45"/>`);
  const curvePath = (factor) => res.curve.map((v, i) => `${i ? "L" : "M"}${xWind(CENTERS[i] * MS_TO_KMH).toFixed(2)},${yPower(res.rated * v * factor).toFixed(2)}`).join(" ");
  out.push(`<path d="${curvePath(1)}" fill="none" stroke="#2171b5" stroke-width="3"/>`,
    `<path d="${curvePath(res.energyCalibration)}" fill="none" stroke="#cb181d" stroke-width="2.5" stroke-dasharray="8 5"/>`,
    svgLine(xWind(res.vmax * MS_TO_KMH), plotY, xWind(res.vmax * MS_TO_KMH), plotY + plotH, "#777", 1.5, "3 4"),
    `<text class="axis" x="${p0.x + p0.w / 2}" y="${plotY + plotH + 48}" text-anchor="middle">Wind speed at 100 m (km/h)</text>`,
    `<text class="small" x="${p0.x + 6}" y="${plotY + 18}" fill="#2171b5">Gross</text>`,
    `<text class="small" x="${p0.x + 70}" y="${plotY + 18}" fill="#cb181d">Net (calibration ${res.energyCalibration.toFixed(3)})</text>`);

  const siteWind = res.site.map((d) => d.wind * MS_TO_KMH);
  const meanWind = mean(siteWind);
  const p1 = panels[1], histTop = plotY, histH = plotH;
  out.push(`<text class="title" x="${p1.x + p1.w / 2}" y="88" text-anchor="middle">Site wind (ERA5)</text>`);
  const hist = Array(30).fill(0);
  for (const v of siteWind) if (v >= 0 && v < 30 * MS_TO_KMH) hist[Math.floor(v / MS_TO_KMH)] += 1;
  const maxHist = Math.max(...hist, 1);
  for (let i = 0; i < hist.length; i += 1) {
    const bw = p1.w / 30;
    const h = hist[i] / maxHist * histH;
    out.push(`<rect x="${p1.x + i * bw}" y="${histTop + histH - h}" width="${bw - 1}" height="${h}" fill="#41b6c4"/>`);
  }
  out.push(svgLine(p1.x, histTop + histH, p1.x + p1.w, histTop + histH, "#333"),
    `<text class="small" x="${p1.x + p1.w / 2}" y="${plotY + plotH + 20}" text-anchor="middle">Wind speed (km/h)</text>`,
    `<text class="small" x="${p1.x + p1.w / 2}" y="${plotY + 24}" text-anchor="middle">Mean ${meanWind.toFixed(2)} km/h · ${siteWind.length} hours</text>`);

  const p2 = panels[2], monthlyWind = Array(12).fill(0), monthlyPower = Array(12).fill(0), monthlyCount = Array(12).fill(0);
  for (const d of res.site) {
    const month = new Date(d.t).getUTCMonth();
    monthlyWind[month] += d.wind; monthlyPower[month] += d.net; monthlyCount[month] += 1;
  }
  monthlyWind.forEach((_, i) => { if (monthlyCount[i]) { monthlyWind[i] /= monthlyCount[i]; monthlyPower[i] /= monthlyCount[i]; } else { monthlyWind[i] = NaN; monthlyPower[i] = NaN; } });
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  out.push(`<text class="title" x="${p2.x + p2.w / 2}" y="88" text-anchor="middle">Monthly averages</text>`);
  const maxMonthlyWind = Math.max(1, ...monthlyWind.filter(Number.isFinite));
  const maxMonthlyPower = Math.max(1, ...monthlyPower.filter(Number.isFinite));
  for (let i = 0; i < 12; i += 1) {
    const x = p2.x + i * p2.w / 12 + 3, bw = p2.w / 12 - 6;
    const h = Number.isFinite(monthlyWind[i]) ? monthlyWind[i] / maxMonthlyWind * plotH : 0;
    out.push(`<rect x="${x}" y="${plotY + plotH - h}" width="${bw}" height="${h}" fill="#41b6c4"/>`,
      `<text class="small" x="${x + bw / 2}" y="${plotY + plotH + 19}" text-anchor="middle">${months[i]}</text>`);
  }
  const monthlyPath = monthlyPower.map((p, i) => Number.isFinite(p) ?
    `${monthlyPower.slice(0, i).some(Number.isFinite) ? "L" : "M"}${p2.x + (i + 0.5) * p2.w / 12},${plotY + plotH - p / maxMonthlyPower * plotH}` : "").filter(Boolean).join(" ");
  out.push(`<path d="${monthlyPath}" fill="none" stroke="#238b45" stroke-width="3"/>`,
    `<text class="small" x="${p2.x + 4}" y="${plotY + 17}" fill="#238b45">Net mean power: 0–${maxMonthlyPower.toFixed(0)} MW</text>`);

  const map = { x: 430, y: 650, size: 740 };
  out.push(`<text class="title" x="${map.x + map.size / 2}" y="585" text-anchor="middle">Satellite view (${opts.lat.toFixed(3)}°N, ${opts.lon.toFixed(3)}°E), radius ${opts.radiusKm} km</text>`,
    `<defs><clipPath id="mapclip"><rect x="${map.x}" y="${map.y}" width="${map.size}" height="${map.size}"/></clipPath></defs>`,
    `<rect x="${map.x}" y="${map.y}" width="${map.size}" height="${map.size}" fill="#e8edf0"/>`);
  if (satellite?.tiles?.length) {
    const scale = map.size / (2 * satellite.radiusPixels);
    const centerX = satellite.centerX * 256, centerY = satellite.centerY * 256;
    out.push(`<g clip-path="url(#mapclip)">`);
    for (const tile of satellite.tiles) {
      const x = map.x + (tile.x * 256 - centerX + satellite.radiusPixels) * scale;
      const y = map.y + (tile.y * 256 - centerY + satellite.radiusPixels) * scale;
      out.push(`<image x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(256 * scale).toFixed(2)}" height="${(256 * scale).toFixed(2)}" href="${tile.href}"/>`);
    }
    out.push("</g>");
  } else {
    out.push(`<text x="${map.x + map.size / 2}" y="${map.y + map.size / 2}" text-anchor="middle">${xmlEscape(satellite?.error ?? "Satellite disabled")}</text>`);
  }
  out.push(`<circle cx="${map.x + map.size / 2}" cy="${map.y + map.size / 2}" r="7" fill="none" stroke="red" stroke-width="3"/>`,
    `<path d="M${map.x + map.size / 2 - 12} ${map.y + map.size / 2}h24 M${map.x + map.size / 2} ${map.y + map.size / 2 - 12}v24" stroke="red" stroke-width="2"/>`,
    `<text class="small" x="${map.x + 6}" y="${map.y + map.size - 12}">Radius ${opts.radiusKm} km</text>`,
    `<text class="small" x="${map.x + map.size / 2}" y="${map.y + map.size + 25}" text-anchor="middle">East (km from site)</text>`,
    `<text class="small" transform="translate(${map.x - 18} ${map.y + map.size / 2}) rotate(-90)" text-anchor="middle">North (km from site)</text>`,
    `<text class="small" x="${map.x}" y="${map.y + map.size + 48}">${xmlEscape(satellite?.attribution ?? "")}</text>`,
    "</svg>");
  return out.join("\n");
}

function lonLatToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n,
  };
}

function metersPerPixel(lat, zoom) {
  return METERS_PER_TILE_EQUATOR * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
}

async function loadSatellite(opts) {
  if (!opts.satellite) return { error: "Satellite image disabled (--sans-satellite)" };
  if (!(opts.radiusKm > 0 && opts.radiusKm <= 500)) throw new MissingDataError("--rayon-km must be greater than 0 and at most 500");
  const source = SOURCES[opts.satelliteSource];
  if (!source) throw new MissingDataError(`Unknown satellite source: ${opts.satelliteSource}`);
  const zoom = Array.from({ length: source.zmax + 1 }, (_, z) => z)
    .find((z) => 2000 * opts.radiusKm / metersPerPixel(opts.lat, z) >= 900) ?? source.zmax;
  const mpp = metersPerPixel(opts.lat, zoom), radiusPixels = opts.radiusKm * 1000 / mpp;
  const center = lonLatToTile(opts.lat, opts.lon, zoom);
  const x0 = center.x * 256 - radiusPixels, x1 = center.x * 256 + radiusPixels;
  const y0 = center.y * 256 - radiusPixels, y1 = center.y * 256 + radiusPixels;
  const n = 2 ** zoom;
  const tx0 = Math.floor(x0 / 256), tx1 = Math.floor((x1 - 1e-9) / 256);
  const ty0 = Math.floor(Math.max(y0, 0) / 256), ty1 = Math.floor((Math.min(y1, n * 256) - 1e-9) / 256);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 64) throw new MissingDataError("Satellite view requires more than 64 tiles; reduce --rayon-km");
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty += 1) for (let tx = tx0; tx <= tx1; tx += 1) {
    const wrappedX = ((tx % n) + n) % n;
    const cache = path.join(opts.tileCache, opts.satelliteSource, String(zoom), String(wrappedX), `${ty}.jpg`);
    let bytes;
    if (fs.existsSync(cache)) bytes = fs.readFileSync(cache);
    else {
      const url = source.url.replace("{z}", String(zoom)).replace("{y}", String(ty)).replace("{x}", String(wrappedX));
      const response = await fetch(url, { headers: { "User-Agent": "courbe-eolien-site-js/1.0 (educational)" } });
      if (!response.ok) throw new MissingDataError(`Satellite tile request failed: HTTP ${response.status} for ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, bytes);
    }
    tiles.push({ x: tx, y: ty, href: `data:image/jpeg;base64,${bytes.toString("base64")}` });
  }
  return { tiles, radiusPixels, centerX: center.x, centerY: center.y, zoom, resolution: mpp, attribution: source.attribution };
}

function selfTest() {
  const synthetic = [];
  for (let i = 0; i < 1200; i += 1) {
    const v = ((i * 37) % 300) / 10;
    synthetic.push({ t: i * HOUR_MS, v, cf: Math.min(1, Math.max(0, (v - 3) / 14)) });
  }
  const model = combineCurves([curveForFarm(synthetic, 2), curveForFarm(synthetic, 2)]);
  if (model.curve.length !== 60 || model.curve.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error("Synthetic curve test failed");
  const pairs = Array.from({ length: 20 }, (_, i) => ({ cf: i, v: i }));
  if (Math.abs(spearman(pairs) - 1) > 1e-10) throw new Error("Spearman correlation test failed");
  const csv = csvRows('timestamp_utc;production_totale_mw\n2024-01-01T00:00:00Z;10\n', ";");
  if (csv[0].production_totale_mw !== "10") throw new Error("CSV parser test failed");
  const point = lonLatToTile(0, 0, 1);
  if (Math.abs(point.x - 1) > 1e-12 || Math.abs(point.y - 1) > 1e-12) throw new Error("Satellite projection test failed");
  console.log("Synthetic self-test passed (CSV parsing, Spearman correlation, wind curve, tile projection).");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(usage()); return; }
  if (opts.selftest) { selfTest(); return; }
  for (const key of ["lat", "lon", "n", "mw"]) {
    if (!Number.isFinite(opts[key])) throw new MissingDataError(`--${key} is required and must be numeric`);
  }
  if (opts.n <= 0 || opts.mw <= 0 || !Number.isInteger(opts.minHours) || opts.minHours <= 0) {
    throw new MissingDataError("--n, --mw, and --min-heures must be positive");
  }
  const farms = loadFarms(opts.farms);
  const production = loadProduction(opts.dataDir, farms);
  const winds = loadReferenceWind(opts.dataDir, farms);
  for (const farm of farms) {
    if (![...winds.get(farm.name).keys()].some((t) => production.get(farm.name).has(t))) {
      throw new MissingDataError(`No common production/wind hour for farm ${farm.name}`);
    }
  }
  const siteWind = await getSiteWind(opts);
  const { lag, scores } = bestLag(production, winds);
  console.error(`Production/wind time shift tested -> mean Spearman correlation: ${[...scores].map(([k, v]) => `${k >= 0 ? "+" : ""}${k}:${format(v)}`).join(", ")}; selected ${lag >= 0 ? "+" : ""}${lag} h`);
  const res = analyze(farms, production, winds, siteWind, opts, lag);
  const warns = warnings(farms, opts, res);
  let satellite;
  try { satellite = await loadSatellite(opts); }
  catch (error) {
    satellite = { error: `Satellite image unavailable: ${error.message}` };
    warns.push(satellite.error);
    console.error(`Warning: ${satellite.error}`);
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  writeCsv(path.join(opts.outDir, "courbe_puissance.csv"),
    ["vent_kmh", "P_MW_brut", "P_MW_net", "P_MW_min_parcs", "P_MW_max_parcs", "heures_ref"],
    CENTERS.map((v, i) => [v * MS_TO_KMH, res.rated * res.curve[i], res.rated * res.curve[i] * res.energyCalibration, res.rated * res.min[i], res.rated * res.max[i], res.counts[i]]));
  writeCsv(path.join(opts.outDir, "serie_horaire_site.csv"),
    ["timestamp_utc", "vent_100m_kmh", "P_brute_MW", "P_nette_MW"],
    res.site.map((d) => [new Date(d.t).toISOString(), d.wind * MS_TO_KMH, d.gross, d.net]));
  fs.writeFileSync(path.join(opts.outDir, "resume.txt"), makeReport(opts, res, warns), "utf8");
  fs.writeFileSync(path.join(opts.outDir, "courbe_site.svg"), chartSvg(opts, res, satellite), "utf8");
  console.log(makeReport(opts, res, warns));
  console.log(`\nFiles written to ${opts.outDir}/ (SVG chart: courbe_site.svg)`);
}

main().catch((error) => {
  console.error(`${error instanceof MissingDataError ? "MISSING DATA" : "ERROR"}: ${error.message}`);
  process.exitCode = 2;
});
