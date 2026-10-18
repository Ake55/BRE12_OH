(function () {
  const section = document.querySelector("[data-windrose-park]");
  const chart = document.getElementById("windRoseChart");
  const yearSelect = document.getElementById("windRoseYear");
  const note = document.getElementById("windRoseNote");
  if (!section || !chart || !yearSelect || !note) return;

  const park = section.dataset.windrosePark;
  const numberFormat = new Intl.NumberFormat("fr-FR");
  const powerFormat = new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const hourColors = [
    { stop: 0, color: [246, 240, 222] },
    { stop: 0.5, color: [242, 181, 68] },
    { stop: 1, color: [182, 48, 38] },
  ];
  const sectors = [
    { direction: "N", label: "Nord", angle: 0 },
    { direction: "NE", label: "Nord-Est", angle: 45 },
    { direction: "E", label: "Est", angle: 90 },
    { direction: "SE", label: "Sud-Est", angle: 135 },
    { direction: "S", label: "Sud", angle: 180 },
    { direction: "SO", label: "Sud-Ouest", angle: 225 },
    { direction: "O", label: "Ouest", angle: 270 },
    { direction: "NO", label: "Nord-Ouest", angle: 315 },
  ];

  function colorForHours(hours, maxHours) {
    const position = maxHours > 0 ? Math.min(1, hours / maxHours) : 0;
    const upperIndex = hourColors.findIndex((stop) => stop.stop >= position);
    const lower = hourColors[Math.max(0, upperIndex - 1)];
    const upper = hourColors[Math.max(0, upperIndex)];
    const fraction = upper.stop === lower.stop ? 0 : (position - lower.stop) / (upper.stop - lower.stop);
    const rgb = lower.color.map((value, index) =>
      Math.round(value + (upper.color[index] - value) * fraction)
    );
    return `rgb(${rgb.join(", ")})`;
  }

  function createColorLegend(maxHours) {
    let legend = section.querySelector(".windrose-color-scale");
    if (!legend) {
      legend = document.createElement("div");
      legend.className = "windrose-color-scale";
      legend.setAttribute("aria-label", "Échelle de couleur du nombre d’heures");

      const minimum = document.createElement("span");
      minimum.className = "windrose-color-scale__value";
      minimum.textContent = "0 h";

      const gradient = document.createElement("span");
      gradient.className = "windrose-color-scale__gradient";
      gradient.setAttribute("aria-hidden", "true");

      const maximum = document.createElement("span");
      maximum.className = "windrose-color-scale__value";
      maximum.id = "windRoseColorMax";

      const label = document.createElement("span");
      label.className = "windrose-color-scale__label";
      label.textContent = "Nombre d’heures observées";

      legend.append(minimum, gradient, maximum, label);
      chart.after(legend);
    }

    legend.querySelector("#windRoseColorMax").textContent = `${numberFormat.format(maxHours)} h`;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const source = text.replace(/^\uFEFF/, "");

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        if (inQuotes && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (character === ";" && !inQuotes) {
        row.push(field);
        field = "";
      } else if (character === "\n" && !inQuotes) {
        row.push(field.replace(/\r$/, ""));
        if (row.some((value) => value !== "")) rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }

    if (inQuotes) throw new Error("Le fichier CSV contient un champ mal formé.");
    if (field || row.length) {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
    }

    if (!rows.length) throw new Error("Le fichier CSV est vide.");
    const headers = rows.shift().map((header) => header.trim());
    const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
    const required = [
      "park",
      "annee",
      "niveau",
      "direction",
      "nombre_heures",
      "frequence_pct",
      "production_moyenne_mw",
    ];
    const missing = required.filter((name) => columns[name] === undefined);
    if (missing.length) {
      throw new Error(`Colonnes absentes du fichier CSV : ${missing.join(", ")}.`);
    }

    return rows.map((values) => {
      const get = (name) => values[columns[name]]?.trim() ?? "";
      const getNumber = (name) => {
        const value = get(name);
        return value === "" ? Number.NaN : Number(value);
      };
      return {
        park: get("park"),
        year: get("annee"),
        level: get("niveau"),
        direction: get("direction"),
        hours: getNumber("nombre_heures"),
        frequency: getNumber("frequence_pct"),
        production: getNumber("production_moyenne_mw"),
      };
    });
  }

  function drawWindRose(rows, year) {
    const annual = rows.filter(
      (row) => row.park === park && row.level === "annee" && row.year === year
    );
    const byDirection = new Map(annual.map((row) => [row.direction, row]));
    if (annual.length !== sectors.length || byDirection.size !== sectors.length) {
      throw new Error(`Données annuelles incomplètes pour ${park} en ${year}.`);
    }
    const ordered = sectors.map((sector) => {
      const row = byDirection.get(sector.direction);
      if (
        !row ||
        !Number.isFinite(row.hours) ||
        !Number.isFinite(row.frequency) ||
        !Number.isFinite(row.production)
      ) {
        throw new Error(`Données annuelles incomplètes pour ${park} en ${year}.`);
      }
      return { ...row, ...sector };
    });

    if (!window.Plotly) {
      throw new Error("La bibliothèque graphique n’a pas pu être chargée.");
    }

    const maxHours = Math.max(...rows.map((row) => row.hours));
    const maxProduction = Math.max(...ordered.map((row) => row.production));
    const maxRadius = maxProduction > 0 ? maxProduction * 1.1 : 1;
    const triangles = ordered.map((row) => ({
      type: "scatterpolar",
      mode: "lines",
      name: row.label,
      theta: [row.angle - 22.5, row.angle, row.angle + 22.5, row.angle - 22.5],
      r: [row.production, 0, row.production, row.production],
      customdata: Array.from({ length: 4 }, () => [
        row.label,
        row.hours,
        row.production,
        row.frequency,
      ]),
      fill: "toself",
      fillcolor: colorForHours(row.hours, maxHours),
      line: { color: "rgba(78, 54, 28, 0.72)", width: 1.2 },
      hoverinfo: "skip",
    }));
    const hoverPoints = ordered.flatMap((row) =>
      [0.2, 0.4, 0.6, 0.8, 0.95].flatMap((radiusFraction) =>
        [-0.8, -0.4, 0, 0.4, 0.8].map((angleFraction) => ({
          theta: row.angle + 22.5 * (1 - radiusFraction) * angleFraction,
          r: row.production * radiusFraction,
          customdata: [row.label, row.hours, row.production, row.frequency],
        }))
      )
    );
    const hoverTargets = {
      type: "scatterpolar",
      mode: "markers",
      name: "Valeurs par direction",
      theta: hoverPoints.map((point) => point.theta),
      r: hoverPoints.map((point) => point.r),
      customdata: hoverPoints.map((point) => point.customdata),
      marker: { size: 14, color: "rgba(0, 0, 0, 0.01)" },
      hovertemplate:
        "Direction : %{customdata[0]}<br>" +
        "Nombre d’heures : %{customdata[1]:,.0f}<br>" +
        "Puissance moyenne : %{customdata[2]:.1f} MW<br>" +
        "Part des heures : %{customdata[3]:.1f} %<extra></extra>",
    };
    createColorLegend(maxHours);

    window.Plotly.react(
      chart,
      [...triangles, hoverTargets],
      {
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { family: '"Segoe UI", Arial, sans-serif', color: "#1c343d", size: 12 },
        margin: window.innerWidth < 700
          ? { l: 28, r: 28, t: 30, b: 24 }
          : { l: 58, r: 58, t: 38, b: 32 },
        height: window.innerWidth < 700 ? 400 : 490,
        showlegend: false,
        polar: {
          bgcolor: "rgba(0,0,0,0)",
          radialaxis: {
            angle: 45,
            range: [0, maxRadius],
            nticks: 5,
            showticklabels: window.innerWidth >= 700,
            ticksuffix: " MW",
            tickfont: { size: 10 },
            gridcolor: "rgba(8, 37, 47, 0.12)",
          },
          angularaxis: {
            direction: "clockwise",
            rotation: 90,
            tickmode: "array",
            tickvals: sectors.map((sector) => sector.angle),
            ticktext: sectors.map((sector) => sector.direction),
            gridcolor: "rgba(8, 37, 47, 0.12)",
          },
        },
      },
      { responsive: true, displaylogo: false }
    );

    const totalHours = ordered.reduce((total, row) => total + row.hours, 0);
    note.textContent =
      `${year} · ${numberFormat.format(totalHours)} heures réparties selon la direction du vent. ` +
      `La longueur des triangles représente la puissance moyenne (de ${powerFormat.format(Math.min(...ordered.map((row) => row.production)))} à ${powerFormat.format(maxProduction)} MW) ; leur couleur représente le nombre d’heures. ` +
      "Survolez la pointe d’un triangle pour afficher les valeurs précises.";
  }

  async function loadWindRose() {
    try {
      const response = await fetch("data/direction_production_annees.csv");
      if (!response.ok) {
        throw new Error(`Le fichier des directions est inaccessible (HTTP ${response.status}).`);
      }

      const rows = parseCsv(await response.text()).filter(
        (row) => row.park === park && row.level === "annee"
      );
      const years = [...new Set(rows.map((row) => row.year))].sort(
        (first, second) => Number(first) - Number(second)
      );
      if (!years.length) throw new Error(`Aucune donnée annuelle disponible pour ${park}.`);

      years.forEach((year) => {
        const option = document.createElement("option");
        option.value = year;
        option.textContent = year;
        yearSelect.appendChild(option);
      });
      yearSelect.value = years[years.length - 1];
      yearSelect.addEventListener("change", () => {
        try {
          drawWindRose(rows, yearSelect.value);
        } catch (error) {
          console.error("Impossible d’afficher la rosace des vents.", error);
          chart.innerHTML = '<p class="chart-fallback">Impossible d’afficher la rosace pour cette année.</p>';
          note.textContent = "Vérifiez les données de direction et rechargez la page.";
        }
      });
      drawWindRose(rows, yearSelect.value);
    } catch (error) {
      console.error("Impossible de charger les données de la rosace des vents.", error);
      chart.innerHTML =
        '<p class="chart-fallback">La rosace des vents n’a pas pu être chargée. Vérifiez que le fichier des données est accessible, puis rechargez la page.</p>';
      note.textContent = "Les données de direction sont temporairement indisponibles.";
    }
  }

  loadWindRose();
})();
