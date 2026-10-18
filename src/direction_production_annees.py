"""Direction du vent selon la production, année par année.

Lit le CSV déjà nettoyé et déjà joint au vent du même parc.
N'écrit pas dans les fichiers bruts et ne remplace aucune heure manquante par zéro.

Sorties :
- data/direction/direction_production_annees.csv
- data/direction/<parc>.csv avec la direction ajoutée à chaque heure
- la même copie dans data/processed/direction_production_annees.csv
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.analytics import assign_production_class, assign_sectors, direction_production_by_year
from backend.config import DATA_DIR, FARMS, PROCESSED_DIR


def main() -> None:
    source = PROCESSED_DIR / "production_vent_croise.csv"
    if not source.exists():
        raise FileNotFoundError(source)
    joined = pd.read_csv(source, parse_dates=["timestamp_utc"])
    joined["timestamp_utc"] = pd.to_datetime(joined["timestamp_utc"], utc=True)

    rows: list[dict] = []
    for park, spec in FARMS.items():
        part = joined.loc[joined["park"] == park]
        park_rows = direction_production_by_year(part, park, spec["label"])
        rows.extend(park_rows)
        yearly = [row for row in park_rows if row["niveau"] == "annee"]
        years = sorted({row["annee"] for row in yearly})
        print(f"{spec['label']}")
        for year in years:
            block = [row for row in yearly if row["annee"] == year]
            hours = sum(row["nombre_heures"] for row in block)
            frequency = sum(row["frequence_pct"] or 0 for row in block)
            present = [row for row in block if row["nombre_heures"] > 0]
            dominant = max(present, key=lambda row: row["nombre_heures"])
            strongest = max(present, key=lambda row: row["production_moyenne_mw"])
            print(
                f"  {year} : {hours} h, fréquences {frequency:.2f} %, "
                f"direction fréquente {dominant['direction']}, "
                f"plus forte moyenne {strongest['direction']} "
                f"({strongest['production_moyenne_mw']:.1f} MW)"
            )
            if hours == 0 or abs(frequency - 100) > 1e-6:
                raise SystemExit(f"Contrôle refusé pour {park} {year}")

    out = pd.DataFrame(rows)
    folder = DATA_DIR / "direction"
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / "direction_production_annees.csv"
    out.to_csv(destination, index=False, sep=";")
    out.to_csv(PROCESSED_DIR / "direction_production_annees.csv", index=False)
    _write_park_hours(joined, folder)
    print(f"{len(out)} lignes écrites dans {destination}")


def _write_park_hours(joined: pd.DataFrame, folder: Path) -> None:
    """Une fichier par parc, même colonnes que les CSV de production, plus la direction."""
    stamps = pd.to_datetime(joined["timestamp_utc"], utc=True)
    local = stamps.dt.tz_convert("Europe/Paris")
    table = pd.DataFrame({
        "timestamp": joined["timestamp_raw"],
        "timestamp_utc": stamps.dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timestamp_fr": local.map(lambda stamp: stamp.isoformat(timespec="seconds")),
        "parc": joined["park"],
        "t1_mw": joined["t1_mw"],
        "t2_mw": joined["t2_mw"],
        "production_totale_mw": joined["production_mw"],
        "wind_direction_deg": joined["wind_direction_deg"],
        "direction": assign_sectors(joined["wind_direction_deg"]),
        "annee": stamps.dt.year,
        "classe_production": assign_production_class(joined["production_mw"]),
        "vent_kmh": joined["wind_speed_source"],
        "vent_ms_hypothese": joined["wind_speed_ms_hypothesis"],
    })
    for park in FARMS:
        part = table.loc[table["parc"] == park].sort_values("timestamp_utc")
        path = folder / f"{park}.csv"
        part.to_csv(path, index=False, sep=";")
        print(f"{path.name} : {len(part)} heures")


if __name__ == "__main__":
    main()
