(function () {
  const data = window.FARM_DATA;
  const chartElement = document.getElementById("farmChart");
  if (!data || !chartElement) return;

  const numberFormat = new Intl.NumberFormat("fr-FR");
  const dateFormat = new Intl.DateTimeFormat("fr-FR", {
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
    `${numberFormat.format(data.capacity.total_mw)} MW installés · ` +
    `${data.capacity.turbines} × ${data.capacity.turbine_mw} MW`;
  byId("metricProducingHours").textContent = formatPercent(data.stats.producing_share);
  byId("metricProducingNote").textContent =
    `${numberFormat.format(data.stats.producing_hours)} heures sur ${numberFormat.format(data.coverage.matched)} heures appariées`;

  if (data.period.start && data.period.end) {
    byId("farmPeriod").textContent = `${dateFormat.format(new Date(data.period.start))} → ${dateFormat.format(
      new Date(data.period.end)
    )} · ${numberFormat.format(data.stats.records)} relevés horaires`;
  }

  byId("coverageNote").textContent =
    `${numberFormat.format(data.coverage.matched)} heures disposent à la fois d’une production valide et d’une mesure de vent correspondante. ` +
    `${numberFormat.format(data.coverage.production_without_wind)} heures de production valide n’ont pas de mesure de vent correspondante. ` +
    `${numberFormat.format(data.coverage.wind_without_production)} heures de vent n’ont pas de production valide, car elles sont hors période ou écartées par le filtre de −10 à 500 MW.`;

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
      kicker: "Production réelle",
      title: "Production mesurée selon la vitesse du vent",
      text:
        "Chaque point représente une heure pour laquelle on dispose d’une mesure de production et " +
        "d’une mesure de vent correspondante. La ligne verte représente la production moyenne par " +
        "tranche de vent de 0,5 m/s et forme la courbe de puissance empirique.",
      legend:
        '<span class="explainer-legend__item"><i class="swatch swatch--dots"></i>Mesures horaires</span>' +
        '<span class="explainer-legend__item"><i class="swatch swatch--line"></i>Moyenne empirique ± 1 écart-type (tranches de 0,5 m/s)</span>',
      note:
        "La courbe empirique reflète le comportement réel du parc, notamment les effets de sillage, " +
        "la maintenance et les limitations de production. Les barres verticales indiquent ± 1 écart-type " +
        "de la production horaire dans chaque tranche.",
    },
    theory: {
      kicker: "Modèle théorique",
      title: "Une courbe de puissance simplifiée",
      text:
        "La ligne rouge pointillée représente un modèle simplifié, qui n’est pas ajusté aux mesures. " +
        "La production est nulle sous la vitesse de démarrage, augmente avec le cube de la vitesse du vent " +
        "jusqu’à la vitesse nominale, reste au niveau nominal puis retombe à zéro après la vitesse de coupure.",
      legend:
        '<span class="explainer-legend__item"><i class="swatch swatch--dash"></i>Modèle théorique</span>',
      note:
        `Hypothèses du modèle : démarrage à ${defaults.cut_in_ms} m/s, vitesse nominale ` +
        `de ${defaults.rated_speed_ms} m/s, coupure à ${defaults.cut_out_ms} m/s et ` +
        `puissance nominale de ${defaults.rated_mw} MW.`,
    },
    comparison: {
      kicker: "Comparaison",
      title: "Modèle et réalité",
      text:
        "Cette vue superpose les mesures horaires, la moyenne empirique et le modèle théorique. " +
        "L’écart entre les courbes montre en quoi la production réelle du parc diffère du modèle simplifié.",
      legend:
        '<span class="explainer-legend__item"><i class="swatch swatch--dots"></i>Mesures horaires</span>' +
        '<span class="explainer-legend__item"><i class="swatch swatch--line"></i>Moyenne empirique ± 1 écart-type (tranches de 0,5 m/s)</span>' +
        '<span class="explainer-legend__item"><i class="swatch swatch--dash"></i>Modèle théorique</span>',
      note:
        "La courbe théorique n’est pas ajustée aux mesures : des écarts avec la moyenne empirique sont donc " +
        "attendus. Les barres verticales indiquent ± 1 écart-type de la production horaire pour chaque tranche de vent.",
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
    name: "Mesures horaires",
    x: wind,
    y: power,
    marker: { color: "#0f6f78", size: 3, opacity: 0.3 },
    hovertemplate: "Vent : %{x:.2f} m/s<br>Puissance : %{y:.0f} MW<extra></extra>",
  };

  const empiricalTrace = {
    type: "scatter",
    mode: "lines",
    name: "Moyenne empirique ± 1 écart-type (tranches de 0,5 m/s)",
    x: empirical.map((bin) => bin.center),
    y: empirical.map((bin) => bin.mean),
    line: { color: "#287347", width: 3 },
    error_y: {
      type: "data",
      array: empirical.map((bin) => bin.stdDev),
      visible: true,
      color: "rgba(40, 115, 71, 0.45)",
      thickness: 1,
      width: 4,
    },
    customdata: empirical.map((bin) => [bin.count, bin.stdDev]),
    hovertemplate:
      "Vent : %{x:.2f} m/s<br>Moyenne : %{y:.1f} MW<br>± %{customdata[1]:.1f} MW (écart-type)<br>%{customdata[0]} heures<extra></extra>",
  };

  let currentMode = "real";

  function visibleTraces() {
    const curve = theoryLine();
    const theoryTrace = {
      type: "scatter",
      mode: "lines",
      name: "Modèle théorique",
      x: curve.x,
      y: curve.y,
      line: { color: "#d45b45", width: 2.5, dash: "dot" },
      hovertemplate: "Vent : %{x:.1f} m/s<br>Modèle : %{y:.1f} MW<extra></extra>",
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
        title: { text: "Vitesse du vent (m/s, source en km/h ÷ 3,6)", font: { size: 12 } },
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
        '<p class="chart-fallback">La bibliothèque graphique n’a pas pu être chargée. Vérifiez votre connexion Internet puis rechargez la page.</p>';
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
    const rows = ["centre_tranche_vent_ms,puissance_moyenne_mw,ecart_type_mw,heures"];
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
  const monthLabels = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const monthlyLabels = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const hourlyChart = byId("hourlyChart");
  const monthlyChart = byId("monthlyChart");
  const profileYear = byId("profileYear");

  function showChartFallback(element) {
    element.innerHTML =
      '<p class="chart-fallback">La bibliothèque graphique n’a pas pu être chargée. Vérifiez votre connexion Internet puis rechargez la page.</p>';
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
        title: { text: isHourly ? "Heure de la journée" : "Mois", font: { size: 11 } },
      },
      yaxis: {
        title: { text: "Production (MW)", font: { size: 11 } },
        gridcolor: "rgba(8, 37, 47, 0.08)",
        zeroline: false,
      },
      yaxis2: {
        title: { text: "Vent (m/s)", font: { size: 11 } },
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
        hovertemplate: "%{x}<br>Production moyenne : %{y:.1f} MW<br>%{customdata} heures<extra></extra>",
      },
      {
        type: "scatter",
        mode: "lines+markers",
        name: "Vitesse du vent (m/s)",
        x: labels,
        y: profile.wind,
        yaxis: "y2",
        line: { color: "#d45b45", width: 2.5 },
        marker: { color: "#d45b45", size: 5 },
        customdata: profile.wind_hours,
        connectgaps: false,
        hovertemplate: "%{x}<br>Vent moyen : %{y:.2f} m/s<br>%{customdata} heures<extra></extra>",
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
      `${year}${coverage ? ` · période couverte : ${coverage}` : ""} · ` +
      `${numberFormat.format(productionHours)} heures de production et ` +
      `${numberFormat.format(windHours)} heures de vent utilisées. Les heures manquantes ne sont pas assimilées à zéro.`;
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
