from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, date, timedelta
from typing import Iterable, Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://balise.no"
USER_AGENT = "Mozilla/5.0 (compatible; BaliseLogistikkBot/0.1; +local prototype)"


class BaliseError(Exception):
    pass


@dataclass
class VehicleSet:
    set_id: str
    owner: Optional[str]
    operator: Optional[str]
    active: Optional[bool]
    source_url: str
    fetched_at: str


@dataclass
class VehicleCompositionRow:
    set_id: str
    vehicle_no: str
    seats: Optional[int]
    position: Optional[int]
    litra: Optional[str]
    source_url: str
    fetched_at: str


@dataclass
class TrainRun:
    run_date: str
    train_no: str
    route_from: Optional[str]
    route_to: Optional[str]
    operator: Optional[str]
    category: Optional[str]
    source_url: str
    fetched_at: str


@dataclass
class TrainMaterialLink:
    run_date: str
    train_no: str
    set_id: str
    source_url: str
    fetched_at: str


@dataclass
class TrainStop:
    run_date: str
    train_no: str
    station: str
    track: Optional[str]
    arr_scheduled: Optional[str]
    dep_scheduled: Optional[str]
    source_url: str
    fetched_at: str


class BaliseClient:
    def __init__(self, timeout: int = 20):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.timeout = timeout

    def get_html(self, path_or_url: str) -> str:
        url = path_or_url if path_or_url.startswith("http") else urljoin(BASE_URL, path_or_url)
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        return response.text

    def parse_type_page(self, html: str, source_url: str) -> list[VehicleSet]:
        fetched_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text("\n", strip=True)
        # Typical lines resemble: 70-12 Norske tog Vy
        matches = re.findall(r"\b(\d{2}(?:-\d{2})?)\s+(Norske tog|SJ|Go-Ahead|Bane NOR|OnRail|CargoNet|Green Cargo)?\s*(Vy|SJ|Go-Ahead|Bane NOR|CargoNet|Flytoget)?", text)
        rows: list[VehicleSet] = []
        seen: set[str] = set()
        for set_id, owner, operator in matches:
            # Ignore the type header line like "70 Norske tog Vy" only if it has no hyphen and we already saw a specific set.
            if set_id in seen:
                continue
            active = "✝" not in text[text.find(set_id): text.find(set_id) + 8]
            rows.append(VehicleSet(
                set_id=set_id,
                owner=owner or None,
                operator=operator or None,
                active=active if "-" in set_id else None,
                source_url=source_url,
                fetched_at=fetched_at,
            ))
            seen.add(set_id)
        return [r for r in rows if "-" in r.set_id]

    def parse_composition_page(self, html: str, set_id: str, source_url: str) -> tuple[list[VehicleCompositionRow], Optional[str]]:
        fetched_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text("\n", strip=True)

        rows: list[VehicleCompositionRow] = []
        for vehicle_no, seats, position, litra in re.findall(r"\b(\d{5})\s+(\d+)\s+(\d+)\s+([A-ZÆØÅ0-9]+)", text):
            rows.append(VehicleCompositionRow(
                set_id=set_id,
                vehicle_no=vehicle_no,
                seats=int(seats),
                position=int(position),
                litra=litra,
                source_url=source_url,
                fetched_at=fetched_at,
            ))

        last_seen = None
        m = re.search(r"Sist sett\s+([\w\s:.,+-]+?)\s+Sammensetning", text, flags=re.IGNORECASE)
        if m:
            last_seen = m.group(1).strip()
        return rows, last_seen

    def parse_train_page(self, html: str, train_no: str, run_date: str, source_url: str) -> tuple[TrainRun, list[TrainMaterialLink], list[TrainStop]]:
        fetched_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text("\n", strip=True)

        # Header example: # | Skien - Notodden
        route_from = route_to = None
        m = re.search(r"\|\s*([^\n|]+?)\s*-\s*([^\n|]+)", text)
        if m:
            route_from = m.group(1).strip()
            route_to = m.group(2).strip()

        operator = None
        category = None
        m = re.search(r"([A-Za-zÆØÅa-zæøå]+tog) kjørt av ([A-Za-zÆØÅa-zæøå -]+)", text)
        if m:
            category = m.group(1).strip()
            operator = m.group(2).strip()

        links: list[TrainMaterialLink] = []
        for set_id in sorted(set(re.findall(r"\b\d{2}-\d{2}\b", text))):
            links.append(TrainMaterialLink(
                run_date=run_date,
                train_no=train_no,
                set_id=set_id,
                source_url=source_url,
                fetched_at=fetched_at,
            ))

        stops: list[TrainStop] = []
        # Fallback parser for SSR text if route rows are available in plain text
        for line in text.splitlines():
            line = line.strip()
            m = re.match(r"^([A-ZÆØÅa-zæøå .\-]+)\s+(\d+)?\s+(\d{2}:\d{2}|-)\s+(\d{2}:\d{2}|-)$", line)
            if m:
                station, track, arr, dep = m.groups()
                stops.append(TrainStop(
                    run_date=run_date,
                    train_no=train_no,
                    station=station.strip(),
                    track=track,
                    arr_scheduled=None if arr == "-" else arr,
                    dep_scheduled=None if dep == "-" else dep,
                    source_url=source_url,
                    fetched_at=fetched_at,
                ))

        train_run = TrainRun(
            run_date=run_date,
            train_no=train_no,
            route_from=route_from,
            route_to=route_to,
            operator=operator,
            category=category,
            source_url=source_url,
            fetched_at=fetched_at,
        )
        return train_run, links, stops

    def fetch_type_sets(self, vehicle_type: str) -> list[VehicleSet]:
        url = f"{BASE_URL}/materiell/type/{vehicle_type}"
        html = self.get_html(url)
        return self.parse_type_page(html, url)

    def fetch_composition(self, set_id: str) -> tuple[list[VehicleCompositionRow], Optional[str]]:
        url = f"{BASE_URL}/materiell/sammensetning/{set_id}"
        html = self.get_html(url)
        return self.parse_composition_page(html, set_id, url)

    def fetch_train(self, train_no: str, run_date: date) -> tuple[TrainRun, list[TrainMaterialLink], list[TrainStop]]:
        # Balise URLs appear to use next-day date paths for display pages in several cases,
        # so this method accepts the user-facing run_date but also keeps the source date explicit.
        url = f"{BASE_URL}/tog/{train_no}/{run_date.isoformat()}"
        html = self.get_html(url)
        return self.parse_train_page(html, train_no, run_date.isoformat(), url)


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS vehicle_sets (
            set_id TEXT PRIMARY KEY,
            owner TEXT,
            operator TEXT,
            active INTEGER,
            source_url TEXT NOT NULL,
            fetched_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS vehicle_composition (
            set_id TEXT NOT NULL,
            vehicle_no TEXT NOT NULL,
            seats INTEGER,
            position INTEGER,
            litra TEXT,
            source_url TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (set_id, vehicle_no),
            FOREIGN KEY (set_id) REFERENCES vehicle_sets(set_id)
        );

        CREATE TABLE IF NOT EXISTS vehicle_last_seen (
            set_id TEXT PRIMARY KEY,
            last_seen_text TEXT,
            source_url TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            FOREIGN KEY (set_id) REFERENCES vehicle_sets(set_id)
        );

        CREATE TABLE IF NOT EXISTS train_runs (
            run_date TEXT NOT NULL,
            train_no TEXT NOT NULL,
            route_from TEXT,
            route_to TEXT,
            operator TEXT,
            category TEXT,
            source_url TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (run_date, train_no)
        );

        CREATE TABLE IF NOT EXISTS train_material_links (
            run_date TEXT NOT NULL,
            train_no TEXT NOT NULL,
            set_id TEXT NOT NULL,
            source_url TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (run_date, train_no, set_id),
            FOREIGN KEY (run_date, train_no) REFERENCES train_runs(run_date, train_no),
            FOREIGN KEY (set_id) REFERENCES vehicle_sets(set_id)
        );

        CREATE TABLE IF NOT EXISTS train_stops (
            run_date TEXT NOT NULL,
            train_no TEXT NOT NULL,
            station TEXT NOT NULL,
            track TEXT,
            arr_scheduled TEXT,
            dep_scheduled TEXT,
            source_url TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (run_date, train_no, station),
            FOREIGN KEY (run_date, train_no) REFERENCES train_runs(run_date, train_no)
        );
        """
    )
    conn.commit()


def upsert_vehicle_sets(conn: sqlite3.Connection, rows: Iterable[VehicleSet]) -> None:
    conn.executemany(
        """
        INSERT INTO vehicle_sets (set_id, owner, operator, active, source_url, fetched_at)
        VALUES (:set_id, :owner, :operator, :active, :source_url, :fetched_at)
        ON CONFLICT(set_id) DO UPDATE SET
            owner = excluded.owner,
            operator = excluded.operator,
            active = excluded.active,
            source_url = excluded.source_url,
            fetched_at = excluded.fetched_at
        """,
        [row.__dict__ | {"active": None if row.active is None else int(row.active)} for row in rows],
    )
    conn.commit()


def upsert_vehicle_composition(conn: sqlite3.Connection, rows: Iterable[VehicleCompositionRow], last_seen: Optional[str] = None, source_url: Optional[str] = None, fetched_at: Optional[str] = None) -> None:
    rows = list(rows)
    conn.executemany(
        """
        INSERT INTO vehicle_composition (set_id, vehicle_no, seats, position, litra, source_url, fetched_at)
        VALUES (:set_id, :vehicle_no, :seats, :position, :litra, :source_url, :fetched_at)
        ON CONFLICT(set_id, vehicle_no) DO UPDATE SET
            seats = excluded.seats,
            position = excluded.position,
            litra = excluded.litra,
            source_url = excluded.source_url,
            fetched_at = excluded.fetched_at
        """,
        [row.__dict__ for row in rows],
    )
    if rows and last_seen is not None:
        conn.execute(
            """
            INSERT INTO vehicle_last_seen (set_id, last_seen_text, source_url, fetched_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(set_id) DO UPDATE SET
                last_seen_text = excluded.last_seen_text,
                source_url = excluded.source_url,
                fetched_at = excluded.fetched_at
            """,
            (rows[0].set_id, last_seen, source_url or rows[0].source_url, fetched_at or rows[0].fetched_at),
        )
    conn.commit()


def upsert_train_bundle(conn: sqlite3.Connection, run: TrainRun, links: Iterable[TrainMaterialLink], stops: Iterable[TrainStop]) -> None:
    conn.execute(
        """
        INSERT INTO train_runs (run_date, train_no, route_from, route_to, operator, category, source_url, fetched_at)
        VALUES (:run_date, :train_no, :route_from, :route_to, :operator, :category, :source_url, :fetched_at)
        ON CONFLICT(run_date, train_no) DO UPDATE SET
            route_from = excluded.route_from,
            route_to = excluded.route_to,
            operator = excluded.operator,
            category = excluded.category,
            source_url = excluded.source_url,
            fetched_at = excluded.fetched_at
        """,
        run.__dict__,
    )
    conn.executemany(
        """
        INSERT OR REPLACE INTO train_material_links (run_date, train_no, set_id, source_url, fetched_at)
        VALUES (:run_date, :train_no, :set_id, :source_url, :fetched_at)
        """,
        [row.__dict__ for row in links],
    )
    conn.executemany(
        """
        INSERT OR REPLACE INTO train_stops (run_date, train_no, station, track, arr_scheduled, dep_scheduled, source_url, fetched_at)
        VALUES (:run_date, :train_no, :station, :track, :arr_scheduled, :dep_scheduled, :source_url, :fetched_at)
        """,
        [row.__dict__ for row in stops],
    )
    conn.commit()
