from flask import Flask, jsonify, send_file
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
INDEX_FILE = BASE_DIR / "index.html"

app = Flask(__name__, static_folder=".", static_url_path="")

HARDCODED_DEPARTURES = {
    "802": "04:10",
    "852": "04:29",
    "804": "05:11",
    "854": "05:25",
    "2470": "05:27",
    "862": "05:37",
    "806": "06:07",
    "864": "06:17",
    "856": "06:25",
    "2472": "06:49",
    "808": "07:09",
    "2473": "07:31",
    "2474": "07:59",
    "810": "08:09",
    "2475": "09:00",
    "812": "09:09",
    "2477": "10:01",
    "814": "10:09",
    "816": "11:09",
    "2478": "12:01",
    "818": "12:09",
    "820": "13:09",
    "2480": "13:21",
    "2481": "14:04",
    "822": "14:09",
    "2482": "14:55",
    "824": "15:09",
    "2483": "15:39",
    "826": "16:08",
    "2484": "16:20",
    "2485": "17:03",
    "828": "17:08",
    "2486": "18:01",
    "830": "18:08",
    "2487": "19:02",
    "832": "19:09",
    "834": "20:09",
    "836": "21:09",
    "838": "22:09",
    "840": "23:09"
}

HARDCODED_ARRIVALS = {
    "2472": {"time": "06:47", "nextDay": False},
    "2473": {"time": "07:30", "nextDay": False},
    "873": {"time": "07:42", "nextDay": False},
    "2474": {"time": "07:57", "nextDay": False},
    "803": {"time": "08:07", "nextDay": False},
    "805": {"time": "08:53", "nextDay": False},
    "2475": {"time": "08:59", "nextDay": False},
    "807": {"time": "09:53", "nextDay": False},
    "2477": {"time": "10:00", "nextDay": False},
    "809": {"time": "10:53", "nextDay": False},
    "811": {"time": "11:53", "nextDay": False},
    "2478": {"time": "11:59", "nextDay": False},
    "813": {"time": "12:53", "nextDay": False},
    "2480": {"time": "13:19", "nextDay": False},
    "815": {"time": "13:53", "nextDay": False},
    "2481": {"time": "14:02", "nextDay": False},
    "2482": {"time": "14:49", "nextDay": False},
    "817": {"time": "14:53", "nextDay": False},
    "2483": {"time": "15:38", "nextDay": False},
    "819": {"time": "15:53", "nextDay": False},
    "2484": {"time": "16:18", "nextDay": False},
    "821": {"time": "16:30", "nextDay": False},
    "2485": {"time": "17:02", "nextDay": False},
    "853": {"time": "17:30", "nextDay": False},
    "861": {"time": "17:42", "nextDay": False},
    "823": {"time": "17:53", "nextDay": False},
    "2486": {"time": "17:59", "nextDay": False},
    "855": {"time": "18:30", "nextDay": False},
    "863": {"time": "18:42", "nextDay": False},
    "825": {"time": "18:53", "nextDay": False},
    "2487": {"time": "19:01", "nextDay": False},
    "827": {"time": "19:53", "nextDay": False},
    "829": {"time": "20:53", "nextDay": False},
    "2489": {"time": "20:59", "nextDay": False},
    "831": {"time": "21:53", "nextDay": False},
    "833": {"time": "22:53", "nextDay": False},
    "835": {"time": "23:53", "nextDay": False},
    "837": {"time": "00:50", "nextDay": True},
    "839": {"time": "01:45", "nextDay": True}
}

ALLOWED_MATERIAL_PREFIXES = ["69", "70", "74", "75"]


@app.route("/")
def index():
    return send_file(INDEX_FILE)


@app.route("/api/balise-vehicles")
def balise():
    return jsonify({
        "ok": True,
        "updatedAt": datetime.now().strftime("%d.%m.%Y %H:%M:%S"),
        "departures": HARDCODED_DEPARTURES,
        "arrivals": HARDCODED_ARRIVALS,
        "allowedMaterialPrefixes": ALLOWED_MATERIAL_PREFIXES,
        "materialFormat": ["69-xx", "70-xx", "74-xx", "75-xx"]
    })


if __name__ == "__main__":
    print(f"BASE_DIR = {BASE_DIR}")
    print(f"INDEX_FILE = {INDEX_FILE}")
    print(f"INDEX_EXISTS = {INDEX_FILE.exists()}")
    app.run(debug=True)