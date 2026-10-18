from __future__ import annotations

import csv
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PRODUCTION_FILE = ROOT / "data" / "production_offshore_complet_2026-10-01.csv"
PRODUCTION_WITHIN_FILE = ROOT / "data" / "production_offshore_farms_within_constraint.csv"
COMMUNES_FILE = ROOT / "data" / "donnees_communes.csv"
WIND_DIR = ROOT / "data" / "wind_data"
OUTPUT_DIR = ROOT / "webpage" / "data"

LOW_MW = -10
HIGH_MW = 500
DEFAULT_THEORY = {
    "cut_in_ms": 3.5,
    "rated_speed_ms": 12.5,
    "cut_out_ms": 25.0,
    "rated_mw": 480.0,
}

FARMS = {
    "Saint-Nazaire": {
        "slug": "saint-nazaire",
        "region": "Loire-Atlantique",
        "wind": "Saint-Nazaire_hourly_data.csv",
        "turbine_mw": 6.0,
        "turbines": 80,
        "blurb": "France's first commercial-scale offshore wind farm, located off the Loire-Atlantique coast.",
    },
    "Saint-Brieuc": {
        "slug": "saint-brieuc",
        "region": "Brittany",
        "wind": "Saint-Brieuc_hourly_data.csv",
        "turbine_mw": 8.0,
        "turbines": 62,
        "blurb": "Situated in the Bay of Saint-Brieuc, this farm brings offshore wind production to the Brittany coast.",
    },
    "Fecamp": {
        "slug": "fecamp",
        "region": "Normandy",
        "wind": "Fécamp_hourly_data.csv",
        "turbine_mw": 7.0,
        "turbines": 71,
        "blurb": "A Normandy offshore wind farm whose output is shaped by the strong winds of the English Channel.",
    },
    "Yeu-Noirmoutier": {
        "slug": "yeu-noirmoutier",
        "region": "Vendée",
        "wind": "Noirmoutier_hourly_data.csv",
        "turbine_mw": 8.0,
        "turbines": 62,
        "blurb": "Located off the coasts of Île d'Yeu and Noirmoutier, adding Atlantic production to the French fleet.",
    },
}


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip())
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def number(value: str) -> float | None:
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def read_production() -> dict[str, tuple[list[tuple[int, float]], set[int]]]:
    with PRODUCTION_FILE.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        columns = reader.fieldnames or []
        for farm in FARMS:
            if f"{farm} T1" not in columns or f"{farm} T2" not in columns:
                raise SystemExit(f"Missing production columns for {farm}: {columns}")
        result = {farm: ([], set()) for farm in FARMS}
        for row in reader:
            try:
                timestamp = int(parse_utc(row["timestamp"]).timestamp())
            except (KeyError, ValueError):
                continue
            for farm in FARMS:
                first = number(row[f"{farm} T1"])
                second = number(row[f"{farm} T2"])
                if first is None or second is None:
                    continue
                total = first + second
                if not LOW_MW <= total <= HIGH_MW:
                    continue
                result[farm][0].append((timestamp, total))
                result[farm][1].add(timestamp)
    return result


def read_wind(path: Path) -> dict[int, dict[str, float]]:
    readings: dict[int, dict[str, float]] = {}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            try:
                timestamp = int(parse_utc(row["date"]).timestamp())
            except (KeyError, ValueError):
                continue
            speed = number(row.get("hourly_wind_speed_100m", ""))
            if speed is None:
                continue
            readings[timestamp] = {
                "wind_speed_ms_hyp": speed / 3.6,
                "wind_direction_deg": number(row.get("hourly_wind_direction_100m", "")) or 0.0,
                "wind_gusts_ms_hyp": (number(row.get("hourly_wind_gusts_10m", "")) or 0.0) / 3.6,
            }
    return readings


def empty_profile() -> dict[str, list]:
    return {
        "hour_sum": [0.0] * 24,
        "hour_count": [0] * 24,
        "month_sum": [0.0] * 12,
        "month_count": [0] * 12,
    }


def add_value(profile: dict[str, list], moment: datetime, value: float) -> None:
    profile["hour_sum"][moment.hour] += value
    profile["hour_count"][moment.hour] += 1
    profile["month_sum"][moment.month - 1] += value
    profile["month_count"][moment.month - 1] += 1


def read_production_profiles() -> tuple[dict[str, dict[str, dict[str, list]]], dict[str, int]]:
    profiles: dict[str, dict[str, dict[str, list]]] = {farm: {} for farm in FARMS}
    year_rows: dict[str, int] = {}
    with PRODUCTION_WITHIN_FILE.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        for row in reader:
            try:
                moment = datetime.fromisoformat(row["timestamp"].strip())
            except (KeyError, ValueError):
                continue
            year = str(moment.year)
            year_rows[year] = year_rows.get(year, 0) + 1
            for farm in FARMS:
                value = number(row.get(farm, ""))
                if value is None:
                    continue
                profile = profiles[farm].setdefault(year, empty_profile())
                add_value(profile, moment, value)
    return profiles, year_rows


def read_wind_profiles(path: Path) -> dict[str, dict[str, list]]:
    profiles: dict[str, dict[str, list]] = {}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            try:
                moment = datetime.fromisoformat(row["date"].strip())
            except (KeyError, ValueError):
                continue
            speed = number(row.get("hourly_wind_speed_100m", ""))
            if speed is None:
                continue
            profile = profiles.setdefault(str(moment.year), empty_profile())
            add_value(profile, moment, speed / 3.6)
    return profiles


def mean_or_none(total: float, count: int) -> float | None:
    return round(total / count, 2) if count else None


def build_profiles(
    production_years: dict[str, dict[str, list]],
    wind_years: dict[str, dict[str, list]],
    year_rows: dict[str, int],
) -> dict:
    years = sorted(set(production_years) | set(wind_years))
    hourly = {}
    monthly = {}
    annual = {}
    for year in years:
        production = production_years.get(year, empty_profile())
        wind = wind_years.get(year, empty_profile())
        hourly[year] = {
            "production": [
                mean_or_none(production["hour_sum"][hour], production["hour_count"][hour])
                for hour in range(24)
            ],
            "wind": [
                mean_or_none(wind["hour_sum"][hour], wind["hour_count"][hour])
                for hour in range(24)
            ],
            "production_hours": production["hour_count"],
            "wind_hours": wind["hour_count"],
        }
        monthly[year] = {
            "production": [
                mean_or_none(production["month_sum"][month], production["month_count"][month])
                for month in range(12)
            ],
            "wind": [
                mean_or_none(wind["month_sum"][month], wind["month_count"][month])
                for month in range(12)
            ],
            "production_hours": production["month_count"],
            "wind_hours": wind["month_count"],
        }
        annual[year] = {
            "production_mwh": round(sum(production["month_sum"]), 2),
            "production_hours": sum(production["month_count"]),
            "period_hours": year_rows.get(year, sum(production["month_count"])),
            "first_month": next(
                (
                    month
                    for month, value in enumerate(monthly[year]["production"])
                    if value is not None
                ),
                None,
            ),
            "last_month": next(
                (
                    month
                    for month, value in reversed(list(enumerate(monthly[year]["production"])))
                    if value is not None
                ),
                None,
            ),
        }
    default_year = "2025" if "2025" in years else (years[-1] if years else None)
    return {
        "years": years,
        "default_year": default_year,
        "hourly": hourly,
        "monthly": monthly,
        "annual": annual,
    }


def build_farm(name: str, config: dict, production, ) -> dict:
    clean_rows, clean_times = production[name]
    wind = read_wind(WIND_DIR / config["wind"])

    points = []
    for timestamp, total in clean_rows:
        reading = wind.get(timestamp)
        if reading is None:
            continue
        points.append(
            {
                "time": timestamp,
                "wind": round(reading["wind_speed_ms_hyp"], 3),
                "power": round(total, 3),
            }
        )

    matched_times = {point["time"] for point in points}
    powers = [point["power"] for point in points]
    winds = [point["wind"] for point in points]
    capacity_mw = config["turbine_mw"] * config["turbines"]
    total_production_mwh = sum(powers)
    producing_hours = sum(1 for value in powers if value > 0)
    capacity_factor = (
        total_production_mwh / (capacity_mw * len(powers)) if points and capacity_mw > 0 else None
    )
    producing_share = producing_hours / len(powers) if points else None

    if points:
        start = datetime.fromtimestamp(points[0]["time"], timezone.utc).isoformat()
        end = datetime.fromtimestamp(points[-1]["time"], timezone.utc).isoformat()
    else:
        start = end = None

    return {
        "key": name,
        "label": "Fécamp" if name == "Fecamp" else name,
        "slug": config["slug"],
        "region": config["region"],
        "blurb": config["blurb"],
        "defaults": DEFAULT_THEORY,
        "capacity": {
            "turbine_mw": config["turbine_mw"],
            "turbines": config["turbines"],
            "total_mw": capacity_mw,
        },
        "coverage": {
            "matched": len(points),
            "production_clean": len(clean_rows),
            "wind": len(wind),
            "production_without_wind": len(clean_times - set(wind)),
            "wind_without_production": len(set(wind) - clean_times),
        },
        "stats": {
            "mean_power_mw": round(statistics.fmean(powers), 2) if powers else None,
            "median_power_mw": round(statistics.median(powers), 2) if powers else None,
            "mean_wind_ms": round(statistics.fmean(winds), 2) if winds else None,
            "max_wind_ms": round(max(winds), 2) if winds else None,
            "total_production_mwh": round(total_production_mwh, 2),
            "capacity_factor": round(capacity_factor, 6) if capacity_factor is not None else None,
            "producing_hours": producing_hours,
            "producing_share": round(producing_share, 6) if producing_share is not None else None,
            "records": len(points),
        },
        "period": {"start": start, "end": end},
        "points": {
            "time": [point["time"] for point in points],
            "wind": [point["wind"] for point in points],
            "power": [point["power"] for point in points],
        },
    }


def write_communes() -> None:
    communes = []
    with COMMUNES_FILE.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        for row in reader:
            name = (row.get("Commune") or "").strip()
            department = (row.get("DEP") or "").strip()
            code = (row.get("COM") or "").strip()
            population = number(row.get("PTOT", ""))
            if not name or population is None:
                continue
            communes.append([name, department, code, int(round(population))])
    communes.sort(key=lambda item: (item[0].casefold(), item[1]))
    payload = {"per_capita_mwh": 2.223, "communes": communes}
    target = OUTPUT_DIR / "communes.js"
    target.write_text(
        "window.COMMUNE_DATA = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(f"communes: {len(communes)} communes, {target.stat().st_size / 1024:.0f} KB")


def write_coverage(payloads: dict[str, dict]) -> None:
    farms = []
    years = set()
    for payload in payloads.values():
        annual = payload["profiles"]["annual"]
        years.update(annual)
        farms.append(
            {
                "slug": payload["slug"],
                "label": payload["label"],
                "annual": annual,
            }
        )
    payload = {
        "per_capita_mwh": 2.223,
        "default_year": "2025" if "2025" in years else (max(years) if years else None),
        "years": sorted(years),
        "farms": farms,
    }
    target = OUTPUT_DIR / "coverage.js"
    target.write_text(
        "window.COVERAGE_DATA = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(f"coverage: {len(farms)} farms, {target.stat().st_size / 1024:.0f} KB")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    production = read_production()
    production_profiles, year_rows = read_production_profiles()
    payloads = {}
    for name, config in FARMS.items():
        payload = build_farm(name, config, production)
        payload["profiles"] = build_profiles(
            production_profiles[name],
            read_wind_profiles(WIND_DIR / config["wind"]),
            year_rows,
        )
        payloads[config["slug"]] = payload
        target = OUTPUT_DIR / f"{config['slug']}.js"
        target.write_text(
            "window.FARM_DATA = "
            + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            + ";\n",
            encoding="utf-8",
        )
        print(
            f"{config['slug']}: {payload['coverage']['matched']} matched hours, "
            f"{len(payload['points']['wind'])} points, "
            f"profile years {', '.join(payload['profiles']['years'])}, "
            f"{target.stat().st_size / 1024:.0f} KB"
        )
    write_communes()
    write_coverage(payloads)


if __name__ == "__main__":
    main()
