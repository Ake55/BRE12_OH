(function () {
  const reference = window.EXTRAPOLATE_REFERENCE;
  const form = document.getElementById("siteForm");
  const resultsSection = document.getElementById("results");
  const statusElement = document.getElementById("formStatus");

  if (!reference || !form || !resultsSection) {
    if (statusElement) statusElement.textContent = "Reference data could not be loaded.";
    return;
  }

  const HOUR_MS = 3_600_000;
  const MS_TO_KMH = 3.6;
  const CENTERS = Array.from({ length: 60 }, (_, index) => index * 0.5 + 0.25);
  const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const SATELLITE_SOURCES = {
    eox2016: {
      url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
      maxNativeZoom: 14,
      attribution:
        "Sentinel-2 cloudless - s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016) - CC BY 4.0",
    },
    eox2024: {
      url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
      maxNativeZoom: 14,
      attribution:
        "Sentinel-2 cloudless - s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024) - CC BY-NC-SA 4.0",
    },
    esri: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maxNativeZoom: 17,
      attribution: "Tiles (c) Esri - Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  };
  const DEFAULTS = {
    lat: 45.834,
    lon: -1.923,
    turbines: 80,
    turbineMw: 15,
    startDate: "2016-01-01",
    endDate: "2025-12-31",
    model: "",
    regimeThreshold: 0.9,
    vOk: 8,
    stopThreshold: 0.01,
    minHours: 30,
    satelliteRadius: 200,
    satelliteSource: "eox2016",
    satelliteEnabled: true,
  };

  const farms = reference.farms;
  const productions = new Map();
  const winds = new Map();
  for (const farm of farms) {
    const series = reference.series[farm.name];
    productions.set(farm.name, seriesToMap(series.production));
    winds.set(farm.name, seriesToMap(series.wind));
  }

  let lastRun = null;
  let siteMap = null;
  let tileLayer = null;
  let overlayLayer = null;
  const siteWindCache = new Map();

  function seriesToMap(series) {
    const map = new Map();
    for (let index = 0; index < series.offsets.length; index += 1) {
      map.set(series.start + series.offsets[index] * HOUR_MS, series.values[index]);
    }
    return map;
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
  }

  function quantile(values, q) {
    const sorted = values.slice().sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }

  function pairData(cf, wind, lag = 0) {
    const pairs = [];
    for (const [timestamp, cfValue] of cf) {
      const windValue = wind.get(timestamp + lag * HOUR_MS);
      if (Number.isFinite(windValue) && Number.isFinite(cfValue)) {
        pairs.push({ t: timestamp, cf: cfValue, v: windValue });
      }
    }
    return pairs.sort((first, second) => first.t - second.t);
  }

  function rank(values) {
    const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = new Array(values.length);
    for (let index = 0; index < sorted.length;) {
      let next = index + 1;
      while (next < sorted.length && sorted[next].value === sorted[index].value) next += 1;
      const average = (index + 1 + next) / 2;
      for (let item = index; item < next; item += 1) ranks[sorted[item].index] = average;
      index = next;
    }
    return ranks;
  }

  function correlation(first, second) {
    if (first.length < 2 || first.length !== second.length) return NaN;
    const meanFirst = mean(first);
    const meanSecond = mean(second);
    let covariance = 0;
    let varianceFirst = 0;
    let varianceSecond = 0;
    for (let index = 0; index < first.length; index += 1) {
      const x = first[index] - meanFirst;
      const y = second[index] - meanSecond;
      covariance += x * y;
      varianceFirst += x * x;
      varianceSecond += y * y;
    }
    return varianceFirst && varianceSecond
      ? covariance / Math.sqrt(varianceFirst * varianceSecond)
      : NaN;
  }

  function spearman(pairs) {
    return correlation(
      rank(pairs.map((item) => item.cf)),
      rank(pairs.map((item) => item.v))
    );
  }

  function bestLag() {
    const scores = new Map();
    for (let lag = -3; lag <= 3; lag += 1) {
      const correlations = [...productions.keys()]
        .map((name) => spearman(pairData(productions.get(name), winds.get(name), lag)))
        .filter(Number.isFinite);
      scores.set(lag, correlations.length ? mean(correlations) : NaN);
    }
    const valid = [...scores].filter(([, score]) => Number.isFinite(score));
    if (!valid.length) throw new Error("Could not determine a production/wind time shift.");
    valid.sort((first, second) => second[1] - first[1]);
    return { lag: valid[0][0], scores };
  }

  function establishedStart(data, threshold) {
    const byMonth = new Map();
    for (const item of data) {
      if (item.v >= 12) {
        const date = new Date(item.t);
        const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push(item.cf);
      }
    }
    const months = [...byMonth]
      .sort((first, second) => first[0].localeCompare(second[0]))
      .filter(([, values]) => values.length >= 10)
      .map(([key, values]) => ({ key, q75: quantile(values, 0.75) }));
    for (let index = 0; index + 1 < months.length; index += 1) {
      const [firstYear, firstMonth] = months[index].key.split("-").map(Number);
      const [secondYear, secondMonth] = months[index + 1].key.split("-").map(Number);
      const consecutive = firstYear * 12 + firstMonth + 1 === secondYear * 12 + secondMonth;
      if (consecutive && months[index].q75 >= threshold && months[index + 1].q75 >= threshold) {
        return Date.UTC(firstYear, firstMonth - 1, 1);
      }
    }
    return null;
  }

  function curveForFarm(data, minHours) {
    const bins = Array.from({ length: CENTERS.length }, () => []);
    for (const item of data) {
      const bin = Math.floor(item.v / 0.5);
      if (bin >= 0 && bin < bins.length) bins[bin].push(item.cf);
    }
    return {
      counts: bins.map((values) => values.length),
      medians: bins.map((values) => (values.length >= minHours ? quantile(values, 0.5) : NaN)),
    };
  }

  function combineCurves(curves) {
    const total = CENTERS.map((_, index) =>
      curves.reduce(
        (sum, curve) => sum + (Number.isFinite(curve.medians[index]) ? curve.counts[index] : 0),
        0
      )
    );
    const combined = CENTERS.map((_, index) => {
      if (!total[index]) return NaN;
      return (
        curves.reduce(
          (sum, curve) =>
            sum + (Number.isFinite(curve.medians[index]) ? curve.medians[index] * curve.counts[index] : 0),
          0
        ) / total[index]
      );
    });
    const valid = combined
      .map((value, index) => (Number.isFinite(value) ? index : -1))
      .filter((index) => index >= 0);
    if (valid.length < 5) throw new Error("Too few populated wind bins to build a curve.");
    const first = valid[0];
    const last = valid.at(-1);
    const full = CENTERS.map((_, index) => {
      if (index < first) return combined[first];
      if (index >= last) return combined[last];
      let low = first;
      while (low + 1 < valid.length && valid[low + 1] < index) low += 1;
      const start = valid[low];
      const end = valid[low + 1];
      return combined[start] + ((combined[end] - combined[start]) * (index - start)) / (end - start);
    });
    const curve = full.map((_, index) => {
      const values = full.slice(Math.max(0, index - 1), Math.min(full.length, index + 2));
      return Math.max(0, Math.min(1, mean(values)));
    });
    const minimum = CENTERS.map((_, index) => {
      const values = curves.map((curve) => curve.medians[index]).filter(Number.isFinite);
      return values.length ? Math.min(...values) : curve[index];
    });
    const maximum = CENTERS.map((_, index) => {
      const values = curves.map((curve) => curve.medians[index]).filter(Number.isFinite);
      return values.length ? Math.max(...values) : curve[index];
    });
    return {
      curve,
      counts: total,
      min: minimum,
      max: maximum,
      vmin: CENTERS[first],
      vmax: CENTERS[last],
    };
  }

  function predict(wind, curve) {
    if (wind <= CENTERS[0]) return curve[0];
    if (wind >= CENTERS.at(-1)) return curve.at(-1);
    const index = Math.floor((wind - CENTERS[0]) / 0.5);
    const fraction = (wind - CENTERS[index]) / (CENTERS[index + 1] - CENTERS[index]);
    return curve[index] + (curve[index + 1] - curve[index]) * fraction;
  }

  function calibrate(dataByFarm, curve) {
    let observed = 0;
    let predicted = 0;
    for (const data of dataByFarm.values()) {
      for (const item of data) {
        observed += item.cf;
        predicted += predict(item.v, curve);
      }
    }
    if (predicted <= 0) throw new Error("Cannot calculate the energy calibration factor.");
    return observed / predicted;
  }

  function analyze(options, siteWind, lag) {
    const allPairs = new Map(
      farms.map((farm) => [farm.name, pairData(productions.get(farm.name), winds.get(farm.name), lag)])
    );
    const windows = [];
    const data = new Map();
    for (const farm of farms) {
      const pairs = allPairs.get(farm.name);
      const start =
        options.regimeThreshold <= 0 ? (pairs[0]?.t ?? null) : establishedStart(pairs, options.regimeThreshold);
      const selected = pairs.filter((item) => start !== null && item.t >= start);
      if (selected.length) data.set(farm.name, selected);
      windows.push({
        farm: farm.name,
        start: start === null ? "never reached" : new Date(start).toISOString().slice(0, 10),
        used: selected.length,
        total: pairs.length,
      });
    }
    if (data.size < 2) {
      throw new Error("Fewer than two farms have an established-operation period; lower the threshold.");
    }
    const base = combineCurves([...data.values()].map((items) => curveForFarm(items, options.minHours)));
    const energyCalibration = calibrate(data, base.curve);
    const ref = [];
    for (const [name, pairs] of data) {
      const highWind = pairs.filter((item) => item.v >= options.vOk && item.v <= 25);
      const timeAvailability = highWind.length
        ? 1 - highWind.filter((item) => item.cf < options.stopThreshold).length / highWind.length
        : NaN;
      ref.push({
        farm: name,
        hours: pairs.length,
        meanWind: mean(pairs.map((item) => item.v)),
        observedCf: mean(pairs.map((item) => item.cf)),
        rawModelCf: mean(pairs.map((item) => predict(item.v, base.curve))),
        timeAvailability,
        energyCalibration: calibrate(new Map([[name, pairs]]), base.curve),
      });
    }
    const timeAvailability =
      ref.reduce((sum, farm) => sum + farm.timeAvailability * farm.hours, 0) /
      ref.reduce((sum, farm) => sum + farm.hours, 0);
    const rated = options.turbines * options.turbineMw;
    const site = [...siteWind]
      .sort((first, second) => first[0] - second[0])
      .map(([timestamp, wind]) => {
        const gross = rated * predict(wind, base.curve);
        return {
          t: timestamp,
          wind,
          gross,
          net: Math.min(gross * energyCalibration, rated),
        };
      });
    if (!site.length) throw new Error("No site wind data available for the selected dates.");
    const grossCf = mean(site.map((item) => item.gross / rated));
    const netCf = mean(site.map((item) => item.net / rated));

    const validation = [];
    for (const name of data.keys()) {
      const training = new Map([...data].filter(([farm]) => farm !== name));
      const trainingCurve = combineCurves(
        [...training.values()].map((items) => curveForFarm(items, options.minHours))
      );
      const factor = calibrate(training, trainingCurve.curve);
      const test = data.get(name);
      const predicted = test.map((item) => predict(item.v, trainingCurve.curve) * factor);
      const observed = test.map((item) => item.cf);
      validation.push({
        farm: name,
        hours: test.length,
        observed: mean(observed),
        predicted: mean(predicted),
        biasPoints: 100 * (mean(predicted) - mean(observed)),
        correlation: correlation(observed, predicted),
        rmsePct: 100 * Math.sqrt(mean(observed.map((value, index) => (value - predicted[index]) ** 2))),
      });
    }

    const sensitivity = [];
    for (const removed of data.keys()) {
      const training = new Map([...data].filter(([farm]) => farm !== removed));
      const model = combineCurves(
        [...training.values()].map((items) => curveForFarm(items, options.minHours))
      );
      const factor = calibrate(training, model.curve);
      const predicted = site.map((item) => predict(item.wind, model.curve));
      const minBin = CENTERS.findIndex((_, index) => model.counts[index] > 0);
      const fcNet = mean(predicted.map((value) => Math.min(value * factor, 1)));
      sensitivity.push({
        removed,
        farms: training.size,
        min: CENTERS[minBin],
        max: model.vmax,
        outsidePct:
          (100 * site.filter((item) => item.wind < CENTERS[minBin] || item.wind > model.vmax).length) /
          site.length,
        calibrationPct: 100 * factor,
        grossCfPct: 100 * mean(predicted),
        netCfPct: 100 * fcNet,
        changePoints: 100 * (fcNet - netCf),
      });
    }

    const below = site.filter((item) => item.wind < base.vmin);
    const above = site.filter((item) => item.wind > base.vmax);
    const outside = site.filter((item) => item.wind < base.vmin || item.wind > base.vmax);
    const predictedTotal = site.reduce((sum, item) => sum + predict(item.wind, base.curve), 0);
    const annual = new Map();
    for (const item of site) {
      const year = new Date(item.t).getUTCFullYear();
      const entry = annual.get(year) ?? { sum: 0, count: 0 };
      entry.sum += item.net / rated;
      entry.count += 1;
      annual.set(year, entry);
    }

    const coverage = farms.map((farm) => {
      const wind = winds.get(farm.name);
      const production = productions.get(farm.name);
      const missing = [...wind.keys()].filter((timestamp) => !production.has(timestamp)).sort((a, b) => a - b);
      const byYear = new Map();
      for (const timestamp of wind.keys()) {
        const year = new Date(timestamp).getUTCFullYear();
        const entry = byYear.get(year) ?? { expected: 0, present: 0 };
        entry.expected += 1;
        if (production.has(timestamp)) entry.present += 1;
        byYear.set(year, entry);
      }
      const periods = [];
      for (const timestamp of missing) {
        const last = periods.at(-1);
        if (last && timestamp === last.end) {
          last.end += HOUR_MS;
          last.hours += 1;
        } else {
          periods.push({ start: timestamp, end: timestamp + HOUR_MS, hours: 1 });
        }
      }
      const gaps = periods
        .slice()
        .sort((first, second) => second.hours - first.hours)
        .slice(0, 3)
        .map(
          (period) =>
            `${formatDateTime(period.start)}–${formatDateTime(period.end)} (${period.hours} hours)`
        );
      return {
        farm: farm.name,
        expected: wind.size,
        present: wind.size - missing.length,
        missing: missing.length,
        coveragePct: wind.size ? (100 * (wind.size - missing.length)) / wind.size : NaN,
        missingPeriods: periods.length,
        longestGap: Math.max(0, ...periods.map((period) => period.hours)),
        gaps: gaps.join("; ") || "none",
        byYear: [...byYear]
          .sort((first, second) => first[0] - second[0])
          .map(([year, entry]) => ({
            farm: farm.name,
            year,
            expected: entry.expected,
            present: entry.present,
            coveragePct: (100 * entry.present) / entry.expected,
          })),
      };
    });

    return {
      ...base,
      rated,
      energyCalibration,
      timeAvailability,
      ref,
      windows,
      site,
      grossCf,
      netCf,
      validation,
      sensitivity,
      belowPct: (100 * below.length) / site.length,
      abovePct: (100 * above.length) / site.length,
      outsideEnergyPct: predictedTotal
        ? (100 * outside.reduce((sum, item) => sum + predict(item.wind, base.curve), 0)) / predictedTotal
        : NaN,
      netCfNoHighExtrapolation: mean(
        site.map((item) =>
          Math.min(
            (item.wind > base.vmax ? 0 : predict(item.wind, base.curve)) * energyCalibration,
            1
          )
        )
      ),
      annual: [...annual]
        .sort((first, second) => first[0] - second[0])
        .map(([year, entry]) => [year, entry.sum / entry.count]),
      coverage,
      coverageByYear: coverage.flatMap((item) => item.byYear),
      lag,
    };
  }

  function buildWarnings(options, result, satelliteError) {
    const warnings = [];
    const low = Math.min(...farms.map((farm) => farm.turbine_mw));
    const high = Math.max(...farms.map((farm) => farm.turbine_mw));
    if (options.turbineMw < 0.75 * low || options.turbineMw > 1.25 * high) {
      warnings.push(
        `Unit rated power ${options.turbineMw} MW is outside the reference range (${low}–${high} MW); treat the result as an order-of-magnitude estimate.`
      );
    }
    if (result.abovePct > 1) {
      warnings.push(
        `${result.abovePct.toFixed(1)}% of site hours exceed the validated wind range up to ${(
          result.vmax * MS_TO_KMH
        ).toFixed(1)} km/h; a plateau is assumed.`
      );
    }
    if (result.belowPct > 1) {
      warnings.push(
        `${result.belowPct.toFixed(1)}% of site hours are below the validated range starting at ${(
          result.vmin * MS_TO_KMH
        ).toFixed(1)} km/h.`
      );
    }
    if (result.energyCalibration > 1) {
      warnings.push(
        `The energy calibration factor is ${(100 * result.energyCalibration).toFixed(
          1
        )}%; it is not a technical availability measure.`
      );
    }
    const maxBias = Math.max(...result.validation.map((item) => Math.abs(item.biasPoints)));
    if (maxBias > 3) {
      warnings.push(
        `Leave-one-farm-out capacity-factor bias reaches ${maxBias.toFixed(1)} percentage points.`
      );
    }
    for (const window of result.windows) {
      const share = window.total ? (100 * window.used) / window.total : 0;
      if (share < 80) {
        warnings.push(
          `${window.farm}: established operation starts ${window.start}; ${share.toFixed(
            0
          )}% of hours retained.`
        );
      }
    }
    if (result.ref.length < 3) {
      warnings.push("Fewer than three reference farms remain: validation may not be representative.");
    }
    if (satelliteError) warnings.push(satelliteError);
    return warnings;
  }

  async function fetchSiteWind(options) {
    const cacheKey = `${options.lat.toFixed(4)}|${options.lon.toFixed(4)}|${options.startDate}|${options.endDate}|${options.model}`;
    if (siteWindCache.has(cacheKey)) return siteWindCache.get(cacheKey);

    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", options.lat);
    url.searchParams.set("longitude", options.lon);
    url.searchParams.set("start_date", options.startDate);
    url.searchParams.set("end_date", options.endDate);
    url.searchParams.set("hourly", "wind_speed_100m");
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("timezone", "UTC");
    if (options.model) url.searchParams.set("models", options.model);

    let response;
    try {
      response = await fetch(url);
      if (!response.ok && options.model) {
        url.searchParams.delete("models");
        response = await fetch(url);
      }
    } catch (error) {
      if (!options.model) throw error;
      url.searchParams.delete("models");
      response = await fetch(url);
    }
    if (!response.ok) {
      throw new Error(`Open-Meteo request failed: HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (
      !payload.hourly?.time ||
      !payload.hourly?.wind_speed_100m ||
      payload.hourly.time.length !== payload.hourly.wind_speed_100m.length
    ) {
      throw new Error("Open-Meteo did not return aligned hourly wind values.");
    }
    const values = new Map();
    payload.hourly.time.forEach((time, index) => {
      const value = Number(payload.hourly.wind_speed_100m[index]);
      if (Number.isFinite(value)) values.set(Date.parse(`${time}Z`), value);
    });
    const hourlyMean = new Map();
    for (const [timestamp, value] of values) {
      if (values.has(timestamp + HOUR_MS)) {
        hourlyMean.set(timestamp, (value + values.get(timestamp + HOUR_MS)) / 2);
      }
    }
    if (!hourlyMean.size) throw new Error("No usable site wind hours were returned.");
    siteWindCache.set(cacheKey, hourlyMean);
    return hourlyMean;
  }

  function optionsFromForm() {
    return {
      lat: Number(document.getElementById("lat").value),
      lon: Number(document.getElementById("lon").value),
      turbines: Number(document.getElementById("turbines").value),
      turbineMw: Number(document.getElementById("turbineMw").value),
      startDate: document.getElementById("startDate").value,
      endDate: document.getElementById("endDate").value,
      model: DEFAULTS.model,
      regimeThreshold: DEFAULTS.regimeThreshold,
      vOk: DEFAULTS.vOk,
      stopThreshold: DEFAULTS.stopThreshold,
      minHours: DEFAULTS.minHours,
      satelliteRadius: Number(document.getElementById("satelliteRadius").value),
      satelliteSource: document.getElementById("satelliteSource").value,
      satelliteEnabled: document.getElementById("satelliteEnabled").checked,
    };
  }

  function validateOptions(options) {
    const required = ["lat", "lon", "turbines", "turbineMw", "startDate", "endDate", "regimeThreshold", "vOk", "stopThreshold", "minHours", "satelliteRadius"];
    for (const key of required) {
      if (options[key] === "" || Number.isNaN(options[key])) {
        throw new Error(`Missing or invalid value for ${key}.`);
      }
    }
    if (options.lat < -85 || options.lat > 85) throw new Error("Latitude must be between -85 and 85.");
    if (options.lon < -180 || options.lon > 180) throw new Error("Longitude must be between -180 and 180.");
    if (options.turbines <= 0 || !Number.isInteger(options.turbines)) throw new Error("Turbine count must be a positive integer.");
    if (options.turbineMw <= 0) throw new Error("MW per turbine must be positive.");
    if (options.startDate >= options.endDate) throw new Error("End date must be after start date.");
    if (options.minHours <= 0 || !Number.isInteger(options.minHours)) throw new Error("Minimum hours must be a positive integer.");
    if (options.satelliteRadius <= 0 || options.satelliteRadius > 500) throw new Error("Satellite radius must be between 1 and 500 km.");
  }

  function setStatus(text, type) {
    statusElement.textContent = text;
    statusElement.classList.toggle("is-error", type === "error");
    statusElement.classList.toggle("is-loading", type === "loading");
  }

  function format(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
  }

  function formatPercent(value, digits = 1) {
    return Number.isFinite(value) ? `${(100 * value).toFixed(digits)}%` : "n/a";
  }

  function formatNumber(value, digits = 0) {
    return Number.isFinite(value)
      ? value.toLocaleString("en-GB", { maximumFractionDigits: digits })
      : "n/a";
  }

  function formatDateTime(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
  }

  function chartConfig() {
    return {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    };
  }

  function chartLayout(extra = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: '"Segoe UI", Arial, sans-serif', color: "#1c343d", size: 11 },
      margin: { l: 58, r: 58, t: 36, b: 48 },
      height: window.innerWidth < 700 ? 340 : 390,
      hovermode: "closest",
      legend: { orientation: "h", x: 0, y: 1.14, font: { size: 10, color: "#5d7279" } },
      ...extra,
    };
  }

  function drawCharts(result) {
    if (!window.Plotly) return;
    const windData = result.site.map((item) => item.wind * MS_TO_KMH);
    const rated = result.rated;
    const xKmh = CENTERS.map((center) => center * MS_TO_KMH);
    window.Plotly.react(
      "curveChart",
      [
        {
          type: "scatter",
          mode: "lines",
          x: xKmh,
          y: result.max.map((value) => value * rated),
          line: { width: 0 },
          hoverinfo: "skip",
          showlegend: false,
        },
        {
          type: "scatter",
          mode: "lines",
          x: xKmh,
          y: result.min.map((value) => value * rated),
          fill: "tonexty",
          fillcolor: "rgba(15, 111, 120, 0.12)",
          line: { width: 0 },
          name: "Reference farm range",
          hoverinfo: "skip",
        },
        {
          type: "scatter",
          mode: "lines",
          x: xKmh,
          y: result.curve.map((value) => value * rated),
          line: { color: "#0f6f78", width: 3 },
          name: "Gross curve",
          customdata: result.counts,
          hovertemplate: "Wind %{x:.1f} km/h<br>Gross %{y:.1f} MW<br>%{customdata} reference hours<extra></extra>",
        },
        {
          type: "scatter",
          mode: "lines",
          x: xKmh,
          y: result.curve.map((value) => value * rated * result.energyCalibration),
          line: { color: "#d45b45", width: 2.5, dash: "dot" },
          name: "Net curve (calibrated)",
          hovertemplate: "Wind %{x:.1f} km/h<br>Net %{y:.1f} MW<extra></extra>",
        },
      ],
      chartLayout({
        xaxis: {
          title: { text: "Wind speed at 100 m (km/h)" },
          gridcolor: "rgba(8,37,47,0.08)",
          zeroline: false,
        },
        yaxis: {
          title: { text: "Power (MW)" },
          gridcolor: "rgba(8,37,47,0.08)",
          zeroline: false,
        },
        shapes: [
          {
            type: "rect",
            xref: "x",
            yref: "paper",
            x0: 0,
            x1: result.vmin * MS_TO_KMH,
            y0: 0,
            y1: 1,
            fillcolor: "rgba(8,37,47,0.06)",
            line: { width: 0 },
            layer: "below",
          },
          {
            type: "rect",
            xref: "x",
            yref: "paper",
            x0: result.vmax * MS_TO_KMH,
            x1: 30 * MS_TO_KMH,
            y0: 0,
            y1: 1,
            fillcolor: "rgba(8,37,47,0.06)",
            line: { width: 0 },
            layer: "below",
          },
        ],
      }),
      chartConfig()
    );

    const histogramCounts = new Array(30).fill(0);
    for (const speed of windData) {
      const bin = Math.floor(speed / MS_TO_KMH);
      if (bin >= 0 && bin < histogramCounts.length) histogramCounts[bin] += 1;
    }
    window.Plotly.react(
      "windChart",
      [
        {
          type: "bar",
          x: histogramCounts.map((_, index) => (index + 0.5) * MS_TO_KMH),
          y: histogramCounts,
          marker: { color: "#6cc7c2", line: { width: 0 } },
          hovertemplate: "%{x:.1f} km/h<br>%{y} hours<extra></extra>",
        },
      ],
      chartLayout({
        xaxis: { title: { text: "Wind speed at 100 m (km/h)" }, gridcolor: "rgba(8,37,47,0.06)" },
        yaxis: { title: { text: "Hours" }, gridcolor: "rgba(8,37,47,0.08)" },
        shapes: [
          {
            type: "line",
            x0: mean(windData),
            x1: mean(windData),
            yref: "paper",
            y0: 0,
            y1: 1,
            line: { color: "#d45b45", width: 2, dash: "dash" },
          },
        ],
      }),
      chartConfig()
    );

    const monthWind = Array.from({ length: 12 }, () => []);
    const monthPower = Array.from({ length: 12 }, () => []);
    for (const item of result.site) {
      const month = new Date(item.t).getUTCMonth();
      monthWind[month].push(item.wind * MS_TO_KMH);
      monthPower[month].push(item.net);
    }
    window.Plotly.react(
      "monthlyChart",
      [
        {
          type: "bar",
          name: "Mean wind speed",
          x: MONTH_LABELS,
          y: monthWind.map((values) => mean(values)),
          marker: { color: "#6cc7c2" },
          yaxis: "y",
          hovertemplate: "%{x}<br>%{y:.1f} km/h<extra></extra>",
        },
        {
          type: "scatter",
          mode: "lines+markers",
          name: "Mean net power",
          x: MONTH_LABELS,
          y: monthPower.map((values) => mean(values)),
          line: { color: "#0f6f78", width: 3 },
          marker: { color: "#0f6f78", size: 5 },
          yaxis: "y2",
          hovertemplate: "%{x}<br>%{y:.1f} MW<extra></extra>",
        },
      ],
      chartLayout({
        xaxis: { title: { text: "Month" } },
        yaxis: {
          title: { text: "Mean wind speed (km/h)", font: { color: "#3c9d99" } },
          tickfont: { color: "#3c9d99" },
          gridcolor: "rgba(8,37,47,0.06)",
        },
        yaxis2: {
          title: { text: "Mean net power (MW)", font: { color: "#0f6f78" } },
          tickfont: { color: "#0f6f78" },
          overlaying: "y",
          side: "right",
          showgrid: false,
          rangemode: "tozero",
        },
      }),
      chartConfig()
    );
  }

  function updateMap(options) {
    const mapElement = document.getElementById("siteMap");
    const note = document.getElementById("mapNote");
    if (!options.satelliteEnabled) {
      mapElement.style.display = "none";
      note.textContent = "Satellite context disabled.";
      return;
    }
    mapElement.style.display = "block";
    if (!window.L) {
      note.textContent = "The map library could not be loaded.";
      return;
    }
    const source = SATELLITE_SOURCES[options.satelliteSource] || SATELLITE_SOURCES.eox2016;
    if (!siteMap) {
      siteMap = window.L.map("siteMap", { scrollWheelZoom: false }).setView(
        [options.lat, options.lon],
        5
      );
    }
    siteMap.invalidateSize();
    if (tileLayer) siteMap.removeLayer(tileLayer);
    if (overlayLayer) siteMap.removeLayer(overlayLayer);
    tileLayer = window.L.tileLayer(source.url, {
      maxNativeZoom: source.maxNativeZoom,
      maxZoom: source.maxNativeZoom,
      attribution: source.attribution,
    }).addTo(siteMap);
    overlayLayer = window.L.layerGroup().addTo(siteMap);
    window.L.marker([options.lat, options.lon]).addTo(overlayLayer).bindPopup("Selected site");
    const circle = window.L.circle([options.lat, options.lon], {
      radius: options.satelliteRadius * 1000,
      color: "#f2b544",
      weight: 2,
      fill: false,
    }).addTo(overlayLayer);
    for (const farm of farms) {
      window.L.circleMarker([farm.lat, farm.lon], {
        radius: 6,
        color: "#ffffff",
        weight: 1,
        fillColor: "#d45b45",
        fillOpacity: 1,
      })
        .addTo(overlayLayer)
        .bindPopup(farm.name);
    }
    siteMap.setView([options.lat, options.lon], 5);
    const bounds = circle.getBounds();
    if (bounds.isValid()) siteMap.fitBounds(bounds, { padding: [16, 16] });
    window.setTimeout(() => siteMap.invalidateSize(), 120);
    note.textContent = `Site, ${options.satelliteRadius} km radius and reference farms. ${source.attribution}`;
  }

  function renderResults(options, result, warnings, satelliteError) {
    document.getElementById("siteSummary").textContent =
      `${options.turbines} × ${options.turbineMw} MW = ${formatNumber(result.rated)} MW · ${options.startDate} to ${options.endDate} · ${options.model || "default Open-Meteo model"}`;
    document.getElementById("netCf").textContent = formatPercent(result.netCf);
    document.getElementById("annualEnergy").textContent = `${formatNumber(
      (mean(result.site.map((item) => item.net)) * 8766) / 1000
    )} GWh/year`;

    resultsSection.hidden = false;
    drawCharts(result);

    const warningList = document.getElementById("warningList");
    warningList.innerHTML = "";
    if (!warnings.length) {
      const item = document.createElement("li");
      item.textContent = "No specific warnings for this run.";
      warningList.appendChild(item);
    } else {
      warnings.forEach((warning) => {
        const item = document.createElement("li");
        item.textContent = warning;
        warningList.appendChild(item);
      });
    }

    updateMap(options);
    lastRun = { options, result, warnings, satelliteError };
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function buildCsv(headers, rows) {
    const escape = (value) => {
      const text = String(value ?? "");
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return `${headers.join(",")}\n${rows.map((row) => row.map(escape).join(",")).join("\n")}\n`;
  }

  function downloadText(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function textTable(headers, rows) {
    const values = [headers, ...rows.map((row) => row.map((value) => String(value)))];
    const widths = headers.map((_, index) => Math.max(...values.map((row) => row[index].length)));
    return values
      .map((row, rowIndex) =>
        row
          .map((value, index) => (rowIndex === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index])))
          .join("  ")
          .trimEnd()
      )
      .join("\n");
  }

  function buildReport(options, result, warnings) {
    const lines = [
      `SITE: ${options.turbines} x ${options.turbineMw} MW = ${result.rated.toFixed(0)} MW | selected production/wind time shift: ${result.lag >= 0 ? "+" : ""}${result.lag} h`,
      `CAPACITY FACTOR: gross ${(100 * result.grossCf).toFixed(1)}% net ${(100 * result.netCf).toFixed(1)}% | mean net energy ${((mean(result.site.map((item) => item.net)) * 8766) / 1000).toFixed(0)} GWh/year`,
      `APPARENT TIME AVAILABILITY: ${(100 * result.timeAvailability).toFixed(1)}% (wind ${(options.vOk * MS_TO_KMH).toFixed(1)}–${(25 * MS_TO_KMH).toFixed(1)} km/h, production below ${(100 * options.stopThreshold).toFixed(1)}% of rated capacity)`,
      `ENERGY CALIBRATION FACTOR: ${(100 * result.energyCalibration).toFixed(1)}% (observed/modelled reference production; not technical availability)`,
      "",
      "ESTABLISHED-OPERATION PERIOD USED PER FARM (ramp-up excluded):",
      textTable(
        ["Farm", "Established start", "Hours used", "Total hours", "Share used %"],
        result.windows.map((item) => [
          item.farm,
          item.start,
          item.used,
          item.total,
          format(item.total ? (100 * item.used) / item.total : NaN, 1),
        ])
      ),
      "",
      "REFERENCE FARMS:",
      textTable(
        ["Farm", "Hours", "Mean wind km/h", "Observed CF", "Raw model CF", "Availability", "Calibration"],
        result.ref.map((item) => [
          item.farm,
          item.hours,
          format(item.meanWind * MS_TO_KMH),
          format(item.observedCf),
          format(item.rawModelCf),
          format(item.timeAvailability),
          format(item.energyCalibration),
        ])
      ),
      "",
      "LEAVE-ONE-FARM-OUT VALIDATION:",
      textTable(
        ["Farm", "Hours", "Observed CF", "Predicted CF", "Bias points", "Correlation", "RMSE % Pnom"],
        result.validation.map((item) => [
          item.farm,
          item.hours,
          format(item.observed),
          format(item.predicted),
          format(item.biasPoints, 2),
          format(item.correlation),
          format(item.rmsePct, 2),
        ])
      ),
      "",
      "REFERENCE SENSITIVITY:",
      textTable(
        ["Farm removed", "Training farms", "Validated range km/h", "Site hours outside %", "Calibration %", "Gross CF %", "Net CF %", "Net CF change points"],
        result.sensitivity.map((item) => [
          item.removed,
          item.farms,
          `${format(item.min * MS_TO_KMH)}–${format(item.max * MS_TO_KMH)}`,
          format(item.outsidePct, 2),
          format(item.calibrationPct, 2),
          format(item.grossCfPct, 2),
          format(item.netCfPct, 2),
          format(item.changePoints, 2),
        ])
      ),
      "",
      `VALIDATED REFERENCE WIND-SPEED RANGE: ${(result.vmin * MS_TO_KMH).toFixed(2)}–${(result.vmax * MS_TO_KMH).toFixed(2)} km/h`,
      `Site hours below range: ${result.belowPct.toFixed(2)}%; above range: ${result.abovePct.toFixed(2)}%.`,
      `Share of modelled energy outside the range: ${result.outsideEnergyPct.toFixed(2)}%.`,
      `Sensitivity scenario only: net capacity factor would be ${(100 * result.netCfNoHighExtrapolation).toFixed(1)}% if production were zero above ${(result.vmax * MS_TO_KMH).toFixed(2)} km/h.`,
      "",
      "PRODUCTION COVERAGE:",
      textTable(
        ["Farm", "Expected wind hours", "Production hours", "Missing hours", "Coverage %", "Missing periods", "Longest gap h"],
        result.coverage.map((item) => [
          item.farm,
          item.expected,
          item.present,
          item.missing,
          format(item.coveragePct, 2),
          item.missingPeriods,
          item.longestGap,
        ])
      ),
      "",
      "SITE NET CAPACITY FACTOR BY YEAR:",
      result.annual.map(([year, value]) => `${year}: ${(100 * value).toFixed(1)}%`).join("\n"),
      "",
      "WARNINGS:",
      ...(warnings.length ? warnings.map((warning) => ` - ${warning}`) : [" - none"]),
      "",
      "METHOD:",
      "- ERA5 wind at 100 m is averaged over each hour using the values at both ends of the hour.",
      "- Reference production is clipped at zero and normalized by installed capacity.",
      "- Ramp-up is excluded using the established-operation threshold.",
      "- The curve is the hour-weighted median capacity factor per 0.5 m/s bin.",
      "- The energy calibration factor is observed divided by modelled reference production.",
      "- The site uses the reference curve and ERA5 site wind; above the validated range a plateau is assumed.",
    ];
    return lines.join("\n") + "\n";
  }

  document.getElementById("siteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    let options;
    try {
      options = optionsFromForm();
      validateOptions(options);
    } catch (error) {
      setStatus(error.message, "error");
      return;
    }
    document.getElementById("runButton").disabled = true;
    try {
      setStatus("Building the reference model…", "loading");
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      const { lag } = bestLag();
      setStatus("Fetching ERA5 wind for the site…", "loading");
      const siteWind = await fetchSiteWind(options);
      setStatus("Calculating site output and validation…", "loading");
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      const result = analyze(options, siteWind, lag);
      let satelliteError = null;
      if (options.satelliteEnabled && !window.L) {
        satelliteError = "Satellite map library could not be loaded.";
      }
      const warnings = buildWarnings(options, result, satelliteError);
      setStatus(`Done: ${result.site.length.toLocaleString("en-GB")} site hours modelled.`, "");
      renderResults(options, result, warnings, satelliteError);
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${error.message}`, "error");
    } finally {
      document.getElementById("runButton").disabled = false;
    }
  });

  document.getElementById("resetButton").addEventListener("click", () => {
    Object.entries(DEFAULTS).forEach(([key, value]) => {
      const input = document.getElementById(key);
      if (!input) return;
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
    });
    setStatus("Defaults restored. Ready.", "");
    resultsSection.hidden = true;
    lastRun = null;
  });

  document.getElementById("downloadCurve").addEventListener("click", () => {
    if (!lastRun) return;
    const { result } = lastRun;
    const csv = buildCsv(
      ["vent_kmh", "P_MW_brut", "P_MW_net", "P_MW_min_parcs", "P_MW_max_parcs", "heures_ref"],
      CENTERS.map((_, index) => [
        (CENTERS[index] * MS_TO_KMH).toFixed(3),
        (result.curve[index] * result.rated).toFixed(6),
        (result.curve[index] * result.rated * result.energyCalibration).toFixed(6),
        (result.min[index] * result.rated).toFixed(6),
        (result.max[index] * result.rated).toFixed(6),
        result.counts[index],
      ])
    );
    downloadText("courbe_puissance.csv", csv);
  });

  document.getElementById("downloadSeries").addEventListener("click", () => {
    if (!lastRun) return;
    const { result } = lastRun;
    const csv = buildCsv(
      ["timestamp_utc", "vent_100m_kmh", "P_brute_MW", "P_nette_MW"],
      result.site.map((item) => [
        new Date(item.t).toISOString(),
        (item.wind * MS_TO_KMH).toFixed(3),
        item.gross.toFixed(6),
        item.net.toFixed(6),
      ])
    );
    downloadText("serie_horaire_site.csv", csv);
  });

  document.getElementById("downloadReport").addEventListener("click", () => {
    if (!lastRun) return;
    downloadText("resume.txt", buildReport(lastRun.options, lastRun.result, lastRun.warnings));
  });

  document.getElementById("downloadChart").addEventListener("click", () => {
    if (!lastRun || !window.Plotly) return;
    window.Plotly.downloadImage("curveChart", {
      format: "svg",
      filename: "courbe_site",
      width: 1400,
      height: 800,
    });
  });
})();
