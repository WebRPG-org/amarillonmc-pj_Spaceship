#!/usr/bin/env python3
"""Read-only static inventory of an RPG Maker MV/MZ project (Python 3.8+).

Usage: python inspect_project.py "/path/to/project" [--maps 31 32]
JSON goes to stdout; exit 0 = no reported errors, 1 = reported errors,
2 = invalid CLI usage. --maps limits details, never the validation scope.
No JavaScript is executed and no project file is written.

Standard layout references (project plugins may override these conventions):
https://rpgmakerofficial.com/product/mz/rmmz_api/Tilemap.js.html
https://rpgmakerofficial.com/product/MV_Help/page/01_10_06.html
https://rpgmakerofficial.com/product/MZ_help-en/01_10_06.html
https://github.com/rpgtkoolmv/corescript
"""

import argparse
from collections import Counter
import json
from pathlib import Path, PurePosixPath
import re
import sys


PLANE_ROLES = ["tile_0", "tile_1", "tile_2", "tile_3", "shadow", "region"]
SLOTS = ["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"]
MAP_FILE = re.compile(r"Map(\d+)\.json\Z")


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def positive(value):
    return integer(value) and value > 0


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key: {!r}".format(key))
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError("non-JSON numeric constant: " + value)


class Inspector:
    def __init__(self, project, selected):
        self.root = Path(project).expanduser().resolve()
        self.base = self.root
        self.selected = set(selected) if selected is not None else None
        self.issues = []
        self.maps = {}
        self.infos = {}
        self.map_paths = {}
        self.tilesets = {}
        self.used_tilesets = {}
        self.assets = {}
        self.direct = []
        self.unresolved = Counter()

    def issue(self, severity, code, message, **context):
        self.issues.append(dict(severity=severity, code=code,
                                message=message, **context))

    def relative(self, path):
        try:
            return str(path.relative_to(self.base)).replace("\\", "/")
        except ValueError:
            return str(path)

    def read_text(self, path, required=True):
        try:
            return path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            self.issue("error" if required else "warning", "unreadable_file",
                       str(exc), file=self.relative(path))
            return None

    def read_json(self, path, expected):
        content = self.read_text(path)
        if content is None:
            return None
        try:
            value = json.loads(content, object_pairs_hook=unique_object,
                               parse_constant=invalid_constant)
        except (ValueError, RecursionError) as exc:
            self.issue("error", "invalid_json", str(exc), file=self.relative(path))
            return None
        if not isinstance(value, expected):
            self.issue("error", "invalid_json_root",
                       "Expected a JSON {} (null is not valid here).".format(
                           "object" if expected is dict else "array"),
                       file=self.relative(path))
            return None
        return value

    def engine_inventory(self, system):
        clues, scripts = [], []
        js = self.base / "js"
        for filename, inferred in (("rpg_core.js", "MV"), ("rmmz_core.js", "MZ")):
            path = js / filename
            if not path.is_file():
                continue
            content = self.read_text(path, required=False)
            item = {"file": self.relative(path), "filename_suggests": inferred}
            clues.append({"engine": inferred, "source": self.relative(path)})
            if content is not None:
                for constant, key in (("RPGMAKER_NAME", "declared_engine"),
                                      ("RPGMAKER_VERSION", "declared_version")):
                    match = re.search(r"Utils\." + constant +
                                      r"\s*=\s*(['\"])([^'\"\r\n]+)\1", content)
                    if match:
                        item[key] = match.group(2)
                        if key == "declared_engine" and match.group(2) in ("MV", "MZ"):
                            clues.append({"engine": match.group(2),
                                          "source": self.relative(path) + ":" + constant})
            scripts.append(item)
        for folder in dict.fromkeys((self.root, self.base)):
            for pattern, inferred in (("*.rpgproject", "MV"), ("*.rmmzproject", "MZ")):
                for marker in sorted(folder.glob(pattern)):
                    clues.append({"engine": inferred, "source": str(marker)})
        engines = sorted({item["engine"] for item in clues})
        detected = engines[0] if len(engines) == 1 else "ambiguous" if engines else "unknown"
        if detected in ("ambiguous", "unknown"):
            self.issue("warning", "engine_" + detected,
                       "Engine clues are {}. Inspect the local runtime before editing.".format(detected))
        advanced = system.get("advanced")
        advanced = advanced if isinstance(advanced, dict) else {}
        return {"detected": detected, "clues": clues, "core_scripts": scripts,
                "system": {key: system[key] for key in
                           ("gameTitle", "editorVersion", "tileSize", "hasEncryptedImages")
                           if key in system},
                "configured_viewport": {key: advanced[key] for key in
                                        ("screenWidth", "screenHeight", "uiAreaWidth", "uiAreaHeight")
                                        if key in advanced},
                "plugins": self.plugins_inventory(js / "plugins.js")}

    def plugins_inventory(self, path):
        content = self.read_text(path, required=False)
        result = {"file": self.relative(path), "method": "JSON literal only; never executes JavaScript"}
        if content is None:
            result["status"] = "unreadable"
            return result
        match = re.search(r"(?:var|let|const)\s+\$plugins\s*=\s*", content)
        if not match:
            match = re.search(r"\$plugins\s*=\s*", content)
        try:
            if match is None:
                raise ValueError("No $plugins assignment found.")
            decoder = json.JSONDecoder(object_pairs_hook=unique_object,
                                       parse_constant=invalid_constant)
            plugins, _end = decoder.raw_decode(content[match.end():].lstrip())
            if not isinstance(plugins, list):
                raise ValueError("$plugins is not a JSON array.")
            if any(not isinstance(p, dict) or not isinstance(p.get("name"), str)
                   or not isinstance(p.get("status"), bool) for p in plugins):
                raise ValueError("Plugin entries need string name and boolean status.")
        except (ValueError, RecursionError) as exc:
            result["status"] = "unresolved_javascript"
            self.issue("warning", "plugins_not_statically_parsed", str(exc), file=self.relative(path))
            return result
        result.update(status="literal_inventory_only",
                      enabled=[p["name"] for p in plugins if p["status"]],
                      disabled_count=sum(not p["status"] for p in plugins))
        # A literal inventory is not a proof that later JavaScript leaves it unchanged.
        result["runtime_mutations_checked"] = False
        return result

    def index_database(self, entries, filename):
        result = {}
        for index, entry in enumerate(entries or []):
            if entry is None:
                continue
            if not isinstance(entry, dict):
                self.issue("error", "invalid_database_entry", "Expected object or null.",
                           file=filename, index=index)
                continue
            if index == 0 or entry.get("id") != index or not positive(entry.get("id")):
                self.issue("error", "database_id_mismatch",
                           "Standard database IDs must match their positive array index.",
                           file=filename, index=index, declared_id=entry.get("id"))
            if index > 0:
                result[index] = entry
        return result

    def add_asset(self, kind, name, map_id, tileset_id=None):
        if name in (None, ""):
            return
        if not isinstance(name, str):
            self.issue("error", "invalid_asset_name", "Asset names must be strings.",
                       kind=kind, map_id=map_id, tileset_id=tileset_id)
            return
        key = (kind, name)
        if key not in self.assets:
            entry = {"kind": kind, "name": name, "used_by_maps": set(), "tileset_ids": set()}
            normalized = name.replace("\\", "/")
            rel = PurePosixPath(normalized)
            if "\x00" in name or rel.is_absolute() or ".." in rel.parts or re.match(r"^[A-Za-z]:", normalized):
                entry["status"] = "unresolved_nonlocal_name"
                self.issue("warning", "nonlocal_asset_name",
                           "Asset path escapes the usual image folder; no external path is checked.",
                           kind=kind, name=name)
            else:
                stem = self.base / "img" / kind / normalized
                paths = [Path(str(stem) + suffix) for suffix in (".png", ".rpgmvp", ".png_")]
                found = [self.relative(path) for path in paths if path.is_file()]
                entry["status"] = "file_present" if found else "missing_standard_candidates"
                entry["files"] = found
                if not found:
                    entry["checked"] = [self.relative(path) for path in paths]
                    self.issue("error", "missing_asset",
                               "No PNG or standard MV/MZ encrypted image candidate exists; custom loaders are not resolved.",
                               kind=kind, name=name)
            self.assets[key] = entry
        self.assets[key]["used_by_maps"].add(map_id)
        if tileset_id is not None:
            self.assets[key]["tileset_ids"].add(tileset_id)

    def check_tileset(self, map_id, tileset_id):
        if not positive(tileset_id) or tileset_id not in self.tilesets:
            self.issue("error", "missing_tileset", "Map has no valid referenced tileset.",
                       map_id=map_id, tileset_id=tileset_id)
            return
        definition = self.tilesets[tileset_id]
        first_use = tileset_id not in self.used_tilesets
        if first_use:
            self.used_tilesets[tileset_id] = {"id": tileset_id, "name": definition.get("name", ""),
                                             "used_by_maps": [], "images": []}
        self.used_tilesets[tileset_id]["used_by_maps"].append(map_id)
        names = definition.get("tilesetNames")
        if not isinstance(names, list):
            if first_use:
                self.issue("error", "invalid_tileset_names", "tilesetNames must be an array.", tileset_id=tileset_id)
            return
        if first_use and len(names) != 9:
            self.issue("warning", "nonstandard_tileset_slots",
                       "Standard MV/MZ uses nine image slots A1-A5/B-E; verify plugin conventions.",
                       tileset_id=tileset_id, count=len(names))
        for slot, name in enumerate(names):
            if first_use and name:
                self.used_tilesets[tileset_id]["images"].append(
                    {"slot": SLOTS[slot] if slot < 9 else str(slot), "name": name})
            self.add_asset("tilesets", name, map_id, tileset_id)

    def coordinate_check(self, x, y, map_data):
        width, height = map_data.get("width"), map_data.get("height")
        if not integer(x) or not integer(y):
            return "error", "Coordinates must be integers."
        if not positive(width) or not positive(height):
            return "warning", "Cannot check coordinates because target dimensions are invalid."
        bad_x, bad_y = not (0 <= x < width), not (0 <= y < height)
        if not bad_x and not bad_y:
            return None, None
        scroll = map_data.get("scrollType", 0)
        horizontal, vertical = scroll in (2, 3), scroll in (1, 3)
        if (not bad_x or horizontal) and (not bad_y or vertical):
            return "warning", "Coordinates are outside stored bounds on a looping axis; inspect runtime wrapping."
        return "error", "Coordinates are outside map bounds on a non-looping axis."

    def inspect_map(self, map_id, data):
        width, height = data.get("width"), data.get("height")
        item = {"id": map_id, "name": self.infos.get(map_id, {}).get("name", ""),
                "file": self.relative(self.map_paths[map_id]), "width": width, "height": height,
                "tileset_id": data.get("tilesetId"), "display_name": data.get("displayName", ""),
                "scroll_type": data.get("scrollType", 0)}
        dimensions_ok = positive(width) and positive(height)
        if not dimensions_ok:
            self.issue("error", "invalid_map_dimensions", "Map width/height must be positive integers.", map_id=map_id)
        cells = data.get("data")
        plane = {"length": len(cells) if isinstance(cells, list) else None}
        if not isinstance(cells, list):
            self.issue("error", "invalid_map_data", "Map data must be a flat JSON array.", map_id=map_id)
        else:
            bad_values = [i for i, value in enumerate(cells) if not integer(value) or value < 0]
            if bad_values:
                self.issue("error", "invalid_map_data_values", "Map data contains non-integer or negative values.",
                           map_id=map_id, count=len(bad_values), first_indices=bad_values[:10])
            if dimensions_ok:
                area = width * height
                planes, remainder = divmod(len(cells), area)
                plane.update(expected_standard_length=area * 6, whole_planes=planes, trailing_cells=remainder,
                             nonzero_per_standard_plane=[sum(1 for value in cells[z * area:(z + 1) * area]
                                                            if integer(value) and value != 0) for z in range(6)])
                if remainder or planes < 6:
                    self.issue("error", "map_data_size_mismatch",
                               "Data is incomplete for the standard six-plane layout or contains a partial plane.",
                               map_id=map_id, actual=len(cells), expected_standard=area * 6)
                elif planes > 6:
                    self.issue("warning", "extra_map_planes",
                               "Extra complete planes may be plugin data; their meaning is not inferred.",
                               map_id=map_id, planes=planes)
        item["data"] = plane
        self.check_tileset(map_id, data.get("tilesetId"))
        self.add_asset("parallaxes", data.get("parallaxName"), map_id)
        events = data.get("events")
        item["event_count"] = 0
        if not isinstance(events, list):
            self.issue("error", "invalid_events", "events must be an array (null entries inside it are allowed).", map_id=map_id)
            return item
        counts = Counter()
        for index, event in enumerate(events):
            if event is None:
                continue
            if not isinstance(event, dict):
                self.issue("error", "invalid_event", "Event must be an object or null.", map_id=map_id, event_index=index)
                continue
            item["event_count"] += 1
            context = {"map_id": map_id, "event_id": event.get("id", index)}
            if not positive(event.get("id")) or event.get("id") != index:
                self.issue("error", "event_id_mismatch", "Event ID must match its positive array index.",
                           **context, event_index=index)
            severity, message = self.coordinate_check(event.get("x"), event.get("y"), data)
            if severity:
                self.issue(severity, "event_coordinates", message, **context,
                           x=event.get("x"), y=event.get("y"))
            pages = event.get("pages")
            if not isinstance(pages, list):
                self.issue("error", "invalid_event_pages", "Event pages must be an array.", **context)
                continue
            for page_index, page in enumerate(pages, 1):
                location = dict(context, page=page_index)
                if not isinstance(page, dict):
                    self.issue("error", "invalid_event_page", "Event page must be an object.", **location)
                    continue
                graphic = page.get("image")
                if isinstance(graphic, dict):
                    self.add_asset("characters", graphic.get("characterName"), map_id)
                commands = page.get("list")
                if not isinstance(commands, list):
                    self.issue("error", "invalid_event_commands", "Event command list must be an array.", **location)
                    continue
                for command_index, command in enumerate(commands):
                    command_location = dict(location, command_index=command_index)
                    if not isinstance(command, dict) or not integer(command.get("code")):
                        self.issue("error", "invalid_event_command", "Command must be an object with an integer code.",
                                   **command_location)
                        continue
                    code = command["code"]
                    if code in (117, 355, 356, 357):
                        category = {117: "common_event_calls_not_expanded", 355: "script_blocks_not_executed",
                                    356: "plugin_commands_not_executed", 357: "plugin_commands_not_executed"}[code]
                        counts[category] += 1
                    if code != 201:
                        continue
                    params = command.get("parameters")
                    if not isinstance(params, list) or len(params) < 4 or not integer(params[0]):
                        self.issue("error", "invalid_transfer_parameters", "Transfer Player requires mode/map/x/y parameters.",
                                   **command_location)
                        continue
                    if params[0] == 0:
                        self.direct.append(dict(command_location, target_map_id=params[1], x=params[2], y=params[3]))
                        counts["direct_transfers"] += 1
                    elif params[0] == 1:
                        counts["variable_transfers_unresolved"] += 1
                    else:
                        counts["nonstandard_transfer_modes_unresolved"] += 1
                        self.issue("warning", "nonstandard_transfer_mode", "Unknown Transfer Player mode; no runtime inference.",
                                   **command_location, mode=params[0])
        item["transfer_and_dynamic_command_counts"] = dict(counts)
        self.unresolved.update({key: count for key, count in counts.items() if key != "direct_transfers"})
        return item

    def inspect_transfers(self):
        for transfer in self.direct:
            target = transfer["target_map_id"]
            if not positive(target) or target not in self.map_paths:
                transfer["status"] = "invalid_target_map"
                self.issue("error", "missing_transfer_target", "Direct transfer target map does not exist.", **transfer)
            elif target not in self.maps:
                transfer["status"] = "unresolved_target_data"
            else:
                severity, message = self.coordinate_check(transfer["x"], transfer["y"], self.maps[target])
                if severity:
                    transfer["status"] = "coordinate_error" if severity == "error" else "requires_runtime_review"
                    self.issue(severity, "transfer_coordinates", message, **transfer)
                else:
                    transfer["status"] = "in_bounds_only"

    def run(self):
        report = {"schema_version": 1, "mode": "read_only_static_inventory",
                  "project_root": str(self.root),
                  "scope": {"validation": "all discovered maps and MapInfos references",
                            "map_detail_filter": sorted(self.selected) if self.selected is not None else "all",
                            "asset_types": ["tilesets", "map parallaxes", "event-page character images"]},
                  "standard_plane_roles": PLANE_ROLES,
                  "limitations": [
                      "Six planes and (z * height + y) * width + x indexing describe standard MV/MZ data; inspect local plugins for overrides.",
                      "In-bounds coordinates and existing assets do not establish passability, connectivity, event-page activation, transfer execution or map quality.",
                      "Variable transfers, scripts, plugin commands and common event calls are not executed or expanded; they may contain additional transfers or resource references.",
                      "Asset checks only test local PNG/encrypted-file existence, not decoding, licensing, runtime loaders or the complete game asset graph.",
                      "No autotile correctness, room-shape, U-shape, carpet or aesthetic scoring is performed."
                  ]}
        if not self.root.is_dir():
            self.issue("error", "missing_project_root", "Project root is not an existing directory.")
            return self.finish(report)
        if (self.root / "data").is_dir():
            if (self.root / "www" / "data").is_dir():
                self.issue("warning", "ambiguous_content_root",
                           "Both data/ and www/data/ exist; using data/. Pass www explicitly to inspect the deployed copy.")
        elif (self.root / "www" / "data").is_dir():
            self.base = self.root / "www"
        else:
            self.issue("error", "missing_data_directory", "Neither data/ nor www/data/ exists under the supplied root.")
            return self.finish(report)
        report["content_root"] = str(self.base)
        data_dir = self.base / "data"
        system = self.read_json(data_dir / "System.json", dict)
        report["engine"] = self.engine_inventory(system or {})
        self.infos = self.index_database(self.read_json(data_dir / "MapInfos.json", list), "data/MapInfos.json")
        self.tilesets = self.index_database(self.read_json(data_dir / "Tilesets.json", list), "data/Tilesets.json")
        for path in sorted(data_dir.iterdir()):
            match = MAP_FILE.fullmatch(path.name)
            if not match or not path.is_file():
                continue
            map_id = int(match.group(1))
            if map_id == 0:
                self.issue("error", "invalid_map_id", "Map IDs must be positive.", file=self.relative(path))
                continue
            if map_id in self.map_paths:
                self.issue("error", "duplicate_map_id", "Multiple filenames resolve to one map ID.",
                           map_id=map_id, files=[self.relative(self.map_paths[map_id]), self.relative(path)])
                continue
            self.map_paths[map_id] = path
            canonical = "Map{:03d}.json".format(map_id)
            if path.name != canonical:
                self.issue("error", "noncanonical_map_filename", "The standard loader expects " + canonical,
                           map_id=map_id, file=self.relative(path))
        for map_id in sorted(self.infos.keys() - self.map_paths.keys()):
            self.issue("error", "missing_map_file", "MapInfos references an absent map file.", map_id=map_id)
        for map_id in sorted(self.map_paths.keys() - self.infos.keys()):
            self.issue("warning", "unlisted_map_file", "Map file is not listed in MapInfos; it may be an intentional template.", map_id=map_id)
        if self.selected is not None:
            for map_id in sorted(self.selected - self.map_paths.keys()):
                self.issue("error", "selected_map_missing", "Requested detail map was not found.", map_id=map_id)
        details = []
        for map_id, path in sorted(self.map_paths.items()):
            value = self.read_json(path, dict)
            if value is not None:
                self.maps[map_id] = value
        for map_id, value in sorted(self.maps.items()):
            item = self.inspect_map(map_id, value)
            if self.selected is None or map_id in self.selected:
                details.append(item)
        self.inspect_transfers()
        report["maps"] = details
        report["tilesets_used"] = list(self.used_tilesets.values())
        report["assets"] = [dict(asset, used_by_maps=sorted(asset["used_by_maps"]),
                                 tileset_ids=sorted(asset["tileset_ids"]))
                            for _, asset in sorted(self.assets.items())]
        report["transfers"] = {
            "direct_total_all_maps": len(self.direct),
            "direct_details": [item for item in self.direct if self.selected is None or item["map_id"] in self.selected],
            "unresolved_command_counts_all_maps": dict(self.unresolved)}
        return self.finish(report)

    def finish(self, report):
        report["issues"] = self.issues
        report["summary"] = {"map_files_discovered": len(self.map_paths), "maps_parsed": len(self.maps),
                             "map_details_shown": len(report.get("maps", [])),
                             "mapinfo_entries": len(self.infos), "tilesets_used": len(self.used_tilesets),
                             "unique_image_references": len(self.assets),
                             "errors": sum(item["severity"] == "error" for item in self.issues),
                             "warnings": sum(item["severity"] == "warning" for item in self.issues)}
        report["status"] = "errors_found" if report["summary"]["errors"] else "no_static_errors_found"
        return report


def positive_cli(value):
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("map IDs must be positive integers")
    if number < 1:
        raise argparse.ArgumentTypeError("map IDs must be positive integers")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project", help="project directory, or MV deployment directory containing www/data")
    parser.add_argument("--maps", type=positive_cli, nargs="+", metavar="ID",
                        help="limit map and direct-transfer details; all maps are still checked")
    args = parser.parse_args()
    try:
        inspector = Inspector(args.project, args.maps)
        try:
            report = inspector.run()
        except (OSError, ValueError, RecursionError) as exc:
            inspector.issue("error", "inspection_io_or_format_error", str(exc))
            report = inspector.finish({"schema_version": 1, "mode": "read_only_static_inventory",
                                       "project_root": str(inspector.root)})
    except (OSError, ValueError, RuntimeError) as exc:
        report = {"schema_version": 1, "mode": "read_only_static_inventory", "status": "errors_found",
                  "summary": {"errors": 1, "warnings": 0},
                  "issues": [{"severity": "error", "code": "invalid_project_path", "message": str(exc)}]}
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 1 if report["summary"]["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
