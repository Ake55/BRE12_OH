(function () {
  const data = window.FARM_DATA;
  const chartElement = document.getElementById("farmChart");
  if (!data || !chartElement) return;

  const numberFormat = new Intl.NumberFormat("en-GB");
  const dateFormat = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  const byId = (id) => document.getElementById(id);
  const points = data.points;
  const wind = points.wind;
  const power = points.power;
  const defaults = data.defaults;

  function formatPower(value) {
    return value === null || value === undefined ? "—" : `${value.toFixed(1)} MW`;
  }

  function formatPercent(value) {
    return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
  }

  byId("metricHours").textContent = numberFormat.format(data.coverage.matched);
  byId("metricMeanPower").textContent = formatPower(data.stats.mean_power_mw);
  byId("metricMedianPower").textContent = formatPower(data.stats.median_power_mw);
  byId("metricMeanWind").textContent =
    data.stats.mean_wind_ms === null ? "—" : `${data.stats.mean_wind_ms.toFixed(1)} m/s`;
  byId("metricCapacityFactor").textContent = formatPercent(data.stats.capacity_factor);
  byId("metricCapacityNote").textContent =
    `${numberFormat.format(data.capacity.total_mw)} MW installed · ` +
    `${data.capacity.turbines} × ${data.capacity.turbine_mw} MW`;
  byId("metricProducingHours").textContent = formatPercent(data.stats.producing_share);
  byId("metricProducingNote").textContent =
    `${numberFormat.format(data.stats.producing_hours)} of ${numberFormat.format(data.coverage.matched)} matched hours`;

  if (data.period.start && data.period.end) {
    byId("farmPeriod").textContent = `${dateFormat.format(new Date(data.period.start))} → ${dateFormat.format(
      new Date(data.period.end)
    )} · ${numberFormat.format(data.stats.records)} hourly records`;
  }

  byId("coverageNote").textContent =
    `${numberFormat.format(data.coverage.matched)} hours have both clean production and a matching wind reading. ` +
    `${numberFormat.format(data.coverage.production_without_wind)} clean production hours have no matching wind. ` +
    `${numberFormat.format(data.coverage.wind_without_production)} wind hours have no clean production, because they fall outside the period or were rejected by the −10 to 500 MW filter.`;

  const binStep = 0.5;
  const bins = new Map();
  for (let index = 0; index < wind.length; index += 1) {
    const binIndex = Math.floor(wind[index] / binStep);
    const entry = bins.get(binIndex) || { sum: 0, sumSquares: 0, count: 0 };
    entry.sum += power[index];
    entry.sumSquares += power[index] * power[index];
    entry.count += 1;
    bins.set(binIndex, entry);
  }

  const empirical = Array.from(bins.entries())
    .sort((first, second) => first[0] - second[0])
    .map(([binIndex, entry]) => {
      const mean = entry.sum / entry.count;
      const variance = entry.sumSquares / entry.count - mean * mean;
      return {
        center: binIndex * binStep + binStep / 2,
        mean,
        count: entry.count,
        stdDev: Math.sqrt(Math.max(0, variance)),
      };
    });

  const parameters = { ...defaults };

  const explainers = {
    real: {
      kicker: "Real output",
      title: "Measured production by wind speed",
      text:
        "Each dot is one hour with both measured production and a matching wind " +
        "reading. The orange line averages production within 0.5 m/s wind-speed " +
        "bins, forming the empirical power curve.",
      legend:
        '<span class="explainer-legend__item"><i class="swatch swatch--dots"></i>Hourly measurements</span>' +
        '<span class="explainer-legend__item"><i class="swatch swatch--line"></i>Empirical mean ±1 SD (0.5 m/s bins)</span>',
      note:
        "The empirical curve reflects real farm behaviour, including wake effects, " +
        "maintenance and curtailment. Vertical bars show ±1 population standard " +
        "deviation of hourly production within each bin.",
    },
    theory: {
      kicker: "Theoretical model",
      title: "A simplified power curve",
      text:
        "The dotted red line is a simplified model, not a fit to the measurements. " +
        "Output is zero below cut-in, rises with the cube of wind speed to rated " +
        "speed, stays flat at rated power, then drops to zero after cut-out.",
      legend:
        '<span class="explainer-legend__item"><i class="swatch swatch--dash"></i>Theoretical model</span>',
      note:
        `Model assumptions: cut-in ${defaults.cut_in_ms} m/s, rated speed ` +
        `${defaults.rated_speed_ms} m/s, cut-out ${defaults.cut_out_ms} m/s and ` +
        `rated power ${defaults.rated_mw} MW.`,
    },
    comparison: {
      kicker: "Comparison",
      title: "Model versus reality",
      text:
        "This view overlays the measured hours, the empirical mean and the " +
        "theoretical model. The gap between the curves shows where real farm " +
        "output differs from the simplified model.",
      legend:
        '<span class="explainer-legend__item"><i class="swatch swatch--dots"></i>Hourly measurements</span>' +
        '<span class="explainer-legend__item"><i class="swatch swatch--line"></i>Empirical mean ±1 SD (0.5 m/s bins)</span>' +
        '<span class="explainer-legend__item"><i class="swatch swatch--dash"></i>Theoretical model</span>',
      note:
        "The theoretical curve is not fitted to measurements, so differences from " +
        "the empirical mean are expected. Vertical bars show ±1 population standard " +
        "deviation within each wind-speed bin.",
    },
  };

  function updateExplainer(mode) {
    const explainer = explainers[mode] || explainers.real;
    byId("explainerKicker").textContent = explainer.kicker;
    byId("explainerTitle").textContent = explainer.title;
    byId("explainerText").textContent = explainer.text;
    byId("explainerLegend").innerHTML = explainer.legend;
    byId("explainerNote").textContent = explainer.note;
  }

  function theoryAt(speed) {
    const cutIn = parameters.cut_in_ms;
    const ratedSpeed = parameters.rated_speed_ms;
    const cutOut = parameters.cut_out_ms;
    const ratedPower = parameters.rated_mw;

    if (speed < cutIn || speed >= cutOut) return 0;
    if (speed >= ratedSpeed) return ratedPower;

    const denominator = Math.pow(ratedSpeed, 3) - Math.pow(cutIn, 3);
    if (denominator <= 0) return 0;
    const ratio = (Math.pow(speed, 3) - Math.pow(cutIn, 3)) / denominator;
    return ratedPower * Math.max(0, Math.min(1, ratio));
  }

  function theoryLine() {
    const maxSpeed = Math.max(30, parameters.cut_out_ms + 2);
    const speeds = [];
    const values = [];
    for (let speed = 0; speed <= maxSpeed; speed += 0.1) {
      speeds.push(Number(speed.toFixed(2)));
      values.push(theoryAt(speed));
    }
    return { x: speeds, y: values };
  }

  const scatterTrace = {
    type: "scattergl",
    mode: "markers",
    name: "Hourly measurements",
    x: wind,
    y: power,
    marker: { color: "#0f6f78", size: 3, opacity: 0.3 },
    hovertemplate: "Wind %{x:.2f} m/s<br>Power %{y:.0f} MW<extra></extra>",
  };

  const empiricalTrace = {
    type: "scatter",
    mode: "lines",
    name: "Empirical mean ±1 SD (0.5 m/s bins)",
    x: empirical.map((bin) => bin.center),
    y: empirical.map((bin) => bin.mean),
    line: { color: "#c98a1f", width: 3 },
    error_y: {
      type: "data",
      array: empirical.map((bin) => bin.stdDev),
      visible: true,
      color: "rgba(201, 138, 31, 0.55)",
      thickness: 1,
      width: 4,
    },
    customdata: empirical.map((bin) => [bin.count, bin.stdDev]),
    hovertemplate:
      "Wind %{x:.2f} m/s<br>Mean %{y:.1f} MW<br>± %{customdata[1]:.1f} MW SD<br>%{customdata[0]} hours<extra></extra>",
  };

  let currentMode = "real";

  function visibleTraces() {
    const curve = theoryLine();
    const theoryTrace = {
      type: "scatter",
      mode: "lines",
      name: "Theoretical model",
      x: curve.x,
      y: curve.y,
      line: { color: "#d45b45", width: 2.5, dash: "dot" },
      hovertemplate: "Wind %{x:.1f} m/s<br>Model %{y:.1f} MW<extra></extra>",
    };

    if (currentMode === "theory") return [theoryTrace];
    if (currentMode === "comparison") return [scatterTrace, empiricalTrace, theoryTrace];
    return [scatterTrace, empiricalTrace];
  }

  function layout() {
    const maxSpeed = Math.max(
      30,
      Math.ceil(Math.max(...wind) + 1),
      Math.ceil(parameters.cut_out_ms + 2)
    );
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: '"Segoe UI", Arial, sans-serif', color: "#1c343d", size: 12 },
      margin: { l: 58, r: 18, t: 44, b: 54 },
      height: window.innerWidth < 700 ? 400 : 560,
      hovermode: "closest",
      legend: {
        orientation: "h",
        x: 0,
        y: 1.12,
        font: { size: 11, color: "#5d7279" },
      },
      xaxis: {
        title: { text: "Wind speed (m/s, source km/h ÷ 3.6)", font: { size: 12 } },
        range: [0, maxSpeed],
        gridcolor: "rgba(8, 37, 47, 0.08)",
        zeroline: false,
      },
      yaxis: {
        title: { text: "Production (MW)", font: { size: 12 } },
        range: [-25, 520],
        gridcolor: "rgba(8, 37, 47, 0.08)",
        zeroline: false,
      },
    };
  }

  const config = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
  };

  function draw() {
    if (!window.Plotly) {
      chartElement.innerHTML =
        '<p class="chart-fallback">The chart library could not be loaded. Check your internet connection and reload the page.</p>';
      return;
    }
    window.Plotly.react(chartElement, visibleTraces(), layout(), config);
  }

  function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll("[data-mode]").forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    updateExplainer(mode);
    draw();
  }

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  byId("downloadCurve").addEventListener("click", () => {
    const rows = ["wind_bin_center_ms,mean_power_mw,std_dev_mw,hours"];
    empirical.forEach((bin) => {
      rows.push(
        `${bin.center.toFixed(2)},${bin.mean.toFixed(3)},${bin.stdDev.toFixed(3)},${bin.count}`
      );
    });
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `empirical_curve_${data.slug}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  const hourLabels = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
  const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthlyLabels = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const hourlyChart = byId("hourlyChart");
  const monthlyChart = byId("monthlyChart");
  const profileYear = byId("profileYear");

  function showChartFallback(element) {
    element.innerHTML =
      '<p class="chart-fallback">The chart library could not be loaded. Check your internet connection and reload the page.</p>';
  }

  function profileLayout(labels, isHourly) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: '"Segoe UI", Arial, sans-serif', color: "#1c343d", size: 11 },
      margin: { l: 52, r: 54, t: 38, b: 46 },
      height: window.innerWidth < 700 ? 340 : 380,
      hovermode: "closest",
      legend: {
        orientation: "h",
        x: 0,
        y: 1.14,
        font: { size: 10, color: "#5d7279" },
      },
      xaxis: {
        type: "category",
        categoryorder: "array",
        categoryarray: labels,
        gridcolor: "rgba(8, 37, 47, 0.06)",
        tickfont: { size: 10 },
        title: { text: isHourly ? "Hour of day" : "Month", font: { size: 11 } },
      },
      yaxis: {
        title: { text: "Production (MW)", font: { size: 11 } },
        gridcolor: "rgba(8, 37, 47, 0.08)",
        zeroline: false,
      },
      yaxis2: {
        title: { text: "Wind (m/s)", font: { size: 11 } },
        overlaying: "y",
        side: "right",
        showgrid: false,
        zeroline: false,
      },
    };
  }

  function profileTraces(profile, labels) {
    return [
      {
        type: "scatter",
        mode: "lines+markers",
        name: "Production (MW)",
        x: labels,
        y: profile.production,
        line: { color: "#0f6f78", width: 3 },
        marker: { color: "#0f6f78", size: 5 },
        customdata: profile.production_hours,
        connectgaps: false,
        hovertemplate: "%{x}<br>Average production %{y:.1f} MW<br>%{customdata} hours<extra></extra>",
      },
      {
        type: "scatter",
        mode: "lines+markers",
        name: "Wind speed (m/s)",
        x: labels,
        y: profile.wind,
        yaxis: "y2",
        line: { color: "#d45b45", width: 2.5 },
        marker: { color: "#d45b45", size: 5 },
        customdata: profile.wind_hours,
        connectgaps: false,
        hovertemplate: "%{x}<br>Average wind %{y:.2f} m/s<br>%{customdata} hours<extra></extra>",
      },
    ];
  }

  function coverageForMonths(monthly) {
    const active = monthly.production
      .map((value, index) => (value !== null || monthly.wind[index] !== null ? index : -1))
      .filter((index) => index >= 0);
    if (!active.length) return "";
    const first = active[0];
    const last = active[active.length - 1];
    if (first === 0 && last === 11) return "";
    const firstLabel = monthlyLabels[first].slice(0, 3);
    const lastLabel = monthlyLabels[last].slice(0, 3);
    return `${firstLabel}–${lastLabel}`;
  }

  function drawProfiles(year) {
    const hourly = data.profiles.hourly[year];
    const monthly = data.profiles.monthly[year];
    if (!hourly || !monthly) return;

    if (!window.Plotly) {
      showChartFallback(hourlyChart);
      showChartFallback(monthlyChart);
      return;
    }

    window.Plotly.react(
      hourlyChart,
      profileTraces(hourly, hourLabels),
      profileLayout(hourLabels, true),
      config
    );
    window.Plotly.react(
      monthlyChart,
      profileTraces(monthly, monthLabels),
      profileLayout(monthLabels, false),
      config
    );

    const productionHours = monthly.production_hours.reduce((total, count) => total + count, 0);
    const windHours = monthly.wind_hours.reduce((total, count) => total + count, 0);
    const coverage = coverageForMonths(monthly);
    byId("profileNote").textContent =
      `${year}${coverage ? ` coverage: ${coverage}` : ""} · ` +
      `${numberFormat.format(productionHours)} production hours and ` +
      `${numberFormat.format(windHours)} wind hours used. Missing hours are not treated as zero.`;
  }

  function yearOptionLabel(year) {
    const coverage = coverageForMonths(data.profiles.monthly[year]);
    return coverage ? `${year} (${coverage})` : year;
  }

  if (data.profiles && data.profiles.years.length && hourlyChart && monthlyChart && profileYear) {
    data.profiles.years.forEach((year) => {
      const option = document.createElement("option");
      option.value = year;
      option.textContent = yearOptionLabel(year);
      profileYear.appendChild(option);
    });
    profileYear.value = data.profiles.default_year || data.profiles.years[data.profiles.years.length - 1];
    profileYear.addEventListener("change", () => drawProfiles(profileYear.value));
    drawProfiles(profileYear.value);
  }

  updateExplainer(currentMode);
  draw();
})();
