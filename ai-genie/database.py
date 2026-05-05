"""Database layer with sample data for Semiconductor BI and People Analytics."""

import sqlite3
import random
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "genie_demo.db"


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def execute_query(sql: str) -> list[dict]:
    """Execute a SQL query and return results as list of dicts."""
    conn = get_connection()
    try:
        cursor = conn.execute(sql)
        columns = [desc[0] for desc in cursor.description] if cursor.description else []
        rows = cursor.fetchall()
        return [dict(zip(columns, row)) for row in rows]
    finally:
        conn.close()


def get_schema_description() -> str:
    """Return a human-readable description of all tables and columns."""
    conn = get_connection()
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()

        schema_parts = []
        for (table_name,) in tables:
            cols = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
            col_descs = [f"  - {c[1]} ({c[2]})" for c in cols]
            row_count = conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
            schema_parts.append(
                f"Table: {table_name} ({row_count} rows)\n" + "\n".join(col_descs)
            )
        return "\n\n".join(schema_parts)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Sample data generation
# ---------------------------------------------------------------------------

FABS = ["Fab-Austin", "Fab-Dresden", "Fab-Singapore", "Fab-Hsinchu"]
PRODUCTS = ["CPU-Xeon", "GPU-Arc", "FPGA-Agilex", "SoC-Mobile", "Memory-HBM"]
PROCESS_NODES = ["3nm", "5nm", "7nm", "10nm", "14nm"]
DEFECT_TYPES = ["particle", "scratch", "pattern", "metal_residue", "via_open"]

DEPARTMENTS = ["Engineering", "Sales", "HR", "Finance", "Operations", "R&D", "Marketing"]
LOCATIONS = ["Austin", "San Jose", "Portland", "Munich", "Bangalore", "Shanghai"]
LEVELS = ["IC1", "IC2", "IC3", "IC4", "Senior", "Staff", "Principal", "Director", "VP"]
GENDERS = ["Male", "Female", "Non-Binary"]
ETHNICITIES = ["White", "Asian", "Hispanic", "Black", "Two or More", "Other"]


def _random_date(start_year: int, end_year: int) -> str:
    start = datetime(start_year, 1, 1)
    end = datetime(end_year, 12, 31)
    delta = (end - start).days
    return (start + timedelta(days=random.randint(0, delta))).strftime("%Y-%m-%d")


def init_database():
    """Create tables and populate with sample data if DB doesn't exist."""
    if DB_PATH.exists():
        return

    conn = sqlite3.connect(str(DB_PATH))
    random.seed(42)

    # ---- Semiconductor BI tables ----

    conn.execute("""
        CREATE TABLE wafer_lots (
            lot_id TEXT PRIMARY KEY,
            fab TEXT,
            product TEXT,
            process_node TEXT,
            lot_date TEXT,
            wafers_in INTEGER,
            wafers_out INTEGER,
            yield_pct REAL,
            cycle_time_hours REAL
        )
    """)

    conn.execute("""
        CREATE TABLE defects (
            defect_id INTEGER PRIMARY KEY AUTOINCREMENT,
            lot_id TEXT,
            wafer_number INTEGER,
            defect_type TEXT,
            defect_count INTEGER,
            inspection_date TEXT,
            FOREIGN KEY (lot_id) REFERENCES wafer_lots(lot_id)
        )
    """)

    conn.execute("""
        CREATE TABLE fab_utilization (
            fab TEXT,
            month TEXT,
            capacity_wafers INTEGER,
            actual_wafers INTEGER,
            utilization_pct REAL,
            downtime_hours REAL
        )
    """)

    conn.execute("""
        CREATE TABLE semiconductor_revenue (
            quarter TEXT,
            product TEXT,
            region TEXT,
            revenue_millions REAL,
            units_shipped INTEGER,
            asp_dollars REAL
        )
    """)

    # Generate wafer lots
    for i in range(500):
        lot_id = f"LOT-{i+1:04d}"
        fab = random.choice(FABS)
        product = random.choice(PRODUCTS)
        node = random.choice(PROCESS_NODES)
        lot_date = _random_date(2023, 2025)
        wafers_in = random.randint(20, 25)
        yield_pct = random.gauss(88, 8)
        yield_pct = max(50, min(99, yield_pct))
        wafers_out = int(wafers_in * yield_pct / 100)
        cycle_time = random.gauss(45, 10) * (1 + PROCESS_NODES.index(node) * 0.1)

        conn.execute(
            "INSERT INTO wafer_lots VALUES (?,?,?,?,?,?,?,?,?)",
            (lot_id, fab, product, node, lot_date, wafers_in, wafers_out,
             round(yield_pct, 2), round(cycle_time, 1)),
        )

        # Defects for this lot
        for w in range(1, wafers_in + 1):
            if random.random() < 0.3:
                conn.execute(
                    "INSERT INTO defects (lot_id, wafer_number, defect_type, defect_count, inspection_date) VALUES (?,?,?,?,?)",
                    (lot_id, w, random.choice(DEFECT_TYPES),
                     random.randint(1, 50), lot_date),
                )

    # Fab utilization by month
    for fab in FABS:
        for year in [2023, 2024, 2025]:
            for month in range(1, 13):
                cap = random.randint(8000, 12000)
                util = random.gauss(82, 10)
                util = max(50, min(98, util))
                conn.execute(
                    "INSERT INTO fab_utilization VALUES (?,?,?,?,?,?)",
                    (fab, f"{year}-{month:02d}", cap, int(cap * util / 100),
                     round(util, 1), round(random.gauss(40, 20), 1)),
                )

    # Revenue
    regions = ["Americas", "EMEA", "APAC"]
    for year in [2023, 2024, 2025]:
        for q in range(1, 5):
            for product in PRODUCTS:
                for region in regions:
                    rev = random.gauss(500, 200) * (1 + 0.05 * (year - 2023))
                    units = random.randint(10000, 500000)
                    conn.execute(
                        "INSERT INTO semiconductor_revenue VALUES (?,?,?,?,?,?)",
                        (f"{year}-Q{q}", product, region, round(max(50, rev), 2),
                         units, round(rev * 1e6 / units, 2)),
                    )

    # ---- People Analytics tables ----

    conn.execute("""
        CREATE TABLE employees (
            employee_id INTEGER PRIMARY KEY,
            department TEXT,
            location TEXT,
            level TEXT,
            gender TEXT,
            ethnicity TEXT,
            hire_date TEXT,
            termination_date TEXT,
            salary REAL,
            is_active INTEGER
        )
    """)

    conn.execute("""
        CREATE TABLE hiring_funnel (
            requisition_id TEXT,
            department TEXT,
            location TEXT,
            open_date TEXT,
            close_date TEXT,
            applicants INTEGER,
            phone_screens INTEGER,
            interviews INTEGER,
            offers INTEGER,
            hires INTEGER
        )
    """)

    conn.execute("""
        CREATE TABLE engagement_surveys (
            survey_id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER,
            survey_date TEXT,
            overall_score REAL,
            manager_score REAL,
            growth_score REAL,
            balance_score REAL,
            FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
        )
    """)

    conn.execute("""
        CREATE TABLE compensation_bands (
            level TEXT,
            department TEXT,
            band_min REAL,
            band_mid REAL,
            band_max REAL
        )
    """)

    # Generate employees
    for eid in range(1, 2001):
        dept = random.choice(DEPARTMENTS)
        loc = random.choice(LOCATIONS)
        level = random.choice(LEVELS)
        gender = random.choices(GENDERS, weights=[48, 45, 7])[0]
        eth = random.choices(ETHNICITIES, weights=[35, 30, 15, 10, 7, 3])[0]
        hire_date = _random_date(2015, 2025)

        is_active = 1
        term_date = None
        if random.random() < 0.15:
            is_active = 0
            term_date = _random_date(2023, 2025)

        base = {"IC1": 80000, "IC2": 100000, "IC3": 125000, "IC4": 150000,
                "Senior": 175000, "Staff": 210000, "Principal": 250000,
                "Director": 280000, "VP": 350000}
        salary = base[level] * random.gauss(1, 0.12)

        conn.execute(
            "INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?,?)",
            (eid, dept, loc, level, gender, eth, hire_date, term_date,
             round(salary, 2), is_active),
        )

    # Hiring funnel
    for i in range(200):
        dept = random.choice(DEPARTMENTS)
        loc = random.choice(LOCATIONS)
        open_date = _random_date(2023, 2025)
        apps = random.randint(50, 500)
        screens = int(apps * random.uniform(0.15, 0.4))
        interviews = int(screens * random.uniform(0.3, 0.6))
        offers = int(interviews * random.uniform(0.2, 0.5))
        hires = int(offers * random.uniform(0.5, 0.9))

        conn.execute(
            "INSERT INTO hiring_funnel VALUES (?,?,?,?,?,?,?,?,?,?)",
            (f"REQ-{i+1:04d}", dept, loc, open_date,
             _random_date(2023, 2025), apps, screens, interviews, offers, max(1, hires)),
        )

    # Engagement surveys
    for eid in range(1, 2001):
        if random.random() < 0.8:
            for survey_date in ["2023-06-01", "2024-06-01", "2025-06-01"]:
                conn.execute(
                    "INSERT INTO engagement_surveys (employee_id, survey_date, overall_score, manager_score, growth_score, balance_score) VALUES (?,?,?,?,?,?)",
                    (eid, survey_date,
                     round(random.gauss(3.8, 0.7), 2),
                     round(random.gauss(4.0, 0.8), 2),
                     round(random.gauss(3.5, 0.9), 2),
                     round(random.gauss(3.7, 0.8), 2)),
                )

    # Compensation bands
    for level in LEVELS:
        for dept in DEPARTMENTS:
            base = {"IC1": 80000, "IC2": 100000, "IC3": 125000, "IC4": 150000,
                    "Senior": 175000, "Staff": 210000, "Principal": 250000,
                    "Director": 280000, "VP": 350000}
            mid = base[level]
            conn.execute(
                "INSERT INTO compensation_bands VALUES (?,?,?,?,?)",
                (level, dept, round(mid * 0.8), mid, round(mid * 1.2)),
            )

    conn.commit()
    conn.close()
    print(f"Database initialized at {DB_PATH}")


if __name__ == "__main__":
    init_database()
