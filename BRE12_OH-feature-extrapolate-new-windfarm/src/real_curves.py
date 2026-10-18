from math import *
from matplotlib.pyplot import *
from statistics import mean, pstdev

def lecture_csv(fichier: str, sep: str=";") -> list[dict]:
    data = []
    with open(fichier, "r") as f:
        lines = f.read().splitlines()
        keys = lines[0].split(sep)
        for line in lines[1:]:
            values = line.split(sep)
            for i, v in enumerate(values):
                try:
                    values[i] = float(v)
                except ValueError:
                    pass
            data.append(dict(zip(keys, values)))
    return data

def printth(Nt, R, Vmin, Vmax, P, name:str='non précisé', fichier: str | None = None):
    v=[i for i in range (Vmax)]
    v.append(Vmax-0.01)
    for i in range(5):
        v.append(Vmax+i)
    Pord=[0. for _ in range(Vmin)]
    tempo=(1/2)*((v[len(Pord)]-(Vmin-1))**3)*pi*(R**2)*(10**(-6))
    while tempo<P:
        Pord.append(tempo)
        tempo=(1/2)*((v[len(Pord)]-(Vmin-1))**3)*pi*(R**2)*(10**(-6))
    print('step1')
    i=len(Pord)
    while v[i]<Vmax:
        Pord.append(P)
        i+=1
    print('step2')
    while i<len(v):
        Pord.append(0.)
        i+=1
    Pord=[p*Nt for p in Pord]
    print('step3')
    title('Production théorique du parc : '+name)
    xlabel('Vitesse du vent (m/s)')
    ylabel('Production (MW)')
    plot(v, Pord)
    if fichier is None:
        show()
    else:
        savefig(fichier, dpi=150, bbox_inches='tight')
        close()

#printth(71, 75, 3, 25, 7)

def extraire_cle_prod(timestamp: str) -> str:
    """'2023-01-01T14:00:00' -> '2023-01-01 14' (date + heure)."""
    date, heure = timestamp.split('T')
    return date + ' ' + heure.split(':')[0]

def extraire_cle_wind(date_wind: str) -> str:
    """'2023-01-01 14:00:00' -> '2023-01-01 14' (date + heure)."""
    date, heure = date_wind.split(' ')
    return date + ' ' + heure.split(':')[0]

def apparier(prod_lignes: list[dict], prod_y, parc: str,
             wind_lignes: list[dict]) -> tuple[list, list]:
    """Apparie production et vent sur la même date+heure.

    Retourne (vitesses, productions) filtrées : uniquement les heures
    présentes dans les deux fichiers avec une production non vide.

    Le CSV de vent est en km/h (maxima au-dessus de 100). Les vitesses
    renvoyées sont en m/s : km/h / 3,6.
    """
    # index du vent : clé 'date heure' -> vitesse en m/s
    index_wind = {}
    for w in wind_lignes:
        index_wind[extraire_cle_wind(w['date'])] = w['hourly_wind_speed_100m'] / 3.6

    speeds, prods = [], []
    for p in prod_lignes:
        prod = p[parc]
        if prod == '':
            continue
        cle = extraire_cle_prod(p['timestamp'])
        if cle in index_wind:
            speeds.append(index_wind[cle])
            prods.append(prod)
    return speeds, prods

prod_tps = lecture_csv('data/production_offshore_farms_within_constraint.csv', ";")
wind_YN_tps = lecture_csv('data/Noirmoutier_hourly_data.csv', ",")
wind_SB_tps = lecture_csv('data/Saint-Brieuc_hourly_data.csv', ",")
wind_SN_tps = lecture_csv('data/Saint-Nazaire_hourly_data.csv', ",")
wind_F_tps = lecture_csv('data/Fécamp_hourly_data.csv', ",")

wind_speed = {}
prod_r = {}

wind_speed['Saint-Nazaire'], prod_r['Saint-Nazaire'] = \
    apparier(prod_tps, 'timestamp', 'Saint-Nazaire', wind_SN_tps)
wind_speed['Saint-Brieuc'], prod_r['Saint-Brieuc'] = \
    apparier(prod_tps, 'timestamp', 'Saint-Brieuc', wind_SB_tps)
wind_speed['Fecamp'], prod_r['Fecamp'] = \
    apparier(prod_tps, 'timestamp', 'Fecamp', wind_F_tps)
wind_speed['Yeu-Noirmoutier'], prod_r['Yeu-Noirmoutier'] = \
    apparier(prod_tps, 'timestamp', 'Yeu-Noirmoutier', wind_YN_tps)

def stats_par_intervalle(vitesses, productions, pas=1.0):
    """Moyenne et écart-type de la production par tranche de vitesse du vent.

    Regroupe les points par intervalle [k*pas, (k+1)*pas[ m/s et calcule,
    pour chaque tranche contenant des points, la moyenne et l'écart-type
    (population) de la production.
    """
    bins = {}
    for v, p in zip(vitesses, productions):
        k = int(v // pas)
        bins.setdefault(k, []).append(p)
    res = {}
    for k, ps in bins.items():
        res[k] = (mean(ps), pstdev(ps) if len(ps) > 1 else 0.)
    return res

def facteur_de_charge(parc, P, Nt):
    """Facteur de charge annuel du parc.

    Production réelle cumulée sur un an (somme des MW horaires, soit des MWh)
    divisée par la production maximale théorique : P * Nt * 8760 MWh
    (8760 = nombre d'heures dans une année).

    P : puissance nominale d'une éolienne (MW)
    Nt : nombre d'éoliennes du parc
    """
    heures = len(prod_r[parc])
    if heures == 0:
        raise ValueError(f'Aucune donnée de production pour {parc}')
    prod_reelle = sum(prod_r[parc])          # MWh (1 valeur par heure)
    prod_max = P * Nt * heures               # MWh théoriques sur la même période
    fc = prod_reelle / prod_max
    print(f'{parc} : {heures} heures de données')
    print(f'  Production réelle : {prod_reelle:,.0f} MWh')
    print(f'  Production max théorique ({P} MW x {Nt} éoliennes) : {prod_max:,.0f} MWh')
    print(f'  Facteur de charge : {fc:.2%}')
    return fc

def dispo(parc):
    nhd=0
    for p in prod_r[parc]:
        if p>0:
            nhd+=1
    return nhd/len(prod_r[parc])

def printr_pv(parc, P, Nt, pas=1.0, afficher_stats=True, fichier: str | None = None):
    fig, ax = subplots(figsize=(10, 6))
    ax.set_title('Production réelle du parc en fonction de la vitesse du vent : ' + parc)
    ax.set_xlabel('Vitesse du vent à 100 m (m/s, km/h ÷ 3,6)')
    ax.set_ylabel('Production (MW)')
    ax.plot(wind_speed[parc], prod_r[parc], marker='x', linestyle='none',
            color='lightblue', label='Points horaires')

    if afficher_stats:
        stats = stats_par_intervalle(wind_speed[parc], prod_r[parc], pas)
        centres = [(k + 0.5) * pas for k in sorted(stats)]
        moyennes = [stats[k][0] for k in sorted(stats)]
        ecarts = [stats[k][1] for k in sorted(stats)]
        centres_f = [c for c, m in zip(centres, moyennes) if m == m]
        moyennes_f = [m for m in moyennes if m == m]
        ecarts_f = [e for e, m in zip(ecarts, moyennes) if m == m]
        ax.errorbar(centres_f, moyennes_f, yerr=ecarts_f, marker='.',
                    linestyle='-', capsize=3, color='crimson',
                    label=f'Moyenne ± écart-type ({pas:g} m/s)')
        ax.annotate(f'Facteur de charge : {facteur_de_charge(parc, P, Nt):.1%}', xy=(0.02, 0.95), xycoords='axes fraction', fontsize=11, bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.7))
        ax.annotate(f'Disponibilité : {dispo(parc):.1%}', xy=(0.02, 0.87), xycoords='axes fraction', fontsize=11, bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.7))
    ax.legend(loc='upper right')
    if fichier is None:
        show()
    else:
        fig.savefig(fichier, dpi=150, bbox_inches='tight')
        close(fig)

# Puissance unitaire (MW) et nombre d'éoliennes.
# Saint-Nazaire 80×6 = 480 MW, Saint-Brieuc 62×8 = 496 MW,
# Fécamp 71×7 = 497 MW, Yeu-Noirmoutier 61×8 = 488 MW.
PARCS = {
    'Saint-Nazaire': (6, 80),
    'Saint-Brieuc': (8, 62),
    'Fecamp': (7, 71),
    'Yeu-Noirmoutier': (8, 61),
}

if __name__ == '__main__':
    from pathlib import Path
    dossier = Path('figures')
    dossier.mkdir(exist_ok=True)
    for nom, (P, Nt) in PARCS.items():
        printr_pv(nom, P, Nt, fichier=dossier / f'reel_{nom}.png')
    # Courbe théorique commentée à l'origine : Fécamp, R = 75 m.
    printth(71, 75, 3, 25, 7, 'Fecamp', fichier=dossier / 'theorique_Fecamp.png')

