from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FEATURE_DIR = ROOT / "BRE12_OH-feature-extrapolate-new-windfarm"
DATA_DIR = FEATURE_DIR / "data"
FARMS_FILE = FEATURE_DIR / "farms_reference.json"
OUTPUT_FILE = ROOT / "webpage" / "data" / "extrapolate-reference.js"
HOUR_MS = 3_600_000

PRODUCTION_FILES = {
    "Saint-Nazaire": "Saint-Nazaire.csv",
    "Fécamp": "Fecamp.csv",
    "Saint-Brieuc": "Saint-Brieuc.csv",
    "Yeu-Noirmoutier": "Yeu-Noirmoutier.csv",
}

WIND_FILES = {
    "Saint-Nazaire": "Saint-Nazaire_hourly_data.csv",
    "Fécamp": "Fécamp_hourly_data.csv",
    "Saint-Brieuc": "Saint-Brieuc_hourly_data.csv",
    "Yeu-Noirmoutier": "Noirmoutier_hourly_data.csv",
}


def parse_timestamp(value: str) -> int:
    moment = datetime.fromisoformat(value.strip())
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.astimezone(timezone.utc).timestamp() * 1000)


def compact_series(series: list[tuple[int, float]], digits: int) -> dict:
    start = series[0][0]
    return {
        "start": start,
        "offsets": [round((timestamp - start) / HOUR_MS) for timestamp, _ in series],
        "values": [round(value, digits) for _, value in series],
    }


def read_production(path: Path, pnom: float) -> list[tuple[int, float]]:
    hourly: dict[int, dict[str, float]] = {}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        reader.fieldnames = [name.strip() for name in (reader.fieldnames or [])]
        columns = reader.fieldnames or []
        time_col = next((name for name in ("timestamp_utc", "timestamp") if name in columns), None)
        value_col = next(
            (name for name in ("production_totale_mw", "production_mw") if name in columns),
            None,
        )
        if time_col is None or value_col is None:
            raise SystemExit(f"Unsupported production columns in {path}: {columns}")
        for row in reader:
            timestamp = parse_timestamp(row[time_col])
            hour = timestamp - timestamp % HOUR_MS
            value = max(0.0, float(row[value_col]))
            entry = hourly.setdefault(hour, {"sum": 0.0, "count": 0.0})
            entry["sum"] += value
            entry["count"] += 1.0
    return sorted(
        (timestamp, entry["sum"] / entry["count"] / pnom)
        for timestamp, entry in hourly.items()
        if entry["count"]
    )


def read_wind(path: Path) -> list[tuple[int, float]]:
    raw: dict[int, float] = {}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        reader.fieldnames = [name.strip() for name in (reader.fieldnames or [])]
        columns = reader.fieldnames or []
        time_col = next(
            (name for name in ("date", "timestamp_utc", "timestamp") if name in columns),
            None,
        )
        value_col = next(
            (name for name in ("hourly_wind_speed_100m", "wind_speed_100m") if name in columns),
            None,
        )
        if time_col is None or value_col is None:
            raise SystemExit(f"Unsupported wind columns in {path}: {columns}")
        for row in reader:
            raw[parse_timestamp(row[time_col])] = float(row[value_col]) / 3.6
    mean_hourly = {
        timestamp: (value + raw[timestamp + HOUR_MS]) / 2
        for timestamp, value in raw.items()
        if timestamp + HOUR_MS in raw
    }
    return sorted(mean_hourly.items())


def main() -> None:
    farms = json.loads(FARMS_FILE.read_text(encoding="utf-8"))
    output_farms = []
    series = {}
    for farm in farms:
        name = farm["name"]
        production_file = PRODUCTION_FILES[name]
        wind_file = WIND_FILES[name]
        pnom = float(farm["n_turbines"]) * float(farm["mw_per_turbine"])
        production = read_production(DATA_DIR / production_file, pnom)
        wind = read_wind(DATA_DIR / wind_file)
        output_farms.append(
            {
                "name": name,
                "column": farm["column"],
                "lat": float(farm["lat"]),
                "lon": float(farm["lon"]),
                "turbines": int(farm["n_turbines"]),
                "turbine_mw": float(farm["mw_per_turbine"]),
                "pnom_mw": pnom,
            }
        )
        series[name] = {
            "production": compact_series(production, 5),
            "wind": compact_series(wind, 3),
        }
        print(
            f"{name}: production {len(production):,} hours, wind {len(wind):,} hours, "
            f"pnom {pnom:g} MW"
        )
    payload = {"farms": output_farms, "series": series}
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        "window.EXTRAPOLATE_REFERENCE = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(f"wrote {OUTPUT_FILE} ({OUTPUT_FILE.stat().st_size / 1024 / 1024:.2f} MB)")


if __name__ == "__main__":
    main()
