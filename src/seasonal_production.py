from matplotlib.pyplot import *
from statistics import mean
import real_curves as rc

prod_tps = rc.lecture_csv('data/production_offshore_farms_within_constraint.csv', ";")
wind_YN_tps = rc.lecture_csv('data/Noirmoutier_hourly_data.csv', ",")
wind_SB_tps = rc.lecture_csv('data/Saint-Brieuc_hourly_data.csv', ",")
wind_SN_tps = rc.lecture_csv('data/Saint-Nazaire_hourly_data.csv', ",")
wind_F_tps = rc.lecture_csv('data/Fécamp_hourly_data.csv', ",")
wind_tps={'Yeu-Noirmoutier':wind_YN_tps, 'Saint-Brieuc':wind_SB_tps, 'Saint-Nazaire':wind_SN_tps, 'Fecamp':wind_F_tps}

def month_prod(year, parc):
    m=[]
    tps=[]
    for month in range(12):
        tps.append(month+1)
        month='0'+str(month+1) if month<9 else str(month+1)
        prod_m=[]
        for d in prod_tps:
            t=rc.extraire_cle_prod(d['timestamp'])
            t=t.split('-')
            if t[0]==year:
                if t[1]==month and d[parc]!='':
                    prod_m.append(d[parc])
        if prod_m:
            m.append(mean(prod_m))
        else : 
            m.append(0)
    w=[]
    for month in range(12):
        month='0'+str(month+1) if month<9 else str(month+1)
        wind_m=[]
        for d in wind_tps[parc]:
            t=rc.extraire_cle_wind(d['date'])
            t=t.split('-')
            if t[0]==year:
                if t[1]==month and d['hourly_wind_speed_100m']!='':
                    wind_m.append(d['hourly_wind_speed_100m'])
        if wind_m:
            w.append(mean(wind_m))
        else: 
            w.append(0)
    _, ax1=subplots()
    ax1.plot(tps, m, marker='x', linestyle='-')
    ax2=ax1.twinx()
    ax2.plot(tps, w, marker='x', linestyle='-', color='red')
    title('production du parc '+parc+" par mois sur l'année "+year )
    show()
    
#month_prod('2025', 'Saint-Nazaire')
    
