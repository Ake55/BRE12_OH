(function () {
  const coverageData = window.COVERAGE_DATA;
  const communeData = window.COMMUNE_DATA;
  const byId = (id) => document.getElementById(id);

  const farmSelect = byId("coverageFarm");
  const yearSelect = byId("coverageYear");
  const communeSearch = byId("communeSearch");
  const communeResults = byId("communeResults");
  const noteElement = byId("consumptionNote");

  if (!coverageData || !communeData || !farmSelect || !yearSelect || !communeSearch || !communeResults) {
    if (noteElement) noteElement.textContent = "Impossible de charger les données de couverture.";
    return;
  }

  const numberFormat = new Intl.NumberFormat("fr-FR");
  const dayFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
  const monthLabels = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const perCapitaMwh = coverageData.per_capita_mwh;
  let selectedCommune = null;
  let communeMatches = [];
  let activeCommuneIndex = -1;

  function normalizeText(value) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  const communeIndex = (communeData.communes || []).map((entry) => ({
    entry,
    key: normalizeText(entry[0]),
  }));

  function communeLabel(entry) {
    return `${entry[0]} (${entry[1]})`;
  }

  function formatEnergy(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "—";
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} TWh`;
    if (Math.abs(value) >= 1_000) return `${(value / 1_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} GWh`;
    return `${Math.round(value).toLocaleString("fr-FR")} MWh`;
  }

  function formatCoverage(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `x${value.toFixed(2)}`;
  }

  function monthCoverage(annual) {
    if (annual.first_month === null || annual.last_month === null) return "";
    if (annual.first_month === 0 && annual.last_month === 11) return "";
    return `${monthLabels[annual.first_month]}–${monthLabels[annual.last_month]}`;
  }

  function updateCoverage() {
    const farm = coverageData.farms.find((item) => item.slug === farmSelect.value);
    const year = yearSelect.value;
    const annual = farm?.annual?.[year];
    if (!farm || !annual || !selectedCommune) return;

    const days = annual.period_hours / 24;
    const demandMwh = days * (perCapitaMwh / 365) * selectedCommune[3];
    const coverage = demandMwh > 0 ? annual.production_mwh / demandMwh : null;
    const barWidth = coverage === null ? 0 : Math.min(100, Math.max(0, coverage * 100));

    byId("coveragePercent").textContent = formatCoverage(coverage);
    const caption = `de la consommation électrique des habitants de ${selectedCommune[0]} sur la même période`;
    byId("coverageCaption").textContent = caption;
    byId("coverageBar").style.width = `${barWidth}%`;
    byId("consumptionFarm").textContent = formatEnergy(annual.production_mwh);
    byId("consumptionDemand").textContent = formatEnergy(demandMwh);
    byId("consumptionPopulation").textContent = numberFormat.format(selectedCommune[3]);

    const months = monthCoverage(annual);
    const missingHours = annual.period_hours - annual.production_hours;
    let note =
      `Estimation fondée sur ${perCapitaMwh.toLocaleString("fr-FR")} MWh par personne et par an, sur ${dayFormat.format(days)} jours.`;
    if (months) note += ` Les données de production couvrent la période ${months} ${year}.`;
    if (missingHours > 0) {
      const hourWord = missingHours === 1 ? "heure" : "heures";
      note +=
        ` ${numberFormat.format(missingHours)} ${hourWord} sans valeur de production sont comptabilisées comme une production nulle.`;
    }
    noteElement.textContent = note;
  }

  function closeCommuneResults() {
    communeResults.hidden = true;
    communeSearch.setAttribute("aria-expanded", "false");
    communeSearch.removeAttribute("aria-activedescendant");
    activeCommuneIndex = -1;
  }

  function selectCommune(entry) {
    selectedCommune = entry;
    communeSearch.value = communeLabel(entry);
    closeCommuneResults();
    updateCoverage();
  }

  function renderCommuneMatches() {
    communeResults.innerHTML = "";
    communeMatches.forEach((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.id = `commune-option-${index}`;
      button.classList.toggle("is-active", index === activeCommuneIndex);
      const label = document.createElement("span");
      label.textContent = `${entry[0]} (${entry[1]})`;
      const population = document.createElement("small");
      population.textContent = numberFormat.format(entry[3]);
      button.append(label, population);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => selectCommune(entry));
      communeResults.appendChild(button);
    });
    communeResults.hidden = communeMatches.length === 0;
    communeSearch.setAttribute("aria-expanded", String(communeMatches.length > 0));
    if (activeCommuneIndex >= 0 && communeMatches[activeCommuneIndex]) {
      communeSearch.setAttribute("aria-activedescendant", `commune-option-${activeCommuneIndex}`);
      communeResults.children[activeCommuneIndex]?.scrollIntoView({ block: "nearest" });
    } else {
      communeSearch.removeAttribute("aria-activedescendant");
    }
  }

  function searchCommunes(query) {
    const needle = normalizeText(query.trim());
    if (!needle) {
      communeMatches = [];
      activeCommuneIndex = -1;
      renderCommuneMatches();
      return;
    }
    const matches = [];
    for (const item of communeIndex) {
      if (item.key.startsWith(needle)) {
        matches.push({ entry: item.entry, rank: 0 });
      } else if (item.key.includes(needle)) {
        matches.push({ entry: item.entry, rank: 1 });
      }
    }
    matches.sort((first, second) => first.rank - second.rank || second.entry[3] - first.entry[3]);
    communeMatches = matches.slice(0, 8).map((match) => match.entry);
    activeCommuneIndex = communeMatches.length ? 0 : -1;
    renderCommuneMatches();
  }

  coverageData.years.forEach((year) => {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    yearSelect.appendChild(option);
  });
  yearSelect.value = coverageData.default_year || coverageData.years[coverageData.years.length - 1];

  coverageData.farms.forEach((farm) => {
    const option = document.createElement("option");
    option.value = farm.slug;
    option.textContent = farm.label;
    farmSelect.appendChild(option);
  });
  farmSelect.value =
    coverageData.farms.find((farm) => farm.slug === "saint-nazaire")?.slug ||
    coverageData.farms[0]?.slug;

  farmSelect.addEventListener("change", updateCoverage);
  yearSelect.addEventListener("change", updateCoverage);

  communeSearch.addEventListener("input", () => {
    selectedCommune = null;
    byId("coveragePercent").textContent = "—";
    byId("coverageCaption").textContent = "Choisissez une commune pour afficher le ratio";
    byId("coverageBar").style.width = "0";
    byId("consumptionFarm").textContent = "—";
    byId("consumptionDemand").textContent = "—";
    byId("consumptionPopulation").textContent = "—";
    noteElement.textContent =
      "Sélectionnez un parc, une commune et une année pour comparer la production à la demande locale.";
    searchCommunes(communeSearch.value);
  });

  communeSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCommuneResults();
      return;
    }
    if (!communeMatches.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeCommuneIndex = (activeCommuneIndex + 1) % communeMatches.length;
      renderCommuneMatches();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeCommuneIndex =
        (activeCommuneIndex - 1 + communeMatches.length) % communeMatches.length;
      renderCommuneMatches();
    } else if (event.key === "Enter" && activeCommuneIndex >= 0) {
      event.preventDefault();
      selectCommune(communeMatches[activeCommuneIndex]);
    }
  });

  communeSearch.addEventListener("blur", () => {
    window.setTimeout(closeCommuneResults, 120);
  });

  const defaultCommune =
    communeIndex.find((item) => item.entry[0] === "Toulouse" && item.entry[1] === "31") ||
    communeIndex[0];
  if (defaultCommune) selectCommune(defaultCommune.entry);
})();
