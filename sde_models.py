from dataclasses import dataclass, field
from typing import Dict, List, Optional


SLOTS = [
    "1S", "1N",
    "2S", "2N",
    "3S", "3M", "3N",
    "4S", "4M", "4N",
    "5S", "5M", "5N",
    "6SS", "6S", "6N",
    "7SS", "7S", "7N",
    "8SS", "8S", "8N",
    "9",
    "10S", "10N",
    "11S", "11N",
    "12S", "12N",
]


@dataclass
class Vehicle:
    number: str
    role: str
    needs: List[str] = field(default_factory=list)
    target_train: Optional[str] = None


@dataclass
class Move:
    vehicle: str
    from_slot: str
    to_slot: str
    time: str
    reason: str
    score: int
    warnings: List[str] = field(default_factory=list)


@dataclass
class Scenario:
    status: Dict[str, Optional[str]]
    vehicles: Dict[str, Vehicle]
    moves: List[Move] = field(default_factory=list)
    score: int = 0
    warnings: List[str] = field(default_factory=list)
