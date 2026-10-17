#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
courbe_eolien_site.py
=====================
Entrée : un point GPS, un nombre d'éoliennes, une puissance par éolienne.
Sortie : courbe puissance = f(vent à 100 m), facteur de charge, disponibilité, série horaire, graphique PNG.
Le graphique inclut aussi une vue satellite centrée sur le site, de rayon fixe 200 km.

MÉTHODE
-------
 1. Vent à 100 m (= hauteur de moyeu supposée) : Open-Meteo archive, modèle ERA5, m/s, UTC, au point GPS.
 2. Pour chaque parc de référence (farms_reference.json) : vent horaire lu dans data/<nom>_hourly_data.csv
    (nom ou colonne du JSON) croisé avec sa production horaire réelle ÷ sa puissance installée (= CF).
    [v2] Le vent ERA5 est instantané à l'heure pile alors que la production est une moyenne sur l'heure : on utilise
    le vent moyen 0,5 x (v(t) + v(t+1 h)) (corrélation de rang meilleure sur les 4 parcs).
    [v2] Seules les heures « en régime établi » servent à construire la courbe : on exclut la montée en puissance
    de chaque parc (capacité en service < capacité nominale -> CF sous-estimé). Fin de montée = 1er mois d'une série
    de >= 2 mois où le 3e quartile du CF aux heures à vent >= 12 m/s dépasse --seuil-regime (défaut 0,9).
 3. Courbe « en fonctionnement » : médiane de CF par tranche de vent de 0,5 m/s (robuste aux arrêts, tant qu'ils
    sont < 50 % des heures d'une tranche). Courbe retenue = moyenne des parcs pondérée par le nombre d'heures ;
    l'écart min-max entre parcs est tracé comme incertitude.
 4. Disponibilité (deux indicateurs apparents, pas une disponibilité technique mesurée) :
      A_temps  = 1 - part des heures à vent >= --v-ok où la production est < --seuil-arret x Pnom  (arrêts francs)
      facteur de calibration énergétique = somme(production réelle) / somme(courbe(vent ERA5))
                  sur les parcs de référence (peut dépasser 100 %)
 5. Site : puissance_brute(t) = n x P_unitaire x courbe(vent_site(t)) ; nette = brute x facteur de calibration énergétique.
    FC_brut / FC_net = énergie moyenne / (n x P_unitaire).
 6. VALIDATION « un parc laissé de côté » : courbe et A apprises sur les autres, prédiction du parc retiré,
    comparaison avec son FC observé. C'est le seul indicateur de la qualité du modèle : à regarder avant de croire un résultat.
 7. Le rapport donne la couverture horaire de production et la sensibilité aux références retirées une à une.
    Hors de la plage de vent suffisamment documentée, la courbe est extrapolée ; à vent fort, le plateau
    est une hypothèse et non un modèle d'arrêt tempête.

LIMITES (ne pas les oublier)
----------------------------
 L1  ERA5 : maille ~31 km, biais connus en mer ; erreur horaire de plusieurs m/s possible. Le FC peut être faussé de plusieurs points.
 L2  La courbe vient de turbines de 6 à 8 MW. Pour une machine très différente (15 MW+, autre puissance
     spécifique W/m²), la forme de la courbe change : le script avertit si P_unitaire sort de la plage des références.
 L3  Les pertes de sillage dépendent de l'implantation (inconnue). Celles des parcs de référence sont implicitement
     incluses dans la courbe. Aucune correction de densité de parc.
 L4  Le facteur de calibration énergétique absorbe arrêts et biais ; il ne constitue pas une mesure de disponibilité technique.
 L5  Production de référence : on ignore si elle contient des bridages (fichier « within_constraint ») ; ils sont alors
     dans A_energie.
 L6  Open-Meteo gratuit : usage non commercial, limites d'appels ; attribution requise. À vérifier pour un usage commercial.
 L6b [v2] La courbe est E[CF | vent ERA5] : elle est lissée par l'erreur du vent ERA5 (ce n'est PAS la courbe constructeur)
     et n'est valable qu'avec un vent du MÊME produit (ERA5 100 m via Open-Meteo, mêmes paramètres que les fichiers de
     référence : --model doit correspondre à celui utilisé pour télécharger data/*_hourly_data.csv ; défaut = aucun).
 L7  [v2] Hauteur de moyeu : les parcs de référence ont des moyeux d'environ 100 m ; pour des éoliennes plus grandes
     (moyeu 130-150 m) le vent ERA5 à 100 m sous-estime le vent au moyeu (cisaillement) -> FC sous-estimé de l'ordre de
     1 à 2 points. Non corrigé (aucune donnée pour le faire sans inventer).
 L8  [v2] Biais propres à chaque parc (±4 points de FC mesurés en validation) : ERA5 + turbine + site. C'est l'incertitude
     réaliste à retenir sur le FC d'un nouveau site, pas la précision apparente des chiffres.
 L9  [v3] Image satellite : à 200 km de rayon, ~400 m/pixel -> on situe le site (côtes, parcs voisins), on ne voit pas les
     éoliennes. Mosaïque annuelle sans nuages : un parc récent peut être absent. Licences : voir la section « image satellite ».
 

USAGE
-----
 python3 courbe_eolien_site.py --lat 48.5 --lon -4.9 --n 60 --mw 15 \\
         --farms farms_reference.json
 options : --seuil-regime (0 = désactiver) --data-dir (défaut data) --start/--end (climatologie du site, défaut 2016-2025)
           --outdir --v-ok --seuil-arret --min-heures --model
           --rayon-km (satellite, défaut 200) --source-sat --sans-satellite --cache-tuiles
  Production de référence : data/production_offshore_farms_within_constraint.csv
"""
import argparse
import glob
import hashlib
import json
import os
import io
import math
import sys
import tempfile
import time
import unicodedata

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

EDGES = np.arange(0.0, 30.5, 0.5)
CENTERS = EDGES[:-1] + 0.25
URL = "https://archive-api.open-meteo.com/v1/archive"
RAYON_SATELLITE_KM = 200
PRODUCTION_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "data",
    "production_offshore_farms_within_constraint.csv",
)


class DonneeManquante(Exception):
    pass


# ================================================================== image satellite (ex image_satellite_site.py)
# Image satellite d'un site à partir de (lat, lon), utilisable dans une figure matplotlib.
#   image_satellite(lat, lon, rayon_km, source, ...) -> dict(image RGB, extent_km, zoom, resolution_m_px, source, attribution, ...)
#   dessiner_satellite(ax, sat, points=None)         -> dessine sur un Axes existant (km Est/Nord depuis le site, échelle, attribution)
# Géométrie : tuiles Web Mercator (EPSG:3857), échelle 1/cos(lat) -> axes convertis en km réels (x_km = x_merc x cos(lat) / 1000).
# SOURCES (aucune clé ; LICENCES À RESPECTER, l'attribution est incluse sur l'image) :
#   eox2016  Sentinel-2 cloudless 2016 (EOX), CC BY 4.0 (la plus permissive)
#   eox2024  Sentinel-2 cloudless 2024 (EOX), CC BY-NC-SA 4.0 : USAGE NON COMMERCIAL
#   esri     Esri World Imagery : conditions d'utilisation à vérifier hors démonstration
# La date des images n'est pas connue précisément (mosaïque annuelle) ; à 10 m/pixel les éoliennes ne sont pas visibles.
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
    ax.set_xlabel("East (km from site)"); ax.set_ylabel("North (km from site)"); ax.grid(alpha=.25, color="white")
    if titre:
        ax.set_title(f"Satellite view ({sat['lat']:.3f}°N, {sat['lon']:.3f}°E)\nradius {xmax:g} km - {sat['resolution_m_px']:.0f} m/pixel (zoom {sat['zoom']})")
    return ax


def _echelle_ronde(cible_km):
    for v in (0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100):
        if v >= cible_km:
            return v
    return 100


# ------------------------------------------------------------------ auto-test (tuiles synthétiques, aucun réseau)
def _selftest_satellite():
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
    fig.savefig(os.path.join(tempfile.gettempdir(), "selftest_satellite.png"), dpi=100); plt.close(fig)
    print("Auto-test OK (géométrie + recadrage + tracé ; tuiles SYNTHÉTIQUES, aucun accès réseau).")



# ------------------------------------------------------------------ données
def charger_parcs(path):
    """farms_reference.json : liste d'objets {name, lat, lon, n_turbines, mw_per_turbine, column}. Aucune valeur par défaut."""
    with open(path, encoding="utf-8") as f:
        parcs = json.load(f)
    manques = []
    for p in parcs:
        for c in ("name", "lat", "lon", "n_turbines", "mw_per_turbine", "column"):
            if p.get(c) is None:
                manques.append(f"{p.get('name', '?')}.{c}")
    if manques:
        raise DonneeManquante("farms_reference.json incomplet (rien n'est inventé) : " + ", ".join(manques))
    for p in parcs:
        p["pnom_mw"] = p["n_turbines"] * p["mw_per_turbine"]
    return parcs


def telecharger_vent(lat, lon, start, end, cache_dir, model="era5"):
    """Vent à 100 m (m/s) horaire UTC. Cache disque par (lat, lon, période, modèle)."""
    os.makedirs(cache_dir, exist_ok=True)
    cle = hashlib.md5(f"{lat:.4f}|{lon:.4f}|{start}|{end}|{model}".encode()).hexdigest()[:12]
    f = os.path.join(cache_dir, f"vent100_{cle}.csv")
    if os.path.exists(f):
        s = pd.read_csv(f, index_col=0, parse_dates=True)["v100"]
        s.index = pd.DatetimeIndex(s.index).tz_convert("UTC") if s.index.tz else pd.DatetimeIndex(s.index).tz_localize("UTC")
        return s
    try:
        import openmeteo_requests
        import requests_cache
        from retry_requests import retry
    except ImportError as e:
        raise DonneeManquante(f"dépendance météo manquante : {e}") from e
    sess = retry(requests_cache.CachedSession(os.path.join(cache_dir, ".http"), expire_after=-1), retries=5, backoff_factor=0.2)
    client = openmeteo_requests.Client(session=sess)
    params = dict(latitude=lat, longitude=lon, start_date=start, end_date=end, hourly=["wind_speed_100m"],
                  wind_speed_unit="ms", timezone="UTC")
    if model:
        params["models"] = model
    try:
        r = client.weather_api(URL, params=params)[0]
    except Exception as e:  # la valeur du paramètre « models » n'a pas pu être vérifiée
        if not model:
            raise
        print(f"  [avertissement] requête avec models={model} refusée ({e}); nouvel essai sans 'models'", file=sys.stderr)
        params.pop("models")
        r = client.weather_api(URL, params=params)[0]
    h = r.Hourly()
    idx = pd.date_range(start=pd.to_datetime(h.Time(), unit="s", utc=True), end=pd.to_datetime(h.TimeEnd(), unit="s", utc=True),
                        freq=pd.Timedelta(seconds=h.Interval()), inclusive="left")
    s = pd.Series(h.Variables(0).ValuesAsNumpy(), index=idx, name="v100").astype(float)
    print(f"  Open-Meteo : demandé ({lat:.4f}, {lon:.4f}) -> grille ({r.Latitude():.3f}, {r.Longitude():.3f}), "
          f"altitude {r.Elevation():.0f} m, {len(s)} h", file=sys.stderr)
    s.to_frame().to_csv(f)
    return s


def charger_production(path, parcs):
    df = pd.read_csv(path, sep=None, engine="python")
    tcol = next((c for c in ("timestamp_utc", "timestamp") if c in df.columns), None)
    if tcol is None:
        raise DonneeManquante("colonne temporelle absente (timestamp ou timestamp_utc)")
    df[tcol] = pd.to_datetime(df[tcol], utc=True)
    df = df.set_index(tcol).sort_index()
    out = {}
    for p in parcs:
        if p["column"] not in df.columns:
            raise DonneeManquante(f"colonne de production absente : {p['column']}")
        x = df[p["column"]].astype(float).clip(lower=0.0)       # valeurs < 0 = auxiliaires -> 0
        out[p["name"]] = x.resample("1h").mean() / p["pnom_mw"]  # CF horaire ; trous = NaN
    return out


def _normaliser_nom_fichier(nom):
    return "".join(
        c for c in unicodedata.normalize("NFKD", nom)
        .encode("ascii", "ignore").decode("ascii").casefold()
        if c.isalnum()
    )


def charger_vents_parcs(data_dir, parcs):
    """Charge le vent des CSV horaires locaux, en associant les fichiers aux noms du JSON."""
    fichiers = glob.glob(os.path.join(data_dir, "*_hourly_data.csv"))
    index_fichiers = {
        _normaliser_nom_fichier(os.path.basename(f)[:-len("_hourly_data.csv")]): f
        for f in fichiers
    }
    vents = {}
    for parc in parcs:
        noms = (parc["name"], parc["column"])
        cles = {_normaliser_nom_fichier(nom) for nom in noms}
        correspondances = {index_fichiers[cle] for cle in cles if cle in index_fichiers}
        if not correspondances:
            suffixes = {
                _normaliser_nom_fichier(nom.rsplit("-", 1)[-1])
                for nom in noms if "-" in nom
            }
            correspondances = {index_fichiers[cle] for cle in suffixes if cle in index_fichiers}
        if len(correspondances) != 1:
            disponibles = ", ".join(os.path.basename(f) for f in fichiers) or "aucun fichier trouvé"
            raise DonneeManquante(
                f"fichier horaire du parc {parc['name']} introuvable ou ambigu dans {data_dir} "
                f"({disponibles})"
            )

        path = correspondances.pop()
        df = pd.read_csv(path)
        df.columns = df.columns.str.strip()
        tcol = next((c for c in ("date", "timestamp_utc", "timestamp") if c in df.columns), None)
        vcol = next((c for c in ("hourly_wind_speed_100m", "wind_speed_100m") if c in df.columns), None)
        if tcol is None or vcol is None:
            raise DonneeManquante(
                f"{path} doit contenir une colonne date (date, timestamp ou timestamp_utc) "
                "et une colonne hourly_wind_speed_100m"
            )
        index = pd.to_datetime(df[tcol], utc=True, errors="coerce")
        if index.isna().any():
            raise DonneeManquante(f"dates invalides dans {path}")
        vitesse = pd.to_numeric(df[vcol], errors="coerce") / 3.6
        serie = pd.Series(vitesse.to_numpy(), index=pd.DatetimeIndex(index), name="v100").sort_index()
        if serie.index.has_duplicates:
            raise DonneeManquante(f"horodatages en double dans {path}")
        vents[parc["name"]] = serie
    return vents


def diagnostiquer_couverture(cfs, vents):
    """Retourne la couverture horaire par parc, les lacunes et la couverture annuelle."""
    lignes = []
    lignes_annuelles = []
    for nom, vent in vents.items():
        production = cfs[nom].reindex(vent.index)
        manquant = production.isna()
        expected = len(vent)
        present = int((~manquant).sum())

        groupes = manquant.ne(manquant.shift(fill_value=False)).cumsum()
        lacunes = []
        for _, groupe in manquant.groupby(groupes):
            if groupe.iloc[0]:
                debut = groupe.index[0]
                fin = groupe.index[-1] + pd.Timedelta(hours=1)
                lacunes.append((len(groupe), debut, fin))
        principales = sorted(lacunes, reverse=True)[:3]
        lacunes_txt = "; ".join(
            f"{debut:%Y-%m-%d %H:%M}–{fin:%Y-%m-%d %H:%M} ({heures} hours)"
            for heures, debut, fin in principales
        ) or "aucune"

        lignes.append({
            "parc": nom,
            "heures_vent": expected,
            "heures_production": present,
            "heures_manquantes": expected - present,
            "couverture_pct": 100 * present / expected if expected else float("nan"),
            "nb_periodes_manquantes": len(lacunes),
            "plus_longue_lacune_h": max((g[0] for g in lacunes), default=0),
            "principales_lacunes": lacunes_txt,
        })

        annee = pd.Series((~manquant).to_numpy(), index=vent.index).groupby(vent.index.year)
        for an, disponibles in annee:
            nb_attendu = len(disponibles)
            nb_present = int(disponibles.sum())
            lignes_annuelles.append({
                "parc": nom,
                "annee": an,
                "heures_production": nb_present,
                "heures_vent": nb_attendu,
                "couverture_pct": 100 * nb_present / nb_attendu if nb_attendu else float("nan"),
            })
    return pd.DataFrame(lignes), pd.DataFrame(lignes_annuelles)


# ------------------------------------------------------------------ calcul
def apparier(cf, vent, lag_h=0):
    """production(t) <-> vent(t + lag_h). Heures sans l'un ou l'autre écartées."""
    w = vent.copy()
    w.index = w.index - pd.Timedelta(hours=lag_h)
    d = pd.concat([cf.rename("cf"), w.rename("v")], axis=1, join="inner").dropna()
    return d


def vent_moyen_heure(v):
    """Vent moyen sur l'heure [t, t+1h] ~ 0,5 x (v(t) + v(t+1h)) ; l'heure est écartée si v(t+1h) manque."""
    suivant = v.copy()
    suivant.index = suivant.index - pd.Timedelta(hours=1)           # suivant[t] = v(t+1h)
    return (0.5 * (v + suivant.reindex(v.index))).dropna().rename(v.name)


def fin_montee_en_puissance(d, seuil=0.9, vmin_ref=12.0, nmin_heures=10, nb_mois=2):
    """Début du régime établi : 1er mois d'une série de nb_mois mois observés consécutifs où le 3e quartile du CF aux
    heures à vent >= vmin_ref atteint seuil. Renvoie (date_debut_UTC ou None, indicateur mensuel)."""
    h = d[d["v"] >= vmin_ref]
    mois = h.index.tz_convert("UTC").tz_localize(None).to_period("M")
    g = h["cf"].groupby(mois)
    ind = g.quantile(0.75)[g.count() >= nmin_heures]
    ok = (ind >= seuil).to_numpy(); m = list(ind.index)
    for i in range(len(m) - nb_mois + 1):
        if ok[i:i + nb_mois].all():
            return m[i].start_time.tz_localize("UTC"), ind
    return None, ind


def fenetres_regime(paires, seuil):
    """Restreint chaque parc à son régime établi. seuil <= 0 : aucune restriction. Renvoie (fenetres, tableau d'info)."""
    out, rows = {}, []
    for k, d in paires.items():
        if seuil <= 0:
            t = d.index.min()
        else:
            t, _ = fin_montee_en_puissance(d, seuil)
        w = d[d.index >= t] if t is not None else d.iloc[0:0]
        if len(w):
            out[k] = w
        rows.append(dict(parc=k, debut_regime_etabli=(f"{t:%Y-%m-%d}" if t is not None else "jamais atteint"),
                         heures_utilisees=len(w), heures_totales=len(d),
                         part_utilisee_pct=100 * len(w) / len(d) if len(d) else float("nan")))
    return out, pd.DataFrame(rows)


def meilleur_decalage(cfs, vents, plage=range(-3, 4)):
    res = {}
    for L in plage:
        cs = [apparier(cfs[k], vents[k], L).corr(method="spearman").iloc[0, 1] for k in cfs]
        res[L] = float(np.mean(cs))
    return max(res, key=res.get), res


def courbe_parc(d, min_heures):
    b = np.digitize(d["v"].to_numpy(), EDGES) - 1
    n = np.zeros(len(CENTERS)); med = np.full(len(CENTERS), np.nan)
    for i in range(len(CENTERS)):
        x = d["cf"].to_numpy()[b == i]
        n[i] = len(x)
        if len(x) >= min_heures:
            med[i] = np.median(x)
    return n, med


def combiner(courbes):
    """courbes : liste de (n, med). Moyenne pondérée par n ; renvoie (courbe lissée, n total, min, max, nb_bins_valides)."""
    N = np.array([c[0] for c in courbes]); M = np.array([c[1] for c in courbes])
    w = np.where(np.isnan(M), 0.0, N)
    tot = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        moy = np.nansum(np.where(np.isnan(M), 0.0, M) * w, axis=0) / tot
    moy[tot == 0] = np.nan
    ok = ~np.isnan(moy)
    if ok.sum() < 5:
        raise DonneeManquante("trop peu de tranches de vent renseignées pour construire la courbe")
    fi, la = np.where(ok)[0][[0, -1]]
    full = np.interp(CENTERS, CENTERS[ok], moy[ok])
    # [v2] sous la 1re tranche valide : np.interp prolonge la 1re valeur (l'ancienne ligne forçait une valeur non nulle si 1re tranche > 4 m/s)
    full[la + 1:] = full[la]                                  # au-delà de la dernière tranche valide : plateau (signalé)
    lisse = pd.Series(full).rolling(3, center=True, min_periods=1).mean().clip(0, 1).to_numpy()
    import warnings
    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore")
        mn, mx = np.nanmin(np.where(np.isnan(M), np.nan, M), axis=0), np.nanmax(np.where(np.isnan(M), np.nan, M), axis=0)
    mn = np.where(np.isnan(mn), lisse, mn); mx = np.where(np.isnan(mx), lisse, mx)
    return lisse, tot, mn, mx, CENTERS[la]


def predire(v, courbe):
    return np.interp(v, CENTERS, courbe)


def disponibilites(d, courbe, v_ok, seuil_arret):
    sel = d[(d["v"] >= v_ok) & (d["v"] <= 25.0)]
    a_t = 1.0 - float((sel["cf"] < seuil_arret).mean()) if len(sel) else float("nan")
    pred = predire(d["v"].to_numpy(), courbe)
    a_e = float(d["cf"].sum() / pred.sum()) if pred.sum() > 0 else float("nan")
    return a_t, a_e


def calibrer_energie(paires, courbe):
    production_observee = sum(d["cf"].sum() for d in paires.values())
    production_predite = sum(predire(d["v"].to_numpy(), courbe).sum() for d in paires.values())
    if production_predite <= 0:
        raise DonneeManquante("impossible de calculer le facteur de calibration énergétique")
    return float(production_observee / production_predite)


def validation(paires, min_heures, v_ok, seuil_arret):
    """Un parc laissé de côté à la fois."""
    rows = []
    for k in paires:
        autres = [x for x in paires if x != k]
        if not autres:
            break
        courbe, *_ = combiner([courbe_parc(paires[x], min_heures) for x in autres])
        a_e = calibrer_energie({x: paires[x] for x in autres}, courbe)
        d = paires[k]; pred = predire(d["v"].to_numpy(), courbe) * a_e
        obs_fc, pre_fc = float(d["cf"].mean()), float(pred.mean())
        rows.append(dict(parc=k, heures=len(d), FC_observe=obs_fc, FC_predit=pre_fc, biais_points=100 * (pre_fc - obs_fc),
                         correlation_horaire=float(np.corrcoef(d["cf"], pred)[0, 1]),
                         RMSE_horaire_pct_Pnom=100 * float(np.sqrt(np.mean((d["cf"] - pred) ** 2)))))
    return pd.DataFrame(rows)


def sensibilite_references(paires, vent_site, min_heures, fc_net_complet):
    """Réentraîne la courbe en retirant chaque ferme, puis mesure l'effet sur le FC net du site."""
    rows = []
    for retire in paires:
        apprentissage = {nom: d for nom, d in paires.items() if nom != retire}
        courbe, nb, _, _, vmax = combiner([
            courbe_parc(d, min_heures) for d in apprentissage.values()
        ])
        bins_valides = np.flatnonzero(nb > 0)
        vmin = float(CENTERS[bins_valides[0]])
        facteur = calibrer_energie(apprentissage, courbe)
        vents_site = vent_site.to_numpy()
        fc_brut = float(predire(vents_site, courbe).mean())
        fc_net = float(np.minimum(predire(vents_site, courbe) * facteur, 1.0).mean())   # [v2] plafonné à Pnom comme dans analyser
        rows.append({
            "ferme_retiree": retire,
            "fermes_apprentissage": len(apprentissage),
            "plage_validee_min_ms": vmin,
            "plage_validee_max_ms": vmax,
            "heures_site_hors_plage_pct": 100 * float(((vents_site < vmin) | (vents_site > vmax)).mean()),
            "facteur_calibration_energie_pct": 100 * facteur,
            "FC_brut_pct": 100 * fc_brut,
            "FC_net_pct": 100 * fc_net,
            "variation_FC_net_points": 100 * (fc_net - fc_net_complet),
        })
    return pd.DataFrame(rows)


def analyser(parcs, cfs, vents, vent_site, n, mw, min_heures=30, v_ok=8.0, seuil_arret=0.01, lag_h=None, seuil_regime=0.9):
    if lag_h is None:
        lag_h, tab = meilleur_decalage(cfs, vents)
        print("Décalage production/vent (h) testé -> corrélation de rang moyenne : " +
              ", ".join(f"{k:+d}:{v:.3f}" for k, v in tab.items()) + f"  => retenu {lag_h:+d} h", file=sys.stderr)
    paires_toutes = {k: apparier(cfs[k], vents[k], lag_h) for k in cfs}
    paires, fenetres = fenetres_regime(paires_toutes, seuil_regime)
    if len(paires) < 2:
        raise DonneeManquante("moins de 2 parcs en régime établi : abaisser --seuil-regime ou vérifier les données")
    courbe, nb, mn, mx, vmax = combiner([courbe_parc(d, min_heures) for d in paires.values()])
    bins_valides = np.flatnonzero(nb > 0)
    vmin = float(CENTERS[bins_valides[0]])
    ref = []
    for k, d in paires.items():
        a_t, a_e = disponibilites(d, courbe, v_ok, seuil_arret)
        ref.append(dict(parc=k, heures=len(d), vent_moyen=float(d.v.mean()), FC_observe=float(d.cf.mean()),
                        FC_modele_brut=float(predire(d.v.to_numpy(), courbe).mean()),
                        disponibilite_temps_apparente=a_t, facteur_calibration_energie=a_e))
    ref = pd.DataFrame(ref)
    a_e = calibrer_energie(paires, courbe)
    a_t = float(np.average(ref.disponibilite_temps_apparente, weights=ref.heures))
    pn = n * mw
    pred_site = predire(vent_site.to_numpy(), courbe)
    brute = pn * pred_site
    site = pd.DataFrame({"vent_100m_ms": vent_site, "P_brute_MW": brute, "P_nette_MW": np.minimum(brute * a_e, pn)})   # [v2] plafonnée à Pnom
    fc_b, fc_n = float(site.P_brute_MW.mean() / pn), float(site.P_nette_MW.mean() / pn)
    annee = (site.P_nette_MW.groupby(site.index.year).mean() / pn).rename("FC_net")
    val = validation(paires, min_heures, v_ok, seuil_arret)
    sensibilite = sensibilite_references(paires, vent_site, min_heures, fc_n)
    hors_plage_basse = vent_site.to_numpy() < vmin
    hors_plage_haute = vent_site.to_numpy() > vmax
    pred_sans_haute = pred_site.copy()
    pred_sans_haute[hors_plage_haute] = 0.0
    fc_net_sans_haute = float(np.minimum(pred_sans_haute * a_e, 1.0).mean())
    return dict(courbe=courbe, nb=nb, mn=mn, mx=mx, vmin_valide=vmin, vmax_valide=vmax,
                ref=ref, fenetres=fenetres, A_energie=a_e, A_temps=a_t, v_ok=v_ok, seuil_arret=seuil_arret,
                seuil_regime=seuil_regime, min_heures=min_heures, pn=pn,
                site=site, FC_brut=fc_b, FC_net=fc_n, FC_par_annee=annee, validation=val, lag_h=lag_h,
                sensibilite_references=sensibilite,
                part_heures_sous_plage=float(hors_plage_basse.mean()),
                part_heures_au_dela=float(hors_plage_haute.mean()),
                FC_net_sans_extrapolation_haute=fc_net_sans_haute,
                energie_site_predite_hors_plage_pct=(
                    100 * float(pred_site[hors_plage_basse | hors_plage_haute].sum() / pred_site.sum())
                    if pred_site.sum() > 0 else float("nan")
                ))


def avertissements(parcs, mw, res):
    w = []
    lo, hi = min(p["mw_per_turbine"] for p in parcs), max(p["mw_per_turbine"] for p in parcs)
    if mw < 0.75 * lo or mw > 1.25 * hi:
        w.append(f"Unit rated power {mw} MW is outside the reference range ({lo}-{hi} MW): the actual power-curve "
                 "shape will differ (L2); treat the result as an order-of-magnitude estimate.")
    if res["part_heures_au_dela"] > 0.01:
        w.append(f"{100 * res['part_heures_au_dela']:.1f}% of site hours have wind > {res['vmax_valide']:.1f} m/s, "
                 "beyond reference data: a plateau is assumed (no storm shutdown is modelled).")
    if res["part_heures_sous_plage"] > 0.01:
        w.append(f"{100 * res['part_heures_sous_plage']:.1f}% of site hours have wind < "
                 f"{res['vmin_valide']:.1f} m/s, below the reference range.")
    if res["A_energie"] > 1:
        w.append(f"The energy calibration factor is {100 * res['A_energie']:.1f}%: "
                 "it may cause modelled power to exceed gross power and does not represent availability.")
    v = res["validation"]
    if len(v) and v.biais_points.abs().max() > 3:
        w.append(f"Validation: capacity-factor bias reaches {v.biais_points.abs().max():.1f} percentage points "
                 "for a held-out farm; site capacity-factor uncertainty may be of a similar order.")
    f = res["fenetres"]
    exclus = f[f.part_utilisee_pct < 80]
    if len(exclus):
        w.append("Ramp-up excluded from the power-curve calculation: " + "; ".join(
            f"{r.parc} (established operation from {r.debut_regime_etabli}, "
            f"{r.part_utilisee_pct:.0f}% of hours retained)" for r in exclus.itertuples()))
    if (f.heures_utilisees == 0).any():
        w.append("Farm(s) with no established-operation period detected, excluded: "
                 + ", ".join(f.loc[f.heures_utilisees == 0, "parc"]))
    if len(res["ref"]) < 3:
        w.append("Fewer than 3 reference farms: validation may not be representative.")
    return w


# ------------------------------------------------------------------ sorties
def tracer(res, n, mw, lat, lon, path, satellite):
    pn = res["pn"]
    fig = plt.figure(figsize=(17, 14))
    grille = fig.add_gridspec(2, 3, height_ratios=[1, 1.6])
    ax = [fig.add_subplot(grille[0, i]) for i in range(3)]
    ax_satellite = fig.add_subplot(grille[1, :])
    a = ax[0]
    a.axvspan(0, res["vmin_valide"], color="grey", alpha=.12, label="outside validated wind range")
    a.axvspan(res["vmax_valide"], EDGES[-1], color="grey", alpha=.12)
    support = (CENTERS >= res["vmin_valide"]) & (CENTERS <= res["vmax_valide"])
    a.fill_between(CENTERS[support], pn * res["mn"][support], pn * res["mx"][support],
                   alpha=.2, color="tab:blue", label="reference-farm min–max range")
    a.plot(CENTERS[support], pn * res["courbe"][support], color="tab:blue", lw=2,
           label="curve within validated range")
    a.plot(CENTERS[support], pn * res["courbe"][support] * res["A_energie"], "--",
           color="tab:red", lw=1.6,
           label=f"net (energy calibration factor = {res['A_energie']:.3f})")
    a.axvline(res["vmax_valide"], color="grey", ls=":", lw=1); a.text(res["vmax_valide"], pn * .02, " end of data", color="grey", fontsize=8)
    a.axvline(res["vmin_valide"], color="grey", ls=":", lw=1)
    a.set_xlabel("Wind speed at 100 m (m/s)"); a.set_ylabel("Power (MW)")
    a.set_title(f"Site power curve\n{n} x {mw} MW = {pn:.0f} MW"); a.grid(alpha=.3); a.legend(fontsize=8, loc="lower right")
    b = ax[1]; v = res["site"]["vent_100m_ms"]
    b.hist(v, bins=np.arange(0, 30, 1), color="tab:cyan", edgecolor="white")
    b.axvline(v.mean(), color="k", ls="--"); b.set_title(f"Site wind (ERA5)\nmean {v.mean():.2f} m/s"); b.set_xlabel("m/s"); b.set_ylabel("Hours")
    c = ax[2]
    monthly_wind = v.groupby(v.index.month).mean().reindex(range(1, 13))
    monthly_power = res["site"]["P_nette_MW"].groupby(res["site"].index.month).mean().reindex(range(1, 13))
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    c.bar(range(1, 13), monthly_wind, color="tab:cyan", edgecolor="white", label="mean wind speed")
    c.set_xticks(range(1, 13), months)
    c.set_xlabel("Month"); c.set_ylabel("Mean wind speed (m/s)", color="tab:cyan")
    c.tick_params(axis="y", labelcolor="tab:cyan")
    c2 = c.twinx()
    c2.plot(range(1, 13), monthly_power, color="tab:green", marker="o", lw=2,
            label="mean net power")
    c2.set_ylim(bottom=0)
    c2.set_ylabel("Mean net power (MW)", color="tab:green")
    c2.tick_params(axis="y", labelcolor="tab:green")
    c.set_title("Monthly averages over the simulated period")
    c.legend(loc="upper left", fontsize=8)
    c2.legend(loc="upper right", fontsize=8)
    if isinstance(satellite, dict):
        dessiner_satellite(ax_satellite, satellite)
    else:                                                          # [v3] panneau de repli si pas d'image
        ax_satellite.axis("off"); ax_satellite.text(0.5, 0.5, str(satellite), ha="center", va="center", fontsize=10, wrap=True)
    energie_annuelle = res["site"]["P_nette_MW"].mean() * 8766 / 1000
    fig.suptitle(
        f"Site ({lat:.3f}°N, {lon:.3f}°E) — net capacity factor {100 * res['FC_net']:.1f}% — "
        f"mean annual energy {energie_annuelle:,.0f} GWh/year — ERA5 model + {len(res['ref'])} reference farms",
        fontsize=11,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.97)); fig.savefig(path, dpi=140); plt.close(fig)


def rapport(res, n, mw, warns, couverture=None, couverture_annuelle=None):
    L = []
    pd.set_option("display.width", 200); pd.set_option("display.float_format", lambda x: f"{x:,.3f}")
    L.append(f"SITE: {n} x {mw} MW = {res['pn']:.0f} MW   |   selected production/wind time shift: {res['lag_h']:+d} h")
    L.append(f"CAPACITY FACTOR: gross {100 * res['FC_brut']:.1f}%   net {100 * res['FC_net']:.1f}%   "
             f"mean net energy {res['site'].P_nette_MW.sum() / len(res['site']) * 8766 / 1000:,.0f} GWh/year")
    L.append(f"APPARENT TIME AVAILABILITY: {100 * res['A_temps']:.1f}% "
             f"(wind between {res['v_ok']:.1f} and 25 m/s, production below "
             f"{100 * res['seuil_arret']:.1f}% of rated capacity)")
    L.append(f"ENERGY CALIBRATION FACTOR: {100 * res['A_energie']:.1f}% "
             "(observed production / modelled production; may exceed 100% and is not technical availability)")
    L.append("\nESTABLISHED-OPERATION PERIOD USED PER FARM (ramp-up excluded):")
    L.append(res["fenetres"].replace({"jamais atteint": "never reached"}).rename(columns={
        "parc": "Farm",
        "debut_regime_etabli": "Established_regime_start",
        "heures_utilisees": "Hours_used",
        "heures_totales": "Total_hours",
        "part_utilisee_pct": "Share_used_pct",
    }).to_string(index=False))
    L.append("\nREFERENCE FARMS (within the selected period):")
    L.append(res["ref"].rename(columns={
        "parc": "Farm",
        "heures": "Hours",
        "vent_moyen": "Mean_wind_m_s",
        "FC_observe": "Observed_CF",
        "FC_modele_brut": "Raw_model_CF",
        "disponibilite_temps_apparente": "Apparent_time_availability",
        "facteur_calibration_energie": "Energy_calibration_factor",
    }).to_string(index=False))
    L.append("\nLEAVE-ONE-FARM-OUT VALIDATION:")
    L.append(res["validation"].rename(columns={
        "parc": "Farm",
        "heures": "Hours",
        "FC_observe": "Observed_CF",
        "FC_predit": "Predicted_CF",
        "biais_points": "Bias_percentage_points",
        "correlation_horaire": "Hourly_correlation",
        "RMSE_horaire_pct_Pnom": "Hourly_RMSE_pct_rated_capacity",
    }).to_string(index=False))
    L.append("\nREFERENCE SENSITIVITY (curve recalculated after removing each farm):")
    L.append(res["sensibilite_references"].rename(columns={
        "ferme_retiree": "Farm_removed",
        "fermes_apprentissage": "Training_farms",
        "plage_validee_min_ms": "Validated_min_wind_m_s",
        "plage_validee_max_ms": "Validated_max_wind_m_s",
        "heures_site_hors_plage_pct": "Site_hours_outside_range_pct",
        "facteur_calibration_energie_pct": "Energy_calibration_factor_pct",
        "FC_brut_pct": "Gross_CF_pct",
        "FC_net_pct": "Net_CF_pct",
        "variation_FC_net_points": "Net_CF_change_percentage_points",
    }).to_string(index=False))
    sens = res["sensibilite_references"]["variation_FC_net_points"]
    L.append(f"Net capacity factor range across farm-removal tests: "
             f"{res['FC_net'] * 100 + sens.min():.1f}–{res['FC_net'] * 100 + sens.max():.1f} % "
             f"(all reference farms: {res['FC_net'] * 100:.1f} %)")
    L.append("\nVALIDATED REFERENCE WIND-SPEED RANGE: "
             f"{res['vmin_valide']:.2f}–{res['vmax_valide']:.2f} m/s")
    L.append(f"Site hours below range: {100 * res['part_heures_sous_plage']:.2f}%; "
             f"above range: {100 * res['part_heures_au_dela']:.2f}%.")
    L.append(f"Share of modelled energy attributed to hours outside the range: "
             f"{res['energie_site_predite_hors_plage_pct']:.2f} %.")
    L.append(f"Sensitivity scenario only: net capacity factor would be "
             f"{100 * res['FC_net_sans_extrapolation_haute']:.1f}% if production were zero "
             f"above {res['vmax_valide']:.2f} m/s (actual high-wind behavior is unknown).")
    if couverture is not None:
        L.append("\nPRODUCTION DATA COVERAGE (expected hours = hours in the wind file):")
        L.append(couverture.rename(columns={
            "parc": "Farm",
            "heures_vent": "Expected_wind_hours",
            "heures_production": "Production_hours",
            "heures_manquantes": "Missing_hours",
            "couverture_pct": "Coverage_pct",
            "nb_periodes_manquantes": "Missing_periods",
            "plus_longue_lacune_h": "Longest_gap_hours",
            "principales_lacunes": "Main_gaps",
        }).to_string(index=False))
        L.append("\nCOVERAGE BY YEAR:")
        L.append(couverture_annuelle.rename(columns={
            "parc": "Farm",
            "annee": "Year",
            "heures_production": "Production_hours",
            "heures_vent": "Expected_wind_hours",
            "couverture_pct": "Coverage_pct",
        }).to_string(index=False))
        L.append("\nLONGEST CONTINUOUS GAPS (up to 3 per farm):")
        for row in couverture.itertuples(index=False):
            L.append(f"{row.parc}: {row.principales_lacunes}")
    L.append("\nSITE NET CAPACITY FACTOR BY YEAR:")
    L.append((100 * res["FC_par_annee"]).round(1).rename("Net_capacity_factor_pct").rename_axis("Year").to_string())
    if warns:
        L.append("\nWARNINGS:"); L += [f" - {w}" for w in warns]
    L.append("\nASSUMPTIONS AND ESTIMATION ACCURACY:")
    L.append(
        "- Wind: ERA5 wind speed at 100 m, in m/s. Hourly wind is estimated as "
        "the mean of the values at both ends of the hour; hours missing either "
        "endpoint are excluded."
    )
    L.append(
        "- Reference production: mean hourly production divided by installed rated "
        "capacity. Negative values are set to zero; missing periods are neither "
        "interpolated nor treated as outages."
    )
    L.append(
        f"- Ramp-up: established operation is detected when the 75th percentile of "
        f"capacity factor is >= {res['seuil_regime']:.2f} at wind speeds of at least "
        "12 m/s, for at least two consecutive months with at least 10 qualifying "
        "hours per month. This threshold is an empirical rule."
    )
    L.append(
        f"- Power curve: median capacity factor in {EDGES[1] - EDGES[0]:.1f} m/s "
        f"wind-speed bins, requiring at least {res['min_heures']} hours per bin; "
        "reference-farm values are averaged with weights proportional to hours. "
        "Empty bins are interpolated and values are smoothed with a three-bin "
        "moving average. The plateau above the last validated bin is an extrapolation, "
        "not measured turbine behavior."
    )
    L.append(
        f"- Net power: empirical curve multiplied by a global energy calibration "
        f"factor ({100 * res['A_energie']:.1f}%), then capped at the site's rated "
        "capacity. This factor combines outages, curtailment, and model bias; it is "
        "not an independent measure of technical availability."
    )
    L.append(
        "- Capacity factor and equivalent annual energy: capacity factor is mean "
        "power divided by rated capacity. Annual energy shown annualizes this mean "
        "over 8,766 hours; it is not a measurement of energy produced in a calendar year."
    )
    L.append(
        "- Monthly panel: each point/bar is the mean over available hours for that "
        "calendar month, pooled across all years in the requested period. Power is "
        "shown as mean MW, not monthly energy in MWh."
    )
    L.append(
        f"- Apparent time availability: share of hours with wind between "
        f"{res['v_ok']:.1f} and 25 m/s for which capacity factor exceeds "
        f"{100 * res['seuil_arret']:.1f}% of rated capacity. This does not measure "
        "machine availability from outage logs."
    )
    L.append(
        "- The model is most applicable to turbines, hub heights, sites, and conditions "
        "represented by the reference farms. Wake effects, hub-height differences, "
        "curtailment, and weather-product differences are not corrected separately."
    )
    validation = res["validation"]
    if len(validation):
        biais = validation["biais_points"].abs()
        rmse = validation["RMSE_horaire_pct_Pnom"]
        corr = validation["correlation_horaire"]
        L.append(
            "- Measured accuracy from leave-one-farm-out cross-validation: median "
            f"absolute bias {biais.median():.2f} capacity-factor percentage points, "
            f"maximum absolute bias {biais.max():.2f} points; hourly RMSE "
            f"{rmse.min():.1f}–{rmse.max():.1f}% of rated capacity; hourly "
            f"correlation {corr.min():.2f}–{corr.max():.2f}."
        )
        L.append(
            "- Accuracy limitation: validation uses the same farms and periods to "
            "tune parameters and assess performance by holding out one farm. It does "
            "not measure absolute weather errors and does not guarantee performance "
            "for a turbine or site outside these references."
        )
    if len(sens):
        L.append(
            "- Sensitivity to reference selection (one farm removed at a time, with "
            "no retraining on independent data): net capacity factor "
            f"{res['FC_net'] * 100 + sens.min():.2f}–"
            f"{res['FC_net'] * 100 + sens.max():.2f}%, a change of "
            f"{sens.min():+.2f} to {sens.max():+.2f} percentage points. This range is not a "
            "confidence interval."
        )
    if couverture is not None and len(couverture):
        L.append(
            "- Reference-production coverage: "
            f"{couverture['couverture_pct'].min():.1f}–"
            f"{couverture['couverture_pct'].max():.1f}% across farms; potential bias "
            "from missing hours cannot be quantified without knowing their cause."
        )
    L.append(
        "- Interpretation: displayed decimal places reflect numerical precision, "
        "not guaranteed accuracy. Cross-validation and sensitivity above describe "
        "performance observed on the references only; they are not a confidence "
        "interval for a new site."
    )
    return "\n".join(L)


# ------------------------------------------------------------------ auto-test (synthétique)
def _vent_synth(rng, idx, moy=9.0):
    x = np.zeros(len(idx)); x[0] = 0
    for i in range(1, len(idx)):
        x[i] = 0.97 * x[i - 1] + rng.normal(0, 0.25)
    return pd.Series(np.clip(moy + 3.2 * (x / x.std()), 0, 40), index=idx)


def _vraie_courbe(v):
    c = 1 / (1 + np.exp(-(np.asarray(v) - 9.0) / 1.4))
    return np.where((v < 3.0) | (v > 25.0), 0.0, c)


def selftest():
    rng = np.random.default_rng(1)
    idx = pd.date_range("2023-01-01", periods=24 * 365 * 3, freq="1h", tz="UTC")
    parcs = [dict(name=f"P{i}", mw_per_turbine=7, n_turbines=70 + i, pnom_mw=7 * (70 + i)) for i in range(4)]
    cfs, vents, vrai = {}, {}, {}
    for i, p in enumerate(parcs):
        v_true = _vent_synth(rng, idx, moy=9 + 0.3 * i)
        panne = rng.random(len(idx)) < 0.04                     # 4 % d'heures à l'arrêt
        cf = pd.Series(_vraie_courbe(v_true.to_numpy()), index=idx) * np.where(panne, 0.0, 1.0)
        if i == 0:                                                 # P0 : montée en puissance linéaire sur 180 jours
            cf = cf * np.clip(np.arange(len(idx)) / (24 * 180), 0, 1)
        vents[p["name"]] = (v_true + rng.normal(0, 0.9, len(idx))).clip(lower=0)   # « ERA5 » = vérité + erreur
        cfs[p["name"]] = cf.shift(1)                              # production décalée de +1 h -> doit être détecté
    site_true = _vent_synth(rng, idx, moy=9.4)
    site_era5 = (site_true + rng.normal(0, 0.9, len(idx))).clip(lower=0)
    res = analyser(parcs, cfs, vents, site_era5, n=60, mw=7)
    fc_vrai = float((_vraie_courbe(site_true.to_numpy()) * 0.96).mean())
    assert res["lag_h"] == -1 or res["lag_h"] == 1, res["lag_h"]
    assert abs(res["A_temps"] - 0.96) < 0.025, res["A_temps"]
    assert abs(res["FC_net"] - fc_vrai) < 0.04, (res["FC_net"], fc_vrai)
    assert res["validation"].biais_points.abs().max() < 3.0, res["validation"]
    assert set(res["sensibilite_references"]["ferme_retiree"]) == {p["name"] for p in parcs}
    f = res["fenetres"].set_index("parc")
    debut_p0 = pd.Timestamp(f.loc["P0", "debut_regime_etabli"])
    assert pd.Timestamp("2023-04-01") <= debut_p0 <= pd.Timestamp("2023-08-01"), f          # fin de montée détectée vers le mois 5-7
    assert f.loc["P1", "part_utilisee_pct"] > 95, f                                           # parc sans montée : rien d'exclu
    assert (res["site"]["P_nette_MW"] <= res["pn"] + 1e-9).all()
    vm = vent_moyen_heure(pd.Series([0.0, 2.0, 4.0, 6.0], index=idx[:4]))
    assert list(vm.round(6)) == [1.0, 3.0, 5.0], list(vm)
    test_cf = pd.Series([0.5, np.nan, np.nan, 0.5], index=idx[:4])
    test_wind = pd.Series([5.0, 5.0, 5.0, 5.0], index=idx[:4])
    couverture, annuelle = diagnostiquer_couverture({"test": test_cf}, {"test": test_wind})
    assert couverture.iloc[0]["heures_manquantes"] == 2
    assert couverture.iloc[0]["plus_longue_lacune_h"] == 2
    assert len(annuelle) == 1
    satellite_test = {
        "image": np.zeros((128, 128, 3), dtype=np.uint8),
        "extent_km": (-RAYON_SATELLITE_KM, RAYON_SATELLITE_KM,
                      -RAYON_SATELLITE_KM, RAYON_SATELLITE_KM),
        "lat": 48.0, "lon": -4.0, "resolution_m_px": 1000.0,
        "zoom": 7, "attribution": "Image synthétique pour auto-test",
    }
    tracer(res, 60, 7, 48.0, -4.0, os.path.join(tempfile.gettempdir(), "selftest_courbe.png"), satellite_test)
    tracer(res, 60, 7, 48.0, -4.0, os.path.join(tempfile.gettempdir(), "selftest_courbe_sans_sat.png"), "Image satellite indisponible : test de repli")
    _selftest_satellite()
    print(rapport(res, 60, 7, avertissements(parcs, 7, res)))
    print(f"\nSynthetic self-test passed: net capacity factor {100 * res['FC_net']:.1f}% "
          f"vs true {100 * fc_vrai:.1f}%, apparent time availability {100 * res['A_temps']:.1f}% "
          "(injected value 96%). No real data used.")


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float); ap.add_argument("--lon", type=float)
    ap.add_argument("--n", type=int, help="nombre d'éoliennes"); ap.add_argument("--mw", type=float, help="puissance par éolienne (MW)")
    ap.add_argument("--farms", default="farms_reference.json")
    ap.add_argument("--data-dir", default="data", help="répertoire des fichiers *_hourly_data.csv des parcs de référence")
    ap.add_argument("--start", default="2016-01-01"); ap.add_argument("--end", default="2025-12-31")
    ap.add_argument("--model", default="", help="paramètre 'models' d'Open-Meteo. Défaut '' = aucun, comme l'extrait ayant servi à "
                    "télécharger data/*_hourly_data.csv ; mettre era5 SEULEMENT si ces fichiers ont aussi été téléchargés avec models=era5")
    ap.add_argument("--seuil-regime", type=float, default=0.9, help="seuil de fin de montée en puissance (0 = ne rien exclure)")
    ap.add_argument("--rayon-km", type=float, default=RAYON_SATELLITE_KM, help="rayon de la vue satellite (km)")
    ap.add_argument("--source-sat", default="eox2016", choices=list(SOURCES), help="source des tuiles satellite (licences : voir en-tête)")
    ap.add_argument("--cache-tuiles", default=".cache_tuiles")
    ap.add_argument("--sans-satellite", action="store_true", help="ne pas télécharger l'image satellite")
    ap.add_argument("--v-ok", type=float, default=8.0); ap.add_argument("--seuil-arret", type=float, default=0.01)
    ap.add_argument("--min-heures", type=int, default=30); ap.add_argument("--outdir", default="sortie_site")
    ap.add_argument("--cache", default=".cache_vent"); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    for k in ("lat", "lon", "n", "mw"):
        if getattr(a, k) is None:
            raise DonneeManquante(f"--{k} est obligatoire")
    if not os.path.isfile(PRODUCTION_PATH):
        raise DonneeManquante(f"fichier de production introuvable : {PRODUCTION_PATH}")
    parcs = charger_parcs(a.farms)
    prod = charger_production(PRODUCTION_PATH, parcs)
    vents = {k: vent_moyen_heure(v) for k, v in charger_vents_parcs(a.data_dir, parcs).items()}
    cfs = {}
    for p in parcs:
        t0, t1 = prod[p["name"]].dropna().index.min(), prod[p["name"]].dropna().index.max()
        print(f"Parc {p['name']} : {p['n_turbines']} x {p['mw_per_turbine']} MW, production {t0:%Y-%m-%d} -> {t1:%Y-%m-%d}", file=sys.stderr)
        if not vents[p["name"]].index.intersection(prod[p["name"]].index).size:
            raise DonneeManquante(
                f"aucun horaire commun entre production et fichier de vent du parc {p['name']}"
            )
        cfs[p["name"]] = prod[p["name"]]
    couverture, couverture_annuelle = diagnostiquer_couverture(cfs, vents)
    site = vent_moyen_heure(telecharger_vent(a.lat, a.lon, a.start, a.end, a.cache, a.model or None))
    res = analyser(parcs, cfs, vents, site, a.n, a.mw, a.min_heures, a.v_ok, a.seuil_arret, seuil_regime=a.seuil_regime)
    warns = avertissements(parcs, a.mw, res)
    if a.sans_satellite:
        satellite = "Satellite image disabled (--sans-satellite)"
    else:
        try:
            satellite = image_satellite(a.lat, a.lon, rayon_km=a.rayon_km, source=a.source_sat, cache_dir=a.cache_tuiles)
        except ImageSatelliteErreur as e:      # [v3] l'échec du satellite ne doit pas faire perdre tout le calcul
            satellite = f"Satellite image unavailable: {e}"
            warns.append(satellite)
            print(f"  [warning] {satellite}", file=sys.stderr)
    os.makedirs(a.outdir, exist_ok=True)
    pd.DataFrame({"vent_ms": CENTERS, "P_MW_brut": res["pn"] * res["courbe"], "P_MW_net": res["pn"] * res["courbe"] * res["A_energie"],
                  "P_MW_min_parcs": res["pn"] * res["mn"], "P_MW_max_parcs": res["pn"] * res["mx"], "heures_ref": res["nb"]}
                 ).to_csv(os.path.join(a.outdir, "courbe_puissance.csv"), index=False)
    res["site"].to_csv(os.path.join(a.outdir, "serie_horaire_site.csv"))
    txt = rapport(res, a.n, a.mw, warns, couverture, couverture_annuelle)
    open(os.path.join(a.outdir, "resume.txt"), "w", encoding="utf-8").write(txt)
    tracer(res, a.n, a.mw, a.lat, a.lon, os.path.join(a.outdir, "courbe_site.png"), satellite)
    print(txt); print(f"\nFiles written to {a.outdir}/")


if __name__ == "__main__":
    try:
        main()
    except DonneeManquante as e:
        print(f"DONNÉE MANQUANTE : {e}", file=sys.stderr); sys.exit(2)
    except ImageSatelliteErreur as e:
        print(f"IMAGE SATELLITE IMPOSSIBLE : {e}", file=sys.stderr); sys.exit(2)
