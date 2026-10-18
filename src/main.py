import csv
from pathlib import Path

DATA_FILE = Path(__file__).parent / "data" / "production_offshore_complet_2026-10-01.csv"
FARM_FILE = Path(__file__).parent / "data" / "production_offshore_farms_2026-10-01.csv"
WITHIN_CONSTRAINT_FILE = Path(__file__).parent / "data" / "production_offshore_farms_within_constraint.csv"
OVERSHOOT_FILE = Path(__file__).parent / "data" / "production_offshore_farms_overshoot.csv"

CONSTRAINT_LOW = -10
CONSTRAINT_HIGH = 500


FARM_GROUPS = {
    "Saint-Nazaire": ["Saint-Nazaire T1", "Saint-Nazaire T2"],
    "Saint-Brieuc": ["Saint-Brieuc T1", "Saint-Brieuc T2"],
    "Fecamp": ["Fecamp T1", "Fecamp T2"],
    "Yeu-Noirmoutier": ["Yeu-Noirmoutier T1", "Yeu-Noirmoutier T2"],
}


def read_rows(path=DATA_FILE):
    # Yield each row of the semicolon-delimited CSV as a list of strings.
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f, delimiter=";")
        for row in reader:
            yield row


def group_farms(rows):
    # Merge each farm's T1/T2 turbine columns into one value per farm by summing
    # the available readings (blank when both turbines are missing).
    header = next(rows)
    index = {name: i for i, name in enumerate(header)}
    yield ["timestamp", *FARM_GROUPS]
    for row in rows:
        values = []
        for columns in FARM_GROUPS.values():
            powers = [int(row[index[c]]) for c in columns if row[index[c]] != ""]
            values.append(sum(powers) if powers else "")
        yield [row[index["timestamp"]], *values]


def write_sheet(rows, path=FARM_FILE):
    # Write the given rows to a semicolon-delimited CSV file (overwrites it).
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerows(rows)


def within_constraint(row, low=CONSTRAINT_LOW, high=CONSTRAINT_HIGH):
    # True if every farm value in the row (skipping blanks/header) is within
    # the [low, high] power boundary.
    for value in row[1:]:
        if value != "" and not low <= int(value) <= high:
            return False
    return True


def split_by_constraint(rows, low=CONSTRAINT_LOW, high=CONSTRAINT_HIGH):
    # Route each data row to the within or overshoot bucket based on the
    # constraint; return the header plus the two lists of rows.
    header = next(rows)
    within, overshoot = [], []
    for row in rows:
        target = within if within_constraint(row, low, high) else overshoot
        target.append(row)
    return header, within, overshoot


def main():
    # Build the per-farm sheet, then split it into within/overshoot sheets.
    write_sheet(group_farms(read_rows()), FARM_FILE)
    header, within, overshoot = split_by_constraint(group_farms(read_rows()))
    write_sheet([header, *within], WITHIN_CONSTRAINT_FILE)
    write_sheet([header, *overshoot], OVERSHOOT_FILE)


if __name__ == "__main__":
    main()
