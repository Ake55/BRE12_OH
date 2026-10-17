"""Dashboard BRE12 : courbes de puissance des parcs éoliens offshore.

Lancer depuis la racine du dépôt :

    uv run streamlit run app.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import streamlit as st

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.charts import empirical_overlay, power_curve_figure, theoretical_overlay
from src.components import (
    PAGES,
    format_int,
    format_ms,
    format_mw,
    format_time,
    hero,
    inject_css,
    note,
)
from src.data_loader import load_dashboard_frames, matched_hours, overview_stats, park_observation_stats
from src.io import PARK_LABELS, PARK_ORDER
from src.power_curves import DEFAULT_THEORY, empirical_curve

THEORY_HELP = (
    "Ces quatre nombres ne sont pas dans les CSV. "
    "500 MW est la borne de nettoyage, pas la puissance nominale. "
    "Le modèle n'est pas ajusté sur les mesures."
)


@st.cache_data(show_spinner="Lecture des heures croisées…")
def load_frames() -> dict[str, pd.DataFrame]:
    return load_dashboard_frames()


def theory_params(park: str) -> dict:
    """Hypothèses du parc, mémorisées pour rester les mêmes d'une page à l'autre."""
    store = st.session_state.setdefault("theory", {})
    if park not in store:
        store[park] = dict(DEFAULT_THEORY)
    return store[park]


def theory_controls(park: str) -> dict:
    params = theory_params(park)
    st.sidebar.markdown("**Modèle théorique simplifié**")
    st.sidebar.caption(THEORY_HELP)
    params["cut_in_ms"] = st.sidebar.number_input(
        "Démarrage (m/s)", min_value=0.0, max_value=15.0, value=float(params["cut_in_ms"]), step=0.5, key=f"cut_{park}"
    )
    params["rated_speed_ms"] = st.sidebar.number_input(
        "Vitesse nominale (m/s)", min_value=1.0, max_value=25.0, value=float(params["rated_speed_ms"]), step=0.5, key=f"ratedv_{park}"
    )
    params["cut_out_ms"] = st.sidebar.number_input(
        "Arrêt (m/s)", min_value=5.0, max_value=40.0, value=float(params["cut_out_ms"]), step=0.5, key=f"cutout_{park}"
    )
    params["rated_mw"] = st.sidebar.number_input(
        "Puissance nominale hypothétique (MW)", min_value=0.0, max_value=800.0, value=float(params["rated_mw"]), step=10.0, key=f"prated_{park}"
    )
    return params


def coverage_sentence(stats: dict) -> str:
    return (
        f"{format_int(stats['heures_appariees'])} heures de production propre ont un vent du même parc. "
        f"{format_int(stats['heures_propres_sans_vent'])} heures propres n'ont pas de vent correspondant. "
        f"{format_int(stats['heures_vent_sans_production_propre'])} heures de vent n'ont pas de production propre "
        f"(hors période, ou heures rejetées par le filtre −10 à 500 MW)."
    )


def page_overview(frames: dict[str, pd.DataFrame]) -> None:
    hero()
    summary = overview_stats(frames["merged"])
    columns = st.columns(4)
    columns[0].metric("Parcs", format_int(summary["n_parcs"]))
    columns[1].metric("Heures croisées", format_int(summary["n_heures"]))
    columns[2].metric("Puissance moyenne", format_mw(summary["puissance_moyenne_mw"]))
    columns[3].metric("Période", f"{format_time(summary['debut'])[0:10]} → {format_time(summary['fin'])[0:10]}")
    note(
        "La vitesse affichée en m/s suppose que `hourly_wind_speed_100m` est en km/h. "
        "On divise par 3,6. Les fichiers dépassent 100 dans l'unité source, ce qui ne serait pas une moyenne horaire crédible en m/s. "
        "Le fichier `Noirmoutier_hourly_data.csv` alimente Yeu-Noirmoutier : mêmes colonnes que les trois autres."
    )
    st.subheader("Les quatre parcs")
    for start in (0, 2):
        cards = st.columns(2)
        for offset, park in enumerate(PARK_ORDER[start : start + 2]):
            stats = park_observation_stats(frames["merged"], frames["coverage"], park)
            quality = frames["quality"].loc[frames["quality"]["park"] == park]
            kept = float(quality["taux_conservation"].iloc[0]) if not quality.empty else float("nan")
            with cards[offset]:
                st.markdown(
                    f"""
                    <article class="park-card">
                      <h3>{stats['park_label']}</h3>
                      <p>{format_int(stats['heures_appariees'])} heures croisées · moyenne {format_mw(stats['puissance_moyenne_mw'])}</p>
                      <p>Vent moyen {format_ms(stats['vent_moyen_ms'])} · conservation {kept:.0%}</p>
                      <p>{format_int(stats['heures_propres_sans_vent'])} heures propres sans vent correspondant</p>
                    </article>
                    """,
                    unsafe_allow_html=True,
                )


def page_park(frames: dict[str, pd.DataFrame]) -> None:
    st.header("Analyse par parc")
    label = st.selectbox("Parc éolien", [PARK_LABELS[park] for park in PARK_ORDER])
    park = next(key for key, value in PARK_LABELS.items() if value == label)
    params = theory_controls(park)
    mode = st.radio("Représentation", ["Réelle", "Théorique", "Comparaison"], horizontal=True)
    show_points = show_mean = show_theory = False
    if mode == "Réelle":
        show_points, show_mean = True, True
    elif mode == "Théorique":
        show_theory = True
    else:
        toggles = st.columns(3)
        show_points = toggles[0].checkbox("Mesures horaires", value=True)
        show_mean = toggles[1].checkbox("Moyenne par 0,5 m/s", value=True)
        show_theory = toggles[2].checkbox("Modèle théorique", value=True)

    observed = matched_hours(frames["merged"], park)
    stats = park_observation_stats(frames["merged"], frames["coverage"], park)
    st.plotly_chart(
        power_curve_figure(observed, label, params, show_points, show_mean, show_theory),
        width="stretch",
    )
    note(coverage_sentence(stats))
    if stats["heures_vent_sup_30_ms"]:
        st.caption(
            f"{format_int(stats['heures_vent_sup_30_ms'])} heures dépassent 30 m/s sous l'hypothèse km/h "
            "et sortent du cadre horizontal du graphe."
        )
    metrics = st.columns(4)
    metrics[0].metric("Heures croisées", format_int(stats["heures_appariees"]))
    metrics[1].metric("Puissance moyenne", format_mw(stats["puissance_moyenne_mw"]))
    metrics[2].metric("Puissance médiane", format_mw(stats["puissance_mediane_mw"]))
    metrics[3].metric("Vent moyen", format_ms(stats["vent_moyen_ms"]))
    st.caption(f"Période des heures croisées : {format_time(stats['debut'])} → {format_time(stats['fin'])}.")
    if observed.empty:
        st.info("Aucune heure de production propre n'est appariée à un vent pour ce parc.")
        return
    curve = empirical_curve(observed["wind_speed_ms_hyp"], observed["production_total_mw"])
    st.download_button(
        "Télécharger la courbe empirique (CSV)",
        data=curve.to_csv(index=False).encode("utf-8"),
        file_name=f"courbe_empirique_{park}.csv",
        mime="text/csv",
    )


def page_compare(frames: dict[str, pd.DataFrame]) -> None:
    st.header("Comparaison des parcs")
    selected_labels = st.multiselect(
        "Parcs à superposer",
        [PARK_LABELS[park] for park in PARK_ORDER],
        default=[PARK_LABELS[park] for park in PARK_ORDER],
    )
    parks = [key for key in PARK_ORDER if PARK_LABELS[key] in selected_labels]
    if len(parks) < 2:
        st.info("Choisis au moins deux parcs.")
        return
    for park in parks:
        theory_params(park)
    st.plotly_chart(empirical_overlay(frames["merged"], parks), width="stretch")
    st.plotly_chart(theoretical_overlay(parks, st.session_state.theory), width="stretch")
    note(
        "Si les hypothèses du modèle sont identiques, les courbes théoriques se superposent. "
        "Ce n'est pas un calage sur les mesures. Les paramètres se modifient dans Analyse par parc."
    )
    rows = []
    for park in parks:
        stats = park_observation_stats(frames["merged"], frames["coverage"], park)
        params = st.session_state.theory[park]
        rows.append(
            {
                "Parc": stats["park_label"],
                "Heures croisées": stats["heures_appariees"],
                "Heures propres sans vent": stats["heures_propres_sans_vent"],
                "Puissance moyenne (MW)": None if pd.isna(stats["puissance_moyenne_mw"]) else round(stats["puissance_moyenne_mw"], 1),
                "Vent moyen (m/s, hypothèse)": None if pd.isna(stats["vent_moyen_ms"]) else round(stats["vent_moyen_ms"], 1),
                "P nominale hypothétique (MW)": params["rated_mw"],
                "Démarrage (m/s)": params["cut_in_ms"],
                "Vitesse nominale (m/s)": params["rated_speed_ms"],
                "Arrêt (m/s)": params["cut_out_ms"],
            }
        )
    table = pd.DataFrame(rows)
    st.dataframe(table, width="stretch", hide_index=True)
    st.download_button(
        "Télécharger le tableau (CSV)",
        data=table.to_csv(index=False).encode("utf-8"),
        file_name="comparaison_parcs.csv",
        mime="text/csv",
    )


def page_method(frames: dict[str, pd.DataFrame]) -> None:
    st.header("Méthodologie")
    st.markdown(
        """
**Provenance.** La production vient du CSV offshore déposé dans `data/raw`.
Le vent vient de quatre fichiers horaires de même schéma :
`date`, `hourly_wind_speed_100m`, `hourly_wind_direction_100m`, `hourly_wind_gusts_10m`.
`Noirmoutier_hourly_data.csv` est le vent de **Yeu-Noirmoutier**. Le nom du fichier ne contient pas « Yeu » ; la clé de jointure, elle, reste `Yeu-Noirmoutier`.

**T1 + T2.** Pour chaque parc et chaque heure, `production_total_mw = T1 + T2`.
Si T1 ou T2 manque, le total manque. Il n'est jamais remplacé par zéro, ni par l'autre série.
Les parcs ne sont pas additionnés entre eux. T1 et T2 ne sont pas documentés comme deux turbines.

**Nettoyage.** Une heure est retenue si l'horodatage est valide, si les deux séries sont numériques,
et si le total est dans [−10, 500] MW inclus. Rien n'est écrêté.
Les valeurs négatives à l'intérieur de cet intervalle sont conservées.
500 MW n'est pas la puissance nominale des parcs.

**Jointure.** Clé `(timestamp_utc, parc)`, une ligne pour une ligne, sans interpolation.
Les offsets `+01:00` et `+02:00` sont convertis en UTC avant la jointure.

**Classes de 0,5 m/s.** La moyenne orange est la moyenne des puissances retenues
dont la vitesse tombe dans une classe de largeur 0,5 m/s.
Le survol et le CSV téléchargé donnent l'effectif : une moyenne sur peu d'heures se voit.

**Unité du vent.** Les maxima source dépassent 100. L'axe en m/s utilise l'hypothèse
`vitesse_ms = hourly_wind_speed_100m / 3,6`. La colonne d'origine n'est pas écrasée.
`wind_speed_ms` du schéma normalisé reste vide tant que l'unité n'est pas confirmée par une fiche.

**Modèle théorique.** Il est calculé sans regarder la production :
0 avant le démarrage, montée en cube jusqu'à la vitesse nominale, plateau, puis 0 à partir de l'arrêt.
Les paramètres par défaut (3,5 / 12,5 / 25 m/s et 480 MW) sont des hypothèses ajustables,
identiques au départ pour les quatre parcs. Ils ne viennent pas des fichiers.

**Direction du vent.** Les colonnes de direction existent. Les roses et les secteurs
ne sont pas encore tracés : le module `src/wind_direction.py` réserve les fonctions,
sans chiffre de remplacement.

**Limites.** Unité de production supposée en MW. Sens de T1/T2 et des valeurs négatives inconnu.
Position du point météo, hauteur réelle et licence inconnues : 100 m et 10 m sont lus dans les noms de colonnes.
La courbe empirique est conditionnelle au filtre [−10, 500].
        """
    )
    st.subheader("Contrôle des fichiers de vent")
    qc = frames["wind_qc"].copy()
    shown = qc[
        [
            "park_label",
            "n",
            "n_timestamp_invalide",
            "n_doublons_cle",
            "n_vitesses_manquantes",
            "n_pas_non_horaires",
            "vitesse_min",
            "vitesse_max",
            "debut_utc",
            "fin_utc",
        ]
    ]
    st.dataframe(shown, width="stretch", hide_index=True)


def main() -> None:
    st.set_page_config(page_title="BRE12 — Offshore wind", layout="wide", initial_sidebar_state="expanded")
    inject_css()
    st.sidebar.markdown("## BRE12")
    st.sidebar.caption("Offshore wind intelligence")
    page = st.sidebar.radio("Navigation", PAGES, label_visibility="collapsed")
    frames = load_frames()
    if page == "Vue d'ensemble":
        page_overview(frames)
    elif page == "Analyse par parc":
        page_park(frames)
    elif page == "Comparaison des parcs":
        page_compare(frames)
    else:
        page_method(frames)


if __name__ == "__main__":
    main()
