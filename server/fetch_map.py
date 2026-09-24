"""从天地图下载目标点周边最新影像，拼接后供本地孪生界面离线使用。

凭据通过 TIANDITU_KEY 环境变量传入，不写进源码或前端。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import math
import os
import sys
from pathlib import Path

import requests
from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parents[1]
SITE_FILE = ROOT / "server" / "assets" / "site.json"
OUT_DIR = ROOT / "web" / "assets" / "maps"
R = 6378137.0
WORLD = math.pi * R
TILE_SIZE = 256
RES0 = 2 * WORLD / TILE_SIZE
UA = {"User-Agent": "ZhicuiDigitalTwin/0.1 map-bootstrap"}


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    x = R * math.radians(lon)
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def merc_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / R)
    lat = math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    return lon, lat


def is_placeholder(image: Image.Image) -> bool:
    stat = ImageStat.Stat(image.convert("RGB"))
    return max(stat.stddev) < 8.5


def get_tile(layer: str, z: int, x: int, y: int, key: str) -> Image.Image:
    last_error: Exception | None = None
    for attempt in range(3):
        subdomain = (x + y + attempt) % 8
        url = f"https://t{subdomain}.tianditu.gov.cn/{layer}_w/wmts"
        params = {
            "SERVICE": "WMTS", "REQUEST": "GetTile", "VERSION": "1.0.0",
            "LAYER": layer, "STYLE": "default", "TILEMATRIXSET": "w",
            "FORMAT": "tiles", "TILECOL": x, "TILEROW": y,
            "TILEMATRIX": z, "tk": key,
        }
        try:
            response = requests.get(url, params=params, headers=UA, timeout=25)
            response.raise_for_status()
            image = Image.open(io.BytesIO(response.content)).convert("RGBA")
            if image.size != (TILE_SIZE, TILE_SIZE):
                raise ValueError(f"tile 尺寸异常: {image.size}")
            if layer == "img" and is_placeholder(image):
                raise ValueError("天地图返回占位影像瓦片")
            return image
        except Exception as exc:  # 重试其它子域，最终返回明确失败原因
            last_error = exc
    raise RuntimeError(f"{layer} tile z{z}/{x}/{y} 获取失败: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zoom", type=int, default=18)
    parser.add_argument("--extent", type=float, default=800, help="地面覆盖范围（米，正方形）")
    args = parser.parse_args()
    if not 1 <= args.zoom <= 19 or args.extent < 200:
        raise SystemExit("zoom 应为 1–19，extent 不应小于 200 米")
    key = os.environ.get("TIANDITU_KEY", "").strip()
    if not key:
        raise SystemExit("请通过 TIANDITU_KEY 环境变量提供天地图 Key")

    site = json.loads(SITE_FILE.read_text(encoding="utf-8"))
    lon, lat = site["center"]["longitude"], site["center"]["latitude"]
    anchor_x, anchor_y = lonlat_to_merc(lon, lat)
    offset_east, offset_north = site.get("mapCenterOffsetMeters", [0, 0])
    map_cx = anchor_x + float(offset_east) / math.cos(math.radians(lat))
    map_cy = anchor_y + float(offset_north) / math.cos(math.radians(lat))
    half = args.extent / (2 * math.cos(math.radians(lat)))
    min_x, max_x, min_y, max_y = map_cx - half, map_cx + half, map_cy - half, map_cy + half
    res = RES0 / (2 ** args.zoom)
    px0 = math.floor((min_x + WORLD) / res)
    px1 = math.ceil((max_x + WORLD) / res)
    py0 = math.floor((WORLD - max_y) / res)
    py1 = math.ceil((WORLD - min_y) / res)
    tx0, ty0 = px0 // TILE_SIZE, py0 // TILE_SIZE
    tx1, ty1 = (px1 - 1) // TILE_SIZE, (py1 - 1) // TILE_SIZE
    coords = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    print(f"新影像抓取：中心 ({lon:.6f}, {lat:.6f})，范围 {args.extent:.0f}m，z{args.zoom}，共 {len(coords)} 张")

    tiles: dict[tuple[int, int], Image.Image] = {}
    failures: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(get_tile, "img", args.zoom, x, y, key): (x, y)
            for x, y in coords
        }
        for future in concurrent.futures.as_completed(futures):
            coord = futures[future]
            try:
                tiles[coord] = future.result()
            except Exception as exc:
                failures.append(str(exc))
    if failures:
        raise SystemExit("底图影像不完整：\n" + "\n".join(failures[:8]))

    mosaic = Image.new("RGBA", ((tx1 - tx0 + 1) * TILE_SIZE, (ty1 - ty0 + 1) * TILE_SIZE))
    for (x, y), tile in tiles.items():
        mosaic.alpha_composite(tile, ((x - tx0) * TILE_SIZE, (y - ty0) * TILE_SIZE))

    left = round(px0 - tx0 * TILE_SIZE)
    top = round(py0 - ty0 * TILE_SIZE)
    right = round(px1 - tx0 * TILE_SIZE)
    bottom = round(py1 - ty0 * TILE_SIZE)
    image = mosaic.crop((left, top, right, bottom)).convert("RGB")

    # 叠加天地图注记；注记层有透明背景，失败时影像仍可正常使用。
    labels: dict[tuple[int, int], Image.Image] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(get_tile, "cva", args.zoom, x, y, key): (x, y) for x, y in coords}
        for future in concurrent.futures.as_completed(futures):
            try:
                labels[futures[future]] = future.result()
            except Exception:
                pass
    if len(labels) == len(coords):
        label_mosaic = Image.new("RGBA", mosaic.size)
        for (x, y), tile in labels.items():
            label_mosaic.alpha_composite(tile, ((x - tx0) * TILE_SIZE, (y - ty0) * TILE_SIZE))
        label_crop = label_mosaic.crop((left, top, right, bottom))
        image = Image.alpha_composite(image.convert("RGBA"), label_crop).convert("RGB")

    # 从裁剪像素边界反算图像实际覆盖的 EPSG:3857 / WGS84 范围。
    west_x = (tx0 * TILE_SIZE + left) * res - WORLD
    east_x = (tx0 * TILE_SIZE + right) * res - WORLD
    north_y = WORLD - (ty0 * TILE_SIZE + top) * res
    south_y = WORLD - (ty0 * TILE_SIZE + bottom) * res
    west, north = merc_to_lonlat(west_x, north_y)
    east, south = merc_to_lonlat(east_x, south_y)
    map_lon, map_lat = merc_to_lonlat(map_cx, map_cy)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_image = OUT_DIR / "site.png"
    out_meta = OUT_DIR / "site.json"
    image.save(out_image, optimize=True)
    meta = {
        "provider": "天地图 WMTS img_w + cva_w",
        "zoom": args.zoom,
        "image": "site.png",
        "anchor": {"longitude": lon, "latitude": lat, "crs": "WGS84"},
        "rasterCenter": {"longitude": map_lon, "latitude": map_lat, "crs": "WGS84"},
        "centerOffsetMeters": [float(offset_east), float(offset_north)],
        "bbox": {"west": west, "south": south, "east": east, "north": north, "crs": "WGS84"},
        "mercatorBoundsMeters": {"west": west_x, "south": south_y, "east": east_x, "north": north_y},
        "sizePx": list(image.size),
        "resolutionProjectedMetersPerPixel": res,
        "requestedExtentGroundMeters": args.extent,
        "tileCount": len(coords),
        "labelsIncluded": len(labels) == len(coords),
        "attribution": "天地图",
    }
    out_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写入 {out_image} ({image.width}×{image.height}) 与 {out_meta}")


if __name__ == "__main__":
    main()
