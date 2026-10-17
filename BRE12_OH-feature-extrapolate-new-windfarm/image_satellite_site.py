#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
image_satellite_site.py
=======================
Image satellite d'un site à partir de (lat, lon), directement utilisable dans une figure matplotlib.

FONCTIONS PRINCIPALES
---------------------
 image_satellite(lat, lon, rayon_km=5.0, source="eox2016", ...) -> dict
        image RGB (H, W, 3, uint8) recadrée sur un carré de 2 x rayon_km autour du point, + métadonnées
        {image, extent_km=(xmin, xmax, ymin, ymax), zoom, resolution_m_px, source, attribution, lat, lon}
 dessiner_satellite(ax, sat, points=None) -> ax
        dessine sur un Axes existant : imshow en km Est/Nord relatifs au site (0,0), repère du site, échelle, attribution.
        Mêmes conventions que les autres panneaux (axes en unités physiques, titre, grille légère) -> se glisse dans la
        figure de courbe_eolien_site.py (option --satellite) ou dans n'importe quelle figure à plusieurs Axes.

GÉOMÉTRIE
---------
 Les tuiles sont en Web Mercator (EPSG:3857) : l'échelle y vaut 1/cos(lat) fois la réalité. Les axes sont donc convertis en km
 réels (x_km = x_mercator x cos(lat) / 1000), avec aspect égal : distances et surfaces lisibles directement sur l'image.

SOURCES (aucune clé requise ; LICENCES À RESPECTER : l'attribution est incluse sur l'image)
------------------------------------------------------------------------------------------
 eox2016  Sentinel-2 cloudless 2016 (EOX), ~10 m/pixel. Licence CC BY 4.0 (d'après le WMTS d'EOX) : la plus permissive.
 eox2024  Sentinel-2 cloudless 2024 (EOX), ~10 m/pixel. Licence CC BY-NC-SA 4.0 : USAGE NON COMMERCIAL.
 esri     Esri World Imagery. Conditions d'utilisation Esri à vérifier pour tout usage hors démonstration ; résolution
          élevée près des côtes, mais souvent faible au large.
 La date des images n'est pas connue précisément (mosaïque annuelle sans nuages) : un parc récent peut ne pas apparaître.
 À 10 m/pixel, les éoliennes individuelles ne sont PAS visibles : l'image sert à situer le site (côte, bathymétrie claire, bateaux, parcs voisins).

CLI : python3 image_satellite_site.py --lat 47.17 --lon -2.58 --rayon-km 8 --out site.png
"""
import argparse
import io
import math
import os
import sys
import time

import numpy as np

TAILLE_TUILE = 256
SOURCES = {
    "eox2016": dict(url="https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg", zmax=14,
                    attribution="Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016) - CC BY 4.0"),
    "eox2024": dict(url="https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg", zmax=14,
                    attribution="Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024) - CC BY-NC-SA 4.0"),
    "esri": dict(url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", zmax=17,
                 attribution="Tiles (c) Esri - Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"),
}
MAX_TUILES = 64  # garde-fou : jamais plus de 64 requêtes par image


class ImageSatelliteErreur(Exception):
    pass


# ------------------------------------------------------------------ géométrie Web Mercator
def lonlat_vers_tuile_flottante(lat, lon, z):
    """Coordonnées de tuile (x, y) flottantes au zoom z (schéma XYZ, origine en haut à gauche)."""
    if not (-85.05112878 <= lat <= 85.05112878):
        raise ImageSatelliteErreur(f"latitude hors Web Mercator : {lat}")
    n = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def metres_par_pixel(lat, z):
    """Taille réelle d'un pixel (m) à la latitude lat, zoom z (tuiles 256 px)."""
    return 40075016.686 * math.cos(math.radians(lat)) / (TAILLE_TUILE * 2.0 ** z)


def choisir_zoom(lat, rayon_km, pixels_cibles=900, zmax=14):
    """Plus petit zoom donnant au moins `pixels_cibles` pixels sur 2 x rayon (plafonné à zmax)."""
    for z in range(0, zmax + 1):
        if 2000.0 * rayon_km / metres_par_pixel(lat, z) >= pixels_cibles:
            return z
    return zmax


# ------------------------------------------------------------------ téléchargement
def _telecharger_tuile(url, cache_path, timeout=30, tentatives=3):
    from PIL import Image
    if cache_path and os.path.exists(cache_path):
        return Image.open(cache_path).convert("RGB")
    import requests
    last = None
    for i in range(tentatives):
        try:
            r = requests.get(url, timeout=timeout, headers={"User-Agent": "courbe-eolien-site/1.0 (usage pédagogique; hackathon)"})
            if r.status_code == 200 and r.content:
                if cache_path:
                    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                    with open(cache_path, "wb") as f:
                        f.write(r.content)
                return Image.open(io.BytesIO(r.content)).convert("RGB")
            last = f"HTTP {r.status_code}"
            if r.status_code in (400, 403, 404):
                break                                  # inutile de réessayer
        except Exception as e:                         # réseau
            last = str(e)
        time.sleep(1.5 * (i + 1))
    raise ImageSatelliteErreur(f"tuile inaccessible ({last}) : {url}")


def image_satellite(lat, lon, rayon_km=5.0, source="eox2016", zoom=None, cache_dir=".cache_tuiles", pause_s=0.05):
    """Image RGB recadrée sur un carré de côté 2 x rayon_km centré sur (lat, lon). Lève ImageSatelliteErreur en cas d'échec."""
    from PIL import Image
    if source not in SOURCES:
        raise ImageSatelliteErreur(f"source inconnue : {source} (choix : {', '.join(SOURCES)})")
    if not (0 < rayon_km <= 500):
        raise ImageSatelliteErreur("rayon_km doit être dans ]0, 500]")
    src = SOURCES[source]
    z = int(zoom) if zoom is not None else choisir_zoom(lat, rayon_km, zmax=src["zmax"])
    mpp = metres_par_pixel(lat, z)
    demi_px = rayon_km * 1000.0 / mpp                       # demi-côté en pixels (réels, corrigés de cos(lat))
    cx, cy = lonlat_vers_tuile_flottante(lat, lon, z)       # centre en unités de tuile
    cxp, cyp = cx * TAILLE_TUILE, cy * TAILLE_TUILE         # centre en pixels de la mosaïque mondiale
    # En Web Mercator, 1 pixel = mpp/cos(lat) mètres Mercator ; la distance réelle (cos(lat) déjà inclus dans mpp) est donc isotrope :
    # un carré réel de côté 2R correspond à un carré de 2*demi_px pixels.
    x0, x1 = cxp - demi_px, cxp + demi_px
    y0, y1 = cyp - demi_px, cyp + demi_px
    n = 2 ** z
    tx0, tx1 = int(math.floor(x0 / TAILLE_TUILE)), int(math.floor((x1 - 1e-9) / TAILLE_TUILE))
    ty0, ty1 = int(math.floor(max(y0, 0) / TAILLE_TUILE)), int(math.floor((min(y1, n * TAILLE_TUILE) - 1e-9) / TAILLE_TUILE))
    nb = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    if nb > MAX_TUILES:
        raise ImageSatelliteErreur(f"{nb} tuiles nécessaires (> {MAX_TUILES}) : réduire rayon_km ou le zoom ({z})")
    mosaique = Image.new("RGB", ((tx1 - tx0 + 1) * TAILLE_TUILE, (ty1 - ty0 + 1) * TAILLE_TUILE))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            url = src["url"].format(z=z, x=tx % n, y=ty)
            cache = os.path.join(cache_dir, source, str(z), str(tx % n), f"{ty}.jpg") if cache_dir else None
            existait = bool(cache and os.path.exists(cache))
            tuile = _telecharger_tuile(url, cache)
            mosaique.paste(tuile, ((tx - tx0) * TAILLE_TUILE, (ty - ty0) * TAILLE_TUILE))
            if not existait:
                time.sleep(pause_s)                  # courtoisie envers le serveur
    boite = (x0 - tx0 * TAILLE_TUILE, y0 - ty0 * TAILLE_TUILE, x1 - tx0 * TAILLE_TUILE, y1 - ty0 * TAILLE_TUILE)
    cote = int(round(2 * demi_px))
    rec = mosaique.crop(tuple(int(round(v)) for v in boite)).resize((cote, cote), Image.LANCZOS)
    return dict(image=np.asarray(rec), extent_km=(-rayon_km, rayon_km, -rayon_km, rayon_km), zoom=z, resolution_m_px=mpp,
                source=source, attribution=src["attribution"], lat=lat, lon=lon, nb_tuiles=nb)


# ------------------------------------------------------------------ matplotlib
def dessiner_satellite(ax, sat, points=None, titre=True, echelle_km=None):
    """Dessine `sat` (sortie de image_satellite) sur l'Axes `ax`. Axes en km réels, Est vers la droite, Nord vers le haut.
    points : liste de (lat, lon, libellé) à superposer (ex. parcs de référence) ; hors du cadre -> ignorés."""
    xmin, xmax, ymin, ymax = sat["extent_km"]
    ax.imshow(sat["image"], extent=(xmin, xmax, ymin, ymax), origin="upper", interpolation="bilinear", zorder=0)
    ax.plot([0], [0], marker="+", ms=18, mew=2.2, color="red", zorder=3)
    ax.plot([0], [0], marker="o", ms=11, mfc="none", mec="red", mew=1.6, zorder=3)
    lat0, lon0 = sat["lat"], sat["lon"]
    for (la, lo, nom) in (points or []):
        x = (lo - lon0) * 111.320 * math.cos(math.radians(lat0))      # approximation locale (km), précise à quelques mètres sur 200 km
        y = (la - lat0) * 110.574
        if xmin <= x <= xmax and ymin <= y <= ymax:
            ax.plot([x], [y], marker="s", ms=7, mfc="yellow", mec="k", zorder=3)
            ax.annotate(nom, (x, y), xytext=(5, 5), textcoords="offset points", fontsize=7, color="white",
                        bbox=dict(boxstyle="round,pad=0.15", fc="black", alpha=0.55, lw=0), zorder=4)
    L = echelle_km or _echelle_ronde((xmax - xmin) / 5)
    bx, by = xmin + 0.05 * (xmax - xmin), ymin + 0.06 * (ymax - ymin)
    ax.plot([bx, bx + L], [by, by], color="white", lw=3, solid_capstyle="butt", zorder=4)
    ax.plot([bx, bx + L], [by, by], color="k", lw=1, solid_capstyle="butt", zorder=5)
    ax.text(bx + L / 2, by + 0.015 * (ymax - ymin), f"{L:g} km", color="white", ha="center", fontsize=8, zorder=5,
            bbox=dict(boxstyle="round,pad=0.1", fc="black", alpha=0.5, lw=0))
    ax.text(xmax - 0.02 * (xmax - xmin), ymin + 0.02 * (ymax - ymin), "(c) " + sat["attribution"], color="white", fontsize=4.2, ha="right",
            va="bottom", zorder=5, bbox=dict(boxstyle="square,pad=0.15", fc="black", alpha=0.5, lw=0), wrap=True)
    ax.set_xlim(xmin, xmax); ax.set_ylim(ymin, ymax); ax.set_aspect("equal")
    ax.set_xlabel("Est (km) depuis le site"); ax.set_ylabel("Nord (km) depuis le site"); ax.grid(alpha=.25, color="white")
    if titre:
        ax.set_title(f"Vue satellite ({sat['lat']:.3f}°N, {sat['lon']:.3f}°E)\nrayon {xmax:g} km - {sat['resolution_m_px']:.0f} m/pixel (zoom {sat['zoom']})")
    return ax


def _echelle_ronde(cible_km):
    for v in (0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100):
        if v >= cible_km:
            return v
    return 100


# ------------------------------------------------------------------ auto-test (tuiles synthétiques, aucun réseau)
def selftest():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image
    # 1. tuile (0, 0) au zoom 1 : (lat 0, lon 0) = coin commun des 4 tuiles
    x, y = lonlat_vers_tuile_flottante(0.0, 0.0, 1)
    assert abs(x - 1.0) < 1e-12 and abs(y - 1.0) < 1e-12, (x, y)
    x, y = lonlat_vers_tuile_flottante(0.0, -180.0, 3)
    assert abs(x) < 1e-12 and abs(y - 4.0) < 1e-12
    # 2. échelle : à l'équateur, zoom 0 : 40 075 016,686 / 256 m/px ; à 60 degrés, moitié
    assert abs(metres_par_pixel(0, 0) - 156543.03392) < 1e-3
    assert abs(metres_par_pixel(60, 5) / metres_par_pixel(0, 5) - 0.5) < 1e-9
    # 3. une « mosaïque » synthétique : couleur = f(position dans le monde) pour vérifier le recadrage
    def faux(url, cache_path, **k):
        import re
        z, tx, ty = (int(v) for v in re.search(r"/(\d+)/(\d+)/(\d+)", url.replace(".jpg", "")).groups())  # .../g/{z}/{y}/{x} -> z, y, x
        ty, tx = tx, ty
        a = np.zeros((TAILLE_TUILE, TAILLE_TUILE, 3), np.uint8)
        a[..., 0] = (tx * 40) % 256; a[..., 1] = (ty * 40) % 256
        return Image.fromarray(a)
    global _telecharger_tuile
    reel, _telecharger_tuile = _telecharger_tuile, faux
    try:
        R = 5.0
        lat, lon = 48.4, -4.5
        for dlat in np.arange(0, 0.02, 0.0005):          # centre loin d'une frontière de tuile (sinon le rééchantillonnage mélange deux tuiles)
            for dlon in np.arange(0, 0.02, 0.0005):
                fx, fy = (v % 1 for v in lonlat_vers_tuile_flottante(lat + dlat, lon + dlon, choisir_zoom(lat, R, zmax=14)))
                if 0.3 < fx < 0.7 and 0.3 < fy < 0.7:
                    break
            else:
                continue
            lat, lon = lat + dlat, lon + dlon
            break
        sat = image_satellite(lat, lon, R, "eox2016", cache_dir=None, pause_s=0)
    finally:
        _telecharger_tuile = reel
    im = sat["image"]
    assert im.ndim == 3 and im.shape[2] == 3 and im.shape[0] == im.shape[1], im.shape
    assert sat["extent_km"] == (-R, R, -R, R)
    # taille : 2R / mpp pixels
    assert abs(im.shape[0] - 2000 * R / sat["resolution_m_px"]) <= 1
    # le pixel central doit venir de la tuile qui contient le centre
    z = sat["zoom"]; cx, cy = lonlat_vers_tuile_flottante(lat, lon, z)
    h = im.shape[0] // 2
    assert im[h, h, 0] == (int(cx) * 40) % 256 and im[h, h, 1] == (int(cy) * 40) % 256, (im[h, h], cx, cy)
    # 4. dessin compatible avec une figure à plusieurs panneaux
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    axes[0].plot([0, 1], [0, 1]); axes[1].hist(np.random.default_rng(0).normal(size=100))
    dessiner_satellite(axes[2], sat, points=[(lat + 0.02, lon + 0.03, "parc test")])
    assert abs(axes[2].get_xlim()[0] + R) < 1e-9 and axes[2].get_aspect() == 1.0
    fig.savefig("/tmp/selftest_satellite.png", dpi=100); plt.close(fig)
    print("Auto-test OK (géométrie + recadrage + tracé ; tuiles SYNTHÉTIQUES, aucun accès réseau).")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float); ap.add_argument("--lon", type=float)
    ap.add_argument("--rayon-km", type=float, default=5.0); ap.add_argument("--source", default="eox2016", choices=list(SOURCES))
    ap.add_argument("--zoom", type=int); ap.add_argument("--cache", default=".cache_tuiles")
    ap.add_argument("--out", default="satellite_site.png"); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.lat is None or a.lon is None:
        raise ImageSatelliteErreur("--lat et --lon sont obligatoires")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    sat = image_satellite(a.lat, a.lon, a.rayon_km, a.source, a.zoom, a.cache)
    fig, ax = plt.subplots(figsize=(7, 7))
    dessiner_satellite(ax, sat)
    fig.tight_layout(); fig.savefig(a.out, dpi=150)
    print(f"{a.out} : {sat['image'].shape[1]}x{sat['image'].shape[0]} px, zoom {sat['zoom']}, {sat['resolution_m_px']:.1f} m/px, "
          f"{sat['nb_tuiles']} tuiles, source {a.source}\n(c) {sat['attribution']}")


if __name__ == "__main__":
    try:
        main()
    except ImageSatelliteErreur as e:
        print(f"IMAGE SATELLITE IMPOSSIBLE : {e}", file=sys.stderr); sys.exit(2)
